/**
 * Anthropic Messages API format parsing and response formatting.
 *
 * Handles:
 *  - Request parsing (system, tools, messages with content blocks)
 *  - Non-streaming response formatting
 *  - Streaming SSE events (message_start / content_block_* / message_delta / message_stop)
 *  - Tool use responses (tool_use content blocks in both streaming and non-streaming)
 */

import { parseAnthropicImageSource } from "./multimodal.js";
import { normalizeTools, generateToolUseId } from "./tools.js";

// ---------------------------------------------------------------------------
// Request parsing
// ---------------------------------------------------------------------------

/**
 * Normalize a single Anthropic content block to our internal format.
 */
function normalizeAnthropicBlock(block) {
  if (!block || typeof block !== "object") throw new Error("Content block must be an object.");
  switch (block.type) {
    case "text":
      return { type: "text", text: String(block.text || "") };
    case "thinking":
      return {
        type: "thinking",
        thinking: String(block.thinking || ""),
        signature: typeof block.signature === "string" ? block.signature : "",
      };
    case "redacted_thinking":
      return {
        type: "redacted_thinking",
        data: typeof block.data === "string" ? block.data : "",
      };
    case "image":
      return parseAnthropicImageSource(block.source);
    case "tool_use":
      return {
        type: "tool_use",
        id: String(block.id || generateToolUseId()),
        name: String(block.name || ""),
        input: block.input && typeof block.input === "object" ? block.input : {},
      };
    case "tool_result": {
      let content = "";
      if (typeof block.content === "string") {
        content = block.content;
      } else if (Array.isArray(block.content)) {
        content = block.content
          .filter((b) => b?.type === "text")
          .map((b) => b.text || "")
          .join("");
      }
      return {
        type: "tool_result",
        toolUseId: String(block.tool_use_id || ""),
        content,
        isError: Boolean(block.is_error),
      };
    }
    default:
      throw new Error(`Unsupported Anthropic content block type: ${block.type}`);
  }
}

/**
 * Normalize Anthropic messages array to internal format.
 */
function normalizeAnthropicMessages(messages) {
  if (!Array.isArray(messages) || !messages.length) {
    throw new Error("messages must be a non-empty array.");
  }
  return messages.map((msg) => {
    if (!msg || typeof msg !== "object") throw new Error("Each message must be an object.");
    const role = String(msg.role || "").trim();
    if (!role) throw new Error("Each message must have a role.");

    let content;
    if (typeof msg.content === "string") {
      content = [{ type: "text", text: msg.content }];
    } else if (Array.isArray(msg.content)) {
      content = msg.content.map(normalizeAnthropicBlock);
    } else {
      throw new Error("Message content must be a string or array.");
    }
    return { role, content };
  });
}

/**
 * Parse and validate an Anthropic /v1/messages request body.
 *
 * Returns:
 *  {
 *    model, maxTokens, systemPrompt,
 *    tools,          // normalized tool defs (or null)
 *    messages,       // internal message array
 *    stream,
 *  }
 */
export function parseAnthropicRequest(body) {
  if (!body || typeof body !== "object") {
    throw new Error("Request body must be a JSON object.");
  }
  if (typeof body.model !== "string" || !body.model.trim()) {
    throw new Error("model is required.");
  }
  if (typeof body.max_tokens !== "number" || body.max_tokens < 1) {
    throw new Error("max_tokens is required and must be a positive integer.");
  }

  // system can be a string or array of text blocks
  let systemPrompt = null;
  if (typeof body.system === "string") {
    systemPrompt = body.system;
  } else if (Array.isArray(body.system)) {
    systemPrompt = body.system
      .filter((b) => b?.type === "text")
      .map((b) => b.text || "")
      .join("\n");
  }

  const rawTools = body.tools;
  const normalizedTools = rawTools ? normalizeTools(rawTools) : [];
  const tools = normalizedTools.length ? normalizedTools : null;

  const messages = normalizeAnthropicMessages(body.messages);

  return {
    model: body.model.trim(),
    maxTokens: body.max_tokens,
    systemPrompt,
    tools,
    messages,
    stream: Boolean(body.stream),
  };
}

// ---------------------------------------------------------------------------
// Response formatting (non-streaming)
// ---------------------------------------------------------------------------

/**
 * Build a non-streaming Anthropic response.
 *
 * @param {object} opts
 * @param {string} opts.requestId
 * @param {string} opts.model
 * @param {string} opts.content      - full text from the agent
 * @param {string} opts.thinking     - optional thinking text
 * @param {object|null} opts.toolCall - { name, input } if agent called a tool
 * @param {string|null} opts.toolCallId
 * @param {object} opts.usage        - { prompt_tokens, completion_tokens, total_tokens }
 */
export function buildAnthropicResponse({
  requestId,
  model,
  content,
  thinking,
  toolCall,
  toolCallId,
  usage,
}) {
  const contentBlocks = [];

  if (thinking) {
    contentBlocks.push({ type: "thinking", thinking });
  }

  let stopReason;
  if (toolCall) {
    contentBlocks.push({
      type: "tool_use",
      id: toolCallId || generateToolUseId(),
      name: toolCall.name,
      input: toolCall.input,
    });
    stopReason = "tool_use";
  } else {
    if (content) contentBlocks.push({ type: "text", text: content });
    stopReason = "end_turn";
  }

  return {
    id: requestId,
    type: "message",
    role: "assistant",
    model,
    content: contentBlocks,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: usage?.prompt_tokens || 0,
      output_tokens: usage?.completion_tokens || 0,
    },
  };
}

// ---------------------------------------------------------------------------
// Streaming helpers
// ---------------------------------------------------------------------------

function sseEvent(eventType, data) {
  return `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
}

function sseRaw(eventType, jsonStr) {
  return `event: ${eventType}\ndata: ${jsonStr}\n\n`;
}

/**
 * Emit the opening events of an Anthropic SSE stream.
 * Returns { write } - a function to write to `res`.
 * Caller must flush headers first.
 */
export function createAnthropicStreamWriter(res, requestId, model, inputTokens) {
  let closed = false;
  res.on("close", () => { closed = true; });

  const write = (chunk) => {
    if (closed) return false;
    return res.write(chunk);
  };

  // message_start
  write(sseEvent("message_start", {
    type: "message_start",
    message: {
      id: requestId,
      type: "message",
      role: "assistant",
      content: [],
      model,
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: inputTokens, output_tokens: 0 },
    },
  }));

  return {
    write,
    closed: () => closed,
    /**
     * Emit a ping (keep-alive comment).
     */
    ping() {
      write(": ping\n\n");
    },
    /**
     * Open a text content block and return a function to stream text deltas.
     */
    openTextBlock(index = 0) {
      write(sseEvent("content_block_start", {
        type: "content_block_start",
        index,
        content_block: { type: "text", text: "" },
      }));
      return {
        delta(text) {
          if (!text) return;
          write(sseEvent("content_block_delta", {
            type: "content_block_delta",
            index,
            delta: { type: "text_delta", text },
          }));
        },
        close() {
          write(sseEvent("content_block_stop", { type: "content_block_stop", index }));
        },
      };
    },
    /**
     * Open a thinking content block and return a handle with delta/close methods.
     * Use this for progressive (streaming) thinking output.
     */
    openThinkingBlock(index = 0) {
      write(sseEvent("content_block_start", {
        type: "content_block_start",
        index,
        content_block: { type: "thinking", thinking: "" },
      }));
      return {
        delta(text) {
          if (!text) return;
          write(sseEvent("content_block_delta", {
            type: "content_block_delta",
            index,
            delta: { type: "thinking_delta", thinking: text },
          }));
        },
        close() {
          write(sseEvent("content_block_stop", { type: "content_block_stop", index }));
        },
      };
    },
    /**
     * Emit a thinking block in one shot (non-streaming, for buffered mode).
     */
    emitThinkingBlock(thinking, index = 0) {
      if (!thinking) return;
      write(sseEvent("content_block_start", {
        type: "content_block_start",
        index,
        content_block: { type: "thinking", thinking: "" },
      }));
      write(sseEvent("content_block_delta", {
        type: "content_block_delta",
        index,
        delta: { type: "thinking_delta", thinking },
      }));
      write(sseEvent("content_block_stop", { type: "content_block_stop", index }));
    },
    /**
     * Emit a complete tool_use block (non-streaming, since we have the full JSON).
     */
    emitToolUseBlock(toolCallId, toolName, toolInput, index = 0) {
      const inputJson = JSON.stringify(toolInput ?? {});
      write(sseEvent("content_block_start", {
        type: "content_block_start",
        index,
        content_block: { type: "tool_use", id: toolCallId, name: toolName, input: {} },
      }));
      write(sseEvent("content_block_delta", {
        type: "content_block_delta",
        index,
        delta: { type: "input_json_delta", partial_json: inputJson },
      }));
      write(sseEvent("content_block_stop", { type: "content_block_stop", index }));
    },
    /**
     * Close the stream with a stop_reason.
     */
    finish(stopReason, outputTokens) {
      write(sseEvent("message_delta", {
        type: "message_delta",
        delta: { stop_reason: stopReason, stop_sequence: null },
        usage: { output_tokens: outputTokens || 0 },
      }));
      write(sseRaw("message_stop", '{"type":"message_stop"}'));
      if (!closed) res.end();
    },
    /**
     * Emit an error event and close.
     */
    error(message) {
      write(sseEvent("error", { type: "error", error: { type: "api_error", message } }));
      if (!closed) res.end();
    },
  };
}
