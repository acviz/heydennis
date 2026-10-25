// D.E.N.N.I.S. as an MCP server: another AI assistant - Claude in the Claude app, Claude Code -
// can talk to him over the Model Context Protocol, at POST /mcp on his local server.
//
//   off   until you switch it on (Capabilities -> CONNECTED APPS -> LET CLAUDE TALK TO ME).
//   local the server binds to 127.0.0.1 and checks Host like the rest of the API; every request
//         needs the bearer token (config `mcpToken`, made when it's first switched on, replaceable
//         from the same place). A request carrying an Origin header (a web page) is refused.
//   in    a message becomes a turn in the same conversation, marked as coming from Claude, not you
//         (context.input = "agent"). One at a time, after whatever you're doing at the computer.
//   asks  anything that needs approval is asked of you - at the computer, and on your phone while
//         you're away (remote.js) - never of Claude. One nobody answers in ten minutes is declined.
//   long  a turn doesn't hold the connection: talk_to_dennis waits up to wait_seconds, then hands
//         back a job id for get_dennis_reply.
//
// mcp-stdio.mjs is the same door for apps that only start MCP servers as local programs.
import crypto from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";

export const ENDPOINT_PATH = "/mcp";
export const APPROVAL_TIMEOUT_MS = 10 * 60_000;
const BUSY_WAIT_MS = 5 * 60_000;
const DEFAULT_WAIT_S = 45; // under the 60 s most MCP clients give a call
const MAX_WAIT_S = 240;
const KEEP_JOBS = 30;
const MAX_MESSAGE = 20_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cap = (s) => String(s).charAt(0).toUpperCase() + String(s).slice(1);
const clip = (s, n) => (String(s).length > n ? String(s).slice(0, n - 1) + "…" : String(s));

export const INSTRUCTIONS = "D.E.N.N.I.S. is a desktop assistant running on the user's own computer (a Claude-powered Electron app). Talk to him in plain language with talk_to_dennis, as you would to a capable colleague; he keeps one ongoing conversation. He can work with the files in the user's mapped folders, the apps they've authorized, classic Outlook email, reminders, background worker agents (minions) and his own connected apps. Anything that changes files, sends something or launches a program waits for the user's own approval at the computer or on their phone: you can't approve it, so tell the user when he's waiting.";

const waitProp = (def) => ({ type: "integer", minimum: 0, maximum: MAX_WAIT_S, description: `How long to wait for him to finish, in seconds (default ${def}, at most ${MAX_WAIT_S}). If he isn't done by then you get a job id; collect the reply with get_dennis_reply.` });

/** The tools, as MCP lists them (also served by mcp-stdio.mjs when he isn't running). */
export const TOOLS = [
  {
    name: "talk_to_dennis",
    title: "Talk to D.E.N.N.I.S.",
    description: "Send a message to D.E.N.N.I.S., the user's desktop assistant on their own computer, and get his reply. He joins it to his ongoing conversation and can use all his tools: files in the user's folders, their authorized apps, Outlook email, reminders, minions and connected apps such as Blender. Write naturally and say what you need. Changes, sends and launches wait for the user's own approval (at the computer or on their phone); you can't approve them. If he's still working after wait_seconds, you get a job id: call get_dennis_reply with it.",
    inputSchema: { type: "object", properties: { message: { type: "string", description: "What to say to him." }, wait_seconds: waitProp(DEFAULT_WAIT_S) }, required: ["message"] },
    annotations: { title: "Talk to D.E.N.N.I.S.", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  {
    name: "get_dennis_reply",
    title: "Get D.E.N.N.I.S.'s reply",
    description: "Collect the reply to a message sent with talk_to_dennis that he hadn't finished yet. Says whether he's still working, waiting for the user's approval (and what for), finished (with his reply), stopped or failed.",
    inputSchema: { type: "object", properties: { job: { type: "string", description: "The job id talk_to_dennis gave you." }, wait_seconds: waitProp(20) }, required: ["job"] },
    annotations: { title: "Get D.E.N.N.I.S.'s reply", readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "dennis_status",
    title: "D.E.N.N.I.S. status",
    description: "Whether D.E.N.N.I.S. is free or busy, what he's waiting on, the brain he thinks with, his connected apps, and whether the user is at the computer.",
    inputSchema: { type: "object", properties: {} },
    annotations: { title: "D.E.N.N.I.S. status", readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "stop_dennis",
    title: "Stop D.E.N.N.I.S.",
    description: "Stop what D.E.N.N.I.S. is doing for you: the given job, or by default whichever of your messages he's working on or has queued. Doesn't touch anything the user asked him at the computer.",
    inputSchema: { type: "object", properties: { job: { type: "string", description: "The job id to stop (optional)." } } },
    annotations: { title: "Stop D.E.N.N.I.S.", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
];

function safeEqual(a, b) {
  const x = Buffer.from(String(a || "")), y = Buffer.from(String(b || ""));
  return x.length > 0 && x.length === y.length && crypto.timingSafeEqual(x, y);
}

function sendJson(res, code, body, headers = {}) {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(code, { "Content-Type": "application/json", "Content-Length": buf.length, "Cache-Control": "no-store", ...headers });
  res.end(buf);
}
const rpcError = (message, code = -32000) => ({ jsonrpc: "2.0", error: { code, message }, id: null });

async function readBody(req, limit = 1_000_000) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new Error("body too large");
    chunks.push(c);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
}

const text = (t, isError = false) => ({ content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) });
const waitOf = (v, def) => Math.max(0, Math.min(MAX_WAIT_S, Number.isFinite(+v) && v !== null && v !== "" ? Math.round(+v) : def));

export class DennisMcpEndpoint {
  /**
   * agent: the Agent (turn, busy, resolveApproval, brain, mcp); remote: the RemoteHub, for
   * approvals on your phone (optional); broadcast: events to every open window; log: dlog.
   */
  constructor({ config, agent, remote = null, broadcast = () => {}, log = () => {}, version = "0.0.0", approvalTimeoutMs = APPROVAL_TIMEOUT_MS }) {
    this.config = config;
    this.agent = agent;
    this.remote = remote;
    this.broadcast = broadcast;
    this.log = log;
    this.version = version;
    this.approvalTimeoutMs = approvalTimeoutMs;
    this.jobs = new Map(); // job id -> job (the last KEEP_JOBS)
    this.queue = [];
    this.pumping = false;
  }

  get enabled() { return !!this.config.get("mcpServer")?.enabled; }
  get user() { return this.config.get("userName") || "the user"; }

  // ---------------------------------------------------------------- HTTP: POST /mcp
  async handle(req, res) {
    if (!this.enabled) return sendJson(res, 404, { error: "not found" }); // switched off: nothing here
    if (req.headers.origin) return sendJson(res, 403, rpcError("Requests from web pages aren't accepted."));
    const m = /^Bearer\s+(\S+)\s*$/i.exec(String(req.headers.authorization || ""));
    if (!m || !safeEqual(m[1], this.config.get("mcpToken"))) return sendJson(res, 401, rpcError("A valid bearer token is needed (D.E.N.N.I.S. -> Capabilities -> CONNECTED APPS)."), { "WWW-Authenticate": 'Bearer realm="dennis"' });
    // stateless: every POST stands alone, so there's no stream to open or session to end
    if (req.method !== "POST") return sendJson(res, 405, rpcError("Method not allowed."), { Allow: "POST" });
    let body;
    try { body = await readBody(req); } catch (e) { return sendJson(res, 400, rpcError(`Couldn't read the request: ${e.message}`, -32700)); }
    const server = this.makeServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => { transport.close().catch(() => {}); server.close().catch(() => {}); });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  }

  makeServer() {
    const server = new Server({ name: "dennis", title: "D.E.N.N.I.S.", version: this.version }, { capabilities: { tools: {} }, instructions: INSTRUCTIONS });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
    server.setRequestHandler(CallToolRequestSchema, async (req) => {
      try { return await this.call(req.params.name, req.params.arguments || {}); } catch (e) { return text(`Something went wrong: ${e.message}`, true); }
    });
    return server;
  }

  async call(name, args) {
    if (name === "talk_to_dennis") return this.talk(args);
    if (name === "get_dennis_reply") return this.reply(args);
    if (name === "dennis_status") return text(this.statusText());
    if (name === "stop_dennis") return this.stop(args);
    return text(`There's no tool called ${name}.`, true);
  }

  // ---------------------------------------------------------------- the tools
  async talk({ message, wait_seconds } = {}) {
    const msg = typeof message === "string" ? message.trim() : "";
    if (!msg) return text("Say something: message is empty.", true);
    if (msg.length > MAX_MESSAGE) return text(`That message is too long (${MAX_MESSAGE.toLocaleString()} characters at most).`, true);
    const job = this.enqueue(msg);
    await this.waitFor(job, waitOf(wait_seconds, DEFAULT_WAIT_S));
    return this.report(job);
  }

  async reply({ job: id, wait_seconds } = {}) {
    const job = this.jobs.get(String(id || ""));
    if (!job) return text(`No job "${id}". Jobs are kept for your last ${KEEP_JOBS} messages, and only while he's running.`, true);
    await this.waitFor(job, waitOf(wait_seconds, 20));
    return this.report(job);
  }

  stop({ job: id } = {}) {
    const open = (j) => ["queued", "running", "waiting_approval"].includes(j.status);
    const job = id ? this.jobs.get(String(id)) : [...this.jobs.values()].reverse().find(open);
    if (!job) return text(id ? `No job "${id}".` : "Nothing of yours is running or queued.", !!id);
    if (!open(job)) return text(`Job ${job.id} had already ${job.status === "done" ? "finished" : job.status}.`);
    if (job.status === "queued") {
      this.queue = this.queue.filter((j) => j !== job);
      this.finish(job, "stopped", { error: "Stopped before he started." });
    } else job.abort?.abort();
    return text(`Stopping job ${job.id}.`);
  }

  statusText() {
    const a = this.agent;
    const b = a.brain?.() || {};
    const mine = [...this.jobs.values()].filter((j) => ["queued", "running", "waiting_approval"].includes(j.status));
    const waiting = mine.find((j) => j.status === "waiting_approval");
    const apps = (a.mcp?.status?.() || []).map((s) => `${s.name} (${s.status === "connected" ? `${s.tools.length} tools` : s.status})`);
    let away = null;
    try { away = this.remote ? this.remote.isAway() : null; } catch { /* unknown */ }
    return [
      `D.E.N.N.I.S. ${this.version} is running.`,
      `Brain: ${b.label || "unknown"}${b.model ? ` (${b.model})` : ""}.`,
      waiting ? `Waiting for ${this.user} to approve: ${waiting.approval?.title || "a request"}.` : a.busy ? (mine.some((j) => j.status === "running") ? "Busy with your message." : `Busy with something ${this.user} asked.`) : "Free.",
      mine.length ? `Your jobs: ${mine.map((j) => `${j.id} (${j.status.replace("_", " ")})`).join(", ")}.` : "",
      `Connected apps: ${apps.length ? apps.join(", ") : "none"}.`,
      away === null ? "" : `${cap(this.user)} ${away ? "seems to be away from" : "is at"} the computer.`,
    ].filter(Boolean).join("\n");
  }

  // ---------------------------------------------------------------- jobs
  enqueue(message) {
    let done;
    const job = { id: `j-${crypto.randomBytes(4).toString("hex")}`, message, status: "queued", reply: "", error: "", approval: null, decisions: [], createdAt: Date.now(), tries: 0 };
    job.done = new Promise((r) => (done = r));
    job.resolve = done;
    this.jobs.set(job.id, job);
    while (this.jobs.size > KEEP_JOBS) this.jobs.delete(this.jobs.keys().next().value);
    this.queue.push(job);
    this.pump();
    return job;
  }

  waitFor(job, seconds) {
    if (!seconds) return Promise.resolve();
    let t;
    return Promise.race([job.done, new Promise((r) => (t = setTimeout(r, seconds * 1000)))]).finally(() => clearTimeout(t));
  }

  async pump() {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.queue.length) await this.run(this.queue.shift());
    } finally { this.pumping = false; }
  }

  async run(job) {
    if (job.status !== "queued") return;
    // someone's using him at the computer or from the phone: wait for that to finish
    const t0 = Date.now();
    while (this.agent.busy && job.status === "queued" && Date.now() - t0 < BUSY_WAIT_MS) await sleep(250);
    if (job.status !== "queued") return;
    if (this.agent.busy) return this.finish(job, "failed", { error: `He's been tied up with something else for five minutes (${this.user} is using him at the computer or from the phone). Try again later.` });
    job.status = "running";
    job.startedAt ??= Date.now();
    job.abort = new AbortController();
    if (!job.tries++) this.broadcast({ type: "remote", channel: "claude", label: "Claude", who: "CLAUDE · MCP", dir: "in", text: job.message });
    let reply = "", problem = "", refusedBusy = false, stopped = false;
    const emit = (ev) => {
      if (ev.type === "text") reply += ev.delta;
      else if (ev.type === "block_stop") { if (reply && !reply.endsWith("\n")) reply += "\n"; }
      else if (ev.type === "approval") this.askApproval(job, ev);
      else if (ev.type === "approval_done") this.approvalDone(job, ev);
      else if (ev.type === "ui") this.broadcast({ ...ev, remote: "claude" }); // shows at the computer (a diagram draws there)
      else if (ev.type === "error") { problem = ev.message; if (/^Still working/.test(ev.message || "")) refusedBusy = true; }
      else if (ev.type === "refusal") reply = "That one I'll have to decline, I'm afraid.";
      else if (ev.type === "done" && ev.stop_reason === "aborted") stopped = true;
    };
    try {
      await this.agent.turn({ text: job.message, context: { input: "agent", channel: "Claude" }, emit, signal: job.abort.signal });
    } catch (e) { problem = e.message; }
    job.reply = reply.trim().replace(/\n{3,}/g, "\n\n");
    // the computer got in first by a hair: back in the queue
    if (refusedBusy && !job.reply && job.tries < 4) { job.status = "queued"; this.queue.unshift(job); return; }
    if (stopped) return this.finish(job, "stopped", { error: "Stopped." });
    if (problem && !job.reply) return this.finish(job, "failed", { error: problem });
    return this.finish(job, "done");
  }

  finish(job, status, { error = "" } = {}) {
    clearTimeout(job.approvalTimer);
    job.status = status;
    job.error = error;
    job.finishedAt = Date.now();
    job.abort = null;
    if (job.tries) this.broadcast({ type: "remote", channel: "claude", label: "Claude", who: "TO CLAUDE · MCP", dir: "out", text: job.reply || error || "Done." });
    job.resolve();
  }

  askApproval(job, ev) {
    job.status = "waiting_approval";
    job.approval = { id: ev.id, title: ev.title || "Allow this?" };
    // at the computer (whichever answers first wins) and, while you're away, on your phone
    this.broadcast({ ...ev, remote: "claude", title: `Claude asked: ${ev.title || "allow this?"}` });
    job.approval.phone = !!this.remote?.forwardApproval?.(ev, "Claude asked D.E.N.N.I.S.: ");
    clearTimeout(job.approvalTimer);
    job.approvalTimer = setTimeout(() => {
      if (job.approval?.id !== ev.id) return;
      job.approval.timedOut = true;
      this.log("ANSWER", `nobody answered in ${Math.round(this.approvalTimeoutMs / 60_000)} minutes - declined: ${job.approval.title}`);
      this.agent.resolveApproval(ev.id, false);
    }, this.approvalTimeoutMs);
    job.approvalTimer.unref?.();
  }

  approvalDone(job, ev) {
    clearTimeout(job.approvalTimer);
    if (job.approval?.id === ev.id) {
      job.decisions.push(`${job.approval.title}: ${ev.yes ? "allowed" : job.approval.timedOut ? "declined (nobody answered)" : "declined"}`);
      job.approval = null;
    }
    if (job.status === "waiting_approval") job.status = "running";
    if (this.remote?.approvalDone) this.remote.approvalDone(ev); // closes the dialog at the computer, tells the phone
    else this.broadcast({ ...ev, remote: "claude" });
  }

  /** What Claude reads back. */
  report(job) {
    const tail = `Job ${job.id}: call get_dennis_reply with it to collect his reply.`;
    const sofar = job.reply ? `\n\nSo far:\n${clip(job.reply, 4000)}` : "";
    const decided = job.decisions.length ? `\n\n(Approvals: ${job.decisions.join("; ")}.)` : "";
    switch (job.status) {
      case "done": return text((job.reply || "Done.") + decided);
      case "queued": return text(`He's busy with something else; your message is queued. ${tail}`);
      case "running": return text(`He's still working on it. ${tail}${sofar}`);
      case "waiting_approval": return text(`He's waiting for ${this.user} to approve: "${job.approval?.title}". It's been asked at the computer${job.approval?.phone ? " and on their phone" : ""}; you can't approve it. If nobody answers within ${Math.round(this.approvalTimeoutMs / 60_000)} minutes it's declined. ${tail}${sofar}`);
      case "stopped": return text(`Stopped before he finished.${sofar}`);
      default: return text(job.error || "That didn't work.", true);
    }
  }

  close() {
    for (const job of this.jobs.values()) {
      if (job.status === "queued") this.finish(job, "stopped", { error: "He shut down." });
      else job.abort?.abort();
    }
    this.queue = [];
  }
}
