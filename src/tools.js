import crypto from "node:crypto";

export function generateToolUseId() {
  return `toolu_${crypto.randomBytes(12).toString("base64url")}`;
}

/**
 * Normalize tool definitions to a common internal format { name, description, inputSchema }.
 *
 * Handles three source formats:
 *
 * 1. OpenAI array:
 *    [{ type: "function", function: { name, description, parameters } }]
 *    or [{ name, description, parameters }]
 *
 * 2. Anthropic array:
 *    [{ name, description, input_schema }]
 *
 * 3. Cherry Studio / MCP object:
 *    { toolName: { description, inputSchema: { jsonSchema: {...} } } }
 *
 * @param {Array|object} tools
 * @returns {{ name: string, description: string, inputSchema: object }[]}
 */
export function normalizeTools(tools) {
  if (!tools) return [];

  // Convert object format → array
  let toolsArray;
  if (Array.isArray(tools)) {
    toolsArray = tools;
  } else if (typeof tools === "object") {
    toolsArray = Object.entries(tools).map(([name, def]) => ({
      name,
      ...(typeof def === "object" && def !== null ? def : {}),
    }));
  } else {
    return [];
  }

  if (!toolsArray.length) return [];

  return toolsArray
    .map((tool) => {
      if (!tool || typeof tool !== "object") return null;

      // OpenAI wraps the actual definition inside a `function` field
      const def = (tool.type === "function" && tool.function) ? tool.function : tool;

      const name = String(def.name || tool.name || "").trim();
      if (!name) return null;

      const description = String(def.description || tool.description || "").trim();

      // Resolve input schema from the various locations:
      //  • Anthropic:       def.input_schema
      //  • OpenAI:          def.parameters
      //  • MCP / Cherry:    def.inputSchema.jsonSchema  or  def.inputSchema
      //  • fallback
      const inputSchema =
        def.input_schema ||
        def.parameters ||
        def.inputSchema?.jsonSchema ||
        def.inputSchema ||
        { type: "object", properties: {} };

      return { name, description, inputSchema };
    })
    .filter(Boolean);
}

/**
 * Build a text section to inject into the prompt that describes available tools
 * and instructs the model how to call them.
 */
export function buildToolsSection(tools) {
  const normalized = normalizeTools(tools);
  if (!normalized.length) return "";

  const toolDescriptions = normalized
    .map((tool) => {
      const lines = [`name: ${tool.name}`];
      if (tool.description) lines.push(`description: ${tool.description}`);
      lines.push(`input_schema: ${JSON.stringify(tool.inputSchema)}`);
      return lines.join("\n");
    })
    .join("\n---\n");

  return [
    "<GatewayToolInstructions>",
    "You are connected to external tools. To use a tool, your ENTIRE response must be",
    "ONLY this JSON — no explanation, no markdown, no surrounding text:",
    '{"tool":"TOOL_NAME","input":INPUT_OBJECT}',
    "",
    "Examples:",
    '  {"tool":"bash","input":{"command":"ls"}}',
    '  {"tool":"mcp__CherryFetch__fetchMarkdown","input":{"url":"https://example.com"}}',
    "",
    "If you do NOT need a tool, reply normally in plain text.",
    "",
    "AVAILABLE TOOLS:",
    toolDescriptions,
    "</GatewayToolInstructions>",
  ].join("\n");
}

/**
 * Try to detect a tool call JSON anywhere in the response text.
 * Returns { name, input } or null.
 *
 * Searches for {"tool":"...","input":...} pattern in the text.
 * If allowedNames is provided, only matches tools in that list.
 *
 * @param {string} text
 * @param {string[]|null} allowedNames
 */
export function detectToolCall(text, allowedNames = null) {
  if (!text) return null;

  // Find every `{` and try to parse a complete JSON object starting there
  for (let start = 0; start < text.length; start++) {
    if (text[start] !== "{") continue;

    // Walk forward to find the matching `}`
    let depth = 0;
    let end = -1;
    for (let i = start; i < text.length; i++) {
      if (text[i] === "{") depth++;
      else if (text[i] === "}") {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (end < 0) break; // no complete object found

    const jsonStr = text.slice(start, end + 1);
    try {
      const parsed = JSON.parse(jsonStr);
      if (typeof parsed.tool === "string" && parsed.tool.trim() && parsed.input !== undefined) {
        const name = parsed.tool.trim();
        if (allowedNames && !allowedNames.includes(name)) {
          // Keep searching — this JSON matches the shape but not the tool list
          continue;
        }
        return {
          name,
          input: parsed.input !== null && typeof parsed.input === "object" ? parsed.input : {},
        };
      }
    } catch {
      // not valid JSON at this position, keep searching
    }
  }

  return null;
}
