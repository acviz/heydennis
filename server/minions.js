// Minions: worker agents D.E.N.N.I.S. sends off on tasks while he carries on with you.
//
// A minion is defined once (a name, a role, and the toolsets it may use) and can be
// deployed on any number of tasks. Each deployment is its own Claude conversation with
// its own tool loop, running in the background; several can run at once. Minions use the
// same tools and the same safety rules as D.E.N.N.I.S. - every change still waits for your
// yes in "ask" mode - but they never drive the interface, never touch his memory, and
// can't deploy minions of their own. When one finishes, its report goes back to him.
import crypto from "node:crypto";
import { buildTools, runTool, TOOLSETS, withUploads } from "./tools.js";

export { TOOLSETS };
const MAX_STEPS = 40;
const MAX_TOKENS = 32000;
const MAX_RUNNING = 4;
const KEEP_RUNS = 30;

/** Clean a definition from Claude or the settings screen; throws on nonsense. */
export function cleanDefinition(d) {
  const name = String(d?.name || "").replace(/\s+/g, " ").trim();
  if (!/^[\p{L}\p{N}][\p{L}\p{N} '._-]{0,31}$/u.test(name)) throw new Error("A minion needs a short name (letters, digits, spaces; up to 32 characters).");
  const role = String(d?.role || "").trim().slice(0, 2000);
  if (!role) throw new Error("Give the minion a role: what it's for and how it should work.");
  const tools = [...new Set((Array.isArray(d?.tools) ? d.tools : ["files"]).map(String).filter((t) => t in TOOLSETS))];
  const effort = ["low", "medium", "high", "xhigh", "max"].includes(d?.effort) ? d.effort : "medium";
  return { name, role, tools: tools.length ? tools : ["files"], effort };
}

const textOf = (content) => (content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();

export class MinionManager {
  /** agent: the main Agent (its client, config, tools, approvals); broadcast(ev): send to every open window. */
  constructor({ agent, broadcast }) {
    this.agent = agent;
    this.broadcast = broadcast || (() => {});
    this.runs = new Map(); // id -> run
  }

  get config() { return this.agent.config; }
  definitions() { return (this.config.get("minions") || []).map((d) => { try { return cleanDefinition(d); } catch { return null; } }).filter(Boolean); }
  find(name) { const want = String(name || "").trim().toLowerCase(); return this.definitions().find((d) => d.name.toLowerCase() === want) || null; }

  /** Add or replace a definition (by name). */
  define(def) {
    const d = cleanDefinition(def);
    const list = this.definitions().filter((x) => x.name.toLowerCase() !== d.name.toLowerCase());
    list.push(d);
    this.config.update({ minions: list });
    this.broadcast({ type: "minions", definitions: this.definitions() });
    return d;
  }

  undefine(name) {
    const want = String(name || "").trim().toLowerCase();
    const list = this.definitions().filter((x) => x.name.toLowerCase() !== want);
    this.config.update({ minions: list });
    this.broadcast({ type: "minions", definitions: this.definitions() });
  }

  view(run) {
    const { id, name, minion, task, status, startedAt, endedAt, steps, activity, report, error, delivered } = run;
    return { id, name, minion, task, status, startedAt, endedAt, steps, activity, report, error, delivered };
  }
  list() { return [...this.runs.values()].map((r) => this.view(r)).sort((a, b) => b.startedAt - a.startedAt); }
  running() { return [...this.runs.values()].filter((r) => r.status === "running"); }
  get(idOrName) {
    const k = String(idOrName || "").trim().toLowerCase();
    return this.runs.get(idOrName) || [...this.runs.values()].filter((r) => r.name.toLowerCase() === k || r.id.startsWith(k)).sort((a, b) => b.startedAt - a.startedAt)[0] || null;
  }

  update(run, patch = {}) {
    Object.assign(run, patch);
    this.broadcast({ type: "minion", run: this.view(run) });
  }

  /**
   * Send a minion off on a task. `minion` names a definition; without one, a general
   * helper is used. Returns the run straight away; the work carries on in the background.
   */
  deploy({ minion, task, label } = {}) {
    task = String(task || "").trim();
    if (!task) throw new Error("A minion needs a task.");
    if (this.running().length >= MAX_RUNNING) throw new Error(`${MAX_RUNNING} minions are already out. Wait for one to finish, or recall one.`);
    let def = minion ? this.find(minion) : null;
    if (minion && !def) throw new Error(`There's no minion called "${minion}". Known: ${this.definitions().map((d) => d.name).join(", ") || "none"}.`);
    def ||= { name: "Helper", role: "A capable general assistant.", tools: ["files", "web", "skills"], effort: "medium" };
    const sameName = [...this.runs.values()].filter((r) => r.minion === def.name && r.status === "running").length;
    const run = {
      id: "mn_" + crypto.randomBytes(5).toString("hex"),
      name: label ? String(label).slice(0, 40) : sameName ? `${def.name} ${sameName + 1}` : def.name,
      minion: def.name,
      task: task.slice(0, 8000),
      status: "running",
      startedAt: Date.now(),
      endedAt: null,
      steps: 0,
      activity: "starting",
      report: null,
      error: null,
      delivered: false,
      abort: new AbortController(),
    };
    this.runs.set(run.id, run);
    this.trim();
    this.update(run);
    this.execute(run, def).catch((e) => {
      if (run.abort.signal.aborted) this.update(run, { status: "recalled", endedAt: Date.now(), activity: "" });
      else { console.error("[minion]", e); this.update(run, { status: "failed", error: this.agent.friendlyError(e), endedAt: Date.now(), activity: "" }); }
    });
    return this.view(run);
  }

  recall(idOrName) {
    const run = this.get(idOrName);
    if (!run || run.status !== "running") return false;
    run.abort.abort();
    this.update(run, { status: "recalled", endedAt: Date.now(), activity: "" });
    return true;
  }

  trim() {
    const done = [...this.runs.values()].filter((r) => r.status !== "running").sort((a, b) => a.startedAt - b.startedAt);
    while (this.runs.size > KEEP_RUNS && done.length) this.runs.delete(done.shift().id);
  }

  /** Finished reports D.E.N.N.I.S. hasn't seen yet (marked as seen). */
  takeReports() {
    const out = [];
    for (const r of this.runs.values()) {
      if (r.delivered || r.status === "running") continue;
      r.delivered = true;
      out.push(this.view(r));
    }
    return out;
  }

  systemPrompt(def) {
    const config = this.config;
    const name = config.get("userName") || "the user";
    const roots = (config.get("roots") || []).map((r) => `- ${r.label}: ${r.path}`).join("\n") || "- (none)";
    const allowed = def.tools.map((t) => `- ${t}: ${TOOLSETS[t]}`).join("\n");
    return `You are ${def.name}, one of the minions of D.E.N.N.I.S. (Digital Entity Neural Network Intelligent System), the personal virtual production assistant of ${name}. D.E.N.N.I.S. has sent you off on a task; work on it on your own, then report back to him.

# Your role
${def.role}

# How to work
- You can't talk to ${name} or ask D.E.N.N.I.S. anything mid-task. Make sensible assumptions, note them, and keep going.
- Use your tools to get real answers; don't guess at file contents or facts you can check.
- Changes (creating, moving) need ${name}'s approval and may be declined. If one is declined, carry on without it and say so in the report.
- When you're done, your final message is the report D.E.N.N.I.S. reads: lead with the result, then the key details (file paths, numbers, sources), then anything that needs a decision. Plain text, no preamble, as short as it can be while complete.

# What you may use
${allowed}

The folders you can see:
${roots}`;
  }

  async execute(run, def) {
    const agent = this.agent, config = this.config;
    const allow = new Set(def.tools);
    const brain = agent.brain(); // minions think with the same brain as D.E.N.N.I.S.
    if (allow.has("mcp")) await agent.mcpReady();
    const docs = allow.has("docs") && agent.docsEnabled();
    const registry = buildTools({
      scope: "minion",
      allow,
      webSearch: allow.has("web") && brain.provider === "anthropic" && !!config.get("webSearch"),
      docs,
      mcpTools: allow.has("mcp") ? agent.mcp.tools() : [],
    });
    const conv = {
      brain,
      model: brain.model,
      effort: def.effort || "medium",
      system: [{ type: "text", text: this.systemPrompt(def) }],
      apiTools: registry.apiTools,
      registry,
      docs,
      containerId: null,
      generated: new Map(),
      messages: [{ role: "user", content: [{ type: "text", text: `Task from D.E.N.N.I.S.:\n${run.task}` }] }],
    };
    const signal = run.abort.signal;
    // approvals go to every open window, tagged with who's asking
    const emit = (ev) => {
      if (ev.type === "approval") this.broadcast({ ...ev, title: `${run.name}: ${ev.title || "allow this?"}`, minion: run.name, runId: run.id });
      else if (ev.type === "approval_done") this.broadcast({ ...ev, runId: run.id });
    };
    const toolCtx = agent.toolContext(emit, signal, { generated: conv.generated, who: run.name });
    const client = agent.client();
    try {
      for (let step = 0; step < MAX_STEPS; step++) {
        if (signal.aborted) return;
        const message = await agent.callModel(client, conv, signal);
        if (message.stop_reason === "refusal") throw new Error("The request was declined.");
        conv.messages.push({ role: "assistant", content: message.content });
        if (message.stop_reason === "pause_turn") continue;
        const uses = message.content.filter((b) => b.type === "tool_use");
        if (!uses.length) {
          this.update(run, { status: "done", report: textOf(message.content) || "(finished without a report)", endedAt: Date.now(), activity: "", steps: step + 1 });
          return;
        }
        let results;
        if (message.stop_reason === "max_tokens") {
          results = uses.map((b) => ({ type: "tool_result", tool_use_id: b.id, is_error: true, content: "Your tool call was cut off by the output limit. Try again with a smaller input." }));
        } else {
          this.update(run, { steps: step + 1, activity: uses.map((b) => (b.name.startsWith("mcp__") ? b.name.slice(5).replace("__", ": ") : b.name)).join(", ") });
          results = await Promise.all(uses.map((b) => runTool(b, toolCtx, conv.registry)));
        }
        conv.messages.push({ role: "user", content: withUploads(results) });
      }
      this.update(run, { status: "done", report: `I ran out of steps before finishing. Where I got to:\n${textOf(conv.messages.at(-2)?.content) || "(no notes)"}`, endedAt: Date.now(), activity: "", steps: MAX_STEPS });
    } finally {
      toolCtx.release();
    }
  }
}

