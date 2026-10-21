// `npm run check` - offline self-test. No API key, no network:
//  1. unit checks on path safety and tool-input validation
//  2. the real agent loop driven by a local fake of the Claude streaming API,
//     checking the request shape, tool execution, append-only history,
//     progress updates and the approval round-trip
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";

// the real, long path: on Windows os.tmpdir() can be an 8.3 short name (C:\Users\ANTHON~1\...),
// while the tools report the long one, so paths would never compare equal
const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "dennis-selftest-")));
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

// skills: install from a folder (folded YAML description) and from a lone .md
const skills = await import("../server/skills.js");
const skillSrc = path.join(tmp, "skill-src", "LED Wall Naming");
fs.mkdirSync(skillSrc, { recursive: true });
fs.writeFileSync(path.join(skillSrc, "SKILL.md"), "---\nname: LED wall render naming\ndescription: >\n  How to name LED wall renders. Use when saving\n  or renaming renders.\n---\n\n# Steps\n1. Use SHOW_SCENE_v###.\n");
fs.writeFileSync(path.join(skillSrc, "template.txt"), "SHOW_SCENE_v001");
const installed = skills.installSkill(path.dirname(skillSrc)); // the parent: SKILL.md is one level down, as in a repo zip
check("skill installs from a folder", installed?.name === "LED wall render naming", JSON.stringify(installed));
check("folded YAML description parsed", /Use when saving or renaming renders\./.test(installed?.description || ""), installed?.description);
check("skill reference files listed, SKILL.md excluded", JSON.stringify(skills.skillFiles(installed)) === '["template.txt"]');
check("skill paths can't escape the skill folder", throws(() => skills.skillPath(installed, "../../config.json")));
fs.writeFileSync(path.join(tmp, "Quick Tip.md"), "Always label the tapes.\n");
check("a lone .md installs as a skill", skills.installSkill(path.join(tmp, "Quick Tip.md"))?.id === "quick-tip");

// tool scoping: document skills, minions
const docTools = buildTools({ webSearch: false, docs: true });
check("document skills add code execution and save_generated_file", docTools.apiTools.some((t) => t.type === "code_execution_20260521") && docTools.byName.has("save_generated_file"));
check("no save_generated_file without document skills", !buildTools({ webSearch: false }).byName.has("save_generated_file"));
check("send_to_sandbox comes with document skills only", docTools.byName.has("send_to_sandbox") && !buildTools({ webSearch: false }).byName.has("send_to_sandbox"));
const { withUploads } = await import("../server/tools.js");
const tr = { type: "tool_result", tool_use_id: "t1", content: "sent" };
Object.defineProperty(tr, "uploads", { value: ["file_abc"], enumerable: false });
const withUp = withUploads([tr]);
check("sandbox uploads follow the tool results as container_upload blocks", withUp.length === 2 && withUp[1].type === "container_upload" && withUp[1].file_id === "file_abc");
check("the upload list never reaches the API JSON", !JSON.stringify(withUp).includes("uploads"));
const filesOnly = buildTools({ scope: "minion", allow: new Set(["files"]), webSearch: false });
check("a files-only minion gets the read tools only", filesOnly.byName.has("read_file") && [...filesOnly.byName.keys()].every((n) => ["list_folder", "search_files", "read_file", "file_info", "analyze_folder"].includes(n)), [...filesOnly.byName.keys()].join());
const writer = buildTools({ scope: "minion", allow: new Set(["files", "write", "skills", "docs", "web"]), webSearch: true, docs: true });
check("minions never drive the interface, touch memory or deploy minions", !["show_on_screen", "control_interface", "remember", "deploy_minion", "create_skill", "open_file"].some((n) => writer.byName.has(n)) && writer.byName.has("create_file") && writer.byName.has("use_skill"));

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
  // a minion's own loop: one tool call, then its report
  () => sse([start("m4"), ...toolBlock(0, "toolu_4", "list_folder", { path: path.join(files, "Projects") }), ...end("tool_use")]),
  () => sse([start("m5"), ...textBlock(0, "Report: Projects holds plan.md and summary.md."), ...end("end_turn")]),
  // D.E.N.N.I.S. briefing the user on it
  () => sse([start("m6"), ...textBlock(0, "Scout reports two files in Projects."), ...end("end_turn")]),
  // an API key without sandbox access: refused once, then fine without document skills
  () => ({ status: 400, body: { type: "error", error: { type: "invalid_request_error", message: "code_execution_20260521 is not available for this organization" } } }),
  () => sse([start("m8"), ...textBlock(0, "Carrying on."), ...end("end_turn")]),
];
const seen = [];
const fake = http.createServer(async (req, res) => {
  let body = "";
  for await (const c of req) body += c;
  seen.push({ url: req.url, headers: req.headers, body: JSON.parse(body || "{}") });
  const next = script[seen.length - 1];
  if (!next) { res.writeHead(500); return res.end("{}"); }
  const out = next();
  if (typeof out === "object") { res.writeHead(out.status, { "Content-Type": "application/json" }); return res.end(JSON.stringify(out.body)); }
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  res.end(out);
});
await new Promise((r) => fake.listen(0, "127.0.0.1", r));
process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${fake.address().port}`;

const { Config } = await import("../server/config.js");
const { startServer } = await import("../server/index.js");
const config = new Config();
config.update({ roots, apiKey: "sk-ant-test-not-real", userName: "Test" });

// a tiny MCP server over stdio: one read-only tool, one that changes things
const sdk = (p) => JSON.stringify(new URL(`../node_modules/@modelcontextprotocol/sdk/dist/esm/${p}`, import.meta.url).href);
const mcpScript = path.join(tmp, "test-mcp.mjs");
fs.writeFileSync(mcpScript, `import { Server } from ${sdk("server/index.js")};
import { StdioServerTransport } from ${sdk("server/stdio.js")};
import { ListToolsRequestSchema, CallToolRequestSchema } from ${sdk("types.js")};
const server = new Server({ name: "tester", version: "1.0.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [
  { name: "echo", description: "Echo text back.", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] }, annotations: { readOnlyHint: true } },
  { name: "make_thing", description: "Pretend to change something.", inputSchema: { $schema: "http://json-schema.org/draft-07/schema#", type: "object", properties: { name: { type: "string" } }, required: ["name"] } },
] }));
server.setRequestHandler(CallToolRequestSchema, async (req) => ({ content: [{ type: "text", text: req.params.name + " says " + JSON.stringify(req.params.arguments) }] }));
await server.connect(new StdioServerTransport());
`);
config.update({ mcpServers: { tester: { command: process.execPath, args: [mcpScript] } } });
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

// ---------------------------------------------------------------- 3. capabilities in the live request
check("system prompt lists the installed skill", JSON.stringify(first.system).includes("LED wall render naming"));
check("document skills: container skills, code execution tool, beta header", first.container?.skills?.some((s) => s.skill_id === "pptx" && s.type === "anthropic") && first.tools?.some((t) => t.type === "code_execution_20260521") && /code-execution-2025-08-25/.test(seen[0]?.headers["anthropic-beta"]), JSON.stringify(first.container));
check("connected MCP tools offered to Claude", first.tools?.some((t) => t.name === "mcp__tester__echo"));
check("MCP schema cleaned for the API ($schema dropped)", first.tools?.find((t) => t.name === "mcp__tester__make_thing")?.input_schema && !("$schema" in first.tools.find((t) => t.name === "mcp__tester__make_thing").input_schema));
check("minions listed in the system prompt", JSON.stringify(first.system).includes("Scout"));

// MCP: the hub itself
const hub = srv.agent.mcp;
const tester = hub.status().find((s) => s.name === "tester");
check("MCP server connects over stdio", tester?.status === "connected", tester?.error || tester?.status);
const echo = hub.tools().find((t) => t.name === "mcp__tester__echo"), makeThing = hub.tools().find((t) => t.name === "mcp__tester__make_thing");
check("read-only MCP tool runs straight away; the other asks first", !!echo && !echo.approval && typeof makeThing?.approval === "function");
check("MCP tool call returns its result", JSON.stringify(await echo.run({ text: "hello" })).includes("hello"));

// minions: deploy over the API, let it run its own loop against the fake, then brief
const post = (route, body) => fetch(`${srv.url}/api${route}`, { method: "POST", headers: { "Content-Type": "application/json", "X-Dennis": "1", Cookie: cookie }, body: JSON.stringify(body) }).then((r) => r.json());
const dep = await post("/minions", { action: "deploy", minion: "Scout", task: "List what's in Projects." });
check("minion deployed", dep.ok && dep.run?.status === "running", JSON.stringify(dep));
for (let i = 0; i < 200 && srv.agent.minions.get(dep.run?.id)?.status === "running"; i++) await new Promise((r) => setTimeout(r, 25));
const run = srv.agent.minions.get(dep.run?.id);
check("minion ran its own tool loop and reported", run?.status === "done" && run.report.includes("plan.md"), `${run?.status} ${run?.error || ""}`);
const mreq = seen[3]?.body || {};
check("minion has its own brief and a narrower toolset", JSON.stringify(mreq.system).includes("minions of D.E.N.N.I.S.") && mreq.tools?.some((t) => t.name === "list_folder") && !mreq.tools?.some((t) => ["show_on_screen", "deploy_minion", "remember"].includes(t.name)));
check("minion's tool result fed back into its loop", JSON.stringify(seen[4]?.body?.messages?.at(-1)).includes("toolu_4"));
const chat = async (body) => {
  const r = await fetch(`${srv.url}/api/chat`, { method: "POST", headers: { "Content-Type": "application/json", "X-Dennis": "1", Cookie: cookie }, body: JSON.stringify(body) });
  return (await r.text()).split("\n\n").filter((l) => l.startsWith("data: ")).map((l) => JSON.parse(l.slice(6)));
};
await chat({ text: "A minion has reported back.", context: { input: "event" } });
check("the report rides in his next message", JSON.stringify(seen[5]?.body?.messages?.at(-1)).includes("<minion_report") && JSON.stringify(seen[5]?.body?.messages?.at(-1)).includes("plan.md"));
const again = await chat({ text: "A minion has reported back.", context: { input: "event" } });
check("a briefing with nothing new makes no model call", seen.length === 6 && again.some((e) => e.type === "done" && e.stop_reason === "nothing_to_report"), `calls: ${seen.length}`);
const fb = await chat({ text: "Make me a deck", context: { input: "typed" } });
const retried = seen[7]?.body || {};
check("no sandbox access: retried without document skills", !!seen[6]?.body?.container && !retried.container && !retried.tools?.some((t) => t.type === "code_execution_20260521") && fb.some((e) => e.type === "done" && e.stop_reason === "end_turn"), `calls: ${seen.length}`);
check("...and said so", fb.some((e) => e.type === "progress" && /document skills/.test(e.delta)));

// ---------------------------------------------------------------- undo
const undoMod = await import("../server/undo.js");
check("the file created in the chat is in the undo history", undoMod.history(5).some((e) => e.kind === "create" && e.path === newFile));
const u1 = await post("/undo", { count: 1 });
check("undo takes the new file away, without deleting it", u1.ok && !fs.existsSync(newFile) && fs.readdirSync(undoMod.UNDONE_DIR, { recursive: true }).some((f) => String(f).endsWith("summary.md")), JSON.stringify(u1));
check("undo says what it did and which folder changed", /summary\.md/.test(u1.text) && u1.refresh?.some((p) => p === path.join(files, "Projects")));
const renamedFrom = path.join(files, "notes.txt"), renamedTo = path.join(files, "notes-renamed.txt");
fs.renameSync(renamedFrom, renamedTo);
undoMod.recordChange({ kind: "move", from: renamedFrom, to: renamedTo, label: "rename notes.txt" });
const u2 = await post("/undo", { count: 1 });
check("undo puts a renamed file back", fs.existsSync(renamedFrom) && !fs.existsSync(renamedTo), JSON.stringify(u2));
const u3 = await post("/undo", { count: 1 });
check("nothing left: undo says so", /nothing to undo/i.test(u3.text), u3.text);

// ---------------------------------------------------------------- reminders and the briefing
const { Reminders } = await import("../server/reminders.js");
const heard = [];
const rem = new Reminders({ announce: (r, o) => { heard.push({ text: r.text, missed: o.missed }); return true; } });
check("a reminder in the past is refused", throws(() => rem.add({ text: "too late", at: Date.now() - 3_600_000 })));
check("an unreadable time is refused", throws(() => rem.add({ text: "when?", at: "next-ish" })));
rem.add({ text: "check the LED calibration", at: Date.now() + 200 });
const daily = rem.add({ text: "stand-up", at: Date.now() + 200, repeat: "daily" });
rem.list.push({ id: "old1", text: "call the gaffer", at: Date.now() - 3_600_000, fired: false, repeat: null });
await new Promise((r) => setTimeout(r, 400));
rem.tick();
check("due reminders go off", heard.some((h) => h.text === "check the LED calibration" && !h.missed));
check("one that came due while closed is announced as missed", heard.some((h) => h.text === "call the gaffer" && h.missed));
check("a daily reminder rolls forward a day", !daily.fired && daily.at > Date.now() + 23 * 3_600_000, new Date(daily.at).toString());
rem.close();
const bt = buildTools({ webSearch: false });
const brief = await bt.byName.get("briefing_data").run({}, { reminders: rem, index: srv.agent.index, config, minions: srv.agent.minions });
check("the briefing gathers reminders, file activity and disk space", /Today's reminders/.test(brief) && /check the LED calibration/.test(brief) && /Disk space:/.test(brief) && /files changed/i.test(brief), brief);

// ---------------------------------------------------------------- the storage report
const ue = path.join(files, "Projects", "MyShow");
fs.mkdirSync(path.join(ue, "DerivedDataCache"), { recursive: true });
fs.mkdirSync(path.join(files, "NotUnreal", "Intermediate"), { recursive: true });
fs.writeFileSync(path.join(ue, "MyShow.uproject"), "{}");
fs.writeFileSync(path.join(ue, "DerivedDataCache", "ddc.bin"), Buffer.alloc(60e6, 1));
fs.writeFileSync(path.join(files, "NotUnreal", "Intermediate", "big.bin"), Buffer.alloc(60e6, 2));
const clip = Buffer.alloc(6e6, 7);
fs.writeFileSync(path.join(files, "Projects", "render_v1.mov"), clip);
fs.writeFileSync(path.join(files, "render_copy.mov"), clip);
await srv.agent.index.rebuild();
const report = await bt.byName.get("storage_report").run({}, { config, index: srv.agent.index, safe: (p) => p });
check("storage report: free space, biggest folders and files", /Disk space:/.test(report) && /Biggest folders:/.test(report) && /Biggest files:/.test(report), report.slice(0, 200));
check("storage report: an Unreal cache is flagged as safe to clear", /DerivedDataCache - \d+ MB: Unreal derived-data cache/.test(report), report);
check("storage report: an 'Intermediate' folder outside a Unreal project is not", !/NotUnreal[\\/]Intermediate - /.test(report));
check("storage report: identical renders found as likely duplicates", /Likely duplicates/.test(report) && /render_v1\.mov/.test(report) && /render_copy\.mov/.test(report));

// ---------------------------------------------------------------- the folder watcher
const { FolderWatcher, inQuietHours } = await import("../server/watcher.js");
const { kindOf: kindOfFile } = await import("../server/kinds.js");
const dropDir = path.join(files, "Renders");
fs.mkdirSync(dropDir, { recursive: true });
const notices = [];
const wcfg = { get: (k) => (k === "roots" ? roots : k === "watch" ? { enabled: true, minFiles: 3, quiet: null, dnd: false } : config.get(k)) };
const fw = new FolderWatcher({ config: wcfg, index: null, kindOf: kindOfFile, notify: (n) => { notices.push(n); return true; } });
await new Promise((r) => setTimeout(r, 300));
for (let i = 1; i <= 4; i++) fs.writeFileSync(path.join(dropDir, `shot_010_v00${i}.png`), "png");
fs.writeFileSync(path.join(dropDir, "render.png.part"), "partial");
await new Promise((r) => setTimeout(r, 1200));
for (const b of fw.pending.values()) b.last = 0; // as if the batch had settled
fw.flush();
check("a batch of new files becomes one notice", notices.length === 1 && notices[0].type === "new_files" && notices[0].count === 4 && notices[0].kind === "image", JSON.stringify(notices));
check("in-progress downloads and temp files are ignored", !notices[0]?.sample.some((n) => n.endsWith(".part")));
for (let i = 5; i <= 8; i++) fs.writeFileSync(path.join(dropDir, `shot_010_v00${i}.png`), "png");
await new Promise((r) => setTimeout(r, 1200));
for (const b of fw.pending.values()) b.last = 0;
fw.lastNotice = 0;
fw.flush();
check("the same folder stays quiet during its cooldown", notices.length === 1);
fw.lastNotice = 0;
const quiet = new FolderWatcher({ config: { get: (k) => (k === "watch" ? { dnd: true } : k === "roots" ? [] : null) }, index: null, kindOf: kindOfFile, notify: () => { throw new Error("should not notify"); } });
let dndOk = true; try { quiet.deliver({ type: "disk_low" }); } catch { dndOk = false; }
check("do not disturb holds notices back", dndOk);
quiet.close(); fw.close();
check("quiet hours wrap past midnight", inQuietHours({ from: "22:00", to: "07:00" }, new Date(2026, 0, 1, 23, 30)) && inQuietHours({ from: "22:00", to: "07:00" }, new Date(2026, 0, 1, 6, 0)) && !inQuietHours({ from: "22:00", to: "07:00" }, new Date(2026, 0, 1, 12, 0)));

// ---------------------------------------------------------------- themes
config.update({ visuals: { theme: "neural" } });
check("the theme is saved with the other visuals", config.get("visuals").theme === "neural" && config.get("visuals").autoRotate === true, JSON.stringify(config.get("visuals")));
config.update({ visuals: { theme: "disco" } });
check("an unknown theme is ignored", config.get("visuals").theme === "neural");
const ciEvents = [];
const ci = await bt.byName.get("control_interface").run({ action: "theme", theme: "spiral" }, { ui: (e) => ciEvents.push(e) });
check("he can switch the theme", ciEvents[0]?.action === "theme" && ciEvents[0]?.theme === "spiral" && /spiral/.test(ci));
await bt.byName.get("control_interface").run({ action: "conversation_on" }, { ui: (e) => ciEvents.push(e) });
check("he can switch continuous conversation on", ciEvents[1]?.action === "conversation_on" && !validate(bt.byName.get("control_interface").input_schema, { action: "conversation_off" }));

// ---------------------------------------------------------------- diagrams
const sd = bt.byName.get("show_diagram");
const asked = [];
const dctx = (answer) => ({ uiAsk: async (ev) => { asked.push(ev); return answer(ev); }, safe: (p) => p, ui: () => {}, index: srv.agent.index, who: "D.E.N.N.I.S." });
const d1 = await sd.run({ title: "Signal flow", mermaid: "flowchart LR\n  MS[Media server] --> P[LED processor] --> W[LED wall]" }, dctx(() => ({ ok: true })));
check("show_diagram puts it on screen", /on screen/.test(d1) && asked[0]?.action === "diagram" && /LED processor/.test(asked[0]?.mermaid) && !asked[0]?.want, d1);
const d2 = await sd.run({ title: "Broken", mermaid: "flowchart LR\n  A -->" }, dctx(() => ({ ok: false, error: "Parse error on line 2" })));
check("Mermaid's syntax error comes back for him to fix", /Parse error on line 2/.test(d2?.error || ""), JSON.stringify(d2));
const dSave = path.join(files, "Diagrams", "tracking.svg");
const d3 = await sd.run({ title: "Camera tracking", mermaid: "flowchart LR\n  A --> B", save_to: dSave }, dctx((ev) => ({ ok: true, svg: ev.want === "svg" ? "<svg xmlns='http://www.w3.org/2000/svg'></svg>" : null })));
check("a diagram can be saved into their folders (undoable)", fs.existsSync(dSave) && undoMod.history(1)[0]?.path === dSave && /saved to/.test(d3), d3);
const d4 = await sd.run({ title: "Camera tracking", mermaid: "flowchart LR\n  A --> B", save_to: dSave }, dctx(() => ({ ok: true })));
check("...and never over an existing file", /already exists/.test(d4?.error || ""));
check("saving asks first; just showing one doesn't", !!sd.approval({ title: "x", save_to: "y" }) && !sd.approval({ title: "x" }));
const d5 = await sd.run({ title: "Nobody home", mermaid: "flowchart LR\n  A --> B" }, dctx(() => null));
check("no window to answer: he's told it may not have drawn", /didn't confirm/.test(d5));

// ---------------------------------------------------------------- messaging: WhatsApp and Teams (against fakes of Meta and Microsoft)
{
  const { RemoteHub } = await import("../server/remote.js");
  const { validSignature, toWhatsApp, splitText } = await import("../server/whatsapp.js");
  const { TeamsChannel, fromTeamsHtml } = await import("../server/teams.js");
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (fn, ms = 4000) => { const t0 = Date.now(); while (!fn() && Date.now() - t0 < ms) await wait(25); return fn(); };
  const crypto = await import("node:crypto");
  const ME = "971500000001", PORT = 47931;
  const store = { remote: {
    whatsapp: { enabled: true, phoneNumberId: "1234567", allow: [ME], port: PORT, apiVersion: "v23.0", template: "", templateLang: "en", verifyToken: "vt-test", publicUrl: "" },
    teams: { enabled: true, tenant: "organizations", clientId: "client-1", chatId: "chat-1", chatName: "Notes", pollSeconds: 6, account: "" },
    forward: { reminders: true, minions: true, watcher: true, approvals: true, awayOnly: true, awayMinutes: 10, via: "whatsapp" },
  } };
  const secrets = { waToken: "wa-token", waAppSecret: "app-secret", teamsRefresh: "rt-1" };
  const fcfg = { get: (k) => store[k], getSecret: (k) => secrets[k], setSecret: (k, v) => { if (v) secrets[k] = v; else delete secrets[k]; }, save: () => {}, update: () => {} };
  const out = [], teamsInbox = [];
  const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json" } });
  const fakeFetch = async (url, opts = {}) => {
    url = String(url);
    if (url.startsWith(`http://127.0.0.1:${PORT}`)) return fetch(url, opts); // the real listener
    const body = typeof opts.body === "string" && opts.body.startsWith("{") ? JSON.parse(opts.body) : opts.body;
    out.push({ url, method: opts.method || "GET", body });
    if (url.includes("graph.facebook.com")) return json({ messages: [{ id: `wamid.${out.length}` }] });
    if (url.includes("login.microsoftonline.com")) return json({ access_token: "at-1", refresh_token: "rt-2", expires_in: 3600 });
    if (url.includes("/me?")) return json({ id: "me-1", displayName: "Tester" });
    if (url.includes("/chats/chat-1/messages") && (opts.method || "GET") === "GET") return json({ value: teamsInbox });
    if (url.includes("/chats/chat-1/messages")) return json({ id: `sent-${out.length}` });
    return json({ error: { message: "not faked" } }, 404);
  };
  const turns = [], answered = [];
  const stubAgent = {
    busy: false,
    resolveApproval: (id, yes) => { answered.push([id, yes]); return true; },
    async turn({ text, context, emit }) {
      turns.push({ text, context });
      if (/move/.test(text)) { emit({ type: "approval", id: "ap1", title: "Move this file?", detail: "notes.txt -> Archive" }); await until(() => answered.length); emit({ type: "approval_done", id: "ap1", yes: answered[0][1] }); }
      emit({ type: "text", delta: `**Done**: ${text}` });
      emit({ type: "done" });
    },
  };
  let away = true;
  const hub = new RemoteHub({ config: fcfg, agent: stubAgent, isAway: () => away, fetchImpl: fakeFetch, stateFile: path.join(tmp, "remote-state.json") });
  await hub.wa.start();
  const sign = (raw) => "sha256=" + crypto.createHmac("sha256", "app-secret").update(raw).digest("hex");
  const hook = (msg, signed = true) => { const raw = JSON.stringify({ object: "whatsapp_business_account", entry: [{ id: "waba", changes: [{ field: "messages", value: { metadata: { phone_number_id: "1234567" }, messages: [msg] } }] }] });
    return fetch(`http://127.0.0.1:${PORT}/whatsapp`, { method: "POST", headers: { "Content-Type": "application/json", ...(signed ? { "X-Hub-Signature-256": sign(raw) } : {}) }, body: raw }); };
  const waSends = () => out.filter((o) => o.url.includes("graph.facebook.com") && o.body?.type);

  check("WhatsApp signatures are checked", validSignature(Buffer.from("x"), sign("x"), "app-secret") && !validSignature(Buffer.from("x"), sign("y"), "app-secret"));
  const v = await fetch(`http://127.0.0.1:${PORT}/whatsapp?hub.mode=subscribe&hub.verify_token=vt-test&hub.challenge=abc123`);
  const vBad = await fetch(`http://127.0.0.1:${PORT}/whatsapp?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=abc123`);
  check("Meta's callback check is answered (and only with the right verify token)", (await v.text()) === "abc123" && vBad.status === 403);
  check("nothing else is reachable through the WhatsApp listener", (await fetch(`http://127.0.0.1:${PORT}/api/state`)).status === 404);
  check("an unsigned webhook call is refused", (await hook({ id: "m0", from: ME, type: "text", text: { body: "hi" } }, false)).status === 401 && !turns.length);
  await hook({ id: "m1", from: ME, type: "text", text: { body: "what's in Downloads?" } });
  await until(() => waSends().length);
  const r1 = waSends()[0];
  check("your WhatsApp message runs a turn, marked as coming from your phone", turns[0]?.text === "what's in Downloads?" && turns[0]?.context.input === "remote" && turns[0]?.context.channel === "WhatsApp", JSON.stringify(turns));
  check("...and the reply comes back in WhatsApp's style", r1?.body.to === ME && r1?.body.text?.body === "*Done*: what's in Downloads?", JSON.stringify(r1?.body));
  await hook({ id: "m1", from: ME, type: "text", text: { body: "what's in Downloads?" } }); // Meta delivering it twice
  await hook({ id: "m2", from: "447700900000", type: "text", text: { body: "hello?" } }); // a stranger
  await wait(300);
  check("duplicates and strangers are ignored", turns.length === 1 && hub.wa.ignored === 1);
  await hook({ id: "m3", from: ME, type: "text", text: { body: "move notes.txt into Archive" } });
  await until(() => waSends().some((o) => o.body.type === "interactive"));
  const ask = waSends().find((o) => o.body.type === "interactive");
  check("an approval comes to WhatsApp as Allow / Cancel buttons", ask?.body.interactive.action.buttons[0].reply.id === "ap:ap1:yes" && /Move this file/.test(ask?.body.interactive.body.text), JSON.stringify(ask?.body));
  await hook({ id: "m4", from: ME, type: "interactive", interactive: { type: "button_reply", button_reply: { id: "ap:ap1:yes", title: "Allow" } } });
  await until(() => waSends().some((o) => /Done\*: move/.test(o.body.text?.body || "")));
  check("tapping Allow approves it, and the turn carries on", answered[0]?.[0] === "ap1" && answered[0]?.[1] === true && waSends().some((o) => /Done\*: move/.test(o.body.text?.body || "")));
  // updates: only while away; outside WhatsApp's 24 h window they wait for your next message
  away = false;
  check("while you're at the computer, updates stay off your phone", hub.notify("Reminder: check the LED calibration", { kind: "reminders" }) === false);
  away = true;
  hub.state.lastInbound[ME] = Date.now() - 30 * 3600_000;
  const before = waSends().length;
  check("while you're away they go to your phone", hub.notify("Scout finished: 3 processors found", { kind: "minions" }) === true);
  await wait(200);
  check("...but outside WhatsApp's 24-hour window they're held, not sent", waSends().length === before && hub.wa.status().held === 1);
  await hook({ id: "m5", from: ME, type: "text", text: { body: "morning" } });
  await until(() => waSends().some((o) => /While you were away/.test(o.body.text?.body || "")));
  check("...and delivered as soon as you write again", waSends().some((o) => /While you were away:[\s\S]*Scout finished/.test(o.body.text?.body || "")));
  check("long replies are split, markdown converted", splitText("a ".repeat(3000), 3900).length === 2 && toWhatsApp("## Title\n- one\n**b**") === "*Title*\n• one\n*b*");
  // the Cloudflare quick tunnel's new address goes to Meta by itself
  store.remote.whatsapp.appId = "998877";
  hub.wa.settleMs = 0;
  const reg = await hub.wa.registerWebhook("https://quiet-owl.trycloudflare.com");
  const sub = out.find((o) => o.url.includes("/998877/subscriptions"));
  const form = sub && new URLSearchParams(sub.body);
  check("a new tunnel address is registered with Meta (callback, verify token, app token)", reg.ok && form?.get("callback_url") === "https://quiet-owl.trycloudflare.com/whatsapp" && form?.get("verify_token") === "vt-test" && form?.get("access_token") === "998877|app-secret" && form?.get("fields") === "messages", JSON.stringify(reg));
  hub.close();
  config.update({ remote: { whatsapp: { allow: "+971 50 000 0001, 44 7700 900000", publicUrl: "my-dennis.example.com/whatsapp", tunnel: "sideways" } } });
  const wcfg2 = config.get("remote").whatsapp;
  check("numbers typed with spaces are understood; the address and tunnel choice are tidied", JSON.stringify(wcfg2.allow) === '["971500000001","447700900000"]' && wcfg2.publicUrl === "https://my-dennis.example.com" && wcfg2.tunnel === "own", JSON.stringify(wcfg2));
  config.update({ waToken: "secret-wa", teamsWebhook: "https://example.com/hook" });
  const pv = JSON.stringify(config.publicView());
  config.update({ waToken: "", teamsWebhook: "" });
  check("messaging tokens never reach the page", !pv.includes("secret-wa") && !pv.includes("example.com/hook"));

  // Teams: the chat you picked, checked every few seconds
  const got = [];
  const tm = new TeamsChannel({ config: fcfg, onMessage: (ch, m) => got.push(m), fetchImpl: fakeFetch });
  await tm.whoami();
  teamsInbox.push({ id: "t0", messageType: "message", createdDateTime: "2026-10-21T10:00:00Z", from: { user: { id: "me-1" } }, body: { content: "<p>old message</p>" } });
  await tm.poll(); // the first look only notes where the chat is up to
  teamsInbox.unshift(
    { id: "t3", messageType: "message", createdDateTime: "2026-10-21T10:03:00Z", from: { user: { id: "someone-else" } }, body: { content: "<p>not you</p>" } },
    { id: "t2", messageType: "message", createdDateTime: "2026-10-21T10:02:00Z", from: { user: { id: "me-1" } }, body: { content: "<p>\u{1F916} D.E.N.N.I.S.</p><p>his own reply</p>" } },
    { id: "t1", messageType: "message", createdDateTime: "2026-10-21T10:01:00Z", from: { user: { id: "me-1" } }, body: { content: "<p>Summarise <b>today&#39;s</b> renders</p>" } },
  );
  await tm.poll();
  check("Teams: your new message is picked up (old ones aren't replayed)", got.length === 1 && got[0].text === "Summarise today's renders", JSON.stringify(got));
  check("Teams: his own replies and other people's messages are ignored", !got.some((m) => /his own|not you/.test(m.text)));
  await tm.send(null, "All **six** renders are in.");
  const post = out.find((o) => o.method === "POST" && o.url.includes("/chats/chat-1/messages"));
  check("Teams: replies go to the chat, marked as D.E.N.N.I.S.", /D\.E\.N\.N\.I\.S\.[\s\S]*<b>six<\/b>/.test(post?.body?.body?.content || ""), JSON.stringify(post?.body));
  check("Teams HTML comes in as plain text", fromTeamsHtml("<p>a&nbsp;b<br>c &amp; d</p>") === "a b\nc & d");
  tm.close();

  // the OneDrive inbox: messages to him with no app registration (a Workflow saves them, OneDrive syncs them here)
  const inboxDir = path.join(tmp, "OneDrive", "Dennis", "Inbox");
  store.remote.teams = { ...store.remote.teams, chatId: "", inboxFolder: inboxDir, inboxPrefix: true };
  secrets.teamsWebhook = "https://example.com/workflow-hook";
  const inboxGot = [];
  const ib = new TeamsChannel({ config: fcfg, onMessage: (ch, m) => inboxGot.push(m), fetchImpl: fakeFetch });
  ib.startInbox();
  clearInterval(ib.inboxTimer);
  await wait(50);
  const put = (name, text, ageMs) => { const f = path.join(inboxDir, name); fs.writeFileSync(f, text); const t = (Date.now() - ageMs) / 1000; fs.utimesSync(f, t, t); };
  put("1.txt", "<p>Dennis, what's new in <b>Renders</b>?</p>", 5000);
  put("2.txt", "buy milk on the way home", 5000);
  put("3.json", JSON.stringify({ text: "Dennis yes" }), 5000);
  put("4.txt", "Dennis, move everything to Archive", 3600_000); // written an hour ago, while he was off
  put("5.json", JSON.stringify({ responder: { displayName: "Tester" }, data: { reply: "sort the renders by shot", from: "dennis-card" } }), 5000); // a card reply
  await ib.scanInbox();
  await wait(100);
  check("inbox: messages that start with Dennis are picked up (HTML or JSON), and card replies need no prefix", inboxGot.map((m) => m.text).join("|") === "what's new in Renders?|yes|sort the renders by shot" && inboxGot.every((m) => m.from === "inbox") && ib.allowed("inbox"), JSON.stringify(inboxGot));
  check("inbox: other notes to self are left alone, and stale ones aren't acted on", ib.inbox.ignored === 1 && !inboxGot.some((m) => /Archive/.test(m.text)));
  check("inbox: every file is filed under Done - nothing deleted", fs.readdirSync(inboxDir).filter((n) => n !== "Done").length === 0 && fs.readdirSync(path.join(inboxDir, "Done")).length === 5);
  const cardPost = out.find((o) => o.url === "https://example.com/workflow-hook");
  const card = cardPost?.body?.attachments?.[0]?.content;
  check("inbox: his cards carry a reply box and a Send button", card?.body?.some((b) => b.type === "Input.Text" && b.id === "reply") && card?.actions?.[0]?.type === "Action.Submit", JSON.stringify(card));
  check("inbox: he says he set the stale one aside, through the Workflow", out.some((o) => o.url === "https://example.com/workflow-hook" && /set aside 1 message/.test(JSON.stringify(o.body))));
  ib.close();
}

// ---------------------------------------------------------------- 4. another brain (OpenAI-compatible: GPT, Gemini, Ollama, ...)
const compatSeen = [];
const compatChunks = [
  // a tool call whose arguments stream in two pieces
  [{ choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "list_folder", arguments: "{\"path\": " } }] } }] },
   { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(path.join(files, "Projects")) + "}" } }] } }] },
   { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }],
  [{ choices: [{ index: 0, delta: { content: "Projects has " } }] }, { choices: [{ index: 0, delta: { content: "two files." } }] },
   { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }, { choices: [], usage: { prompt_tokens: 120, completion_tokens: 9 } }],
];
const compat = http.createServer(async (req, res) => {
  let body = "";
  for await (const c of req) body += c;
  if (req.method === "GET" && req.url === "/v1/models") { res.writeHead(200, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ data: [{ id: "local-model" }, { id: "other-model" }] })); }
  compatSeen.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(body || "{}") });
  const chunks = compatChunks[compatSeen.length - 1];
  if (!chunks) { res.writeHead(500); return res.end("{}"); }
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  res.end(chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n");
});
await new Promise((r) => compat.listen(0, "127.0.0.1", r));
const compatUrl = `http://127.0.0.1:${compat.address().port}/v1`;
await post("/settings", { provider: "custom", brains: { custom: { model: "local-model", baseUrl: compatUrl } }, customKey: "test-compat-key" });
const listed = await post("/brains/models", { provider: "custom", baseUrl: compatUrl });
check("LIST MODELS asks the server", listed.ok && listed.models?.includes("local-model"), JSON.stringify(listed));
const cev = await chat({ text: "What's in Projects?", context: { input: "typed" } });
const c1 = compatSeen[0]?.body || {}, c2 = compatSeen[1]?.body || {};
check("other brain: Chat Completions request with the system prompt and function tools", compatSeen[0]?.url === "/v1/chat/completions" && c1.model === "local-model" && c1.messages?.[0]?.role === "system" && c1.tools?.some((t) => t.type === "function" && t.function.name === "list_folder"), JSON.stringify(c1).slice(0, 200));
check("other brain: its key goes in the Authorization header", compatSeen[0]?.auth === "Bearer test-compat-key");
check("other brain: no Claude-only tools (web search, sandbox)", !c1.tools?.some((t) => ["web_search", "code_execution", "save_generated_file"].includes(t.function?.name)));
check("other brain: streamed tool call ran, result sent back as a tool message", c2.messages?.some((m) => m.role === "assistant" && m.tool_calls?.[0]?.id === "call_1") && c2.messages?.some((m) => m.role === "tool" && m.tool_call_id === "call_1" && m.content.includes("plan.md")), JSON.stringify(c2.messages?.slice(-2)).slice(0, 300));
check("other brain: reply streamed to the UI", cev.filter((e) => e.type === "text").map((e) => e.delta).join("") === "Projects has two files." && cev.some((e) => e.type === "done" && e.stop_reason === "end_turn"));
await post("/settings", { provider: "anthropic" });
compat.close();

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
