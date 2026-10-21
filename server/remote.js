// Messaging: talk to D.E.N.N.I.S. from your phone, over WhatsApp (whatsapp.js) or Microsoft Teams
// (teams.js).
//
//   in   a message from you - only you; anyone else is ignored - becomes a turn, as if you'd typed
//        it at the computer (same conversation, same tools, same rules). The reply goes back the
//        same way. When something needs your approval he asks in the chat: tap Allow, or reply
//        YES / NO. "stop" cancels what he's doing.
//   out  reminders, finished minions, folder-watcher notices and minions' approval requests reach
//        your phone - by default only while you're away from the computer - and he can message
//        you himself (the message_phone tool), e.g. "message me when the renders are in".
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DATA_DIR } from "./config.js";
import { WhatsAppChannel, WA_DEFAULTS } from "./whatsapp.js";
import { TeamsChannel } from "./teams.js";

const STATE_FILE = path.join(DATA_DIR, "remote-state.json");
export const FORWARD_DEFAULTS = { reminders: true, minions: true, watcher: true, approvals: true, awayOnly: true, awayMinutes: 10, via: "whatsapp" };
const YES = /^\s*(y|yes|yep|yeah|yup|ok|okay|allow|approve|approved|go|go ahead|do it|sure|confirm)\s*[.!]*\s*$/i;
const NO = /^\s*(n|no|nope|nah|deny|cancel|stop|don'?t|reject|decline)\s*[.!]*\s*$/i;
const STOP = /^\s*(stop|cancel|abort|halt|never ?mind)\s*[.!]*\s*$/i;
const clip = (s, n) => (String(s).length > n ? String(s).slice(0, n - 1) + "…" : String(s));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmtBytes = (n) => { const u = ["B", "KB", "MB", "GB", "TB"]; let i = 0; while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; } return `${n.toFixed(n < 10 && i ? 1 : 0)} ${u[i]}`; };

export class RemoteHub {
  /** isAway(): true when nobody's at the computer (no window open, or no activity for a while) */
  constructor({ config, agent, broadcast = () => {}, isAway = () => true, fetchImpl, stateFile = STATE_FILE }) {
    this.config = config;
    this.agent = agent;
    this.broadcast = broadcast;
    this.isAwayFn = isAway;
    this.stateFile = stateFile;
    this.state = { lastInbound: {}, held: {} };
    try { Object.assign(this.state, JSON.parse(fs.readFileSync(stateFile, "utf8"))); } catch { /* first time */ }
    const save = () => { try { fs.mkdirSync(path.dirname(stateFile), { recursive: true }); fs.writeFileSync(stateFile, JSON.stringify(this.state)); } catch { /* not fatal */ } };
    const onMessage = (ch, msg) => this.onInbound(ch, msg);
    const changed = () => this.broadcast({ type: "remote_status", status: this.status() });
    this.wa = new WhatsAppChannel({ config, onMessage, state: this.state, save, fetchImpl });
    this.wa.onTunnel = () => changed();
    this.teams = new TeamsChannel({ config, onMessage, onChange: changed, fetchImpl });
    this.channels = [this.wa, this.teams];
    this.queue = [];
    this.approvals = new Map(); // approval id -> { channel, to }
    this.runs = new Map(); // minion run id -> last status we saw
  }

  get forward() { return { ...FORWARD_DEFAULTS, ...(this.config.get("remote")?.forward || {}) }; }
  isAway() { try { return !!this.isAwayFn(this.forward.awayMinutes); } catch { return true; } }

  async start() {
    // a verify token for Meta's webhook check, made once
    if (!this.config.get("remote")?.whatsapp?.verifyToken) this.config.update({ remote: { whatsapp: { verifyToken: `dennis-${crypto.randomBytes(12).toString("hex")}` } } });
    await this.wa.start();
    await this.teams.start();
  }
  async restart() { this.wa.close(); this.teams.stop(); await this.start(); this.broadcast({ type: "remote_status", status: this.status() }); }
  close() { this.wa.close(); this.teams.close(); }

  // ---------------------------------------------------------------- in: your messages
  async onInbound(channel, { from, text, buttonId }) {
    if (!channel.allowed(from)) return;
    // an answer to something waiting for your approval?
    if (buttonId?.startsWith("ap:")) { const [, id, ans] = buttonId.split(":"); return this.answer(channel, from, id, ans === "yes"); }
    const waiting = [...this.approvals.entries()].filter(([, a]) => a.channel === channel);
    if (waiting.length && (YES.test(text) || NO.test(text))) return this.answer(channel, from, waiting[waiting.length - 1][0], YES.test(text));
    if (STOP.test(text) && this.busy) { this.abort?.abort(); this.queue = this.queue.filter((j) => j.channel !== channel); return channel.send(from, "Stopped.").catch(() => {}); }
    this.queue.push({ channel, to: from, text });
    if (this.queue.length > 10) this.queue.shift();
    this.pump();
  }
  answer(channel, to, id, yes) {
    const known = this.approvals.has(id);
    this.approvals.delete(id);
    const ok = this.agent.resolveApproval(id, yes);
    channel.send(to, ok ? (yes ? "Allowed - carrying on." : "Cancelled.") : known ? "That one was already answered." : "That request has expired.").catch(() => {});
  }

  async pump() {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.queue.length) {
        const job = this.queue.shift();
        // someone's using him at the computer: wait for that to finish (up to five minutes)
        for (let i = 0; i < 600 && this.agent.busy; i++) await sleep(500);
        if (this.agent.busy) { await job.channel.send(job.to, "I'm tied up with something at the computer - try me again in a few minutes.").catch(() => {}); continue; }
        await this.runTurn(job).catch((e) => job.channel.send(job.to, `Something went wrong: ${e.message}`).catch(() => {}));
      }
    } finally { this.pumping = false; }
  }

  async runTurn({ channel, to, text }) {
    this.broadcast({ type: "remote", channel: channel.id, label: channel.label, dir: "in", text });
    let reply = "", problem = "";
    this.busy = true;
    this.abort = new AbortController();
    const emit = (ev) => {
      if (ev.type === "text") reply += ev.delta;
      else if (ev.type === "block_stop") { if (reply && !reply.endsWith("\n")) reply += "\n"; }
      else if (ev.type === "approval") this.askApproval(channel, to, ev);
      else if (ev.type === "approval_done") this.approvalDone(ev);
      else if (ev.type === "ui") this.broadcast({ ...ev, remote: channel.id }); // shows on the computer too (a diagram draws there)
      else if (ev.type === "error") problem = ev.message;
      else if (ev.type === "refusal") reply = "That one I'll have to decline, I'm afraid.";
      else if (ev.type === "done" && ev.stop_reason === "aborted") problem = "Stopped.";
    };
    try {
      await this.agent.turn({ text, context: { input: "remote", channel: channel.label }, emit, signal: this.abort.signal });
    } finally { this.busy = false; this.abort = null; }
    const out = (reply.trim() || problem || "Done.").replace(/\n{3,}/g, "\n\n");
    await channel.send(to, out);
    this.broadcast({ type: "remote", channel: channel.id, label: channel.label, dir: "out", text: out });
  }

  askApproval(channel, to, ev) {
    this.approvals.set(ev.id, { channel, to });
    this.broadcast({ ...ev, remote: channel.id }); // the dialog shows at the computer too: whichever answers first
    const text = `${ev.minion ? `${ev.minion} asks: ` : ""}${ev.title || "Allow this?"}${ev.detail ? `\n${clip(ev.detail, 700)}` : ""}`;
    channel.askYesNo(to, text, ev.id).catch(() => {});
  }
  approvalDone(ev) {
    const a = this.approvals.get(ev.id);
    this.broadcast({ ...ev, remote: a?.channel.id || true });
    if (!a) return;
    this.approvals.delete(ev.id);
    a.channel.send(a.to, ev.yes ? "Approved at the computer - carrying on." : "Declined at the computer.").catch(() => {});
  }

  // ---------------------------------------------------------------- out: updates for your phone
  /** Where updates go: your choice in Messaging (WhatsApp, Teams or both), falling back to whichever is set up. */
  targets(pick = "any") {
    const ready = this.channels.filter((c) => c.ready);
    if (pick !== "any") return ready.filter((c) => c.id === pick);
    const via = this.forward.via;
    if (via === "both") return ready;
    const preferred = ready.filter((c) => c.id === via);
    return preferred.length ? preferred : ready.slice(0, 1);
  }
  /**
   * Send an update. kind: "direct" (he chose to message you) or reminders / minions / watcher /
   * approvals (sent only if that's switched on, and - by default - only while you're away).
   * Returns true when it's on its way.
   */
  notify(text, { kind = "direct", channel = "any" } = {}) {
    const f = this.forward;
    if (kind !== "direct" && (!f[kind] || (f.awayOnly && !this.isAway()))) return false;
    const targets = this.targets(channel);
    if (!targets.length) return false;
    for (const c of targets) c.send(null, text).then(() => this.broadcast({ type: "remote", channel: c.id, label: c.label, dir: "out", text, update: true })).catch((e) => { c.lastError = e.message; });
    return true;
  }
  /** What the tool message_phone does. */
  async message(text, channel = "any") {
    const targets = this.targets(channel);
    if (!targets.length) return { error: "Messaging isn't set up yet - they can connect WhatsApp or Teams under Capabilities -> Messaging." };
    const done = [];
    for (const c of targets) {
      try { const r = await c.send(null, text); done.push(r?.held ? `${c.label} (held: WhatsApp only allows it once they next write)` : c.label); } catch (e) { return { error: `${c.label}: ${e.message}` }; }
    }
    this.broadcast({ type: "remote", channel: targets[0].id, label: targets[0].label, dir: "out", text, update: true });
    return `Sent on ${done.join(" and ")}.`;
  }

  /** Server events worth passing on: finished minions, and minions asking for approval while you're away. */
  onEvent(ev) {
    if (ev.type === "minion" && ev.run) {
      const before = this.runs.get(ev.run.id);
      this.runs.set(ev.run.id, ev.run.status);
      if (before === "running" && ev.run.status !== "running") {
        const r = ev.run;
        const what = r.status === "done" ? `finished: ${clip(r.report || "", 1200)}` : r.status === "failed" ? `ran into trouble: ${r.error || "unknown error"}` : "was recalled.";
        this.notify(`${r.name} ${what}`, { kind: "minions" });
      }
      if (this.runs.size > 200) this.runs.delete(this.runs.keys().next().value);
    } else if (ev.type === "approval" && ev.runId && !ev.remote) {
      const f = this.forward;
      if (!f.approvals || (f.awayOnly && !this.isAway())) return;
      const [c] = this.targets();
      if (!c || (c.id === "teams" && !c.chatReady)) return; // a one-way Workflow can't take an answer
      this.approvals.set(ev.id, { channel: c, to: null });
      c.askYesNo(null, `${ev.minion || "A minion"} asks: ${ev.title || "allow this?"}${ev.detail ? `\n${clip(ev.detail, 700)}` : ""}`, ev.id).catch(() => {});
    } else if (ev.type === "approval_done" && !ev.remote) {
      this.approvals.delete(ev.id);
    }
  }
  /** A folder-watcher notice in a sentence. */
  static watchText(n) {
    if (n.type === "new_files") return `${n.count} new ${n.kind === "other" ? "" : `${n.kind} `}files just landed in ${String(n.folder).split(/[\\/]/).filter(Boolean).pop()}.`;
    if (n.type === "disk_low") return `Heads up: ${n.drive} is down to ${fmtBytes(n.free)} free.`;
    return null;
  }

  status() {
    return { away: this.isAway(), forward: this.forward, whatsapp: this.wa.status(), teams: this.teams.status(), webhookPath: "/whatsapp", defaults: { port: WA_DEFAULTS.port } };
  }
}
