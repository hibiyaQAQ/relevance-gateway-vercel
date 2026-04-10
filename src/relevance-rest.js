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

export function extractAnswerAndUsage(studioResult) {
  const preview = studioResult?.output_preview || {};
  let answer = preview.answer || "";

  if (!answer && preview.message) {
    try {
      answer = JSON.parse(preview.message).answer || preview.message;
    } catch {
      answer = preview.message;
    }
  }

  if (!answer) {
    const historyItems = preview.history_items || [];
    const aiMessages = historyItems
      .filter((item) => item?.role === "ai")
      .map((item) => item?.message || "")
      .filter(Boolean);
    answer = aiMessages.at(-1) || "";
  }

  let promptTokens = preview.input_tokens;
  let completionTokens = preview.output_tokens;
  let totalTokens = null;

  const traceUsage = preview.trace_info?.usage || {};
  if (promptTokens == null) promptTokens = traceUsage.input_tokens;
  if (completionTokens == null) completionTokens = traceUsage.output_tokens;
  if (totalTokens == null) totalTokens = traceUsage.total_tokens;

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
    text: typeof latestAgentMessage.text === "string" ? latestAgentMessage.text : "",
  };
}
