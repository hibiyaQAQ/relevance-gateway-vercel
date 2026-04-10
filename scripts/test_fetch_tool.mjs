#!/usr/bin/env node
/**
 * 复现 Cherry Studio + mcp__CherryFetch 工具调用完整两轮对话，
 * 检查最终回答内容是否干净（无 JSON blob / thinking 混入）。
 */

const GW   = "http://127.0.0.1:8080";
const KEY  = "sk-gw--k75VCp5tR9-f0cLkpWcV5t0iLvBYs0i";
const MODEL = "anthropic-claude-opus-4-6-context-1m";
const TARGET = "https://relevanceai.com/docs/get-started/core-concepts/agents";

const TOOLS = {
  mcp__CherryFetch__fetchMarkdown: {
    description: "Fetch a website and return the content as Markdown",
    inputSchema: {
      jsonSchema: {
        type: "object",
        properties: { url: { type: "string" } },
        required: ["url"],
      },
    },
  },
  mcp__CherryFetch__fetchTxt: {
    description: "Fetch a website, return the content as plain text",
    inputSchema: {
      jsonSchema: {
        type: "object",
        properties: { url: { type: "string" } },
        required: ["url"],
      },
    },
  },
};

async function gwPost(path, body) {
  const json = JSON.stringify(body);
  console.error(`  → POST ${path}  body=${(json.length/1024).toFixed(1)}KB`);
  const res = await fetch(GW + path, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${KEY}`,
      "Content-Type": "application/json",
    },
    body: json,
    signal: AbortSignal.timeout(180_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

async function fetchPage(url, maxChars = 20_000) {
  console.error(`  → Fetching ${url} ...`);
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0" },
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  const trimmed = text.slice(0, maxChars);
  console.error(`  → Fetched ${trimmed.length} chars`);
  return trimmed;
}

// ── Turn 1 ───────────────────────────────────────────────────────────────────
console.error("\n=== Turn 1: user message + tools ===");
const t1 = await gwPost("/v1/chat/completions", {
  model: MODEL,
  stream: false,
  messages: [{ role: "user", content: [{ type: "text", text: `${TARGET} 访问一下这份文档，告诉我内容` }] }],
  tools: TOOLS,
});

const choice1 = t1.choices[0];
console.error(`  finish_reason: ${choice1.finish_reason}`);

if (choice1.finish_reason !== "tool_calls") {
  console.error("  !! Model did not call a tool.");
  console.error("  content:", choice1.message.content);
  process.exit(1);
}

const tc       = choice1.message.tool_calls[0];
const toolId   = tc.id;
const toolName = tc.function.name;
const toolArgs = JSON.parse(tc.function.arguments);
console.error(`  tool_call: id=${toolId}  name=${toolName}  args=${JSON.stringify(toolArgs)}`);

// ── Execute tool locally ─────────────────────────────────────────────────────
console.error("\n=== Executing tool locally ===");
const pageContent = await fetchPage(toolArgs.url);

// Cherry Studio wraps the output in {"toolCallId","input","output":{"content":[...]}}
const toolResultContent = JSON.stringify({
  toolCallId: toolId,
  input: toolArgs,
  output: { content: [{ type: "text", text: pageContent }] },
});
console.error(`  tool_result size: ${(toolResultContent.length / 1024).toFixed(1)}KB`);

// ── Turn 2 ───────────────────────────────────────────────────────────────────
console.error("\n=== Turn 2: tool result → final answer ===");
const t2 = await gwPost("/v1/chat/completions", {
  model: MODEL,
  stream: false,
  messages: [
    { role: "user", content: [{ type: "text", text: `${TARGET} 访问一下这份文档，告诉我内容` }] },
    { role: "assistant", content: null, tool_calls: [tc] },
    { role: "tool", tool_call_id: toolId, content: toolResultContent },
  ],
  tools: TOOLS,
});

const choice2 = t2.choices[0];
console.error(`  finish_reason: ${choice2.finish_reason}`);
const msg = choice2.message;
const content = msg.content ?? "";

// ── Diagnostics ──────────────────────────────────────────────────────────────
console.log("\n=== RESULT ===");
console.log(`content type    : ${typeof content}`);
console.log(`content length  : ${typeof content === "string" ? content.length : "N/A"}`);

if (typeof content === "string") {
  const looksLikeJson = content.trim().startsWith("{") || content.includes('"thinking"');
  console.log(`looks like JSON : ${looksLikeJson}`);
  console.log(`has \\\\n literal : ${content.includes("\\\\n")}`);
  console.log("\n--- content preview (first 600 chars) ---");
  console.log(content.slice(0, 600));
} else {
  console.log("content is not a string:", JSON.stringify(content).slice(0, 300));
}

console.log(`\nthinking preview: ${(msg.thinking || "[none]").slice(0, 150)}`);
console.log(`usage: ${JSON.stringify(t2.usage)}`);
