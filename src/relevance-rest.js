import { setTimeout as delay } from "node:timers/promises";

export class RelevanceError extends Error {
  constructor(message, statusCode = null) {
    super(message);
    this.name = "RelevanceError";
    this.statusCode = statusCode;
  }
}

function buildBaseUrl(material) {
  return `https://api-${material.region}.stack.tryrelevance.com/latest`;
}

function encodeQuery(params = {}) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value == null) continue;
    search.set(key, String(value));
  }
  const serialized = search.toString();
  return serialized ? `?${serialized}` : "";
}

export class RelevanceRestClient {
  constructor(material, timeoutSeconds = 30) {
    this.material = material;
    this.timeoutSeconds = timeoutSeconds;
  }

  async request(path, { method = "GET", query, json, headers } = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutSeconds * 1000);
    try {
      const response = await fetch(`${buildBaseUrl(this.material)}/${path}${encodeQuery(query)}`, {
        method,
        headers: {
          Authorization: `${this.material.project}:${this.material.apiKey}`,
          Accept: "application/json",
          ...(json ? { "Content-Type": "application/json" } : {}),
          ...(headers || {}),
        },
        body: json ? JSON.stringify(json) : undefined,
        signal: controller.signal,
      });

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
        const message =
          typeof payload === "object" && payload
            ? payload.message || payload.error || text || response.statusText
            : text || response.statusText;
        throw new RelevanceError(String(message), response.status);
      }

      return payload;
    } catch (error) {
      if (error?.name === "AbortError") {
        throw new RelevanceError(
          `Upstream request timed out after ${this.timeoutSeconds} seconds.`,
        );
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  listAgents() {
    return this.request("agents/list", { method: "POST", json: {} }).then(
      (payload) => payload.results || [],
    );
  }

  listAgentModels(modelSubset = "AGENT") {
    return this.request("agents/models/list", {
      query: { model_subset: modelSubset },
    }).then((payload) => payload.models || []);
  }

  upsertAgent(body) {
    return this.request("agents/upsert", { method: "POST", json: body }).then(
      (payload) => payload.agent_id,
    );
  }

  getAgent(agentId) {
    return this.request(`agents/${agentId}/get`).then((payload) => payload.agent);
  }

  deleteAgent(agentId) {
    return this.request(`agents/${agentId}/delete`, { method: "POST", json: {} });
  }

  listAgentTools(agentId) {
    return this.request("agents/tools/list", {
      method: "POST",
      json: { agent_ids: [agentId] },
    });
  }

  getConversationResult(agentId, conversationId) {
    return this.request("agents/conversations/studios/list", {
      query: {
        conversation_id: conversationId,
        agent_id: agentId,
        page_size: 100,
      },
    }).then((payload) => {
      const results = payload.results || [];
      if (!results.length) {
        throw new RelevanceError("Conversation result was empty.");
      }
      return results[0];
    });
  }

  async waitForConversationResult(agentId, conversationId, timeoutSeconds = 15) {
    const startedAt = Date.now();
    let lastError = null;
    while ((Date.now() - startedAt) / 1000 < timeoutSeconds) {
      try {
        const result = await this.getConversationResult(agentId, conversationId);
        if (result.status === "complete") return result;
        if (result.status === "failed") {
          throw new RelevanceError(JSON.stringify(result.errors || result));
        }
      } catch (error) {
        lastError = error;
      }
      await delay(500);
    }
    if (lastError) throw lastError;
    throw new RelevanceError("Timed out while waiting for final conversation result.");
  }

  getTaskMetadata(agentId, conversationId, includeStreamingToken = false) {
    return this.request(`agents/${agentId}/tasks/${conversationId}/metadata`, {
      query: includeStreamingToken ? { include_streaming_token: true } : undefined,
    });
  }

  getTaskView(agentId, conversationId) {
    return this.request(`agents/${agentId}/tasks/${conversationId}/view`, {
      method: "POST",
      json: { page_size: 1000 },
    });
  }
}

const RESULT_TEXT_FIELDS = ["answer", "text", "content"];

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function decodeJsonishString(rawValue) {
  let decoded = "";
  for (let index = 0; index < rawValue.length; index += 1) {
    const char = rawValue[index];
    if (char !== "\\") {
      decoded += char;
      continue;
    }

    const next = rawValue[index + 1];
    if (next == null) {
      decoded += "\\";
      break;
    }

    switch (next) {
      case "\"":
        decoded += "\"";
        break;
      case "\\":
        decoded += "\\";
        break;
      case "/":
        decoded += "/";
        break;
      case "b":
        decoded += "\b";
        break;
      case "f":
        decoded += "\f";
        break;
      case "n":
        decoded += "\n";
        break;
      case "r":
        decoded += "\r";
        break;
      case "t":
        decoded += "\t";
        break;
      case "u": {
        const hex = rawValue.slice(index + 2, index + 6);
        if (/^[0-9a-fA-F]{4}$/.test(hex)) {
          decoded += String.fromCharCode(Number.parseInt(hex, 16));
          index += 4;
        } else {
          decoded += "u";
        }
        break;
      }
      default:
        decoded += next;
        break;
    }

    index += 1;
  }
  return decoded;
}

function extractNamedJsonishStringField(text, fieldName) {
  const matcher = new RegExp(`"${escapeRegExp(fieldName)}"\\s*:\\s*"`, "g");
  let match;
  while ((match = matcher.exec(text)) !== null) {
    let index = matcher.lastIndex;
    let rawValue = "";
    while (index < text.length) {
      const char = text[index];
      if (char === "\\") {
        rawValue += char;
        index += 1;
        if (index < text.length) {
          rawValue += text[index];
          index += 1;
        }
        continue;
      }
      if (char === "\"") {
        return decodeJsonishString(rawValue);
      }
      rawValue += char;
      index += 1;
    }
  }
  return null;
}

export function unwrapStructuredAnswerText(text) {
  if (typeof text !== "string" || !text) return "";

  const trimmed = text.trimStart();
  const looksStructured =
    trimmed.startsWith("{") ||
    trimmed.startsWith("[") ||
    /"(answer|text|content)"\s*:/.test(trimmed.slice(0, 240));
  if (!looksStructured) {
    return text;
  }

  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      for (const fieldName of RESULT_TEXT_FIELDS) {
        if (typeof parsed[fieldName] === "string") {
          return parsed[fieldName];
        }
      }
    }
  } catch {}

  for (const fieldName of RESULT_TEXT_FIELDS) {
    const extracted = extractNamedJsonishStringField(trimmed, fieldName);
    if (typeof extracted === "string") {
      return extracted;
    }
  }

  return text;
}

/**
 * Extract the answer text and token usage from a Relevance AI conversation result.
 *
 * The `conversations/studios/list` API can return the payload at different levels
 * depending on the agent/model configuration:
 *
 *   A) studioResult.answer                        ← top-level (observed with Claude models)
 *   B) studioResult.output_preview.answer         ← nested in output_preview
 *   C) studioResult.output_preview.message        ← JSON string {"text":"...","thinking":[...]}
 *   D) studioResult.validation_history[*].message ← history fallback
 *
 * Token counts may also appear at the top level (studioResult.input_tokens) when
 * output_preview is absent.
 */
export function extractAnswerAndUsage(studioResult) {
  const preview = studioResult?.output_preview || {};
  let answer = "";
  let thinkingFromResult = null;

  // ── A: top-level answer (most common with Claude-based agents) ──────────
  // In some cases (e.g. when the agent makes a nested tool call) Relevance AI
  // serialises the full output_preview as a JSON string in the answer field.
  // We unwrap it: if the value itself is a JSON object, look for .answer/.text
  // inside before falling back to using the whole string.
  if (studioResult?.answer) {
    const rawAnswer = String(studioResult.answer);
    answer = unwrapStructuredAnswerText(rawAnswer);
    if (rawAnswer.trim().startsWith("{") || rawAnswer.trim().startsWith("[")) {
      try {
        const inner = JSON.parse(rawAnswer);
        if (inner && typeof inner === "object" && !Array.isArray(inner)) {
          // Opportunistically extract thinking from nested validation_history
          const vh = Array.isArray(inner.validation_history) ? inner.validation_history : [];
          if (!thinkingFromResult && vh.length) {
            const lastAi = [...vh].reverse().find((h) => h?.role === "ai");
            if (lastAi && Array.isArray(lastAi.thinking) && lastAi.thinking.length) {
              thinkingFromResult = lastAi.thinking
                .filter((t) => t && typeof t.text === "string")
                .map((t) => t.text)
                .join("\n\n");
            }
          }
        }
      } catch {}
    }
  }

  // ── B: output_preview.answer ────────────────────────────────────────────
  if (!answer && preview.answer) {
    answer = unwrapStructuredAnswerText(String(preview.answer));
  }

  // ── C: output_preview.message (may be a JSON blob) ──────────────────────
  if (!answer && preview.message) {
    const rawPreviewMessage = String(preview.message);
    answer = unwrapStructuredAnswerText(rawPreviewMessage);
    try {
      const parsed = JSON.parse(rawPreviewMessage);
      if (Array.isArray(parsed.thinking) && parsed.thinking.length) {
        thinkingFromResult = parsed.thinking
          .filter((t) => t && typeof t === "object" && typeof t.text === "string")
          .map((t) => t.text)
          .join("\n\n");
      }
    } catch {}
  }

  // ── D: validation_history / history_items fallback ──────────────────────
  if (!answer) {
    const historyItems =
      preview.history_items ||
      preview.validation_history ||
      studioResult?.validation_history ||
      [];
    const aiMessages = historyItems
      .filter((item) => item?.role === "ai")
      .map((item) => {
        if (typeof item.message !== "string") return "";
        const unwrappedMessage = unwrapStructuredAnswerText(item.message);
        if (unwrappedMessage !== item.message) {
          return unwrappedMessage;
        }
        // The message field itself might be a JSON blob
        try {
          const p = JSON.parse(item.message);
          if (p.text || p.answer) {
            if (!thinkingFromResult && Array.isArray(p.thinking) && p.thinking.length) {
              thinkingFromResult = p.thinking
                .filter((t) => t && typeof t.text === "string")
                .map((t) => t.text)
                .join("\n\n");
            }
            return p.answer || p.text || "";
          }
        } catch { /* plain text */ }
        return item.message;
      })
      .filter(Boolean);
    answer = aiMessages.at(-1) || "";
  }

  // ── Thinking: always scan validation_history for thinking blocks ─────────
  // Do this regardless of which path provided the answer, because thinking
  // lives in validation_history[*].thinking even when answer came from A/B/C.
  if (!thinkingFromResult) {
    const historyForThinking =
      preview.history_items ||
      preview.validation_history ||
      studioResult?.validation_history ||
      [];
    const lastAi = [...historyForThinking].reverse().find((item) => item?.role === "ai");
    if (lastAi) {
      // Dedicated thinking array on the history item
      if (Array.isArray(lastAi.thinking) && lastAi.thinking.length) {
        thinkingFromResult = lastAi.thinking
          .filter((t) => t && typeof t === "object" && typeof t.text === "string")
          .map((t) => t.text)
          .join("\n\n");
      }
      // Or thinking embedded in the message JSON blob
      if (!thinkingFromResult && typeof lastAi.message === "string") {
        try {
          const p = JSON.parse(lastAi.message);
          if (Array.isArray(p.thinking) && p.thinking.length) {
            thinkingFromResult = p.thinking
              .filter((t) => t && typeof t.text === "string")
              .map((t) => t.text)
              .join("\n\n");
          }
        } catch { /* not JSON */ }
      }
    }
  }

  // ── Token counts ─────────────────────────────────────────────────────────
  // May live in output_preview, at the top level, or in trace_info.
  let promptTokens = preview.input_tokens ?? studioResult?.input_tokens ?? null;
  let completionTokens = preview.output_tokens ?? studioResult?.output_tokens ?? null;
  let totalTokens = null;

  const traceUsage = preview.trace_info?.usage || {};
  if (promptTokens == null) promptTokens = traceUsage.input_tokens ?? null;
  if (completionTokens == null) completionTokens = traceUsage.output_tokens ?? null;
  if (totalTokens == null) totalTokens = traceUsage.total_tokens ?? null;

  const creditsUsed = Array.isArray(studioResult?.credits_used)
    ? studioResult.credits_used.filter((item) => item && typeof item === "object")
    : [];

  if (promptTokens == null) {
    promptTokens = creditsUsed.reduce((sum, item) => sum + Number(item.input_tokens || 0), 0);
  }
  if (completionTokens == null) {
    completionTokens = creditsUsed.reduce(
      (sum, item) => sum + Number(item.output_tokens || 0),
      0,
    );
  }
  if (totalTokens == null && promptTokens != null && completionTokens != null) {
    totalTokens = Number(promptTokens || 0) + Number(completionTokens || 0);
  }

  return {
    answer: answer || "",
    thinking: thinkingFromResult || null,
    usage: {
      prompt_tokens: Number(promptTokens || 0),
      completion_tokens: Number(completionTokens || 0),
      total_tokens: Number(totalTokens || 0),
    },
  };
}

export function extractCostAndCredits(studioResult) {
  const cost =
    typeof studioResult?.cost === "number" ? studioResult.cost : Number(studioResult?.cost);
  const normalizedCost = Number.isFinite(cost) ? cost : null;
  const creditsUsed = Array.isArray(studioResult?.credits_used)
    ? studioResult.credits_used.filter((item) => item && typeof item === "object")
    : [];
  return {
    cost: normalizedCost,
    creditsUsed: creditsUsed.length ? creditsUsed : null,
  };
}

export function extractTaskViewProgress(viewPayload) {
  const results = Array.isArray(viewPayload?.results) ? viewPayload.results : [];
  let latestAgentMessage = null;
  for (const item of results) {
    if (!item || typeof item !== "object") continue;
    const content = item.content;
    if (!content || typeof content !== "object") continue;
    if (content.type === "agent-message") {
      latestAgentMessage = content;
      break;
    }
  }

  if (!latestAgentMessage) {
    return { thinking: "", text: "" };
  }

  const rawThinking = latestAgentMessage.thinking;
  let thinking = "";
  if (Array.isArray(rawThinking)) {
    thinking = rawThinking.filter((item) => typeof item === "string" && item.trim()).join("\n\n");
  } else if (typeof rawThinking === "string") {
    thinking = rawThinking.trim();
  }

  return {
    thinking,
    text:
      typeof latestAgentMessage.text === "string"
        ? unwrapStructuredAnswerText(latestAgentMessage.text)
        : "",
  };
}
