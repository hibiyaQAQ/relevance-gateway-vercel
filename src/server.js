import path from "node:path";

import cookie from "cookie";
import express from "express";

import { adminStaticDir, settings, staticDir } from "./config.js";
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

const db = openDatabase(settings.databasePath);
const app = express();

app.use(express.json({ limit: "4mb" }));
app.use("/static", express.static(staticDir));

function requireAdmin(req, res) {
  const cookies = cookie.parse(req.headers.cookie || "");
  const username = parseAdminSession(settings, cookies[settings.adminCookieName]);
  if (!username) {
    res.status(401).json({ detail: "Admin login required." });
    return null;
  }
  return username;
}

function requireGatewayKey(req, res) {
  const rawKey = readBearerToken(req.headers.authorization);
  const gatewayKey = authenticateGatewayKey(db, rawKey);
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
  return {
    model: body.model.trim(),
    messages: normalizedMessages,
    stream: Boolean(body.stream),
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

app.get("/admin-api/bootstrap", (req, res) => {
  if (!requireAdmin(req, res)) return;
  res.json(getBootstrapData(db));
});

app.get("/admin-api/request-logs", (req, res) => {
  if (!requireAdmin(req, res)) return;
  res.json(
    listRequestLogsPage(db, {
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
      upstream_key: serializeUpstreamKey(item, listDeploymentsForKey(item.id)),
    });
  } catch (error) {
    res.status(400).json({ detail: String(error.message || error) });
  }
});

app.post("/admin-api/upstream-keys/:upstreamKeyId/verify", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const result = await verifyUpstreamKey(db, Number(req.params.upstreamKeyId));
    const item = db
      .prepare("SELECT * FROM upstream_keys WHERE id = ?")
      .get(Number(req.params.upstreamKeyId));
    res.json({ result, upstream_key: serializeUpstreamKey(item, listDeploymentsForKey(item.id)) });
  } catch (error) {
    res.status(502).json({ detail: String(error.message || error) });
  }
});

app.get("/admin-api/model-catalog", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const upstreamKeyId = req.query.upstream_key_id ? Number(req.query.upstream_key_id) : null;
  const sourceKey = pickCatalogSourceKey(db, upstreamKeyId);
  if (!sourceKey) {
    return res.status(404).json({ detail: "No enabled upstream key is available." });
  }
  try {
    let cache = findModelCatalogCache(db, {
      project: sourceKey.project,
      region: sourceKey.region,
      modelSubset: "AGENT",
    });
    if (!cache) {
      cache = await refreshModelCatalog(db, sourceKey);
    }
    res.json({
      catalog: serializeModelCatalog(cache),
      source_upstream_key: serializeUpstreamKey(sourceKey, listDeploymentsForKey(sourceKey.id)),
    });
  } catch (error) {
    res.status(502).json({ detail: String(error.message || error) });
  }
});

app.post("/admin-api/model-catalog/refresh", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const upstreamKeyId = req.query.upstream_key_id ? Number(req.query.upstream_key_id) : null;
  const sourceKey = pickCatalogSourceKey(db, upstreamKeyId);
  if (!sourceKey) {
    return res.status(404).json({ detail: "No enabled upstream key is available." });
  }
  try {
    const cache = await refreshModelCatalog(db, sourceKey);
    res.json({
      catalog: serializeModelCatalog(cache),
      source_upstream_key: serializeUpstreamKey(sourceKey, listDeploymentsForKey(sourceKey.id)),
    });
  } catch (error) {
    const cache = findModelCatalogCache(db, {
      project: sourceKey.project,
      region: sourceKey.region,
      modelSubset: "AGENT",
    });
    if (!cache) {
      return res.status(502).json({ detail: String(error.message || error) });
    }
    res.json({
      catalog: serializeModelCatalog(cache),
      source_upstream_key: serializeUpstreamKey(sourceKey, listDeploymentsForKey(sourceKey.id)),
      warning: String(error.message || error),
    });
  }
});

app.get("/admin-api/upstream-keys/:upstreamKeyId/deployments", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const upstreamKeyId = Number(req.params.upstreamKeyId);
  const upstreamKey = db.prepare("SELECT * FROM upstream_keys WHERE id = ?").get(upstreamKeyId);
  if (!upstreamKey) {
    return res.status(404).json({ detail: "Upstream key not found." });
  }
  res.json({
    deployments: listDeploymentsForKey(upstreamKeyId).map(serializeDeployment),
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

app.post("/admin-api/gateway-keys", (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const result = createGatewayApiKey(db, req.body || {});
    res.json({
      gateway_key: serializeGatewayKey(result.gatewayKey),
      raw_key: result.rawKey,
    });
  } catch (error) {
    res.status(400).json({ detail: String(error.message || error) });
  }
});

app.delete("/admin-api/gateway-keys/:gatewayKeyId", (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const result = deleteGatewayApiKey(db, Number(req.params.gatewayKeyId));
    res.json(result);
  } catch (error) {
    res.status(404).json({ detail: String(error.message || error) });
  }
});

app.get("/v1/models", (req, res) => {
  if (!requireGatewayKey(req, res)) return;
  const rows = db
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
  const gatewayKey = requireGatewayKey(req, res);
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

  const deployment = selectDeploymentForModel(db, chatRequest.model);
  if (!deployment) {
    return errorResponse(res, {
      message: `No active deployment is available for model '${chatRequest.model}'.`,
      code: "model_not_available",
      param: "model",
      statusCode: 503,
    });
  }

  const prompt = buildPrompt(chatRequest.messages);
  const requestId = beginGatewayRequest(db, {
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

    res.set({
      ...deploymentHeaders(deployment),
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Content-Type": "text/event-stream; charset=utf-8",
      "x-gateway-mode": "agent-sdk-stream",
      "x-gateway-request-id": requestId,
    });
    res.flushHeaders?.();
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

    markRequestStreaming(db, requestId);

    const heartbeat = setInterval(() => {
      if (!closed) {
        streamState.heartbeatCount += 1;
        writeSse("heartbeat", sseComment("keep-alive"));
      }
    }, settings.streamHeartbeatIntervalSeconds * 1000);

    try {
      const result = await runAgentTask({
        requestId,
        material: {
          project: deployment.project,
          region: deployment.region,
          apiKey: deployment.api_key,
        },
        agentId: deployment.agent_id,
        prompt,
        timeoutSeconds: settings.upstreamPollTimeoutSeconds,
        abortSignal: abortController.signal,
        onTaskCreated: (conversationId) => {
          upstreamConversationId = conversationId;
          markRequestStreaming(db, requestId, conversationId);
        },
        onThinking: (delta) => {
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
        onText: (delta) => {
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
      completeGatewayRequest(db, {
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
        writeSse("done", "data: [DONE]\n\n");
        res.end();
      }
    } catch (error) {
      clearInterval(heartbeat);
      if (watchdogHandle) clearInterval(watchdogHandle);
      failGatewayRequest(db, {
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

  let upstreamConversationId = null;
  try {
    const result = await runAgentTask({
      requestId,
      material: {
        project: deployment.project,
        region: deployment.region,
        apiKey: deployment.api_key,
      },
      agentId: deployment.agent_id,
      prompt,
      timeoutSeconds: settings.upstreamPollTimeoutSeconds,
      onTaskCreated: (conversationId) => {
        upstreamConversationId = conversationId;
      },
    });

    completeGatewayRequest(db, {
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

    return res
      .set({
        ...deploymentHeaders(deployment),
        "x-gateway-mode": "agent-sdk-aggregated",
        "x-gateway-request-id": requestId,
        ...(result.conversationId
          ? { "x-upstream-conversation-id": result.conversationId }
          : {}),
      })
      .json(
        openaiCompletionPayload({
          requestId,
          publicModelName: deployment.public_model_name,
          content: result.content,
          thinking: result.thinking,
          usage: result.usage,
        }),
      );
  } catch (error) {
    failGatewayRequest(db, {
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

function listDeploymentsForKey(upstreamKeyId) {
  return db
    .prepare(
      "SELECT * FROM model_deployments WHERE upstream_key_id = ? ORDER BY display_name COLLATE NOCASE ASC, id ASC",
    )
    .all(upstreamKeyId);
}

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
