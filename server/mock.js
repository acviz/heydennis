// Mock brain for trying the interface without an API key (`npm run mock`).
// It is not Claude: it pattern-matches a few phrases and drives the same tool
// pipeline the real agent uses, so the galaxy, approvals and voice can be
// exercised end to end.
import path from "node:path";
import crypto from "node:crypto";
import { runTool } from "./tools.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function say(emit, text, signal) {
  emit({ type: "text_start" });
  for (const word of text.split(/(?<=\s)/)) {
    if (signal?.aborted) return;
    emit({ type: "text", delta: word });
    await sleep(28);
  }
  emit({ type: "block_stop" });
}

async function call(name, input, emit, toolCtx, registry) {
  const block = { type: "tool_use", id: "mock_" + crypto.randomUUID().slice(0, 8), name, input };
  emit({ type: "tool", id: block.id, name, input, status: "run" });
  const r = await runTool(block, toolCtx, registry);
  emit({ type: "tool", id: block.id, name, status: r.is_error ? "error" : "done" });
  return r;
}

export async function mockTurn({ text, context, emit, toolCtx, registry, signal }) {
  const t = String(text || "").toLowerCase();
  const roots = toolCtx.config.get("roots") || [];
  const root = roots.find((r) => t.includes(r.label.toLowerCase()));

  if (/^(hi|hello|hey)\b/.test(t)) {
    await say(emit, "Good to see you. I'm in mock mode at the moment - all charm, no brain. Add a Claude API key in Settings and I'll do the thinking as well.", signal);
  } else if (/(go )?home|overview|all (my )?folders/.test(t)) {
    await call("control_interface", { action: "home" }, emit, toolCtx, registry);
    await say(emit, "Back to the overview. The whole empire, at a glance.", signal);
  } else if (/\bback\b/.test(t)) {
    await call("control_interface", { action: "back" }, emit, toolCtx, registry);
    await say(emit, "Up one level.", signal);
  } else if (root && /(show|open|go to|take me|pull up)/.test(t)) {
    await call("show_on_screen", { path: root.path }, emit, toolCtx, registry);
    await say(emit, `Your ${root.label} folder. Brace yourself.`, signal);
  } else if (/(find|search|where)/.test(t)) {
    const q = t.replace(/.*?(find|search for|search|where is|where are|where's)\s+(my\s+|the\s+)?/, "").replace(/[?.!]/g, "").trim();
    const r = await call("search_files", { query: q, limit: 30 }, emit, toolCtx, registry);
    const paths = String(r.content).split("\n").map((l) => (l.match(/^- (.+?) \[/) || [])[1]).filter(Boolean);
    if (paths.length) {
      await call("present_files", { title: `Search: ${q}`, paths }, emit, toolCtx, registry);
      await say(emit, `${paths.length} match${paths.length === 1 ? "" : "es"} for ${q}, on screen now.`, signal);
    } else {
      await say(emit, `Nothing called ${q}, I'm afraid. Either it doesn't exist or it's very well hidden.`, signal);
    }
  } else if (/(note|write|create)/.test(t) && roots[0]) {
    const p = path.join(roots[0].path, `DENNIS note ${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.md`);
    await say(emit, "Drafting a note for you. ", signal);
    const r = await call("create_file", { path: p, content: `# Note\n\n${text}\n` }, emit, toolCtx, registry);
    await say(emit, r.is_error ? "Very well. Consider it never written." : `Done. It's in ${roots[0].label}.`, signal);
  } else if (/(space|disk|status|system)/.test(t)) {
    const r = await call("system_status", {}, emit, toolCtx, registry);
    const disk = String(r.content).split("\n").find((l) => l.startsWith("disk")) || "";
    await say(emit, `All systems in fine fettle. ${disk.replace(/^disk \(([^)]*)\): /, "On the $1 drive you have ")}.`, signal);
  } else if (context?.selected && /(what|tell|about|summar)/.test(t)) {
    const r = await call("file_info", { path: context.selected }, emit, toolCtx, registry);
    await say(emit, `That's ${path.basename(context.selected)}. ${String(r.content).split("\n").slice(1, 3).join(", ")}. With an API key I could actually read it for you.`, signal);
  } else {
    await say(emit, `Mock mode heard: "${text}". Try "show my downloads", "find invoice", "make a note", "system status", or "go home". Add an API key in Settings for the real thing.`, signal);
  }
  emit({ type: "done", stop_reason: "end_turn", mock: true });
}
