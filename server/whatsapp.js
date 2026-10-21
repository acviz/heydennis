// WhatsApp, through Meta's official WhatsApp Business Platform (Cloud API).
//
// Incoming: Meta posts each message to a webhook. That needs a public HTTPS address, so this
// runs a small listener of its own (127.0.0.1, default port 47820) that a tunnel such as ngrok
// points at. It answers only /whatsapp, checks Meta's signature on every call (the app secret),
// and nothing else of D.E.N.N.I.S. is reachable through it.
// Outgoing: POST /{phone-number-id}/messages. WhatsApp lets a business write freely only within
// 24 hours of your last message; after that an approved template is needed (optional here), or
// updates wait until you next write.
//
// The tunnel: point your own (ngrok, a named Cloudflare tunnel...) at the listener, or let D.E.N.N.I.S.
// run a free Cloudflare quick tunnel itself (tunnel: "cloudflared"). Its address changes every time it
// starts, so he reads the new one and, with your Meta App ID, updates the callback URL at Meta for you.
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

export const WA_DEFAULTS = { enabled: false, phoneNumberId: "", allow: [], port: 47820, apiVersion: "v23.0", template: "", templateLang: "en", verifyToken: "", publicUrl: "", tunnel: "own", appId: "" };
const CERT_TROUBLE = /CERT|ISSUER|SELF_SIGNED/;

/** Where cloudflared usually lives: D.E.N.N.I.S.'s own bin folder (the standalone .exe, no install needed), winget, the MSI, or anywhere on PATH. */
export function findCloudflared() {
  const exe = process.platform === "win32" ? "cloudflared.exe" : "cloudflared";
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  const home = process.env.DENNIS_HOME || path.join(os.homedir(), ".dennis");
  const spots = [path.join(home, "bin", exe), path.join(local, "Microsoft", "WinGet", "Links", exe), "C:\\Program Files (x86)\\cloudflared\\cloudflared.exe", "C:\\Program Files\\cloudflared\\cloudflared.exe", "/opt/homebrew/bin/cloudflared", "/usr/local/bin/cloudflared", "/usr/bin/cloudflared"];
  for (const dir of String(process.env.PATH || "").split(path.delimiter)) if (dir) spots.push(path.join(dir, exe));
  return spots.find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } }) || null;
}
const WINDOW_MS = 23.5 * 3600_000; // a little inside WhatsApp's 24 h
const digits = (s) => String(s || "").replace(/\D/g, "");

/** Meta signs each webhook body: X-Hub-Signature-256: sha256=<hmac of the raw body with the app secret>. */
export function validSignature(raw, header, secret) {
  const want = "sha256=" + crypto.createHmac("sha256", secret).update(raw).digest("hex");
  const got = String(header || "");
  return got.length === want.length && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want));
}

/** Claude's markdown, the way WhatsApp writes it (*bold*, _italic_, no headings or tables). */
export function toWhatsApp(text) {
  return String(text || "")
    .replace(/\*\*(.+?)\*\*/g, "*$1*")
    .replace(/(^|\n)#{1,6}\s+(.+)/g, "$1*$2*")
    .replace(/(^|\n)\s*[-*]\s+/g, "$1• ")
    .replace(/`{3}[\s\S]*?`{3}/g, (m) => m.replace(/`{3}\w*\n?/g, "```"))
    .trim();
}
/** Long replies go as several messages (WhatsApp's limit is 4096 characters), split at paragraphs where it can. */
export function splitText(text, max = 3900) {
  const out = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n\n", max);
    if (cut < max * 0.5) cut = rest.lastIndexOf("\n", max);
    if (cut < max * 0.5) cut = rest.lastIndexOf(" ", max);
    if (cut < 1) cut = max;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}
// template parameters can't hold newlines, tabs or runs of spaces
const templateText = (text) => String(text).replace(/\s*\n+\s*/g, " · ").replace(/\s{2,}/g, " ").slice(0, 900);

async function readRaw(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const c of req) { size += c.length; if (size > limit) throw new Error("too large"); chunks.push(c); }
  return Buffer.concat(chunks);
}

export class WhatsAppChannel {
  /** onMessage(channel, { from, text, buttonId, id }); state: { lastInbound: {}, held: {} } (kept by the hub) */
  constructor({ config, onMessage, state, save, fetchImpl = (...a) => fetch(...a) }) {
    this.id = "whatsapp";
    this.label = "WhatsApp";
    this.config = config;
    this.onMessage = onMessage;
    this.state = state;
    this.save = save;
    this.fetch = fetchImpl;
    this.seen = new Set(); // Meta sometimes delivers a message twice
    this.ignored = 0;
    this.lastError = "";
    this.lastInboundAt = 0;
    this.listening = false;
  }

  get cfg() { return { ...WA_DEFAULTS, ...(this.config.get("remote")?.whatsapp || {}) }; }
  get owner() { return digits(this.cfg.allow[0]); }
  get ready() { const c = this.cfg; return !!(c.enabled && c.phoneNumberId && c.allow.length && this.config.getSecret("waToken")); }
  allowed(from) { return this.cfg.allow.map(digits).filter(Boolean).includes(digits(from)); }

  async start() {
    const c = this.cfg;
    if (!c.enabled) return;
    if (c.tunnel === "cloudflared") this.startTunnel();
    this.server = http.createServer((req, res) => this.handle(req, res).catch((e) => { this.lastError = e.message; if (!res.headersSent) res.writeHead(500).end(); }));
    await new Promise((resolve) => {
      this.server.once("error", (e) => { this.lastError = e.code === "EADDRINUSE" ? `port ${c.port} is already in use - pick another webhook port` : e.message; resolve(); });
      this.server.listen(+c.port || 47820, "127.0.0.1", () => { this.listening = true; resolve(); });
    });
  }
  close() {
    this.listening = false;
    try { this.server?.close(); } catch { /* closed */ }
    this.server = null;
    this.tunnelWanted = false;
    try { this.tunnelProc?.kill(); } catch { /* gone */ }
    this.tunnelProc = null;
  }

  // ---------------------------------------------------------------- the Cloudflare quick tunnel he runs himself
  startTunnel() {
    const exe = findCloudflared();
    if (!exe) { this.tunnelState = "cloudflared isn't installed"; return; }
    this.tunnelWanted = true;
    this.tunnelState = "starting...";
    const c = this.cfg;
    const proc = spawn(exe, ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${+c.port || 47820}`], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    this.tunnelProc = proc;
    // the address is printed before the connection is made: only use it once Cloudflare confirms the
    // connection (a firewall that blocks tunnels lets the first part through and cuts the second)
    let address = null, connected = false, failures = 0;
    const read = (buf) => {
      const text = String(buf);
      address ||= /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(text)?.[0] || null;
      if (/Registered tunnel connection/i.test(text)) connected = true;
      if (/Unable to establish connection with Cloudflare edge|Serve tunnel error/i.test(text) && !connected && ++failures >= 4) {
        this.tunnelState = "can't connect to Cloudflare from this network - a firewall is blocking tunnels (ask IT, or use Teams, which needs none)";
        this.onTunnel?.(null, { ok: false });
      }
      if (address && connected && address !== this.tunnelUrl) this.tunnelUp(address).catch((e) => { this.lastError = e.message; });
    };
    proc.stdout.on("data", read);
    proc.stderr.on("data", read); // cloudflared logs to stderr
    proc.on("error", (e) => { this.tunnelState = `cloudflared failed: ${e.message}`; });
    proc.on("exit", (code) => {
      if (this.tunnelProc !== proc) return;
      this.tunnelProc = null;
      this.tunnelUrl = null;
      this.tunnelState = `cloudflared stopped (${code})`;
      if (this.tunnelWanted) setTimeout(() => { if (this.tunnelWanted && !this.tunnelProc) this.startTunnel(); }, 15_000); // try again
    });
  }
  async tunnelUp(url) {
    this.tunnelUrl = url;
    this.tunnelState = "up";
    this.config.update({ remote: { whatsapp: { publicUrl: url } } });
    // a new address every time: tell Meta where to deliver (needs the App ID and the App secret)
    const r = await this.registerWebhook(url);
    this.tunnelState = r.ok ? "up - Meta updated" : `up - ${r.error}`;
    this.onTunnel?.(url, r);
  }
  /** Point Meta's webhook for this app at `url` (the App Subscriptions API, with the app's own access token). */
  async registerWebhook(url) {
    const c = this.cfg, secret = this.config.getSecret("waAppSecret");
    if (!c.appId) return { ok: false, error: "add your Meta App ID so the callback URL can be updated for you" };
    if (!secret) return { ok: false, error: "add the App secret" };
    // Meta checks the new address straight away (hub.challenge), so give the tunnel a moment to settle
    await new Promise((r) => setTimeout(r, this.settleMs ?? 4000));
    const body = new URLSearchParams({ object: "whatsapp_business_account", callback_url: `${url}/whatsapp`, fields: "messages", verify_token: c.verifyToken, include_values: "true", access_token: `${c.appId}|${secret}` });
    try {
      const r = await this.fetch(`https://graph.facebook.com/${c.apiVersion}/${encodeURIComponent(c.appId)}/subscriptions`, { method: "POST", body });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j.success === false) return { ok: false, error: `Meta didn't take the new address: ${j.error?.message || r.status}` };
      this.registeredAt = Date.now();
      return { ok: true };
    } catch (e) { return { ok: false, error: `couldn't reach Meta: ${e.cause?.code || e.message}` }; }
  }

  async handle(req, res) {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname !== "/whatsapp") return void res.writeHead(404).end();
    if (req.method === "GET") {
      // Meta's one-time check when you save the callback URL
      const token = url.searchParams.get("hub.verify_token") || "", want = this.cfg.verifyToken;
      const ok = url.searchParams.get("hub.mode") === "subscribe" && want && token.length === want.length && crypto.timingSafeEqual(Buffer.from(token), Buffer.from(want));
      if (!ok) return void res.writeHead(403).end();
      this.verifiedAt = Date.now();
      return void res.writeHead(200, { "Content-Type": "text/plain" }).end(url.searchParams.get("hub.challenge") || "");
    }
    if (req.method !== "POST") return void res.writeHead(405).end();
    const raw = await readRaw(req, 1_000_000);
    const secret = this.config.getSecret("waAppSecret");
    if (!secret || !validSignature(raw, req.headers["x-hub-signature-256"], secret)) {
      this.lastError = secret ? "a webhook call failed Meta's signature check - is the App secret right?" : "add the App secret, so webhook calls can be checked";
      return void res.writeHead(401).end();
    }
    res.writeHead(200).end("ok"); // answer straight away: Meta retries slow webhooks
    let body;
    try { body = JSON.parse(raw.toString("utf8")); } catch { return; }
    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        const v = change.value || {};
        if (v.metadata?.phone_number_id && String(v.metadata.phone_number_id) !== String(this.cfg.phoneNumberId)) continue;
        for (const m of v.messages || []) this.receive(m);
        for (const s of v.statuses || []) if (s.status === "failed") this.lastError = `a message didn't arrive: ${s.errors?.[0]?.title || s.errors?.[0]?.message || "unknown reason"}`;
      }
    }
  }

  receive(m) {
    if (!m?.id || this.seen.has(m.id)) return;
    this.seen.add(m.id);
    if (this.seen.size > 500) this.seen.delete(this.seen.values().next().value);
    const from = digits(m.from);
    if (!this.allowed(from)) { this.ignored++; return; } // only you
    this.lastInboundAt = Date.now();
    this.state.lastInbound[from] = Date.now();
    this.save();
    let text = null, buttonId = null;
    if (m.type === "text") text = m.text?.body;
    else if (m.type === "interactive") { buttonId = m.interactive?.button_reply?.id || null; text = m.interactive?.button_reply?.title || m.interactive?.list_reply?.title; }
    else if (m.type === "button") text = m.button?.text; // a template's quick-reply button
    this.markRead(m.id);
    this.flushHeld(from).catch(() => {});
    if (text == null) { this.send(from, "I can only read text messages for now - type it out and I'm all yours.").catch(() => {}); return; }
    this.onMessage(this, { from, text: String(text).slice(0, 4000), buttonId, id: m.id });
  }

  async api(body) {
    const c = this.cfg;
    const r = await this.fetch(`https://graph.facebook.com/${c.apiVersion}/${encodeURIComponent(c.phoneNumberId)}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.config.getSecret("waToken")}`, "Content-Type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", ...body }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      const e = new Error(j.error?.error_data?.details || j.error?.message || `WhatsApp error ${r.status}`);
      e.code = j.error?.code;
      e.status = r.status;
      throw e;
    }
    return j;
  }
  markRead(id) { this.api({ status: "read", message_id: id }).catch(() => {}); }
  windowOpen(to) { const t = this.state.lastInbound[digits(to)]; return !!t && Date.now() - t < WINDOW_MS; }

  /** Send a message; outside WhatsApp's 24-hour window it goes as the template (if set) or waits for your next message. */
  async send(to, text) {
    to = digits(to || this.owner);
    if (!to) throw new Error("no WhatsApp number to send to - add yours in Messaging");
    if (!this.windowOpen(to)) return this.outsideWindow(to, text);
    try {
      for (const part of splitText(toWhatsApp(text))) await this.api({ to, type: "text", text: { body: part, preview_url: false } });
      this.lastError = "";
      return { sent: true };
    } catch (e) {
      if (e.code === 131047) { this.state.lastInbound[to] = 0; this.save(); return this.outsideWindow(to, text); } // WhatsApp says the window has shut
      this.lastError = e.message;
      throw e;
    }
  }
  async outsideWindow(to, text) {
    const c = this.cfg;
    if (c.template) {
      await this.api({ to, type: "template", template: { name: c.template, language: { code: c.templateLang || "en" }, components: [{ type: "body", parameters: [{ type: "text", text: templateText(text) }] }] } });
      return { sent: true, template: true };
    }
    const held = (this.state.held[to] ||= []);
    held.push({ text: String(text).slice(0, 1500), at: Date.now() });
    if (held.length > 20) held.shift();
    this.save();
    return { held: true };
  }
  /** Updates that waited for WhatsApp's window to open again. */
  async flushHeld(to) {
    const held = this.state.held[to];
    if (!held?.length) return;
    delete this.state.held[to];
    this.save();
    const lines = held.map((h) => `• ${new Date(h.at).toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" })}: ${h.text}`);
    await this.send(to, `While you were away:\n${lines.join("\n")}`);
  }

  /** An approval: two buttons inside the window, a plain "reply YES" outside it. */
  async askYesNo(to, text, id) {
    to = digits(to || this.owner);
    if (!this.windowOpen(to)) return this.send(to, `${text}\n\nReply YES to allow or NO to cancel.`);
    return this.api({ to, type: "interactive", interactive: { type: "button", body: { text: String(text).slice(0, 1000) },
      action: { buttons: [{ type: "reply", reply: { id: `ap:${id}:yes`, title: "Allow" } }, { type: "reply", reply: { id: `ap:${id}:no`, title: "Cancel" } }] } } });
  }

  /** Call the public address the way Meta does, to prove the tunnel reaches this listener. */
  async checkTunnel() {
    const c = this.cfg;
    if (!c.publicUrl || (c.tunnel === "cloudflared" && !this.tunnelUrl)) {
      if (c.tunnel !== "cloudflared") return { ok: false, error: "add your tunnel's public address first" };
      return { ok: false, error: !findCloudflared() ? "install Cloudflare's tunnel app first (winget install --id Cloudflare.cloudflared), then save again" : `the Cloudflare tunnel isn't up yet (${this.tunnelState || "starting"}) - give it a few seconds` };
    }
    if (!this.listening) return { ok: false, error: this.lastError || "the WhatsApp listener isn't running - is WhatsApp switched on?" };
    const url = `${c.publicUrl.replace(/\/+$/, "")}/whatsapp?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(c.verifyToken)}&hub.challenge=dennis-check`;
    try {
      const r = await this.fetch(url, { headers: { "ngrok-skip-browser-warning": "1" }, signal: AbortSignal.timeout(8000) });
      const t = (await r.text()).trim();
      if (t === "dennis-check") return { ok: true };
      return { ok: false, error: `that address answered (${r.status}), but not with D.E.N.N.I.S. - is the tunnel pointing at http://localhost:${c.port}?` };
    } catch (e) {
      const code = e.cause?.code || e.message;
      // a company web gateway that inspects encrypted traffic (this check runs from inside it; Meta calls from outside)
      if (CERT_TROUBLE.test(code)) return { ok: false, error: `your network inspects ${new URL(c.publicUrl).host}, so I can't check it from this computer. Meta's "Verify and save" is the real test (or use the Cloudflare tunnel, which isn't inspected here)` };
      return { ok: false, error: `couldn't reach ${c.publicUrl}: ${code}` };
    }
  }

  status() {
    const c = this.cfg;
    return {
      enabled: c.enabled, ready: this.ready, listening: this.listening, port: +c.port || 47820, verifyToken: c.verifyToken, phoneNumberId: c.phoneNumberId, publicUrl: c.publicUrl,
      tunnel: c.tunnel, appId: c.appId, tunnelState: c.tunnel === "cloudflared" ? this.tunnelState || "" : "", cloudflared: c.tunnel === "cloudflared" ? !!findCloudflared() : null, registered: !!this.registeredAt,
      allow: c.allow, template: c.template, templateLang: c.templateLang, apiVersion: c.apiVersion,
      hasToken: !!this.config.getSecret("waToken"), hasSecret: !!this.config.getSecret("waAppSecret"),
      verified: !!this.verifiedAt, lastInbound: this.lastInboundAt || Math.max(0, ...Object.values(this.state.lastInbound)),
      windowOpen: this.owner ? this.windowOpen(this.owner) : false, held: this.owner ? (this.state.held[this.owner] || []).length : 0,
      ignored: this.ignored, error: this.lastError,
    };
  }
}
