// `npm run check` - offline self-test. No API key, no network:
//  1. unit checks on path safety and tool-input validation
//  2. the real agent loop driven by a local fake of the Claude streaming API,
//     checking the request shape, tool execution, append-only history,
//     progress updates and the approval round-trip
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dennis-selftest-"));
const home = path.join(tmp, "home");
const files = path.join(tmp, "files");
fs.mkdirSync(path.join(files, "Projects"), { recursive: true });
fs.writeFileSync(path.join(files, "Projects", "plan.md"), "# Plan\nShip it.\n");
fs.writeFileSync(path.join(files, "notes.txt"), "remember the milk\n");
process.env.DENNIS_HOME = home;

let failures = 0;
const check = (name, ok, detail = "") => { console.log(`${ok ? "  ok  " : "  FAIL"} ${name}${!ok && detail ? ` - ${detail}` : ""}`); if (!ok) failures++; };

// ---------------------------------------------------------------- 1. units
const { resolveSafe } = await import("../server/paths.js");
const { validate, buildTools } = await import("../server/tools.js");
const roots = [{ path: files, label: "Files" }];
const throws = (fn) => { try { fn(); return false; } catch { return true; } };
check("path inside a root resolves", !throws(() => resolveSafe(path.join(files, "notes.txt"), roots)));
check("path outside the roots is refused", throws(() => resolveSafe(os.homedir(), roots)));
check("../ escape is refused", throws(() => resolveSafe(path.join(files, "..", "home"), roots, { mustExist: false })));
check("relative path is refused", throws(() => resolveSafe("notes.txt", roots)));
const { byName, apiTools } = buildTools({ webSearch: true });
check("validator rejects a missing field", !!validate(byName.get("read_file").input_schema, {}));
check("validator rejects a wrong type", !!validate(byName.get("read_file").input_schema, { path: 3 }));
check("validator rejects unknown fields", !!validate(byName.get("read_file").input_schema, { path: "x", evil: 1 }));
check("validator accepts good input", validate(byName.get("move_file").input_schema, { source: "a", destination: "b" }) === null);
check("client tools stream eagerly; server tool doesn't", apiTools.filter((t) => t.input_schema).every((t) => t.eager_input_streaming === true) && apiTools.some((t) => t.type === "web_search_20260209" && !("eager_input_streaming" in t)));

// ---------------------------------------------------------------- 2. agent loop vs. a fake Claude API
const sse = (events) => events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
const start = (id) => ({ type: "message_start", message: { id, type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 50, output_tokens: 1 } } });
const end = (reason) => [{ type: "message_delta", delta: { stop_reason: reason, stop_sequence: null }, usage: { output_tokens: 30 } }, { type: "message_stop" }];
const progressBlock = (i, text) => [
  { type: "content_block_start", index: i, content_block: { type: "thinking", thinking: "", signature: "" } },
  { type: "content_block_delta", index: i, delta: { type: "thinking_delta", thinking: text } },
  { type: "content_block_delta", index: i, delta: { type: "signature_delta", signature: "sig-" + i } },
  { type: "content_block_stop", index: i },
];
const toolBlock = (i, id, name, input) => [
  { type: "content_block_start", index: i, content_block: { type: "tool_use", id, name, input: {} } },
  { type: "content_block_delta", index: i, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } },
  { type: "content_block_stop", index: i },
];
const textBlock = (i, text) => [
  { type: "content_block_start", index: i, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: i, delta: { type: "text_delta", text } },
  { type: "content_block_stop", index: i },
];
const newFile = path.join(files, "Projects", "summary.md");
const script = [
  () => sse([start("m1"), ...progressBlock(0, "Looking through Projects."), ...toolBlock(1, "toolu_1", "list_folder", { path: path.join(files, "Projects") }), ...end("tool_use")]),
  () => sse([start("m2"), ...toolBlock(0, "toolu_2", "create_file", { path: newFile, content: "# Summary\nOne plan.\n" }), ...end("tool_use")]),
  () => sse([start("m3"), ...textBlock(0, "Done. I listed Projects and wrote a summary."), ...end("end_turn")]),
];
const seen = [];
const fake = http.createServer(async (req, res) => {
  let body = "";
  for await (const c of req) body += c;
  seen.push({ url: req.url, headers: req.headers, body: JSON.parse(body || "{}") });
  const next = script[seen.length - 1];
  if (!next) { res.writeHead(500); return res.end("{}"); }
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  res.end(next());
});
await new Promise((r) => fake.listen(0, "127.0.0.1", r));
process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${fake.address().port}`;

const { Config } = await import("../server/config.js");
const { startServer } = await import("../server/index.js");
const config = new Config();
config.update({ roots, apiKey: "sk-ant-test-not-real", userName: "Test" });
const srv = await startServer({ config, platform: { electron: false, openPath: async () => "", revealPath: () => {} }, port: 47890 });
const cookie = `dennis_k=${config.get("token")}`;

const events = [];
const res = await fetch(`${srv.url}/api/chat`, {
  method: "POST",
  headers: { "Content-Type": "application/json", "X-Dennis": "1", Cookie: cookie },
  body: JSON.stringify({ text: "Summarise my projects into a file", context: { view: "overview", input: "typed" } }),
});
const reader = res.body.getReader();
const dec = new TextDecoder();
let buf = "";
for (;;) {
  const { value, done } = await reader.read();
  if (done) break;
  buf += dec.decode(value, { stream: true });
  let i;
  while ((i = buf.indexOf("\n\n")) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 2);
    if (!line.startsWith("data: ")) continue;
    const ev = JSON.parse(line.slice(6));
    events.push(ev);
    if (ev.type === "approval") {
      await fetch(`${srv.url}/api/approve`, { method: "POST", headers: { "Content-Type": "application/json", "X-Dennis": "1", Cookie: cookie }, body: JSON.stringify({ id: ev.id, yes: true }) });
    }
  }
}

const first = seen[0]?.body || {};
check("model call went to the Messages API", seen[0]?.url?.startsWith("/v1/messages"), seen[0]?.url);
check("three model calls in one turn", seen.length === 3, `got ${seen.length}`);
check("model is claude-opus-5-5", first.model === "claude-opus-5-5", first.model);
check("beta headers sent", /server-side-fallback-2026-07-01/.test(seen[0]?.headers["anthropic-beta"]) && /thinking-display-updates-2026-08-18/.test(seen[0]?.headers["anthropic-beta"]), seen[0]?.headers["anthropic-beta"]);
check("fallbacks: default", first.fallbacks === "default");
check("adaptive thinking with progress updates", first.thinking?.type === "adaptive" && first.thinking?.display === "updates");
check("effort set explicitly", first.output_config?.effort === "low");
check("streaming on", first.stream === true);
check("app context rides in the user message", JSON.stringify(first.messages?.[0]).includes("<app_context>"));
const second = seen[1]?.body?.messages || [];
check("history appends the assistant turn unchanged (thinking + signature kept)", JSON.stringify(second[1]?.content?.[0]) === JSON.stringify({ type: "thinking", thinking: "Looking through Projects.", signature: "sig-0" }), JSON.stringify(second[1]?.content?.[0]));
check("tool result returned for the tool call", second[2]?.content?.[0]?.type === "tool_result" && second[2].content[0].tool_use_id === "toolu_1" && String(second[2].content[0].content).includes("plan.md"));
check("system prompt and tools identical across calls", JSON.stringify(seen[0]?.body?.system) === JSON.stringify(seen[2]?.body?.system) && JSON.stringify(seen[0]?.body?.tools) === JSON.stringify(seen[2]?.body?.tools));
check("prefix of call 2 is preserved in call 3", JSON.stringify(seen[2]?.body?.messages?.slice(0, 3)) === JSON.stringify(second.slice(0, 3)));
check("progress update forwarded to the UI", events.some((e) => e.type === "progress" && e.delta.includes("Looking through")));
check("approval requested before creating", events.some((e) => e.type === "approval" && e.tool === "create_file"));
check("file created after approval", fs.existsSync(newFile));
check("final text streamed", events.filter((e) => e.type === "text").map((e) => e.delta).join("").includes("Done."));
check("turn ended cleanly", events.some((e) => e.type === "done" && e.stop_reason === "end_turn"));
check("UI asked to refresh the changed folder", events.some((e) => e.type === "ui" && e.action === "refresh"));

// unauthenticated and cross-site requests are refused
const locked = await fetch(`${srv.url}/api/state`);
check("API locked without the session cookie", locked.status === 401);
const noHeader = await fetch(`${srv.url}/api/new`, { method: "POST", headers: { Cookie: cookie } });
check("POST without X-Dennis refused", noHeader.status === 403);
const outside = await fetch(`${srv.url}/api/raw?path=${encodeURIComponent(os.homedir())}`, { headers: { Cookie: cookie } });
check("raw file outside roots refused", outside.status === 403);

await srv.close();
fake.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `\n${failures} check(s) FAILED` : "\nall checks passed");
process.exit(failures ? 1 : 0);
