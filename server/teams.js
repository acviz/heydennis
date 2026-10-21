// Microsoft Teams, two ways:
//
//   a chat    D.E.N.N.I.S. signs in as you once (a code you enter at microsoft.com/devicelogin)
//             and checks one chat every few seconds - "chat with yourself" is ideal. Your messages
//             there are instructions; his replies go in the same chat, marked "D.E.N.N.I.S.". No
//             public address needed. It uses an app registration of your own in Entra ID with the
//             delegated Chat.ReadWrite permission (your IT may need to approve it).
//   updates   a Teams Workflows webhook ("post to a chat or channel when a webhook request is
//             received"): one-way, for updates only, when the chat isn't possible.
//   inbox     the way back without an app registration: every card he posts has a reply box; the
//             Workflow ("post adaptive card and wait for a response") saves what you type into a
//             OneDrive folder, OneDrive syncs it to this computer, and he picks each one up from there
//             (then files it under Done - nothing is deleted). Plain notes saved there work too, if
//             they start with "Dennis".
import fs from "node:fs";
import path from "node:path";
const GRAPH = "https://graph.microsoft.com/v1.0";
const SCOPE = "Chat.ReadWrite User.Read offline_access";
export const TEAMS_DEFAULTS = { enabled: false, tenant: "organizations", clientId: "", chatId: "", chatName: "", pollSeconds: 6, account: "", inboxFolder: "", inboxPrefix: true };
const INBOX_FRESH_MS = 15 * 60_000; // older than this (written while he was off) is set aside, not acted on
const PREFIX = /^\s*(hey\s+|ok\s+|okay\s+)?dennis\b[\s,:;.!-]*/i;
const MARK = "\u{1F916} D.E.N.N.I.S."; // starts every message he posts, so he never answers himself

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
/** Claude's markdown as the little HTML Teams accepts. */
export function toTeamsHtml(text) {
  return esc(String(text || "").trim())
    .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
    .replace(/(^|\n)#{1,6}\s+(.+)/g, "$1<b>$2</b>")
    .replace(/`([^`\n]+)`/g, "<code>$1</code>")
    .replace(/\n/g, "<br>");
}
/** A Teams message body (HTML) as plain text. */
export function fromTeamsHtml(html) {
  return String(html || "")
    .replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|li)>/gi, "\n").replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&")
    .replace(/\n{3,}/g, "\n\n").trim();
}

export class TeamsChannel {
  constructor({ config, onMessage, onChange = () => {}, fetchImpl = (...a) => fetch(...a) }) {
    this.id = "teams";
    this.label = "Teams";
    this.config = config;
    this.onMessage = onMessage;
    this.onChange = onChange;
    this.fetch = fetchImpl;
    this.access = null; // { token, until }
    this.me = null; // { id, name }
    this.sentIds = new Set();
    this.since = null; // newest message time seen in the chat
    this.lastError = "";
    this.signin = null; // a device-code sign-in in progress: { userCode, url, expires }
    this.lastInboundAt = 0;
    this.inbox = { seen: new Set(), handled: 0, ignored: 0, error: "", lastAt: 0 };
  }

  get cfg() { return { ...TEAMS_DEFAULTS, ...(this.config.get("remote")?.teams || {}) }; }
  get signedIn() { return !!this.config.getSecret("teamsRefresh"); }
  get chatReady() { const c = this.cfg; return !!(c.enabled && c.clientId && c.chatId && this.signedIn); }
  get ready() { return !!(this.cfg.enabled && (this.chatReady || this.config.getSecret("teamsWebhook"))); }
  get inboxReady() { const c = this.cfg; return !!(c.enabled && c.inboxFolder && this.config.getSecret("teamsWebhook")); }
  allowed(from) { return from === "inbox" ? this.inboxReady : !!this.me && from === this.me.id; }

  // ---------------------------------------------------------------- signing in (device code: no password ever passes through here)
  login(path, form) {
    const c = this.cfg;
    return this.fetch(`https://login.microsoftonline.com/${encodeURIComponent(c.tenant || "organizations")}/oauth2/v2.0/${path}`, {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: c.clientId, ...form }).toString(),
    }).then(async (r) => ({ ok: r.ok, j: await r.json().catch(() => ({})) }));
  }
  async startSignIn() {
    if (!this.cfg.clientId) throw new Error("add the Application (client) ID from your app registration first");
    const { ok, j } = await this.login("devicecode", { scope: SCOPE });
    if (!ok) throw new Error(j.error_description?.split("\n")[0] || j.error || "Microsoft didn't start the sign-in");
    this.signin = { userCode: j.user_code, url: j.verification_uri, expires: Date.now() + (j.expires_in || 900) * 1000, message: j.message };
    this.onChange();
    const every = Math.max(3, j.interval || 5) * 1000;
    (async () => {
      while (this.signin && Date.now() < this.signin.expires) {
        await new Promise((r) => setTimeout(r, every));
        const t = await this.login("token", { grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: j.device_code }).catch(() => null);
        if (!t) continue;
        if (t.ok) { await this.took(t.j); this.signin = null; this.lastError = ""; await this.whoami().catch(() => {}); this.onChange(); this.start(); return; }
        if (t.j.error === "authorization_pending" || t.j.error === "slow_down") continue;
        this.lastError = t.j.error_description?.split("\n")[0] || t.j.error || "sign-in failed";
        this.signin = null;
        this.onChange();
        return;
      }
      if (this.signin) { this.signin = null; this.lastError = "the sign-in code expired - try again"; this.onChange(); }
    })();
    return { userCode: j.user_code, url: j.verification_uri, message: j.message };
  }
  async took(j) {
    this.access = { token: j.access_token, until: Date.now() + ((j.expires_in || 3600) - 120) * 1000 };
    if (j.refresh_token) { this.config.setSecret("teamsRefresh", j.refresh_token); this.config.save(); }
  }
  signOut() {
    this.stop();
    this.access = null;
    this.me = null;
    this.config.setSecret("teamsRefresh", "");
    this.config.update({ remote: { teams: { account: "", chatId: "", chatName: "" } } });
    this.onChange();
  }
  async token() {
    if (this.access && Date.now() < this.access.until) return this.access.token;
    const refresh = this.config.getSecret("teamsRefresh");
    if (!refresh) throw new Error("not signed in to Teams");
    const { ok, j } = await this.login("token", { grant_type: "refresh_token", refresh_token: refresh, scope: SCOPE });
    if (!ok) {
      if (j.error === "invalid_grant") { this.config.setSecret("teamsRefresh", ""); this.config.save(); this.onChange(); throw new Error("the Teams sign-in has expired - sign in again"); }
      throw new Error(j.error_description?.split("\n")[0] || j.error || "couldn't refresh the Teams sign-in");
    }
    await this.took(j);
    return this.access.token;
  }
  async graph(method, path, body, retry = true) {
    const r = await this.fetch(path.startsWith("http") ? path : GRAPH + path, {
      method, headers: { Authorization: `Bearer ${await this.token()}`, ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined,
    });
    if (r.status === 401 && retry) { this.access = null; return this.graph(method, path, body, false); }
    const j = r.status === 204 ? {} : await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(j.error?.message || `Teams error ${r.status}`); e.status = r.status; throw e; }
    return j;
  }
  async whoami() {
    const me = await this.graph("GET", "/me?$select=id,displayName,userPrincipalName");
    this.me = { id: me.id, name: me.displayName || me.userPrincipalName };
    if (this.cfg.account !== this.me.name) this.config.update({ remote: { teams: { account: this.me.name } } });
    return this.me;
  }

  /** Your chats, newest first - with "chat with yourself" on top when your Teams has it. */
  async listChats() {
    if (!this.me) await this.whoami();
    const out = [];
    try { await this.graph("GET", "/chats/48:notes"); out.push({ id: "48:notes", name: "Notes to self (chat with yourself) - recommended" }); } catch { /* not available on this tenant */ }
    const j = await this.graph("GET", "/me/chats?$expand=members&$top=50");
    for (const c of j.value || []) {
      if (c.id === "48:notes") continue;
      const others = (c.members || []).filter((m) => m.userId !== this.me.id).map((m) => m.displayName).filter(Boolean);
      out.push({ id: c.id, name: c.topic || (others.length ? others.join(", ") : "Chat"), kind: c.chatType });
    }
    return out;
  }

  // ---------------------------------------------------------------- the chat: checked every few seconds
  async start() {
    this.stop();
    this.startInbox();
    if (!this.chatReady) return;
    try { if (!this.me) await this.whoami(); } catch (e) { this.lastError = e.message; this.onChange(); }
    this.polling = true;
    const tick = async () => {
      if (!this.polling) return;
      let wait = Math.max(3, this.cfg.pollSeconds) * 1000;
      try { await this.poll(); if (this.lastError) { this.lastError = ""; this.onChange(); } } catch (e) {
        this.lastError = e.status === 403 ? "Teams refused to share the chat - the app may need Chat.ReadWrite approved by your IT" : e.message;
        wait = e.status === 429 ? 60_000 : 20_000;
        this.onChange();
      }
      if (this.polling) this.timer = setTimeout(tick, wait);
    };
    tick();
  }
  stop() { this.polling = false; clearTimeout(this.timer); this.since = null; clearInterval(this.inboxTimer); this.inboxTimer = null; }
  close() { this.stop(); this.signin = null; }

  async poll() {
    const chat = encodeURIComponent(this.cfg.chatId);
    const j = await this.graph("GET", `/chats/${chat}/messages?$top=20&$orderby=createdDateTime desc`);
    const msgs = (j.value || []).filter((m) => m.messageType === "message" && !m.deletedDateTime);
    if (this.since === null) { this.since = msgs[0]?.createdDateTime || new Date().toISOString(); return; } // start from now: nothing old is replayed
    const fresh = msgs.filter((m) => m.createdDateTime > this.since).reverse();
    if (fresh.length) this.since = fresh[fresh.length - 1].createdDateTime;
    for (const m of fresh) {
      if (this.sentIds.has(m.id)) continue;
      const text = fromTeamsHtml(m.body?.content);
      if (!text || text.startsWith(MARK)) continue; // his own messages
      const from = m.from?.user?.id;
      if (!this.allowed(from)) continue; // only you
      this.lastInboundAt = Date.now();
      this.onMessage(this, { from, text: text.slice(0, 4000), id: m.id });
    }
  }

  // ---------------------------------------------------------------- the OneDrive inbox
  startInbox() {
    if (!this.inboxReady) return;
    const dir = this.cfg.inboxFolder;
    try { fs.mkdirSync(path.join(dir, "Done"), { recursive: true }); this.inbox.error = ""; } catch (e) { this.inbox.error = `can't use ${dir}: ${e.code || e.message}`; return; }
    this.inbox.started = Date.now();
    this.inboxTimer = setInterval(() => this.scanInbox().catch((e) => { this.inbox.error = e.message; }), 2000);
    this.inboxTimer.unref?.();
    this.scanInbox().catch(() => {});
  }
  /**
   * One message per file, as a Workflow writes it: a card reply (JSON with data.reply - meant for him,
   * so no "Dennis" needed), JSON with a text/body field, the Teams HTML, or plain text.
   */
  static readMessage(raw) {
    let text = String(raw || "").replace(/^\uFEFF/, ""), explicit = false;
    try {
      const j = JSON.parse(text);
      if (j && typeof j === "object") {
        const reply = j.data?.reply ?? j.body?.data?.reply ?? j.reply;
        if (typeof reply === "string") { text = reply; explicit = true; }
        else text = j.text ?? j.message ?? j.body?.content ?? (typeof j.body === "string" ? j.body : undefined) ?? j.content ?? "";
      }
    } catch { /* not JSON */ }
    text = /<[a-z][\s\S]*>/i.test(String(text)) ? fromTeamsHtml(text) : String(text).trim();
    return { text, explicit };
  }
  async scanInbox() {
    if (this.scanning) return;
    this.scanning = true;
    try {
      const dir = this.cfg.inboxFolder;
      let names;
      try { names = fs.readdirSync(dir); } catch (e) { this.inbox.error = `can't read ${dir}: ${e.code || e.message}`; return; }
      let stale = 0;
      for (const name of names.sort()) {
        if (this.inbox.seen.has(name) || !/\.(txt|json|html?|md)$/i.test(name) || name.startsWith("~") || name.startsWith(".")) continue;
        const file = path.join(dir, name);
        let st;
        try { st = fs.statSync(file); } catch { continue; }
        if (!st.isFile() || Date.now() - st.mtimeMs < 1200) continue; // still being written / synced
        this.inbox.seen.add(name);
        let raw = "";
        try { raw = fs.readFileSync(file, "utf8"); } catch { continue; }
        // file it under Done (a name that's free), whatever it was
        let dest = path.join(dir, "Done", name);
        if (fs.existsSync(dest)) dest = path.join(dir, "Done", `${Date.now()}-${name}`);
        try { fs.renameSync(file, dest); } catch { /* OneDrive may hold it a moment; it's marked seen either way */ }
        const fresh = Date.now() - st.mtimeMs < INBOX_FRESH_MS; // OneDrive keeps the cloud copy's modified time: when the Workflow wrote it
        if (!fresh) { stale++; continue; }
        let { text, explicit } = TeamsChannel.readMessage(raw);
        if (this.cfg.inboxPrefix && !explicit) {
          if (!PREFIX.test(text)) { this.inbox.ignored++; continue; } // a note to self that isn't for him
          text = text.replace(PREFIX, "").trim();
        }
        if (!text || text.startsWith(MARK)) continue;
        this.inbox.handled++;
        this.inbox.lastAt = this.lastInboundAt = Date.now();
        this.onMessage(this, { from: "inbox", text: text.slice(0, 4000), id: name });
      }
      if (stale) this.send(null, `I was offline for a while - I've set aside ${stale} message${stale === 1 ? "" : "s"} older than 15 minutes rather than act on ${stale === 1 ? "it" : "them"} late. Send it again if it still stands.`).catch(() => {});
      if (this.inbox.error) this.inbox.error = "";
    } finally { this.scanning = false; }
  }

  async send(_to, text) {
    if (this.chatReady) {
      const j = await this.graph("POST", `/chats/${encodeURIComponent(this.cfg.chatId)}/messages`, { body: { contentType: "html", content: `<p><b>${MARK}</b></p><p>${toTeamsHtml(text)}</p>` } });
      if (j.id) { this.sentIds.add(j.id); if (this.sentIds.size > 300) this.sentIds.delete(this.sentIds.values().next().value); }
      return { sent: true };
    }
    const hook = this.config.getSecret("teamsWebhook");
    if (!hook) throw new Error("Teams isn't set up: sign in and pick a chat, or add a Workflows URL");
    // a Teams Workflows webhook takes an Adaptive Card
    const card = { type: "message", attachments: [{ contentType: "application/vnd.microsoft.card.adaptive", content: { $schema: "http://adaptivecards.io/schemas/adaptive-card.json", type: "AdaptiveCard", version: "1.4",
      body: [{ type: "TextBlock", text: "D.E.N.N.I.S.", weight: "Bolder" }, { type: "TextBlock", text: String(text).slice(0, 4000), wrap: true },
        ...(this.inboxReady ? [{ type: "Input.Text", id: "reply", placeholder: "Reply to D.E.N.N.I.S.", isMultiline: true }] : [])],
      ...(this.inboxReady ? { actions: [{ type: "Action.Submit", title: "Send", data: { from: "dennis-card" } }] } : {}) } }] };
    const r = await this.fetch(hook, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(card) });
    if (!r.ok) throw new Error(`the Teams Workflow answered ${r.status}`);
    return { sent: true, oneWay: true };
  }
  askYesNo(to, text) { return this.send(to, `${text}\n\nReply YES to allow or NO to cancel.`); }

  status() {
    const c = this.cfg;
    return { enabled: c.enabled, ready: this.ready, chatReady: this.chatReady, signedIn: this.signedIn, account: this.me?.name || c.account, clientId: c.clientId, tenant: c.tenant,
      chatId: c.chatId, chatName: c.chatName, hasWebhook: !!this.config.getSecret("teamsWebhook"), polling: !!this.polling, signin: this.signin ? { userCode: this.signin.userCode, url: this.signin.url } : null,
      lastInbound: this.lastInboundAt, error: this.lastError,
      inboxFolder: c.inboxFolder, inboxPrefix: c.inboxPrefix !== false, inboxReady: this.inboxReady, inbox: { running: !!this.inboxTimer, handled: this.inbox.handled, ignored: this.inbox.ignored, lastAt: this.inbox.lastAt, error: this.inbox.error } };
  }
}
