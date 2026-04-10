import path from "node:path";

import cookie from "cookie";
import express from "express";

import { adminStaticDir, publicDir, settings } from "./config.js";
import { openDatabase } from "./db.js";
import { formatErrorForLog } from "./error-utils.js";
import { runAgentTask } from "./runtime.js";
import {
  authenticateGatewayKey,
  beginGatewayRequest,
  buildPrompt,
  completeGatewayRequest,
  createDeployment,
  createDeploymentsBatch,
  createGatewayApiKey,
  createUpstreamKey,
  deleteDeployment,
  deleteGatewayApiKey,
  deleteUpstreamAgents,
  deleteUpstreamKey,
  failGatewayRequest,
  fetchUpstreamAgents,
  findModelCatalogCache,
  getBootstrapData,
  listRequestLogsPage,
  markRequestStreaming,
  normalizeMessages,
  pickCatalogSourceKey,
  refreshModelCatalog,
  selectDeploymentForModel,
  serializeDeployment,
  serializeGatewayKey,
  serializeModelCatalog,
  serializeUpstreamKey,
  syncDeploymentsToKeys,
  updateDeployment,
  updateUpstreamKey,
  verifyUpstreamKey,
} from "./services.js";
import {
  makeAdminSession,
  parseAdminSession,
  readBearerToken,
  verifyAdminCredentials,
} from "./security.js";
import { resolveImageAttachments } from "./multimodal.js";
import { detectToolCall, normalizeTools, generateToolUseId } from "./tools.js";
import {
  parseAnthropicRequest,
  buildAnthropicResponse,
  createAnthropicStreamWriter,
} from "./anthropic-format.js";

const db = await openDatabase(settings.databasePath);
const app = express();

app.use(express.json({ limit: "4mb" }));
app.use(express.static(publicDir));

function requireAdmin(req, res) {
  const cookies = cookie.parse(req.headers.cookie || "");
  const username = parseAdminSession(settings, cookies[settings.adminCookieName]);
  if (!username) {
    res.status(401).json({ detail: "Admin login required." });
    return null;
  }
  return username;
}

async function requireGatewayKey(req, res) {
  // Support both "Authorization: Bearer <key>" (OpenAI style)
  // and "x-api-key: <key>" (Anthropic style)
  const rawKey =
    readBearerToken(req.headers.authorization) ||
    (req.headers["x-api-key"] ? String(req.headers["x-api-key"]).trim() : null);
  const gatewayKey = await authenticateGatewayKey(db, rawKey);
  if (!gatewayKey) {
    res.status(401).json({ detail: "Invalid gateway API key." });
    return null;
  }
  return gatewayKey;
}

function errorResponse(
  res,
  {
    message,
    code,
    param = null,
    statusCode = 400,
    headers = {},
  },
) {
  return res.status(statusCode).set(headers).json({
    error: {
      message,
      type: "invalid_request_error",
      param,
      code,
    },
  });
}

function openaiCompletionPayload({
  requestId,
  publicModelName,
  content,
  thinking,
  usage,
}) {
  const message = { role: "assistant", content };
  if (thinking) {
    message.reasoning_content = thinking;
    message.thinking = thinking;
  }
  return {
    id: requestId,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: publicModelName,
    choices: [{ index: 0, message, finish_reason: "stop" }],
    usage,
  };
}

function openaiChunkPayload({
  requestId,
  publicModelName,
  delta,
  finishReason = null,
}) {
  return JSON.stringify({
    id: requestId,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: publicModelName,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  });
}

function sseData(payload) {
  return `data: ${payload}\n\n`;
}

function sseComment(comment) {
  return `: ${comment}\n\n`;
}

function sseErrorEvent(requestId, message, code = "upstream_error") {
  return (
    "event: error\n" +
    `data: ${JSON.stringify({ request_id: requestId, error: { message, code } })}\n\n`
  );
}

function previewText(text) {
  if (!text) return "";
  return String(text)
    .replace(/\s+/g, " ")
    .slice(0, settings.debugStreamPayloadPreviewChars);
}

function stringifyPayload(payload) {
  try {
    return JSON.stringify(payload);
  } catch (error) {
    return JSON.stringify({
      message: "Failed to serialize stream debug payload.",
      error: formatErrorForLog(error, { includeStack: false }),
    });
  }
}

function logStreamDebug(level, event, payload = {}) {
  if (!settings.debugRuntime) return;
  const writer =
    level === "error" ? console.error : level === "warn" ? console.warn : console.info;
  writer("stream-debug %s %s", event, stringifyPayload(payload));
}

function parseChatRequest(body) {
  if (!body || typeof body !== "object") {
    throw new Error("Request body must be a JSON object.");
  }
  if (typeof body.model !== "string" || !body.model.trim()) {
    throw new Error("model is required.");
  }
  const normalizedMessages = normalizeMessages(body.messages);
  const rawTools = body.tools;
  const normalizedTools = rawTools ? normalizeTools(rawTools) : [];
  const tools = normalizedTools.length ? normalizedTools : null;
  return {
    model: body.model.trim(),
    messages: normalizedMessages,
    tools,
    stream: Boolean(body.stream),
  };
}

function openaiToolCallPayload({ requestId, publicModelName, toolCallId, toolName, toolInput, usage }) {
  return {
    id: requestId,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: publicModelName,
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        content: null,
        tool_calls: [{
          id: toolCallId,
          type: "function",
          function: {
            name: toolName,
            arguments: JSON.stringify(toolInput),
          },
        }],
      },
      finish_reason: "tool_calls",
    }],
    usage,
  };
}

function deploymentHeaders(deployment) {
  return {
    "x-upstream-agent-id": deployment.agent_id,
  };
}

app.get("/", (_req, res) => {
  res.redirect("/admin");
});

app.get("/healthz", (_req, res) => {
  res.json({ status: "ok" });
});

app.get(["/admin", "/admin/"], (_req, res) => {
  const indexPath = path.join(adminStaticDir, "index.html");
  res.sendFile(indexPath, (error) => {
    if (!error) return;
    res.status(404).send("Admin frontend not built yet.");
  });
});

app.post("/admin-api/login", (req, res) => {
  if (!verifyAdminCredentials(settings, req.body?.username, req.body?.password)) {
    return res.status(401).json({ detail: "Invalid credentials." });
  }
  res.cookie(
    settings.adminCookieName,
    makeAdminSession(settings, req.body.username),
    {
      httpOnly: true,
      sameSite: "lax",
      maxAge: settings.adminCookieTtlSeconds * 1000,
      path: "/",
    },
  );
  return res.json({ ok: true });
});

app.post("/admin-api/logout", (_req, res) => {
  res.clearCookie(settings.adminCookieName, { path: "/" });
  res.json({ ok: true });
});

app.get("/admin-api/bootstrap", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  res.json(await getBootstrapData(db));
});

app.get("/admin-api/request-logs", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  res.json(
    await listRequestLogsPage(db, {
      page: req.query.page,
      pageSize: req.query.page_size,
    }),
  );
});

app.post("/admin-api/upstream-keys", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const item = await createUpstreamKey(db, req.body || {});
    res.json({ upstream_key: serializeUpstreamKey(item, []) });
  } catch (error) {
    res.status(400).json({ detail: String(error.message || error) });
  }
});

app.patch("/admin-api/upstream-keys/:upstreamKeyId", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const item = await updateUpstreamKey(db, Number(req.params.upstreamKeyId), req.body || {});
    res.json({
      upstream_key: serializeUpstreamKey(item, await listDeploymentsForKey(item.id)),
    });
  } catch (error) {
    res.status(400).json({ detail: String(error.message || error) });
  }
});

app.post("/admin-api/upstream-keys/:upstreamKeyId/verify", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const result = await verifyUpstreamKey(db, Number(req.params.upstreamKeyId));
    const item = await db
      .prepare("SELECT * FROM upstream_keys WHERE id = ?")
      .get(Number(req.params.upstreamKeyId));
    res.json({ result, upstream_key: serializeUpstreamKey(item, await listDeploymentsForKey(item.id)) });
  } catch (error) {
    res.status(502).json({ detail: String(error.message || error) });
  }
});

app.get("/admin-api/model-catalog", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const upstreamKeyId = req.query.upstream_key_id ? Number(req.query.upstream_key_id) : null;
  const sourceKey = await pickCatalogSourceKey(db, upstreamKeyId);
  if (!sourceKey) {
    return res.status(404).json({ detail: "No enabled upstream key is available." });
  }
  try {
    let cache = await findModelCatalogCache(db, {
      project: sourceKey.project,
      region: sourceKey.region,
      modelSubset: "AGENT",
    });
    if (!cache) {
      cache = await refreshModelCatalog(db, sourceKey);
    }
    res.json({
      catalog: serializeModelCatalog(cache),
      source_upstream_key: serializeUpstreamKey(sourceKey, await listDeploymentsForKey(sourceKey.id)),
    });
  } catch (error) {
    res.status(502).json({ detail: String(error.message || error) });
  }
});

app.post("/admin-api/model-catalog/refresh", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const upstreamKeyId = req.query.upstream_key_id ? Number(req.query.upstream_key_id) : null;
  const sourceKey = await pickCatalogSourceKey(db, upstreamKeyId);
  if (!sourceKey) {
    return res.status(404).json({ detail: "No enabled upstream key is available." });
  }
  try {
    const cache = await refreshModelCatalog(db, sourceKey);
    res.json({
      catalog: serializeModelCatalog(cache),
      source_upstream_key: serializeUpstreamKey(sourceKey, await listDeploymentsForKey(sourceKey.id)),
    });
  } catch (error) {
    const cache = await findModelCatalogCache(db, {
      project: sourceKey.project,
      region: sourceKey.region,
      modelSubset: "AGENT",
    });
    if (!cache) {
      return res.status(502).json({ detail: String(error.message || error) });
    }
    res.json({
      catalog: serializeModelCatalog(cache),
      source_upstream_key: serializeUpstreamKey(sourceKey, await listDeploymentsForKey(sourceKey.id)),
      warning: String(error.message || error),
    });
  }
});

app.get("/admin-api/upstream-keys/:upstreamKeyId/deployments", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const upstreamKeyId = Number(req.params.upstreamKeyId);
  const upstreamKey = await db.prepare("SELECT * FROM upstream_keys WHERE id = ?").get(upstreamKeyId);
  if (!upstreamKey) {
    return res.status(404).json({ detail: "Upstream key not found." });
  }
  res.json({
    deployments: (await listDeploymentsForKey(upstreamKeyId)).map(serializeDeployment),
  });
});

app.post("/admin-api/upstream-keys/:upstreamKeyId/deployments", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const deployment = await createDeployment(
      db,
      Number(req.params.upstreamKeyId),
      req.body || {},
    );
    res.json({ deployment: serializeDeployment(deployment) });
  } catch (error) {
    res.status(400).json({ detail: String(error.message || error) });
  }
});

app.post("/admin-api/upstream-keys/:upstreamKeyId/deployments/batch", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const result = await createDeploymentsBatch(
      db,
      Number(req.params.upstreamKeyId),
      req.body?.upstream_models || [],
    );
    res.json(result);
  } catch (error) {
    res.status(400).json({ detail: String(error.message || error) });
  }
});

app.patch("/admin-api/upstream-keys/:upstreamKeyId/deployments/:deploymentId", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const deployment = await updateDeployment(
      db,
      Number(req.params.upstreamKeyId),
      Number(req.params.deploymentId),
      req.body || {},
    );
    res.json({ deployment: serializeDeployment(deployment) });
  } catch (error) {
    res.status(400).json({ detail: String(error.message || error) });
  }
});

app.delete("/admin-api/upstream-keys/:upstreamKeyId/deployments/:deploymentId", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const result = await deleteDeployment(
      db,
      Number(req.params.upstreamKeyId),
      Number(req.params.deploymentId),
    );
    res.json(result);
  } catch (error) {
    res.status(404).json({ detail: String(error.message || error) });
  }
});

app.post("/admin-api/upstream-keys/:upstreamKeyId/deployments/sync", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const result = await syncDeploymentsToKeys(
      db,
      Number(req.params.upstreamKeyId),
      req.body || {},
    );
    res.json(result);
  } catch (error) {
    res.status(400).json({ detail: String(error.message || error) });
  }
});

app.get("/admin-api/upstream-keys/:upstreamKeyId/agents", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const agents = await fetchUpstreamAgents(db, Number(req.params.upstreamKeyId));
    res.json({ agents });
  } catch (error) {
    res.status(502).json({ detail: String(error.message || error) });
  }
});

app.post("/admin-api/upstream-keys/:upstreamKeyId/agents/delete", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  if (!Array.isArray(req.body?.agent_ids) || !req.body.agent_ids.length) {
    return res.status(400).json({ detail: "No agent IDs were provided." });
  }
  try {
    const result = await deleteUpstreamAgents(
      db,
      Number(req.params.upstreamKeyId),
      req.body.agent_ids,
    );
    res.json(result);
  } catch (error) {
    res.status(400).json({ detail: String(error.message || error) });
  }
});

app.delete("/admin-api/upstream-keys/:upstreamKeyId", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const result = await deleteUpstreamKey(db, Number(req.params.upstreamKeyId));
    res.json(result);
  } catch (error) {
    res.status(404).json({ detail: String(error.message || error) });
  }
});

app.post("/admin-api/gateway-keys", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const result = await createGatewayApiKey(db, req.body || {});
    res.json({
      gateway_key: serializeGatewayKey(result.gatewayKey),
      raw_key: result.rawKey,
    });
  } catch (error) {
    res.status(400).json({ detail: String(error.message || error) });
  }
});

app.delete("/admin-api/gateway-keys/:gatewayKeyId", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const result = await deleteGatewayApiKey(db, Number(req.params.gatewayKeyId));
    res.json(result);
  } catch (error) {
    res.status(404).json({ detail: String(error.message || error) });
  }
});

app.get("/v1/models", async (req, res) => {
  if (!(await requireGatewayKey(req, res))) return;
  const rows = await db
    .prepare(
      `
        SELECT public_model_name, display_name
        FROM model_deployments d
        JOIN upstream_keys u ON u.id = d.upstream_key_id
        WHERE d.enabled = 1
          AND d.status = 'active'
          AND u.enabled = 1
        GROUP BY public_model_name, display_name
        ORDER BY public_model_name COLLATE NOCASE ASC
      `,
    )
    .all();

  res.json({
    object: "list",
    data: rows.map((row) => ({
      id: row.public_model_name,
      object: "model",
      owned_by: settings.appName,
      display_name: row.display_name,
    })),
  });
});

app.post("/v1/chat/completions", async (req, res) => {
  const gatewayKey = await requireGatewayKey(req, res);
  if (!gatewayKey) return;

  let chatRequest;
  try {
    chatRequest = parseChatRequest(req.body);
  } catch (error) {
    return errorResponse(res, {
      message: String(error.message || error),
      code: "invalid_messages",
    });
  }

  const deployment = await selectDeploymentForModel(db, chatRequest.model);
  if (!deployment) {
    return errorResponse(res, {
      message: `No active deployment is available for model '${chatRequest.model}'.`,
      code: "model_not_available",
      param: "model",
      statusCode: 503,
    });
  }

  const material = {
    project: deployment.project,
    region: deployment.region,
    apiKey: deployment.api_key,
  };

  // Resolve any image attachments (upload base64 → Relevance AI temp storage)
  let resolvedMessages = chatRequest.messages;
  let imageAttachments = [];
  try {
    const resolved = await resolveImageAttachments(chatRequest.messages, material);
    resolvedMessages = resolved.messages;
    imageAttachments = resolved.attachments;
  } catch (error) {
    return errorResponse(res, {
      message: `Failed to process image attachments: ${error.message || error}`,
      code: "invalid_request",
    });
  }

  const prompt = buildPrompt(resolvedMessages, { tools: chatRequest.tools });
  const requestId = await beginGatewayRequest(db, {
    deployment,
    gatewayKeyName: gatewayKey.name,
    stream: chatRequest.stream,
    prompt,
  });

  if (chatRequest.stream) {
    const abortController = new AbortController();
    const streamStartedAt = Date.now();
    let closed = false;
    let upstreamConversationId = null;
    const streamState = {
      sseChunkCount: 0,
      textChunkCount: 0,
      thinkingChunkCount: 0,
      heartbeatCount: 0,
      backpressureCount: 0,
      lastSseWriteAt: null,
      lastSseKind: null,
      lastSsePreview: "",
      lastUpstreamDeltaAt: null,
      lastUpstreamDeltaKind: null,
      lastUpstreamDeltaPreview: "",
      stallBucket: 0,
    };

    const writeSse = (kind, chunk, extra = {}) => {
      if (closed) return false;
      const ok = res.write(chunk);
      streamState.sseChunkCount += 1;
      streamState.lastSseWriteAt = Date.now();
      streamState.lastSseKind = kind;
      streamState.lastSsePreview = previewText(chunk);
      if (!ok) {
        streamState.backpressureCount += 1;
      }
      logStreamDebug(ok ? "info" : "warn", "sse_write", {
        request_id: requestId,
        conversation_id: upstreamConversationId,
        kind,
        chars: chunk.length,
        ok,
        elapsed_ms: Date.now() - streamStartedAt,
        total_sse_chunks: streamState.sseChunkCount,
        backpressure_count: streamState.backpressureCount,
        socket_buffer_size: res.socket?.bufferSize ?? null,
        socket_bytes_written: res.socket?.bytesWritten ?? null,
        preview: settings.debugStreamPayloads ? previewText(chunk) : null,
        ...extra,
      });
      return ok;
    };

    const markUpstreamDelta = (kind, delta) => {
      streamState.lastUpstreamDeltaAt = Date.now();
      streamState.lastUpstreamDeltaKind = kind;
      streamState.lastUpstreamDeltaPreview = previewText(delta);
      if (kind === "thinking") {
        streamState.thinkingChunkCount += 1;
      }
      if (kind === "text") {
        streamState.textChunkCount += 1;
      }
      logStreamDebug("info", "upstream_delta", {
        request_id: requestId,
        conversation_id: upstreamConversationId,
        kind,
        chars: delta.length,
        elapsed_ms: Date.now() - streamStartedAt,
        thinking_chunk_count: streamState.thinkingChunkCount,
        text_chunk_count: streamState.textChunkCount,
        preview: settings.debugStreamPayloads ? previewText(delta) : null,
      });
    };

    const watchdogHandle = settings.debugRuntime
      ? setInterval(() => {
          if (closed) return;
          const thresholdMs = settings.debugStreamStallWarningSeconds * 1000;
          const now = Date.now();
          const upstreamIdleMs = streamState.lastUpstreamDeltaAt
            ? now - streamState.lastUpstreamDeltaAt
            : now - streamStartedAt;
          const sseIdleMs = streamState.lastSseWriteAt
            ? now - streamState.lastSseWriteAt
            : now - streamStartedAt;
          const bucket = Math.floor(Math.max(upstreamIdleMs, sseIdleMs) / thresholdMs);
          if (bucket <= 0 || bucket <= streamState.stallBucket) return;
          streamState.stallBucket = bucket;
          logStreamDebug("warn", "stream_stall_watchdog", {
            request_id: requestId,
            conversation_id: upstreamConversationId,
            elapsed_ms: now - streamStartedAt,
            upstream_idle_ms: upstreamIdleMs,
            sse_idle_ms: sseIdleMs,
            last_upstream_delta_kind: streamState.lastUpstreamDeltaKind,
            last_sse_kind: streamState.lastSseKind,
            sse_chunk_count: streamState.sseChunkCount,
            text_chunk_count: streamState.textChunkCount,
            thinking_chunk_count: streamState.thinkingChunkCount,
            heartbeat_count: streamState.heartbeatCount,
            backpressure_count: streamState.backpressureCount,
            last_upstream_delta_preview: settings.debugStreamPayloads
              ? streamState.lastUpstreamDeltaPreview
              : null,
            last_sse_preview: settings.debugStreamPayloads ? streamState.lastSsePreview : null,
          });
        }, settings.debugStreamWatchdogIntervalSeconds * 1000)
      : null;

    res.on("drain", () => {
      logStreamDebug("info", "sse_drain", {
        request_id: requestId,
        conversation_id: upstreamConversationId,
        elapsed_ms: Date.now() - streamStartedAt,
        socket_buffer_size: res.socket?.bufferSize ?? null,
        socket_bytes_written: res.socket?.bytesWritten ?? null,
        total_sse_chunks: streamState.sseChunkCount,
        backpressure_count: streamState.backpressureCount,
      });
    });

    req.on("aborted", () => {
      if (closed) return;
      closed = true;
      if (watchdogHandle) clearInterval(watchdogHandle);
      console.warn(
        "stream request aborted by client request_id=%s conversation_id=%s headers_sent=%s writable_ended=%s",
        requestId,
        upstreamConversationId,
        res.headersSent,
        res.writableEnded,
      );
      abortController.abort();
    });

    res.on("close", () => {
      const writableEnded = res.writableEnded || res.finished;
      console.info(
        "stream response closed request_id=%s conversation_id=%s headers_sent=%s writable_ended=%s",
        requestId,
        upstreamConversationId,
        res.headersSent,
        writableEnded,
      );
      if (closed) return;
      closed = true;
      if (watchdogHandle) clearInterval(watchdogHandle);
      if (!writableEnded) {
        abortController.abort();
      }
    });

    // When tools are present we buffer all output — we must see the full response
    // before knowing whether the agent is making a tool call.
    const hasTool = Boolean(chatRequest.tools && chatRequest.tools.length);
    const toolNames = hasTool ? chatRequest.tools.map((t) => t.name) : null;

    res.set({
      ...deploymentHeaders(deployment),
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Content-Type": "text/event-stream; charset=utf-8",
      "x-gateway-mode": hasTool ? "agent-sdk-stream-buffered" : "agent-sdk-stream",
      "x-gateway-request-id": requestId,
    });
    res.flushHeaders?.();

    // Only emit the opening role chunk immediately when NOT buffering for tools.
    // When tools are present we'll emit everything after the full response is known.
    if (!hasTool) {
      writeSse(
        "assistant_role",
        sseData(
          openaiChunkPayload({
            requestId,
            publicModelName: deployment.public_model_name,
            delta: { role: "assistant" },
          }),
        ),
      );
    }

    await markRequestStreaming(db, requestId);

    const heartbeat = setInterval(() => {
      if (!closed) {
        streamState.heartbeatCount += 1;
        writeSse("heartbeat", sseComment("keep-alive"));
      }
    }, settings.streamHeartbeatIntervalSeconds * 1000);

    try {
      const result = await runAgentTask({
        requestId,
        material,
        agentId: deployment.agent_id,
        prompt,
        attachments: imageAttachments,
        timeoutSeconds: settings.upstreamPollTimeoutSeconds,
        abortSignal: abortController.signal,
        onTaskCreated: (conversationId) => {
          upstreamConversationId = conversationId;
          void markRequestStreaming(db, requestId, conversationId);
        },
        // When tools are present, suppress progressive streaming so we can inspect
        // the full response for tool-call JSON before emitting anything.
        onThinking: hasTool ? null : (delta) => {
          if (closed || !delta) return;
          markUpstreamDelta("thinking", delta);
          writeSse(
            "thinking_delta",
            sseData(
              openaiChunkPayload({
                requestId,
                publicModelName: deployment.public_model_name,
                delta: { reasoning_content: delta, thinking: delta },
              }),
            ),
            { delta_chars: delta.length },
          );
        },
        onText: hasTool ? null : (delta) => {
          if (closed || !delta) return;
          markUpstreamDelta("text", delta);
          writeSse(
            "content_delta",
            sseData(
              openaiChunkPayload({
                requestId,
                publicModelName: deployment.public_model_name,
                delta: { content: delta },
              }),
            ),
            { delta_chars: delta.length },
          );
        },
      });

      clearInterval(heartbeat);
      if (watchdogHandle) clearInterval(watchdogHandle);
      await completeGatewayRequest(db, {
        requestId,
        deploymentId: deployment.id,
        conversationId: result.conversationId || upstreamConversationId,
        usage: result.usage,
        latencyMs: result.latencyMs,
        firstTokenMs: result.firstTokenMs,
        cost: result.cost,
        creditsUsed: result.creditsUsed,
        transport: result.transport,
        content: result.content,
        thinking: result.thinking,
        emittedContentChars: result.emittedContentChars,
        emittedThinkingChars: result.emittedThinkingChars,
      });

      console.info(
        "stream request completed request_id=%s conversation_id=%s latency_ms=%s prompt_tokens=%s completion_tokens=%s cost=%s emitted_content_chars=%s emitted_thinking_chars=%s transport=%s fallback_used=%s fallback_reason=%s final_tail_content_chars=%s final_tail_thinking_chars=%s final_content_chars=%s final_thinking_chars=%s remaining_fallback_content_chars=%s remaining_fallback_thinking_chars=%s",
        requestId,
        result.conversationId || upstreamConversationId,
        result.latencyMs,
        result.usage.prompt_tokens,
        result.usage.completion_tokens,
        result.cost,
        result.emittedContentChars,
        result.emittedThinkingChars,
        result.transport,
        result.fallbackUsed,
        result.fallbackReason,
        result.finalTailContentChars,
        result.finalTailThinkingChars,
        result.finalContentChars,
        result.finalThinkingChars,
        result.remainingFallbackContentChars,
        result.remainingFallbackThinkingChars,
      );

      if (!closed) {
        if (hasTool) {
          // Emit all buffered content now that we know the full response
          const toolCall = detectToolCall(result.content, toolNames);
          if (toolCall) {
            const toolCallId = generateToolUseId();
            // 1. role chunk
            writeSse("assistant_role", sseData(openaiChunkPayload({
              requestId,
              publicModelName: deployment.public_model_name,
              delta: { role: "assistant", content: null },
            })));
            // 2. tool_call identity chunk
            writeSse("tool_call_init", sseData(openaiChunkPayload({
              requestId,
              publicModelName: deployment.public_model_name,
              delta: {
                tool_calls: [{
                  index: 0,
                  id: toolCallId,
                  type: "function",
                  function: { name: toolCall.name, arguments: "" },
                }],
              },
            })));
            // 3. arguments chunk
            writeSse("tool_call_args", sseData(openaiChunkPayload({
              requestId,
              publicModelName: deployment.public_model_name,
              delta: {
                tool_calls: [{ index: 0, function: { arguments: JSON.stringify(toolCall.input) } }],
              },
            })));
            // 4. finish
            writeSse("finish_chunk", sseData(openaiChunkPayload({
              requestId,
              publicModelName: deployment.public_model_name,
              delta: {},
              finishReason: "tool_calls",
            })));
          } else {
            // No tool call — emit the buffered text as a single stream of chunks
            writeSse("assistant_role", sseData(openaiChunkPayload({
              requestId,
              publicModelName: deployment.public_model_name,
              delta: { role: "assistant" },
            })));
            if (result.thinking) {
              writeSse("thinking_delta", sseData(openaiChunkPayload({
                requestId,
                publicModelName: deployment.public_model_name,
                delta: { reasoning_content: result.thinking, thinking: result.thinking },
              })));
            }
            if (result.content) {
              writeSse("content_delta", sseData(openaiChunkPayload({
                requestId,
                publicModelName: deployment.public_model_name,
                delta: { content: result.content },
              })));
            }
            writeSse("finish_chunk", sseData(openaiChunkPayload({
              requestId,
              publicModelName: deployment.public_model_name,
              delta: {},
              finishReason: "stop",
            })));
          }
        } else {
          console.info(
            "stream request finishing request_id=%s conversation_id=%s remaining_fallback_content_chars=%s remaining_fallback_thinking_chars=%s final_content_chars=%s final_thinking_chars=%s",
            requestId,
            result.conversationId || upstreamConversationId,
            result.remainingFallbackContentChars,
            result.remainingFallbackThinkingChars,
            result.finalContentChars,
            result.finalThinkingChars,
          );
          writeSse(
            "finish_chunk",
            sseData(
              openaiChunkPayload({
                requestId,
                publicModelName: deployment.public_model_name,
                delta: {},
                finishReason: "stop",
              }),
            ),
          );
        }
        writeSse("done", "data: [DONE]\n\n");
        res.end();
      }
    } catch (error) {
      clearInterval(heartbeat);
      if (watchdogHandle) clearInterval(watchdogHandle);
      await failGatewayRequest(db, {
        requestId,
        deploymentId: deployment.id,
        conversationId: upstreamConversationId,
        transport: "sdk-task-runtime",
        errorMessage: String(error.message || error),
      });
      console.error(
        "stream request failed request_id=%s conversation_id=%s error=%s",
        requestId,
        upstreamConversationId,
        formatErrorForLog(error),
      );
      if (!closed) {
        writeSse("error_event", sseErrorEvent(requestId, String(error.message || error)));
        writeSse("done", "data: [DONE]\n\n");
        res.end();
      }
    }
    return;
  }

  const hasTool = Boolean(chatRequest.tools && chatRequest.tools.length);
  const toolNames = hasTool ? chatRequest.tools.map((t) => t.name) : null;
  let upstreamConversationId = null;
  try {
    const result = await runAgentTask({
      requestId,
      material,
      agentId: deployment.agent_id,
      prompt,
      attachments: imageAttachments,
      timeoutSeconds: settings.upstreamPollTimeoutSeconds,
      onTaskCreated: (conversationId) => {
        upstreamConversationId = conversationId;
      },
    });

    await completeGatewayRequest(db, {
      requestId,
      deploymentId: deployment.id,
      conversationId: result.conversationId || upstreamConversationId,
      usage: result.usage,
      latencyMs: result.latencyMs,
      firstTokenMs: result.firstTokenMs,
      cost: result.cost,
      creditsUsed: result.creditsUsed,
      transport: result.transport,
      content: result.content,
      thinking: result.thinking,
      emittedContentChars: result.emittedContentChars,
      emittedThinkingChars: result.emittedThinkingChars,
    });

    console.info(
      "request completed request_id=%s conversation_id=%s latency_ms=%s prompt_tokens=%s completion_tokens=%s cost=%s transport=%s fallback_used=%s fallback_reason=%s final_tail_content_chars=%s final_tail_thinking_chars=%s",
      requestId,
      result.conversationId || upstreamConversationId,
      result.latencyMs,
      result.usage.prompt_tokens,
      result.usage.completion_tokens,
      result.cost,
      result.transport,
      result.fallbackUsed,
      result.fallbackReason,
      result.finalTailContentChars,
      result.finalTailThinkingChars,
    );

    const responseHeaders = {
      ...deploymentHeaders(deployment),
      "x-gateway-mode": "agent-sdk-aggregated",
      "x-gateway-request-id": requestId,
      ...(result.conversationId ? { "x-upstream-conversation-id": result.conversationId } : {}),
    };

    // Detect tool call in the response when tools were provided
    if (hasTool) {
      const toolCall = detectToolCall(result.content, toolNames);
      if (toolCall) {
        const toolCallId = generateToolUseId();
        return res.set(responseHeaders).json(
          openaiToolCallPayload({
            requestId,
            publicModelName: deployment.public_model_name,
            toolCallId,
            toolName: toolCall.name,
            toolInput: toolCall.input,
            usage: result.usage,
          }),
        );
      }
    }

    return res.set(responseHeaders).json(
      openaiCompletionPayload({
        requestId,
        publicModelName: deployment.public_model_name,
        content: result.content,
        thinking: result.thinking,
        usage: result.usage,
      }),
    );
  } catch (error) {
    await failGatewayRequest(db, {
      requestId,
      deploymentId: deployment.id,
      conversationId: upstreamConversationId,
      transport: "sdk-task-runtime",
      errorMessage: String(error.message || error),
    });
    console.error(
      "request failed request_id=%s conversation_id=%s error=%s",
      requestId,
      upstreamConversationId,
      formatErrorForLog(error),
    );
    return errorResponse(res, {
      message: `Upstream request failed: ${error.message || error}`,
      code: "upstream_error",
      statusCode: 502,
      headers: deploymentHeaders(deployment),
    });
  }
});

// ---------------------------------------------------------------------------
// Anthropic Messages API  (/v1/messages)
// ---------------------------------------------------------------------------

app.post("/v1/messages", async (req, res) => {
  const gatewayKey = await requireGatewayKey(req, res);
  if (!gatewayKey) return;

  let anthropicReq;
  try {
    anthropicReq = parseAnthropicRequest(req.body);
  } catch (error) {
    return res.status(400).json({
      type: "error",
      error: { type: "invalid_request_error", message: String(error.message || error) },
    });
  }

  const deployment = await selectDeploymentForModel(db, anthropicReq.model);
  if (!deployment) {
    return res.status(503).json({
      type: "error",
      error: {
        type: "overloaded_error",
        message: `No active deployment is available for model '${anthropicReq.model}'.`,
      },
    });
  }

  const material = {
    project: deployment.project,
    region: deployment.region,
    apiKey: deployment.api_key,
  };

  // Resolve image attachments
  let resolvedMessages = anthropicReq.messages;
  let imageAttachments = [];
  try {
    const resolved = await resolveImageAttachments(anthropicReq.messages, material);
    resolvedMessages = resolved.messages;
    imageAttachments = resolved.attachments;
  } catch (error) {
    return res.status(400).json({
      type: "error",
      error: { type: "invalid_request_error", message: `Image processing failed: ${error.message || error}` },
    });
  }

  const prompt = buildPrompt(resolvedMessages, {
    tools: anthropicReq.tools,
    systemPrompt: anthropicReq.systemPrompt,
  });
  const requestId = await beginGatewayRequest(db, {
    deployment,
    gatewayKeyName: gatewayKey.name,
    stream: anthropicReq.stream,
    prompt,
  });

  const toolNames = anthropicReq.tools ? anthropicReq.tools.map((t) => t.name) : null;
  const hasTool = Boolean(toolNames && toolNames.length);

  // ------------------------------------------------------------------
  // Streaming path
  // ------------------------------------------------------------------
  if (anthropicReq.stream) {
    const abortController = new AbortController();
    let closed = false;
    let upstreamConversationId = null;

    req.on("aborted", () => {
      if (closed) return;
      closed = true;
      abortController.abort();
    });

    res.set({
      "x-upstream-agent-id": deployment.agent_id,
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Content-Type": "text/event-stream; charset=utf-8",
      "x-gateway-mode": hasTool ? "anthropic-stream-buffered" : "anthropic-stream",
      "x-gateway-request-id": requestId,
      "anthropic-version": "2023-06-01",
    });
    res.flushHeaders?.();

    await markRequestStreaming(db, requestId);

    const writer = createAnthropicStreamWriter(res, requestId, anthropicReq.model, 0);

    const heartbeat = setInterval(() => {
      if (!closed) writer.ping();
    }, settings.streamHeartbeatIntervalSeconds * 1000);

    // For progressive streaming (no tools), track open blocks
    let blockIndex = 0;
    let thinkingBlockHandle = null; // open thinking block
    let textBlockHandle = null;     // open text block

    try {
      const result = await runAgentTask({
        requestId,
        material,
        agentId: deployment.agent_id,
        prompt,
        attachments: imageAttachments,
        timeoutSeconds: settings.upstreamPollTimeoutSeconds,
        abortSignal: abortController.signal,
        onTaskCreated: (conversationId) => {
          upstreamConversationId = conversationId;
          void markRequestStreaming(db, requestId, conversationId);
        },
        onThinking: hasTool ? null : (delta) => {
          if (writer.closed() || !delta) return;
          if (!thinkingBlockHandle) {
            thinkingBlockHandle = writer.openThinkingBlock(blockIndex);
          }
          thinkingBlockHandle.delta(delta);
        },
        onText: hasTool ? null : (delta) => {
          if (writer.closed() || !delta) return;
          if (!textBlockHandle) {
            // Close thinking block before opening text block
            if (thinkingBlockHandle) {
              thinkingBlockHandle.close();
              thinkingBlockHandle = null;
              blockIndex++;
            }
            textBlockHandle = writer.openTextBlock(blockIndex);
          }
          textBlockHandle.delta(delta);
        },
      });

      clearInterval(heartbeat);

      await completeGatewayRequest(db, {
        requestId,
        deploymentId: deployment.id,
        conversationId: result.conversationId || upstreamConversationId,
        usage: result.usage,
        latencyMs: result.latencyMs,
        firstTokenMs: result.firstTokenMs,
        cost: result.cost,
        creditsUsed: result.creditsUsed,
        transport: result.transport,
        content: result.content,
        thinking: result.thinking,
        emittedContentChars: result.emittedContentChars,
        emittedThinkingChars: result.emittedThinkingChars,
      });

      if (!writer.closed()) {
        if (hasTool) {
          // Buffered mode — emit everything now that we have the full response
          const toolCall = detectToolCall(result.content, toolNames);
          let idx = 0;
          if (result.thinking) {
            writer.emitThinkingBlock(result.thinking, idx++);
          }
          if (toolCall) {
            const toolCallId = generateToolUseId();
            writer.emitToolUseBlock(toolCallId, toolCall.name, toolCall.input, idx++);
            writer.finish("tool_use", result.usage);
          } else {
            const tb = writer.openTextBlock(idx++);
            if (result.content) tb.delta(result.content);
            tb.close();
            writer.finish("end_turn", result.usage);
          }
        } else {
          // Progressive mode — close any open blocks and finish
          if (thinkingBlockHandle) {
            thinkingBlockHandle.close();
            thinkingBlockHandle = null;
            blockIndex++;
          }
          if (textBlockHandle) {
            textBlockHandle.close();
            textBlockHandle = null;
          } else {
            // Nothing was emitted — emit empty text block so the message is valid
            const tb = writer.openTextBlock(blockIndex);
            tb.close();
          }
          writer.finish("end_turn", result.usage);
        }
      }
    } catch (error) {
      clearInterval(heartbeat);
      await failGatewayRequest(db, {
        requestId,
        deploymentId: deployment.id,
        conversationId: upstreamConversationId,
        transport: "sdk-task-runtime",
        errorMessage: String(error.message || error),
      });
      console.error(
        "anthropic stream failed request_id=%s error=%s",
        requestId,
        formatErrorForLog(error),
      );
      if (!writer.closed()) {
        writer.error(String(error.message || error));
      }
    }
    return;
  }

  // ------------------------------------------------------------------
  // Non-streaming path
  // ------------------------------------------------------------------
  let upstreamConversationId = null;
  try {
    const result = await runAgentTask({
      requestId,
      material,
      agentId: deployment.agent_id,
      prompt,
      attachments: imageAttachments,
      timeoutSeconds: settings.upstreamPollTimeoutSeconds,
      onTaskCreated: (conversationId) => {
        upstreamConversationId = conversationId;
      },
    });

    await completeGatewayRequest(db, {
      requestId,
      deploymentId: deployment.id,
      conversationId: result.conversationId || upstreamConversationId,
      usage: result.usage,
      latencyMs: result.latencyMs,
      firstTokenMs: result.firstTokenMs,
      cost: result.cost,
      creditsUsed: result.creditsUsed,
      transport: result.transport,
      content: result.content,
      thinking: result.thinking,
      emittedContentChars: result.emittedContentChars,
      emittedThinkingChars: result.emittedThinkingChars,
    });

    console.info(
      "anthropic request completed request_id=%s conversation_id=%s latency_ms=%s",
      requestId,
      result.conversationId || upstreamConversationId,
      result.latencyMs,
    );

    const toolCall = hasTool ? detectToolCall(result.content, toolNames) : null;
    const toolCallId = toolCall ? generateToolUseId() : null;

    return res
      .set({
        "x-upstream-agent-id": deployment.agent_id,
        "x-gateway-request-id": requestId,
        "x-gateway-mode": "anthropic-aggregated",
        "anthropic-version": "2023-06-01",
      })
      .json(
        buildAnthropicResponse({
          requestId,
          model: anthropicReq.model,
          content: result.content,
          thinking: result.thinking,
          toolCall,
          toolCallId,
          usage: result.usage,
        }),
      );
  } catch (error) {
    await failGatewayRequest(db, {
      requestId,
      deploymentId: deployment.id,
      conversationId: upstreamConversationId,
      transport: "sdk-task-runtime",
      errorMessage: String(error.message || error),
    });
    console.error(
      "anthropic request failed request_id=%s error=%s",
      requestId,
      formatErrorForLog(error),
    );
    return res.status(502).json({
      type: "error",
      error: {
        type: "api_error",
        message: `Upstream request failed: ${error.message || error}`,
      },
    });
  }
});

async function listDeploymentsForKey(upstreamKeyId) {
  return await db
    .prepare(
      "SELECT * FROM model_deployments WHERE upstream_key_id = ? ORDER BY display_name COLLATE NOCASE ASC, id ASC",
    )
    .all(upstreamKeyId);
}

export default app;

if (!process.env.VERCEL) {
  app.listen(settings.port, settings.host, () => {
    console.info(
      "gateway listening on http://%s:%s using Node.js SDK runtime",
      settings.host,
      settings.port,
    );
    if (settings.debugRuntime) {
      console.info(
        "debug runtime enabled payloads=%s stall_warning_seconds=%s watchdog_interval_seconds=%s",
        settings.debugStreamPayloads,
        settings.debugStreamStallWarningSeconds,
        settings.debugStreamWatchdogIntervalSeconds,
      );
    }
  });
}
