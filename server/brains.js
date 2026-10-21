// Swappable brains. Claude (the default) goes through the Anthropic SDK in agent.js; every
// other brain goes through this one adapter for the OpenAI-compatible Chat Completions API,
// which OpenAI, Google Gemini (its compatibility endpoint), Ollama, LM Studio, OpenRouter
// and most other providers speak.
//
// The conversation is always stored in Anthropic's message format, so the agent loop, the
// tools, minions, skills and MCP work the same whatever the brain. Each call converts the
// history to the provider's format, streams the reply, and converts it back - including
// synthetic stream events, so the UI sees text and tool calls exactly as it does with Claude.
//
// Claude-only features (web search, the code-execution sandbox and document skills,
// thinking progress, prompt caching) are simply not offered to other brains.

export const PROVIDERS = {
  anthropic: { label: "Claude (Anthropic)", keyName: "apiKey" },
  openai: { label: "OpenAI (GPT)", baseUrl: "https://api.openai.com/v1", keyName: "openaiKey", usage: true },
  gemini: { label: "Google Gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", keyName: "geminiKey", strictSchema: true },
  ollama: { label: "Ollama (local, open source)", baseUrl: "http://127.0.0.1:11434/v1", keyName: null },
  custom: { label: "Other OpenAI-compatible", baseUrl: "", keyName: "customKey", usage: true },
};

export class BrainError extends Error {
  constructor(status, message, provider) { super(message); this.status = status; this.provider = provider; }
}

/** The active brain: { provider, label, model, baseUrl, apiKey }. */
export function brainOf(config) {
  const provider = PROVIDERS[config.get("provider")] ? config.get("provider") : "anthropic";
  if (provider === "anthropic") return { provider, label: PROVIDERS.anthropic.label, model: config.get("model") || "claude-opus-5-5" };
  const p = PROVIDERS[provider];
  const set = config.get("brains")?.[provider] || {};
  return {
    provider,
    label: p.label,
    model: String(set.model || "").trim(),
    baseUrl: String(set.baseUrl || p.baseUrl || "").trim().replace(/\/+$/, ""),
    apiKey: p.keyName ? config.getSecret(p.keyName) : null,
  };
}

/** Is there enough to talk to this brain? Returns null when ready, else what's missing. */
export function brainMissing(brain) {
  if (brain.provider === "anthropic") return null; // checked by the caller (keys can come from the environment)
  if (!brain.baseUrl) return "the server address";
  if (!brain.model) return "a model name";
  if (PROVIDERS[brain.provider].keyName && !brain.apiKey) return "an API key";
  return null;
}

const headers = (brain) => ({
  "Content-Type": "application/json",
  ...(brain.apiKey ? { Authorization: `Bearer ${brain.apiKey}` } : brain.provider === "ollama" ? { Authorization: "Bearer ollama" } : {}),
});

async function failure(res, brain) {
  let msg = "";
  try { const j = await res.json(); msg = j?.error?.message || j?.message || j?.error || JSON.stringify(j).slice(0, 300); } catch { try { msg = (await res.text()).slice(0, 300); } catch { /* nothing */ } }
  return new BrainError(res.status, String(msg || res.statusText || "request failed"), brain.provider);
}

/** Model ids the provider offers (for the Settings picker). */
export async function listModels(brain, signal) {
  if (!brain.baseUrl) throw new BrainError(0, "Set the server address first.", brain.provider);
  const res = await fetch(`${brain.baseUrl}/models`, { headers: headers(brain), signal });
  if (!res.ok) throw await failure(res, brain);
  const j = await res.json();
  return (j.data || j.models || []).map((m) => String(m.id || m.name || "").replace(/^models\//, "")).filter(Boolean).sort();
}

// ---------------------------------------------------------------- format conversion
const GEMINI_SCHEMA_KEYS = new Set(["type", "description", "enum", "properties", "required", "items", "format", "nullable", "anyOf", "minimum", "maximum", "minItems", "maxItems"]);

/** Gemini accepts a subset of JSON Schema; others take the schema as written. */
function schemaFor(schema, brain) {
  if (!PROVIDERS[brain.provider].strictSchema) return schema;
  const walk = (s) => {
    if (Array.isArray(s)) return s.map(walk);
    if (!s || typeof s !== "object") return s;
    const out = {};
    for (const [k, v] of Object.entries(s)) {
      if (!GEMINI_SCHEMA_KEYS.has(k)) continue;
      out[k] = k === "properties" ? Object.fromEntries(Object.entries(v || {}).map(([pk, pv]) => [pk, walk(pv)])) : walk(v);
    }
    return out;
  };
  return walk(schema);
}

function blockText(b) {
  if (b.type === "text") return b.text;
  if (b.type === "document") return `[A PDF (${b.title || "document"}) was attached here, but this brain can't read PDFs directly.]`;
  if (b.type === "image") return null;
  return null;
}
const imagePart = (b) => (b.source?.type === "base64" ? { type: "image_url", image_url: { url: `data:${b.source.media_type};base64,${b.source.data}` } } : null);

/** Anthropic-format history -> Chat Completions messages. */
function toCompatMessages(system, messages) {
  const out = [];
  const sys = (system || []).map((b) => b.text).join("\n\n");
  if (sys) out.push({ role: "system", content: sys });
  for (const m of messages) {
    const blocks = typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content || [];
    if (m.role === "assistant") {
      const text = blocks.filter((b) => b.type === "text").map((b) => b.text).join("");
      const calls = blocks.filter((b) => b.type === "tool_use").map((b) => ({ id: b.id, type: "function", function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } }));
      if (!text && !calls.length) continue;
      out.push({ role: "assistant", content: text || null, ...(calls.length ? { tool_calls: calls } : {}) });
      continue;
    }
    // user turn: tool results become "tool" messages; images they carry ride in a following user message
    const pendingImages = [];
    const userParts = [];
    for (const b of blocks) {
      if (b.type === "tool_result") {
        const items = typeof b.content === "string" ? [{ type: "text", text: b.content }] : b.content || [];
        const text = items.map(blockText).filter((t) => t != null).join("\n") || (items.some((i) => i.type === "image") ? "(image attached below)" : "(no output)");
        out.push({ role: "tool", tool_call_id: b.tool_use_id, content: (b.is_error ? "ERROR: " : "") + text });
        for (const i of items) if (i.type === "image") { const p = imagePart(i); if (p) pendingImages.push(p); }
      } else if (b.type === "image") {
        const p = imagePart(b);
        if (p) userParts.push(p);
      } else {
        const t = blockText(b);
        if (t) userParts.push({ type: "text", text: t });
      }
    }
    if (pendingImages.length) out.push({ role: "user", content: [{ type: "text", text: "Images returned by the tools above:" }, ...pendingImages] });
    if (userParts.length) out.push({ role: "user", content: userParts.every((p) => p.type === "text") ? userParts.map((p) => p.text).join("\n\n") : userParts });
  }
  return out;
}

function toCompatTools(apiTools, brain) {
  return (apiTools || []).filter((t) => t.input_schema).map((t) => ({
    type: "function",
    function: { name: t.name, description: String(t.description || "").slice(0, 4000), parameters: schemaFor(t.input_schema, brain) },
  }));
}

const STOP = { stop: "end_turn", tool_calls: "tool_use", function_call: "tool_use", length: "max_tokens", content_filter: "refusal" };

/**
 * One streamed call to an OpenAI-compatible brain. `onEvent` receives Anthropic-style
 * stream events (content_block_start / delta / stop); resolves with an Anthropic-shaped
 * message: { content: [text | tool_use blocks], stop_reason, usage }.
 */
export async function callCompat({ brain, conv, signal, onEvent }) {
  const body = {
    model: brain.model,
    messages: toCompatMessages(conv.system, conv.messages),
    stream: true,
  };
  const tools = toCompatTools(conv.apiTools, brain);
  if (tools.length) { body.tools = tools; body.tool_choice = "auto"; }
  if (PROVIDERS[brain.provider].usage) body.stream_options = { include_usage: true };

  let res;
  for (let attempt = 0; ; attempt++) {
    try {
      res = await fetch(`${brain.baseUrl}/chat/completions`, { method: "POST", headers: headers(brain), body: JSON.stringify(body), signal });
    } catch (e) {
      if (signal?.aborted) throw e;
      throw new BrainError(0, brain.provider === "ollama" ? `Can't reach Ollama at ${brain.baseUrl}. Is it running?` : `Can't reach ${brain.label}: ${e.message}`, brain.provider);
    }
    if (res.ok) break;
    // a server that won't take stream_options: try once without
    if (res.status === 400 && body.stream_options && attempt === 0) { delete body.stream_options; continue; }
    if ([429, 500, 502, 503].includes(res.status) && attempt < 2) { await new Promise((r) => setTimeout(r, 1500 * (attempt + 1))); continue; }
    throw await failure(res, brain);
  }

  const emit = (ev) => { try { onEvent?.(ev); } catch { /* UI's problem */ } };
  let text = "", textOpen = false, finish = null, usage = null;
  const calls = new Map(); // stream index -> { id, name, args }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const handle = (j) => {
    if (j.usage) usage = j.usage;
    const ch = j.choices?.[0];
    if (!ch) return;
    const d = ch.delta || {};
    if (d.content) {
      if (!textOpen) { textOpen = true; emit({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }); }
      text += d.content;
      emit({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: d.content } });
    }
    for (const tc of d.tool_calls || []) {
      const k = tc.index ?? calls.size;
      let c = calls.get(k);
      if (!c) { c = { id: tc.id || `call_${Date.now().toString(36)}_${k}`, name: "", args: "" }; calls.set(k, c); }
      if (tc.id) c.id = tc.id;
      if (tc.function?.name) c.name += tc.function.name;
      if (tc.function?.arguments != null) c.args += typeof tc.function.arguments === "string" ? tc.function.arguments : JSON.stringify(tc.function.arguments);
    }
    if (ch.finish_reason) finish = ch.finish_reason;
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") continue;
      try { handle(JSON.parse(data)); } catch { /* a keep-alive or partial line */ }
    }
  }
  if (textOpen) emit({ type: "content_block_stop", index: 0 });

  const content = [];
  if (text) content.push({ type: "text", text });
  for (const c of calls.values()) {
    let input = {};
    try { input = c.args ? JSON.parse(c.args) : {}; } catch { input = { __unparseable: c.args.slice(0, 500) }; }
    const block = { type: "tool_use", id: c.id, name: c.name, input };
    emit({ type: "content_block_start", index: content.length, content_block: { type: "tool_use", id: c.id, name: c.name, input: {} } });
    emit({ type: "content_block_stop", index: content.length });
    content.push(block);
  }
  let stop_reason = STOP[finish] || (calls.size ? "tool_use" : "end_turn");
  if (calls.size && stop_reason === "end_turn") stop_reason = "tool_use"; // some servers say "stop" even with tool calls
  return {
    content,
    stop_reason,
    usage: { input_tokens: usage?.prompt_tokens || 0, output_tokens: usage?.completion_tokens || 0 },
  };
}
