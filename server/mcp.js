// MCP connections: D.E.N.N.I.S. as a client of Model Context Protocol servers, so other
// apps (Blender, Unreal, Slack, Drive, ...) can lend him their tools.
//
// Servers are configured like Claude Desktop's claude_desktop_config.json:
//   { "blender": { "command": "uvx", "args": ["blender-mcp"], "env": { ... } },
//     "remote":  { "url": "https://example.com/mcp", "headers": { "Authorization": "Bearer ..." } } }
// Add "enabled": false to keep one configured but switched off.
//
// Each server tool becomes a D.E.N.N.I.S. tool named mcp__<server>__<tool>. Tools the
// server marks read-only run straight away; everything else asks first (in "ask" mode),
// exactly like his own file tools.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { DATA_DIR } from "./config.js";

const CONNECT_TIMEOUT_MS = 30_000;
const CALL_TIMEOUT_MS = 180_000;
const MAX_RESULT_TEXT = 40_000;
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const LOG_DIR = path.join(DATA_DIR, "logs");
const clean = (s) => String(s || "").replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "x";

/** API tool names: ^[a-zA-Z0-9_-]{1,64}$, unique. */
function toolName(server, tool) {
  const full = `mcp__${clean(server)}__${clean(tool)}`;
  if (full.length <= 64) return full;
  const h = crypto.createHash("sha1").update(full).digest("hex").slice(0, 6);
  return `${full.slice(0, 57)}_${h}`;
}

function withTimeout(p, ms, what) {
  let t;
  return Promise.race([p, new Promise((_, j) => { t = setTimeout(() => j(new Error(`${what} timed out`)), ms); })]).finally(() => clearTimeout(t));
}

/** Where Claude Desktop keeps its MCP servers on this OS (for "Import from Claude Desktop"). */
export function claudeDesktopConfigPath() {
  if (process.platform === "win32") return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "Claude", "claude_desktop_config.json");
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json");
  return path.join(os.homedir(), ".config", "Claude", "claude_desktop_config.json");
}

/** Accept either { mcpServers: {...} } or the bare map; returns a clean { name: def } map or throws. */
export function normalizeServers(input) {
  const map = input && typeof input === "object" && !Array.isArray(input) && input.mcpServers && typeof input.mcpServers === "object" ? input.mcpServers : input;
  if (!map || typeof map !== "object" || Array.isArray(map)) throw new Error("MCP servers must be a JSON object of name -> server.");
  const out = {};
  for (const [name, d] of Object.entries(map)) {
    if (!d || typeof d !== "object") throw new Error(`Server "${name}" must be an object.`);
    if (!/^[\w .-]{1,40}$/.test(name)) throw new Error(`Server name "${name}" should be short: letters, digits, spaces, - _ .`);
    const def = {};
    if (typeof d.url === "string" && d.url.trim()) {
      const u = new URL(d.url.trim());
      if (!/^https?:$/.test(u.protocol)) throw new Error(`Server "${name}": the url must be http(s).`);
      def.url = u.toString();
      if (d.headers && typeof d.headers === "object") def.headers = Object.fromEntries(Object.entries(d.headers).map(([k, v]) => [String(k), String(v)]));
      if (d.transport === "sse") def.transport = "sse";
    } else if (typeof d.command === "string" && d.command.trim()) {
      def.command = d.command.trim();
      if (d.args != null) {
        if (!Array.isArray(d.args)) throw new Error(`Server "${name}": args must be a list.`);
        def.args = d.args.map(String);
      }
      if (d.env && typeof d.env === "object") def.env = Object.fromEntries(Object.entries(d.env).map(([k, v]) => [String(k), String(v)]));
      if (typeof d.cwd === "string" && d.cwd.trim()) def.cwd = d.cwd.trim();
    } else throw new Error(`Server "${name}" needs a "command" (local) or a "url" (remote).`);
    if (d.enabled === false) def.enabled = false;
    out[name] = def;
  }
  return out;
}

/** Turn an MCP CallToolResult into tool_result content for Claude. */
function toClaudeContent(res) {
  const blocks = [];
  let textBudget = MAX_RESULT_TEXT;
  const addText = (t) => {
    if (!t || textBudget <= 0) return;
    const s = String(t);
    blocks.push({ type: "text", text: s.length > textBudget ? s.slice(0, textBudget) + "\n[... truncated]" : s });
    textBudget -= s.length;
  };
  for (const c of res?.content || []) {
    if (c.type === "text") addText(c.text);
    else if (c.type === "image" && IMAGE_TYPES.has(c.mimeType) && c.data && c.data.length < 6_000_000) blocks.push({ type: "image", source: { type: "base64", media_type: c.mimeType, data: c.data } });
    else if (c.type === "image") addText(`[image: ${c.mimeType || "unknown type"}, not shown]`);
    else if (c.type === "audio") addText(`[audio: ${c.mimeType || "audio"}]`);
    else if (c.type === "resource") addText(c.resource?.text != null ? c.resource.text : `[resource ${c.resource?.uri || ""} (${c.resource?.mimeType || "binary"})]`);
    else if (c.type === "resource_link") addText(`[link: ${c.name || ""} ${c.uri || ""}]`);
  }
  if (!blocks.length && res?.structuredContent) addText(JSON.stringify(res.structuredContent, null, 2));
  if (!blocks.length) addText(res?.isError ? "The tool failed without saying why." : "(done - no output)");
  return blocks;
}

/** Inputs stream eagerly, so check the basics ourselves: an object with the required keys. */
function looseValidate(schema, input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return "input must be an object";
  for (const k of schema?.required || []) if (!(k in input)) return `missing required field "${k}"`;
  return null;
}

export class McpHub {
  constructor(config) {
    this.config = config;
    this.servers = new Map(); // name -> { name, def, client, transport, status, error, tools: [] }
    this.listeners = new Set();
    this.ready = Promise.resolve();
    this.version = 0; // bumps when the set of tools changes
  }

  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit() { this.version++; for (const fn of this.listeners) { try { fn(this.status()); } catch { /* listener's problem */ } } }

  /** Connect to every enabled server (and drop ones that were removed). Resolves when all have settled. */
  start() {
    const defs = this.config.get("mcpServers") || {};
    const run = async () => {
      for (const name of [...this.servers.keys()]) if (!defs[name] || defs[name].enabled === false) await this.disconnect(name);
      await Promise.all(Object.entries(defs).filter(([, d]) => d.enabled !== false).map(([name, def]) => {
        const cur = this.servers.get(name);
        if (cur && cur.status === "connected" && JSON.stringify(cur.def) === JSON.stringify(def)) return null;
        return this.connect(name, def);
      }));
      this.emit();
    };
    this.ready = run().catch((e) => console.error("[mcp]", e));
    return this.ready;
  }

  async connect(name, def) {
    await this.disconnect(name);
    const s = { name, def, status: "connecting", error: null, tools: [], client: null, transport: null };
    this.servers.set(name, s);
    this.emit();
    try {
      const client = new Client({ name: "dennis", version: "0.1.0" }, {
        capabilities: {},
        listChanged: { tools: { onChanged: (err, tools) => { if (!err && tools) { s.tools = tools; this.emit(); } } } },
      });
      let transport;
      if (def.url) {
        const requestInit = def.headers ? { headers: def.headers } : undefined;
        transport = def.transport === "sse" ? new SSEClientTransport(new URL(def.url), { requestInit }) : new StreamableHTTPClientTransport(new URL(def.url), { requestInit });
      } else {
        fs.mkdirSync(LOG_DIR, { recursive: true });
        transport = new StdioClientTransport({ command: def.command, args: def.args || [], env: def.env, cwd: def.cwd, stderr: "pipe" });
        const log = fs.createWriteStream(path.join(LOG_DIR, `mcp-${clean(name)}.log`), { flags: "a" });
        log.write(`\n--- ${new Date().toISOString()} starting ${def.command} ${(def.args || []).join(" ")}\n`);
        transport.stderr?.on("data", (d) => log.write(d));
        s.log = log;
      }
      try {
        await withTimeout(client.connect(transport), CONNECT_TIMEOUT_MS, "connecting");
      } catch (e) {
        // an http server that predates Streamable HTTP may still speak the older SSE transport
        if (!def.url || def.transport === "sse") throw e;
        transport = new SSEClientTransport(new URL(def.url), { requestInit: def.headers ? { headers: def.headers } : undefined });
        await withTimeout(client.connect(transport), CONNECT_TIMEOUT_MS, "connecting");
      }
      s.client = client;
      s.transport = transport;
      transport.onclose = () => { if (this.servers.get(name) === s && s.status === "connected") { s.status = "error"; s.error = "disconnected"; this.emit(); } };
      const tools = [];
      let cursor;
      do {
        const page = await withTimeout(client.listTools(cursor ? { cursor } : undefined), CONNECT_TIMEOUT_MS, "listing tools");
        tools.push(...(page.tools || []));
        cursor = page.nextCursor;
      } while (cursor && tools.length < 500);
      s.tools = tools;
      s.status = "connected";
      s.info = client.getServerVersion?.() || null;
    } catch (e) {
      s.status = "error";
      s.error = String(e?.message || e).slice(0, 300);
      try { await s.client?.close(); } catch { /* already gone */ }
      s.client = null;
    }
    this.emit();
    return s;
  }

  async disconnect(name) {
    const s = this.servers.get(name);
    if (!s) return;
    this.servers.delete(name);
    try { await s.client?.close(); } catch { /* already gone */ }
    try { s.log?.end(); } catch { /* fine */ }
  }

  async close() { for (const name of [...this.servers.keys()]) await this.disconnect(name); }

  status() {
    return [...this.servers.values()].map((s) => ({
      name: s.name, status: s.status, error: s.error, transport: s.def.url ? "remote" : "local",
      tools: s.tools.map((t) => ({ name: t.name, title: t.title || t.annotations?.title || "", readOnly: !!t.annotations?.readOnlyHint })),
      server: s.info ? `${s.info.name || ""} ${s.info.version || ""}`.trim() : "",
    }));
  }

  /** D.E.N.N.I.S. tools for every connected server: same shape as tools.js entries. */
  tools() {
    const out = [];
    const seen = new Set();
    for (const s of this.servers.values()) {
      if (s.status !== "connected") continue;
      for (const t of s.tools) {
        const name = toolName(s.name, t.name);
        if (seen.has(name)) continue;
        seen.add(name);
        const schema = t.inputSchema && t.inputSchema.type === "object" ? t.inputSchema : { type: "object", properties: {} };
        const readOnly = !!t.annotations?.readOnlyHint;
        out.push({
          name,
          mcp: { server: s.name, tool: t.name },
          description: `[${s.name}] ${String(t.description || t.title || t.name).slice(0, 3000)}`,
          input_schema: schema,
          validate: (input) => looseValidate(schema, input),
          approval: readOnly ? null : (input) => ({ title: `${s.name}: ${t.title || t.annotations?.title || t.name}`, detail: JSON.stringify(input, null, 2).slice(0, 2000) }),
          run: async (input) => this.call(s.name, t.name, input),
        });
      }
    }
    return out;
  }

  async call(server, tool, input) {
    const s = this.servers.get(server);
    if (!s || s.status !== "connected" || !s.client) return { error: `The ${server} connection isn't available right now.` };
    const res = await s.client.callTool({ name: tool, arguments: input || {} }, undefined, { timeout: CALL_TIMEOUT_MS, resetTimeoutOnProgress: true });
    const content = toClaudeContent(res);
    return res?.isError ? { error: content.map((b) => b.text || "").join("\n") || "The tool reported an error." } : content;
  }
}
