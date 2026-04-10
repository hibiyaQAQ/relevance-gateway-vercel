#!/usr/bin/env python3
"""
复现 Cherry Studio + mcp__CherryFetch 工具调用的完整两轮对话，
检查最终回答内容是否干净。
"""
import json
import sys
import urllib.request
import urllib.error

GW_URL = "http://127.0.0.1:8080"
API_KEY = "sk-gw--k75VCp5tR9-f0cLkpWcV5t0iLvBYs0i"
MODEL   = "anthropic-claude-opus-4-6-context-1m"
TARGET_URL = "https://relevanceai.com/docs/get-started/core-concepts/agents"

TOOLS = {
    "mcp__CherryFetch__fetchMarkdown": {
        "description": "Fetch a website and return the content as Markdown",
        "inputSchema": {
            "jsonSchema": {
                "type": "object",
                "properties": {"url": {"type": "string", "description": "URL to fetch"}},
                "required": ["url"],
            }
        },
    },
    "mcp__CherryFetch__fetchTxt": {
        "description": "Fetch a website, return the content as plain text (no HTML)",
        "inputSchema": {
            "jsonSchema": {
                "type": "object",
                "properties": {"url": {"type": "string", "description": "URL to fetch"}},
                "required": ["url"],
            }
        },
    },
}


def gw_post(path, body):
    data = json.dumps(body).encode()
    req = urllib.request.Request(
        GW_URL + path,
        data=data,
        headers={
            "Authorization": f"Bearer {API_KEY}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    print(f"  → POST {path}  body_size={len(data)} bytes", flush=True)
    with urllib.request.urlopen(req, timeout=180) as resp:
        raw = resp.read().decode()
    return json.loads(raw)


def fetch_page(url, max_chars=20000):
    print(f"  → Fetching {url} ...", flush=True)
    req = urllib.request.Request(
        url,
        headers={"User-Agent": "Mozilla/5.0 (compatible; test-bot)"},
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            content = resp.read().decode("utf-8", errors="replace")
        content = content[:max_chars]
        print(f"  → Fetched {len(content)} chars", flush=True)
        return content
    except Exception as e:
        print(f"  → Fetch failed: {e}", flush=True)
        return f"[Error fetching page: {e}]"


# ── Turn 1: get the tool call ─────────────────────────────────────────────────
print("\n=== Turn 1: user message + tools ===", flush=True)
turn1_resp = gw_post("/v1/chat/completions", {
    "model": MODEL,
    "stream": False,
    "messages": [
        {"role": "user", "content": [{"type": "text", "text": f"{TARGET_URL} 访问一下这份文档，告诉我内容"}]},
    ],
    "tools": TOOLS,
})

choice = turn1_resp["choices"][0]["message"]
print(f"  finish_reason: {turn1_resp['choices'][0]['finish_reason']}")

if turn1_resp["choices"][0]["finish_reason"] != "tool_calls":
    print("  !! Model did not call a tool. Response:")
    print("  content:", choice.get("content"))
    sys.exit(1)

tool_call = choice["tool_calls"][0]
tool_id   = tool_call["id"]
tool_name = tool_call["function"]["name"]
tool_args = json.loads(tool_call["function"]["arguments"])
print(f"  tool_call: id={tool_id}  name={tool_name}  args={tool_args}")

# ── Execute the tool locally ───────────────────────────────────────────────────
print("\n=== Executing tool locally ===", flush=True)
page_content = fetch_page(tool_args["url"])

# Cherry Studio sends the tool result as a JSON string in the content field
tool_result_content = json.dumps({
    "toolCallId": tool_id,
    "input": tool_args,
    "output": {
        "content": [{"type": "text", "text": page_content}]
    },
})
print(f"  tool_result content size: {len(tool_result_content)} bytes")

# ── Turn 2: submit tool result, get final answer ───────────────────────────────
print("\n=== Turn 2: tool result → final answer ===", flush=True)
turn2_resp = gw_post("/v1/chat/completions", {
    "model": MODEL,
    "stream": False,
    "messages": [
        {"role": "user", "content": [{"type": "text", "text": f"{TARGET_URL} 访问一下这份文档，告诉我内容"}]},
        {"role": "assistant", "content": None, "tool_calls": [tool_call]},
        {"role": "tool", "tool_call_id": tool_id, "content": tool_result_content},
    ],
    "tools": TOOLS,
})

print(f"  finish_reason: {turn2_resp['choices'][0]['finish_reason']}")
final_msg = turn2_resp["choices"][0]["message"]

# ── Report ─────────────────────────────────────────────────────────────────────
print("\n=== Result ===")
content = final_msg.get("content") or ""
thinking = final_msg.get("thinking") or ""

print(f"content type      : {type(content).__name__}")
print(f"content length    : {len(content) if isinstance(content, str) else 'N/A'}")

if isinstance(content, str):
    # check for JSON leakage
    is_json_blob = content.strip().startswith("{") or '"thinking"' in content[:200]
    print(f"starts with {{      : {content.strip()[:1] == '{'}")
    print(f"contains thinking : {'\"thinking\"' in content[:500]}")
    print(f"looks like JSON   : {is_json_blob}")
    print(f"\n--- content preview (first 500 chars) ---")
    print(content[:500])
else:
    print("content is not a string!")
    print(repr(content)[:300])

print(f"\n--- thinking preview (first 200 chars) ---")
print((thinking or "[none]")[:200])
print(f"\nusage: {turn2_resp.get('usage')}")
