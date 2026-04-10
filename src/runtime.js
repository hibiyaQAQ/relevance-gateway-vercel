import { Agent, Client, Key } from "@relevanceai/sdk";
import { setTimeout as delay } from "node:timers/promises";

import { settings } from "./config.js";
import {
  RelevanceError,
  RelevanceRestClient,
  extractAnswerAndUsage,
  extractCostAndCredits,
  extractTaskViewProgress,
} from "./relevance-rest.js";
import { classifyError, serializeError } from "./error-utils.js";

function nowLatencyMs(startedAt) {
  return Date.now() - startedAt;
}

function stringifyPayload(payload) {
  try {
    return JSON.stringify(payload);
  } catch (error) {
    return JSON.stringify({
      message: "Failed to serialize runtime log payload.",
      error: serializeError(error, { includeStack: false }),
    });
  }
}

function logRuntime(level, event, payload = {}) {
  const writer =
    level === "error" ? console.error : level === "warn" ? console.warn : console.info;
  writer("runtime %s %s", event, stringifyPayload(payload));
}

function logRuntimeDebug(level, event, payload = {}) {
  if (!settings.debugRuntime) return;
  const writer =
    level === "error" ? console.error : level === "warn" ? console.warn : console.info;
  writer("runtime-debug %s %s", event, stringifyPayload(payload));
}

function logLevelForClassification(classification) {
  return ["network", "timeout", "abort"].includes(classification) ? "warn" : "error";
}

function previewText(text) {
  if (!text) return "";
  return String(text)
    .replace(/\s+/g, " ")
    .slice(0, settings.debugStreamPayloadPreviewChars);
}

function agentTaskStateToStatus(state) {
  switch (state) {
    case "paused":
      return "paused";
    case "idle":
      return "idle";
    case "starting-up":
    case "waiting-for-capacity":
    case "queued-for-approval":
    case "queued-for-rerun":
      return "queued";
    case "running":
      return "running";
    case "pending-approval":
    case "escalated":
      return "action";
    case "timed-out":
    case "unrecoverable":
    case "errored-pending-approval":
      return "error";
    case "cancelled":
      return "cancelled";
    case "completed":
      return "completed";
    default:
      return null;
  }
}

function getAppendOnlySuffix(current, snapshot) {
  if (typeof snapshot !== "string" || !snapshot) return "";
  if (typeof current !== "string") return snapshot;
  if (snapshot.length <= current.length) return "";
  if (!snapshot.startsWith(current)) return null;
  return snapshot.slice(current.length);
}

class InstrumentedSdkClient extends Client {
  constructor(key, diagnostics = {}) {
    super(key);
    this.diagnostics = diagnostics;
  }

  async fetch(input, init) {
    const url = this.url(input);
    const startedAt = Date.now();
    const method = String(init?.method || "GET").toUpperCase();
    const body =
      typeof init?.body === "string"
        ? init.body
        : init?.body == null
          ? null
          : "[non-string body]";
    const reqInit = Object.assign({}, init, {
      headers: {
        ...this.key.fetchHeaders(),
        ...init?.headers,
      },
    });

    try {
      const response = await fetch(url, reqInit);
      const text = await response.text();
      let payload = {};
      if (text) {
        try {
          payload = JSON.parse(text);
        } catch {
          payload = text;
        }
      }

      if (!response.ok) {
        const error = new Error(response.statusText || `HTTP ${response.status}`);
        error.status = response.status;
        error.statusCode = response.status;
        error.responseBody =
          typeof payload === "string" ? payload.slice(0, 500) : JSON.stringify(payload).slice(0, 500);
        error.url = url.toString();
        error.method = method;
        this.diagnostics.onFetchError?.({
          url: url.toString(),
          method,
          status: response.status,
          latencyMs: nowLatencyMs(startedAt),
          hasBody: Boolean(body),
          bodyChars: body?.length || 0,
          responsePreview: error.responseBody,
          classification: "http",
          error,
        });
        throw error;
      }

      this.diagnostics.onFetchSuccess?.({
        url: url.toString(),
        method,
        status: response.status,
        latencyMs: nowLatencyMs(startedAt),
      });

      if (
        typeof payload === "object" &&
        payload &&
        typeof payload.conversation_id === "string" &&
        url.pathname === "/agents/trigger"
      ) {
        this.diagnostics.onConversationCreated?.(payload.conversation_id);
      }

      return payload;
    } catch (error) {
      if (error?.statusCode || error?.status) {
        throw error;
      }
      this.diagnostics.onFetchError?.({
        url: url.toString(),
        method,
        latencyMs: nowLatencyMs(startedAt),
        hasBody: Boolean(body),
        bodyChars: body?.length || 0,
        classification: classifyError(error),
        error,
      });
      throw error;
    }
  }
}

function createSdkClient(material, diagnostics) {
  return new InstrumentedSdkClient(
    new Key({
      key: material.apiKey,
      region: material.region,
      project: material.project,
    }),
    diagnostics,
  );
}

function isTerminalStatus(status) {
  return ["idle", "completed", "cancelled", "error", "action"].includes(status);
}

function emitTaskCreated(taskId, state, onTaskCreated) {
  if (!taskId || state.emittedTaskId === taskId) return;
  state.emittedTaskId = taskId;
  if (onTaskCreated) {
    onTaskCreated(taskId);
  }
}

function snapshotSdkTaskMetadata(task, fallback = null) {
  const baseTime = new Date();
  return {
    id: task?.id || fallback?.id || "",
    region: task?.region || fallback?.region || "",
    project: task?.project || fallback?.project || "",
    name: task?.name || fallback?.name || "",
    status: task?.status || fallback?.status || "running",
    createdAt: task?.createdAt || fallback?.createdAt || baseTime,
    updatedAt: task?.updatedAt || fallback?.updatedAt || baseTime,
    streamingToken: fallback?.streamingToken,
  };
}

export async function runAgentTask({
  requestId,
  material,
  agentId,
  prompt,
  timeoutSeconds,
  abortSignal,
  onTaskCreated,
  onThinking,
  onText,
}) {
  const restClient = new RelevanceRestClient(material, timeoutSeconds);
  const pollClient = new RelevanceRestClient(material, Math.min(timeoutSeconds, 10));
  const taskState = { emittedTaskId: null };
  const sdkClient = createSdkClient(material, {
    onConversationCreated: (conversationId) => {
      emitTaskCreated(conversationId, taskState, onTaskCreated);
      logRuntime("info", "sdk_trigger_accepted", {
        request_id: requestId,
        agent_id: agentId,
        conversation_id: conversationId,
      });
    },
    onFetchError: (event) => {
      logRuntime(logLevelForClassification(event.classification), "sdk_fetch_failed", {
        request_id: requestId,
        agent_id: agentId,
        conversation_id: taskState.emittedTaskId,
        classification: event.classification,
        method: event.method,
        url: event.url,
        status: event.status || null,
        latency_ms: event.latencyMs,
        request_body_chars: event.bodyChars,
        response_preview: event.responsePreview || null,
        error: serializeError(event.error),
      });
    },
  });

  logRuntime("info", "run_agent_task_started", {
    request_id: requestId,
    agent_id: agentId,
    region: material.region,
    project: material.project,
    prompt_chars: prompt.length,
    timeout_seconds: timeoutSeconds,
    stream_abort_supported: Boolean(abortSignal),
  });

  const agentLookupStartedAt = Date.now();
  let agent;
  try {
    agent = await Agent.get(agentId, sdkClient);
    logRuntime("info", "agent_lookup_completed", {
      request_id: requestId,
      agent_id: agentId,
      latency_ms: nowLatencyMs(agentLookupStartedAt),
    });
  } catch (error) {
    logRuntime(logLevelForClassification(classifyError(error)), "agent_lookup_failed", {
      request_id: requestId,
      agent_id: agentId,
      latency_ms: nowLatencyMs(agentLookupStartedAt),
      classification: classifyError(error),
      error: serializeError(error),
    });
    throw error;
  }

  const sendMessageStartedAt = Date.now();
  let task;
  try {
    task = await agent.sendMessage(prompt);
    emitTaskCreated(task.id, taskState, onTaskCreated);
    logRuntime("info", "send_message_completed", {
      request_id: requestId,
      agent_id: agentId,
      conversation_id: task.id,
      latency_ms: nowLatencyMs(sendMessageStartedAt),
    });
  } catch (error) {
    logRuntime(logLevelForClassification(classifyError(error)), "send_message_failed", {
      request_id: requestId,
      agent_id: agentId,
      conversation_id: taskState.emittedTaskId,
      latency_ms: nowLatencyMs(sendMessageStartedAt),
      classification: classifyError(error),
      error: serializeError(error),
    });
    throw error;
  }

  const startedAt = Date.now();
  let sdkStrategyMetadataCache = snapshotSdkTaskMetadata(task);
  let sdkSubscriptionClosed = false;

  if (task?.strategy) {
    const strategy = task.strategy;
    const originalGetMetadata = strategy.getMetadata.bind(strategy);
    const originalGetMessages = strategy.getMessages.bind(strategy);

    strategy.getMetadata = async (...args) => {
      try {
        const metadata = await originalGetMetadata(...args);
        sdkStrategyMetadataCache = metadata;
        return metadata;
      } catch (error) {
        logRuntime("warn", "sdk_metadata_error_suppressed", {
          request_id: requestId,
          agent_id: agentId,
          conversation_id: task.id,
          classification: classifyError(error),
          error: serializeError(error, { includeStack: false }),
        });
        return snapshotSdkTaskMetadata(task, sdkStrategyMetadataCache);
      }
    };

    strategy.getMessages = async (...args) => {
      try {
        return await originalGetMessages(...args);
      } catch (error) {
        logRuntime("warn", "sdk_messages_error_suppressed", {
          request_id: requestId,
          agent_id: agentId,
          conversation_id: task.id,
          classification: classifyError(error),
          error: serializeError(error, { includeStack: false }),
        });
        return [];
      }
    };
  }

  let emittedThinking = "";
  let emittedContent = "";
  let finalMessageText = "";
  let firstTokenMs = null;
  let settled = false;
  let finishing = false;
  let lastActivityAt = Date.now();
  let lastActivityType = "task_attached";
  let lastActivityPreview = "";
  let messageCount = 0;
  let updateCount = 0;
  let thinkingChunkCount = 0;
  let textChunkCount = 0;
  let lastSseProgressAt = Date.now();
  let metadataTaskStatus = null;
  let metadataTaskState = null;
  let viewFallbackActive = false;
  let viewFallbackReason = null;
  let metadataPollInFlight = false;
  let viewPollInFlight = false;
  let lastViewPollAt = 0;
  let fallbackDrainHandle = null;
  let fallbackQueuedText = "";
  let fallbackQueuedThinking = "";
  let finalTailContentChars = 0;
  let finalTailThinkingChars = 0;

  return await new Promise((resolve, reject) => {
    const closeSdkSubscription = (reason) => {
      if (sdkSubscriptionClosed) return;
      sdkSubscriptionClosed = true;
      try {
        task.unsubscribe();
        logRuntime("info", "sdk_subscription_closed", {
          request_id: requestId,
          agent_id: agentId,
          conversation_id: task.id,
          reason,
        });
      } catch (error) {
        logRuntime("warn", "sdk_subscription_close_failed", {
          request_id: requestId,
          agent_id: agentId,
          conversation_id: task.id,
          reason,
          classification: classifyError(error),
          error: serializeError(error, { includeStack: false }),
        });
      }
    };

    const cleanup = () => {
      closeSdkSubscription("cleanup");
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (finishPollHandle) clearInterval(finishPollHandle);
      if (metadataPollHandle) clearInterval(metadataPollHandle);
      if (fallbackDrainHandle) clearInterval(fallbackDrainHandle);
      if (debugWatchdogHandle) clearInterval(debugWatchdogHandle);
      if (abortSignal && abortHandler) {
        abortSignal.removeEventListener("abort", abortHandler);
      }
    };

    const fail = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };

    const maybeSetFirstToken = () => {
      if (firstTokenMs == null) {
        firstTokenMs = Date.now() - startedAt;
      }
    };

    const markActivity = (type, preview = "") => {
      lastActivityAt = Date.now();
      lastActivityType = type;
      lastActivityPreview = preview;
    };

    const currentTaskStatus = () => metadataTaskStatus || task.status;

    const emitThinkingDelta = (delta, source) => {
      if (!delta) return 0;
      maybeSetFirstToken();
      emittedThinking += delta;
      markActivity(`${source}:thinking`, previewText(delta));
      if (source === "sse") {
        lastSseProgressAt = Date.now();
      }
      if (onThinking) onThinking(delta);
      return delta.length;
    };

    const emitTextDelta = (delta, source) => {
      if (!delta) return 0;
      maybeSetFirstToken();
      emittedContent += delta;
      markActivity(`${source}:text`, previewText(delta));
      if (source === "sse") {
        lastSseProgressAt = Date.now();
      }
      if (onText) onText(delta);
      return delta.length;
    };

    const getFallbackQueue = (kind) =>
      kind === "text" ? fallbackQueuedText : fallbackQueuedThinking;

    const setFallbackQueue = (kind, value) => {
      if (kind === "text") {
        fallbackQueuedText = value;
      } else {
        fallbackQueuedThinking = value;
      }
    };

    const computeQueuedBaseline = (kind) =>
      (kind === "text" ? emittedContent : emittedThinking) + getFallbackQueue(kind);

    const computeDrainChunkSize = (queueLength) => {
      if (queueLength <= 0) return 0;
      const tickMs = Math.max(1, settings.streamFallbackSmoothChunkDelayMs);
      const pollWindowMs = Math.max(tickMs, settings.taskViewPollIntervalSeconds * 1000);
      const ticksPerWindow = Math.max(1, Math.round(pollWindowMs / tickMs));
      return Math.max(
        1,
        Math.min(
          settings.streamFallbackSmoothChunkChars,
          Math.ceil(queueLength / ticksPerWindow),
        ),
      );
    };

    const drainFallbackQueueKind = (kind) => {
      const queue = getFallbackQueue(kind);
      if (!queue) return 0;
      const chunkSize = computeDrainChunkSize(queue.length);
      const chunk = queue.slice(0, chunkSize);
      setFallbackQueue(kind, queue.slice(chunk.length));
      return kind === "text"
        ? emitTextDelta(chunk, "view-queue")
        : emitThinkingDelta(chunk, "view-queue");
    };

    const drainFallbackQueuesOnce = () => {
      if (settled) return { emittedContentChars: 0, emittedThinkingChars: 0 };
      let emittedThinkingChars = 0;
      let emittedContentChars = 0;

      // Treat fallback emission as a single ordered pipeline:
      // drain all reasoning first, then begin draining text.
      if (fallbackQueuedThinking) {
        emittedThinkingChars = drainFallbackQueueKind("thinking");
      } else if (fallbackQueuedText) {
        emittedContentChars = drainFallbackQueueKind("text");
      }

      if (!fallbackQueuedText && !fallbackQueuedThinking && fallbackDrainHandle) {
        clearInterval(fallbackDrainHandle);
        fallbackDrainHandle = null;
      }
      if (settings.debugRuntime && (emittedContentChars || emittedThinkingChars)) {
        logRuntimeDebug("info", "view_fallback_drain_tick", {
          request_id: requestId,
          agent_id: agentId,
          conversation_id: task.id,
          emitted_content_chars: emittedContentChars,
          emitted_thinking_chars: emittedThinkingChars,
          remaining_content_chars: fallbackQueuedText.length,
          remaining_thinking_chars: fallbackQueuedThinking.length,
        });
      }
      return { emittedContentChars, emittedThinkingChars };
    };

    const ensureFallbackDrainLoop = () => {
      if (fallbackDrainHandle || settled) return;
      const intervalMs = Math.max(1, settings.streamFallbackSmoothChunkDelayMs);
      fallbackDrainHandle = setInterval(() => {
        void drainFallbackQueuesOnce();
      }, intervalMs);
      void drainFallbackQueuesOnce();
    };

    const flushFallbackQueues = async () => {
      const intervalMs = Math.max(1, settings.streamFallbackSmoothChunkDelayMs);
      while ((fallbackQueuedText || fallbackQueuedThinking) && !settled) {
        drainFallbackQueuesOnce();
        if (fallbackQueuedText || fallbackQueuedThinking) {
          await delay(intervalMs);
        }
      }
    };

    const queueSnapshotDiff = (kind, snapshot, source) => {
      if (kind === "thinking" && emittedContent.length > 0) {
        const current = computeQueuedBaseline(kind);
        const suffix = getAppendOnlySuffix(current, snapshot);
        if (suffix == null) {
          logRuntime("warn", "snapshot_prefix_mismatch", {
            request_id: requestId,
            agent_id: agentId,
            conversation_id: task.id,
            kind,
            source,
            current_chars: current.length,
            snapshot_chars: typeof snapshot === "string" ? snapshot.length : 0,
          });
          return 0;
        }
        if (suffix) {
          logRuntime("warn", "thinking_after_text_ignored", {
            request_id: requestId,
            agent_id: agentId,
            conversation_id: task.id,
            source,
            ignored_chars: suffix.length,
            emitted_content_chars: emittedContent.length,
            emitted_thinking_chars: emittedThinking.length,
            queue_content_chars: fallbackQueuedText.length,
            queue_thinking_chars: fallbackQueuedThinking.length,
          });
        }
        return 0;
      }

      const current = computeQueuedBaseline(kind);
      const suffix = getAppendOnlySuffix(current, snapshot);
      if (suffix == null) {
        logRuntime("warn", "snapshot_prefix_mismatch", {
          request_id: requestId,
          agent_id: agentId,
          conversation_id: task.id,
          kind,
          source,
          current_chars: current.length,
          snapshot_chars: typeof snapshot === "string" ? snapshot.length : 0,
        });
        return 0;
      }
      if (!suffix) return 0;
      setFallbackQueue(kind, getFallbackQueue(kind) + suffix);
      ensureFallbackDrainLoop();
      logRuntime("info", "view_fallback_progress_buffered", {
        request_id: requestId,
        agent_id: agentId,
        conversation_id: task.id,
        kind,
        source,
        buffered_chars: suffix.length,
        queue_content_chars: fallbackQueuedText.length,
        queue_thinking_chars: fallbackQueuedThinking.length,
      });
      return suffix.length;
    };

    const maybeActivateViewFallback = () => {
      if (viewFallbackActive) return false;
      if (currentTaskStatus() !== "running") return false;
      const hasEmittedAnyToken = emittedThinking.length > 0 || emittedContent.length > 0;
      const silenceThresholdSeconds = hasEmittedAnyToken
        ? settings.streamFallbackSilenceSeconds
        : settings.streamFallbackInitialSilenceSeconds;
      const silenceMs = Date.now() - lastSseProgressAt;
      if (silenceMs < silenceThresholdSeconds * 1000) return false;
      viewFallbackActive = true;
      viewFallbackReason = "sse_silence";
      closeSdkSubscription("view_fallback");
      logRuntime("warn", "view_fallback_activated", {
        request_id: requestId,
        agent_id: agentId,
        conversation_id: task.id,
        phase: hasEmittedAnyToken ? "post-first-token" : "pre-first-token",
        silence_threshold_seconds: silenceThresholdSeconds,
        silence_ms: silenceMs,
        emitted_content_chars: emittedContent.length,
        emitted_thinking_chars: emittedThinking.length,
      });
      return true;
    };

    const pollTaskViewProgress = async () => {
      if (viewPollInFlight || settled) return;
      if (
        lastViewPollAt &&
        Date.now() - lastViewPollAt < settings.taskViewPollIntervalSeconds * 1000
      ) {
        return;
      }
      viewPollInFlight = true;
      lastViewPollAt = Date.now();
      try {
        const viewPayload = await pollClient.getTaskView(agentId, task.id);
        const progress = extractTaskViewProgress(viewPayload);
        const bufferedThinkingChars = queueSnapshotDiff("thinking", progress.thinking, "view");
        const bufferedContentChars = queueSnapshotDiff("text", progress.text, "view");
        if (bufferedThinkingChars || bufferedContentChars) {
          logRuntime("info", "view_fallback_progress_enqueued", {
            request_id: requestId,
            agent_id: agentId,
            conversation_id: task.id,
            buffered_content_chars: bufferedContentChars,
            buffered_thinking_chars: bufferedThinkingChars,
            queue_content_chars: fallbackQueuedText.length,
            queue_thinking_chars: fallbackQueuedThinking.length,
            delivered_content_chars: emittedContent.length,
            delivered_thinking_chars: emittedThinking.length,
          });
        }
      } catch (error) {
        logRuntime("warn", "view_fallback_poll_failed", {
          request_id: requestId,
          agent_id: agentId,
          conversation_id: task.id,
          classification: classifyError(error),
          error: serializeError(error, { includeStack: false }),
        });
      } finally {
        viewPollInFlight = false;
      }
    };

    const pollTaskMetadata = async () => {
      if (metadataPollInFlight || settled) return;
      metadataPollInFlight = true;
      try {
        const metadataPayload = await pollClient.getTaskMetadata(agentId, task.id);
        const nextState = metadataPayload?.metadata?.conversation?.state || null;
        const nextStatus = agentTaskStateToStatus(nextState);
        if (nextState && nextState !== metadataTaskState) {
          metadataTaskState = nextState;
          metadataTaskStatus = nextStatus;
          logRuntime("info", "task_metadata_status_changed", {
            request_id: requestId,
            agent_id: agentId,
            conversation_id: task.id,
            task_state: nextState,
            task_status: nextStatus,
          });
        } else if (nextStatus) {
          metadataTaskStatus = nextStatus;
        }

        if (isTerminalStatus(currentTaskStatus())) {
          void finish();
          return;
        }

        if (maybeActivateViewFallback() || viewFallbackActive) {
          await pollTaskViewProgress();
        }
      } catch (error) {
        logRuntime("warn", "task_metadata_poll_failed", {
          request_id: requestId,
          agent_id: agentId,
          conversation_id: task.id,
          classification: classifyError(error),
          error: serializeError(error, { includeStack: false }),
        });

        if (maybeActivateViewFallback() || viewFallbackActive) {
          await pollTaskViewProgress();
        }
      } finally {
        metadataPollInFlight = false;
      }
    };

    const finish = async () => {
      if (settled || finishing) return;
      if (!isTerminalStatus(currentTaskStatus())) return;
      finishing = true;

      try {
        const effectiveStatus = currentTaskStatus();
        if (effectiveStatus === "cancelled") {
          throw new RelevanceError(`Upstream task ${task.id} was cancelled.`);
        }
        if (effectiveStatus === "action") {
          throw new RelevanceError(`Upstream task ${task.id} requires human action.`);
        }
        if (effectiveStatus === "error") {
          throw new RelevanceError(`Upstream task ${task.id} failed.`);
        }

        let finalContent = finalMessageText || emittedContent;
        let finalThinking = emittedThinking;
        let usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
        let cost = null;
        let creditsUsed = null;

        try {
          const studioResult = await restClient.waitForConversationResult(
            agentId,
            task.id,
            Math.min(timeoutSeconds, 20),
          );
          const answerAndUsage = extractAnswerAndUsage(studioResult);
          const costAndCredits = extractCostAndCredits(studioResult);
          if (
            answerAndUsage.answer &&
            answerAndUsage.answer.length >= (finalContent || "").length
          ) {
            finalContent = answerAndUsage.answer;
          }
          usage = answerAndUsage.usage;
          cost = costAndCredits.cost;
          creditsUsed = costAndCredits.creditsUsed;
        } catch (error) {
          logRuntime("warn", "conversation_result_unavailable", {
            request_id: requestId,
            agent_id: agentId,
            conversation_id: task.id,
            latency_ms: nowLatencyMs(startedAt),
            classification: classifyError(error),
            error: serializeError(error, { includeStack: false }),
          });
          const viewPayload = await pollClient.getTaskView(agentId, task.id).catch(() => null);
          if (viewPayload) {
            const progress = extractTaskViewProgress(viewPayload);
            if (progress.text && progress.text.length >= (finalContent || "").length) {
              finalContent = progress.text;
            }
            if (progress.thinking && progress.thinking.length >= (finalThinking || "").length) {
              finalThinking = progress.thinking;
            }
          } else if (error) {
            throw error;
          }
        }

        if (onThinking) {
          finalTailThinkingChars = queueSnapshotDiff("thinking", finalThinking, "final");
        }
        if (onText) {
          finalTailContentChars = queueSnapshotDiff("text", finalContent, "final");
        }
        await flushFallbackQueues();
        const remainingFallbackContentChars = fallbackQueuedText.length;
        const remainingFallbackThinkingChars = fallbackQueuedThinking.length;

        settled = true;
        cleanup();
        logRuntime("info", "run_agent_task_completed", {
          request_id: requestId,
          agent_id: agentId,
          conversation_id: task.id,
          latency_ms: nowLatencyMs(startedAt),
          first_token_ms: firstTokenMs,
          emitted_content_chars: emittedContent.length,
          emitted_thinking_chars: emittedThinking.length,
          fallback_used: viewFallbackActive,
          fallback_reason: viewFallbackReason,
          final_tail_content_chars: finalTailContentChars,
          final_tail_thinking_chars: finalTailThinkingChars,
          final_content_chars: (finalContent || "").length,
          final_thinking_chars: (finalThinking || "").length,
          remaining_fallback_content_chars: remainingFallbackContentChars,
          remaining_fallback_thinking_chars: remainingFallbackThinkingChars,
        });
        resolve({
          conversationId: task.id,
          content: finalContent || "",
          thinking: finalThinking || "",
          usage,
          cost,
          creditsUsed,
          latencyMs: Date.now() - startedAt,
          firstTokenMs,
          transport: viewFallbackActive
            ? "sdk-task-runtime+view-fallback"
            : "sdk-task-runtime",
          emittedContentChars: emittedContent.length,
          emittedThinkingChars: emittedThinking.length,
          fallbackUsed: viewFallbackActive,
          fallbackReason: viewFallbackReason,
          finalTailContentChars,
          finalTailThinkingChars,
          finalContentChars: (finalContent || "").length,
          finalThinkingChars: (finalThinking || "").length,
          remainingFallbackContentChars,
          remainingFallbackThinkingChars,
        });
      } catch (error) {
        fail(error);
      }
    };

    const timeoutHandle = setTimeout(() => {
      fail(
        new RelevanceError(
          `Upstream task ${task.id} timed out after ${timeoutSeconds} seconds.`,
        ),
      );
    }, timeoutSeconds * 1000);

    const finishPollHandle = setInterval(() => {
      void finish();
    }, 500);

    const metadataPollHandle = setInterval(() => {
      void pollTaskMetadata();
    }, settings.taskMetadataPollIntervalSeconds * 1000);

    const debugWatchdogHandle = settings.debugRuntime
      ? setInterval(() => {
          if (settled || isTerminalStatus(currentTaskStatus())) return;
          const thresholdMs = settings.debugStreamStallWarningSeconds * 1000;
          const idleMs = Date.now() - lastActivityAt;
          if (idleMs < thresholdMs) return;
          const idleBuckets = Math.floor(idleMs / thresholdMs);
          const previousBuckets = Math.floor((idleMs - settings.debugStreamWatchdogIntervalSeconds * 1000) / thresholdMs);
          if (idleBuckets <= previousBuckets) return;
          logRuntimeDebug("warn", "task_stall_watchdog", {
            request_id: requestId,
            agent_id: agentId,
            conversation_id: task.id,
            task_status: task.status,
            idle_ms: idleMs,
            last_activity_type: lastActivityType,
            last_activity_preview: settings.debugStreamPayloads ? lastActivityPreview : null,
            emitted_content_chars: emittedContent.length,
            emitted_thinking_chars: emittedThinking.length,
            message_count: messageCount,
            update_count: updateCount,
            thinking_chunk_count: thinkingChunkCount,
            text_chunk_count: textChunkCount,
          });
        }, settings.debugStreamWatchdogIntervalSeconds * 1000)
      : null;

    const messageHandler = (event) => {
      const message = event.detail?.message;
      if (!message) return;
      const gapMs = Date.now() - lastActivityAt;
      messageCount += 1;

      if (typeof message.isThinking === "function" && message.isThinking()) {
        const delta = message.text || "";
        if (!delta) return;
        thinkingChunkCount += 1;
        logRuntimeDebug("info", "task_message", {
          request_id: requestId,
          agent_id: agentId,
          conversation_id: task.id,
          task_status: task.status,
          message_kind: "thinking",
          delta_chars: delta.length,
          cumulative_chars: emittedThinking.length,
          gap_since_previous_activity_ms: gapMs,
          preview: settings.debugStreamPayloads ? previewText(delta) : null,
        });
        if (!viewFallbackActive) {
          emitThinkingDelta(delta, "sse");
        }
        return;
      }

      if (typeof message.isTyping === "function" && message.isTyping()) {
        const delta = message.text || "";
        if (!delta) return;
        textChunkCount += 1;
        logRuntimeDebug("info", "task_message", {
          request_id: requestId,
          agent_id: agentId,
          conversation_id: task.id,
          task_status: task.status,
          message_kind: "text",
          delta_chars: delta.length,
          cumulative_chars: emittedContent.length,
          gap_since_previous_activity_ms: gapMs,
          preview: settings.debugStreamPayloads ? previewText(delta) : null,
        });
        if (!viewFallbackActive) {
          emitTextDelta(delta, "sse");
        }
        return;
      }

      if (
        typeof message.isAgent === "function" &&
        message.isAgent() &&
        typeof message.isThought === "function" &&
        typeof message.isGenerating === "function" &&
        !message.isThought() &&
        !message.isGenerating()
      ) {
        maybeSetFirstToken();
        finalMessageText = message.text || finalMessageText;
        markActivity("agent_final_message", previewText(finalMessageText));
        logRuntimeDebug("info", "task_message", {
          request_id: requestId,
          agent_id: agentId,
          conversation_id: task.id,
          task_status: task.status,
          message_kind: "agent_final",
          delta_chars: (message.text || "").length,
          cumulative_chars: finalMessageText.length,
          gap_since_previous_activity_ms: gapMs,
          preview: settings.debugStreamPayloads ? previewText(finalMessageText) : null,
        });
        return;
      }

      markActivity("message_other", previewText(message.text || ""));
      logRuntimeDebug("info", "task_message_other", {
        request_id: requestId,
        agent_id: agentId,
        conversation_id: task.id,
        task_status: task.status,
        gap_since_previous_activity_ms: gapMs,
        has_text: typeof message.text === "string" && message.text.length > 0,
        is_agent: typeof message.isAgent === "function" ? message.isAgent() : null,
        is_thinking: typeof message.isThinking === "function" ? message.isThinking() : null,
        is_typing: typeof message.isTyping === "function" ? message.isTyping() : null,
        is_generating:
          typeof message.isGenerating === "function" ? message.isGenerating() : null,
        is_thought: typeof message.isThought === "function" ? message.isThought() : null,
        preview:
          settings.debugStreamPayloads && typeof message.text === "string"
            ? previewText(message.text)
            : null,
      });
    };

    const errorHandler = (event) => {
      const detailMessage = event.detail?.message;
      const errorText =
        detailMessage?.lastError ||
        (Array.isArray(detailMessage?.errors) ? detailMessage.errors.join("; ") : null) ||
        `Upstream task ${task.id} failed.`;
      logRuntimeDebug("error", "task_error_event", {
        request_id: requestId,
        agent_id: agentId,
        conversation_id: task.id,
        task_status: task.status,
        detail: detailMessage || null,
      });
      fail(new RelevanceError(errorText));
    };

    const updateHandler = () => {
      const gapMs = Date.now() - lastActivityAt;
      updateCount += 1;
      markActivity(`task_update:${task.status}`);
      logRuntimeDebug("info", "task_update", {
        request_id: requestId,
        agent_id: agentId,
        conversation_id: task.id,
        task_status: task.status,
        gap_since_previous_activity_ms: gapMs,
        message_count: messageCount,
        emitted_content_chars: emittedContent.length,
        emitted_thinking_chars: emittedThinking.length,
      });
      void finish();
    };

    const abortHandler = abortSignal
      ? () => {
          logRuntime("warn", "client_abort_received", {
            request_id: requestId,
            agent_id: agentId,
            conversation_id: task.id,
            elapsed_ms: nowLatencyMs(startedAt),
          });
          fail(new RelevanceError("Client disconnected before the upstream task completed."));
        }
      : null;

    task.addEventListener("message", messageHandler);
    task.addEventListener("error", errorHandler);
    task.addEventListener("update", updateHandler);

    if (abortSignal && abortHandler) {
      abortSignal.addEventListener("abort", abortHandler, { once: true });
    }

    void pollTaskMetadata();
    void finish();
  });
}
