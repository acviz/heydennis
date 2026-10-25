// A stdio door to D.E.N.N.I.S.'s MCP endpoint (mcp-server.js), for apps that only start MCP servers
// as local programs - the Claude desktop app's claude_desktop_config.json:
//   { "mcpServers": { "dennis": { "command": "node", "args": ["E:\\D.E.N.N.I.S\\server\\mcp-stdio.mjs"] } } }
// It reads his port and token from his data folder (~/.dennis, or DENNIS_HOME), so no token goes into
// the other app's config. It lists his tools even when he isn't running; a call then says he's offline.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { TOOLS, INSTRUCTIONS, ENDPOINT_PATH } from "./mcp-server.js";

const DATA_DIR = process.env.DENNIS_HOME || path.join(os.homedir(), ".dennis");
const VERSION = (() => { try { return JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version; } catch { return "0.0.0"; } })();
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), "utf8")); } catch { return null; } };

/** Where he's listening now (run.json, written while he runs), else his configured port. Read per call: he may have restarted. */
function target() {
  const cfg = readJson("config.json") || {};
  const run = readJson("run.json");
  const port = run?.port || cfg.port || 47800;
  return { url: `http://127.0.0.1:${port}${ENDPOINT_PATH}`, token: cfg.mcpToken || "", enabled: !!cfg.mcpServer?.enabled, port };
}

const say = (t) => ({ content: [{ type: "text", text: t }], isError: true });

async function forward(name, args) {
  const t = target();
  if (!t.enabled || !t.token) return say("Claude's access to D.E.N.N.I.S. is switched off. Turn it on in D.E.N.N.I.S.: Capabilities -> CONNECTED APPS -> LET CLAUDE TALK TO ME.");
  const client = new Client({ name: "dennis-stdio", version: VERSION });
  const transport = new StreamableHTTPClientTransport(new URL(t.url), { requestInit: { headers: { Authorization: `Bearer ${t.token}` } } });
  try {
    await client.connect(transport);
    // talk_to_dennis may wait up to wait_seconds: give the call that long, and a little more
    const wait = Math.min(240, Math.max(0, +args?.wait_seconds || 45));
    return await client.callTool({ name, arguments: args || {} }, undefined, { timeout: (wait + 30) * 1000 });
  } catch (e) {
    const m = String(e?.message || e);
    if (/ECONNREFUSED|fetch failed|ECONNRESET/i.test(m) || /ECONNREFUSED/.test(String(e?.cause?.code))) return say(`D.E.N.N.I.S. isn't running on this computer right now (nothing answers on port ${t.port}). Start him, then try again.`);
    if (/\b404\b/.test(m)) return say("D.E.N.N.I.S. is running, but Claude's access is switched off (Capabilities -> CONNECTED APPS).");
    if (/\b401\b/.test(m)) return say("D.E.N.N.I.S. didn't accept the token. If it was just replaced, try again; otherwise restart him.");
    return say(`Couldn't reach D.E.N.N.I.S.: ${m}`);
  } finally {
    await client.close().catch(() => {});
  }
}

const server = new Server({ name: "dennis", title: "D.E.N.N.I.S.", version: VERSION }, { capabilities: { tools: {} }, instructions: INSTRUCTIONS });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
server.setRequestHandler(CallToolRequestSchema, async (req) => forward(req.params.name, req.params.arguments));
await server.connect(new StdioServerTransport());
