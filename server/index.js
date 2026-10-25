// D.E.N.N.I.S. local server. Serves the interface and a small JSON API on
// 127.0.0.1 only. The Electron app loads it in a window; it also works on its
// own (`npm run serve`) in Chrome.
//
// Access control, because a local server is reachable by any web page the user
// visits:
//  - binds to 127.0.0.1, and rejects requests whose Host isn't this machine
//    (blocks DNS-rebinding)
//  - /api needs the session cookie, set only by visiting /?k=<token>; the cookie
//    is HttpOnly + SameSite=Strict, so other sites can't send it
//  - state-changing calls also need an X-Dennis header (a cross-site page can't
//    add custom headers without a CORS preflight, which we never grant)
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { FileIndex, listDir } from "./fsindex.js";
import { Agent } from "./agent.js";
import { SKILLS_DIR, listSkills, installSkill, removeSkill } from "./skills.js";
import { normalizeServers, claudeDesktopConfigPath } from "./mcp.js";
import { TOOLSETS } from "./minions.js";
import { PROVIDERS, brainOf, listModels } from "./brains.js";
import { applyUndo } from "./tools.js";
import { Reminders } from "./reminders.js";
import { FolderWatcher } from "./watcher.js";
import { RemoteHub } from "./remote.js";
import { DennisMcpEndpoint, ENDPOINT_PATH } from "./mcp-server.js";
import { AppLauncher, findApps } from "./apps.js";
import { OutlookBridge } from "./outlook.js";
import { initLog, dlog, LOG_DIR, listDays, readLog } from "./log.js";
import { OllamaSetup } from "./ollama.js";
import { ChatterboxVoice } from "./chatterbox.js";
import tls from "node:tls";

// Outgoing HTTPS trusts the operating system's certificates as well as Node's own, as browsers do: on a
// company network whose gateway re-signs traffic, its root certificate is in the system store.
try { tls.setDefaultCACertificates([...tls.getCACertificates("default"), ...tls.getCACertificates("system")]); } catch { /* older Node: its own store only */ }
import { history as undoHistory } from "./undo.js";
import { resolveSafe, PathError } from "./paths.js";
import { mimeOf, isExecutable, isTextLike, kindOf } from "./kinds.js";
import { officeText } from "./office.js";
import { DATA_DIR } from "./config.js";

const SERVER_DIR = path.dirname(fileURLToPath(import.meta.url));
const UI_DIR = path.resolve(SERVER_DIR, "..", "ui");
const VERSION = JSON.parse(fs.readFileSync(path.join(UI_DIR, "..", "package.json"), "utf8")).version;
const COOKIE = "dennis_k";

const STATIC_MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json", ".wasm": "application/wasm", ".task": "application/octet-stream",
  ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".woff2": "font/woff2", ".txt": "text/plain; charset=utf-8",
};

function safeEqual(a, b) {
  const x = Buffer.from(String(a || "")), y = Buffer.from(String(b || ""));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function readCookie(req, name) {
  for (const part of String(req.headers.cookie || "").split(/;\s*/)) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i) === name) return decodeURIComponent(part.slice(i + 1));
  }
  return null;
}

async function readJson(req, limit = 1_000_000) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new Error("body too large");
    chunks.push(c);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

// settings fields that are secrets: the log says they changed, never what to
const SECRET_FIELDS = new Set(["apiKey", "elevenKey", "openaiKey", "geminiKey", "deepseekKey", "customKey", "brainKey", "waToken", "waAppSecret", "teamsWebhook"]);
function describePatch(patch) {
  return Object.entries(patch || {}).map(([k, v]) => {
    if (SECRET_FIELDS.has(k)) return `${k}: ${String(v || "").trim() ? "(new secret saved)" : "(removed)"}`;
    if (k === "roots" && Array.isArray(v)) return `folders: ${v.map((r) => r?.label || r?.path).join(", ") || "(none)"}`;
    if (k === "brains" && v && typeof v === "object") return `brains: ${Object.entries(v).map(([p, b]) => `${p} ${b?.model || ""}`.trim()).join(", ")}`;
    let s = "";
    try { s = JSON.stringify(v); } catch { s = String(v); }
    return `${k}: ${s.length > 300 ? `${s.slice(0, 300)}...` : s}`;
  }).join("; ");
}

export async function startServer({ config, platform, mock = false, port } = {}) {
  initLog(config);
  { const locked = config.lockedSecrets(); if (locked.length) dlog("SYSTEM", `saved keys this computer can't unlock (paste them again in Settings): ${locked.join(", ")}`); }
  const index = new FileIndex(config);
  index.schedule();
  const agent = new Agent({ config, index, platform: { ...platform, resolveSafe }, mock });
  const token = config.get("token");
  let current = null; // { abort: AbortController }
  const eventClients = new Set();
  index.onStatus((status) => broadcast({ type: "index", status }));
  // messaging (remote.js): your phone over WhatsApp / Teams. "Away" = no window open, or no activity in one for a while
  const presence = { lastActive: Date.now() };
  const remote = new RemoteHub({ config, agent, broadcast: (ev) => broadcast(ev), isAway: (minutes = 10) => !eventClients.size || Date.now() - presence.lastActive > minutes * 60_000 });
  agent.remote = remote;
  remote.start().catch((e) => console.error("[remote]", e));
  agent.broadcast = (ev) => { broadcast(ev); remote.onEvent(ev); }; // minion progress and approvals reach every open window (and your phone)
  agent.mcp.onChange((servers) => broadcast({ type: "mcp", servers }));
  // the other way round: Claude (the Claude app, Claude Code) talking to him over MCP at /mcp (mcp-server.js)
  const claude = new DennisMcpEndpoint({ config, agent, remote, broadcast: (ev) => broadcast(ev), log: dlog, version: VERSION });
  // apps you've authorized (apps.js); a web app that has to start first opens in every window once it answers
  const apps = new AppLauncher({ config, platform, broadcast: (ev) => broadcast(ev) });
  agent.apps = apps;
  // email through classic Outlook (outlook.js): started on first use, only when switched on
  const outlook = new OutlookBridge({ config });
  agent.email = outlook;
  // the free brain (ollama.js): set up from Settings, "set up Ollama", or a first start with no paid key
  const ollama = new OllamaSetup({ config, broadcast: (ev) => { if (ev.final && ev.phase === "done") agent.conv = null; broadcast(ev); } });
  agent.ollama = ollama;
  // his own voice (chatterbox.js): a local voice server, started now if it's the voice in use
  const chatterbox = new ChatterboxVoice({ config, broadcast: (ev) => broadcast(ev) });
  if (config.get("voice")?.engine === "chatterbox" && chatterbox.installed) chatterbox.ensure().catch((e) => dlog("VOICE", `the Chatterbox voice didn't start: ${e.message}`));
  agent.mcp.start(); // connects in the background
  // reminders go off in every open window; with none open they wait (and are announced as missed)
  // the folder watcher: new batches of files and low disk space, said once (see watcher.js)
  const watcher = new FolderWatcher({ config, index, kindOf, notify: (notice) => {
    const ui = eventClients.size > 0;
    if (ui) broadcast({ type: "watch", notice });
    const text = RemoteHub.watchText(notice);
    const phone = !!text && remote.notify(text, { kind: "watcher" });
    return ui || phone;
  } });
  agent.reminders = new Reminders({ announce: (reminder, { missed }) => {
    const ui = eventClients.size > 0;
    if (ui) broadcast({ type: "reminder", reminder, missed });
    const phone = remote.notify(`\u23F0 ${missed ? "Missed reminder" : "Reminder"}: ${reminder.text}`, { kind: "reminders" });
    return ui || phone;
  } });
  // background events in the daily log (once each: a minion's progress, connected apps)
  const minionSeen = new Map();
  let mcpSeen = "";
  function logEvent(ev) {
    switch (ev?.type) {
      case "remote": if (ev.update) dlog("PHONE", `update sent via ${ev.label || ev.channel}: ${ev.text}`); break;
      case "reminder": dlog("REMINDER", `${ev.missed ? "missed" : "due"}: ${ev.reminder?.text || ""}`); break;
      case "watch": dlog("WATCH", RemoteHub.watchText(ev.notice) || JSON.stringify(ev.notice || {}).slice(0, 400)); break;
      case "app": dlog("APP", ev.text || `${ev.name}: ${ev.phase}`); break;
      case "apps": dlog("APP", `app list saved: ${(ev.apps || []).map((a) => a.name).join(", ") || "(empty)"}`); break;
      case "minion": {
        const r = ev.run;
        if (!r || minionSeen.get(r.id) === r.status) break;
        minionSeen.set(r.id, r.status);
        dlog("MINION", r.status === "running" ? `${r.name} sent off: ${r.task}` : `${r.name}: ${r.status}`, r.status === "running" ? "" : r.report || r.error || "");
        break;
      }
      case "mcp": {
        const s = (ev.servers || []).map((m) => `${m.name} ${m.status}`).join(", ");
        if (s && s !== mcpSeen) dlog("MCP", `connected apps: ${s}`);
        mcpSeen = s;
        break;
      }
      case "index": if (ev.status?.state === "ready") dlog("INDEX", `file index ready: ${(ev.status.total || 0).toLocaleString()} files${ev.status.startedAt ? ` in ${Math.round((ev.status.finishedAt - ev.status.startedAt) / 1000)} s` : ""}`); break;
      default: break;
    }
  }
  function broadcast(ev) {
    try { logEvent(ev); } catch { /* never in the way */ }
    const line = `data: ${JSON.stringify(ev)}\n\n`;
    for (const res of eventClients) res.write(line);
  }

  const roots = () => config.get("roots") || [];
  const safe = (p, opts) => resolveSafe(p, roots(), opts);

  const send = (res, code, body, headers = {}) => {
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
    res.writeHead(code, { "Content-Type": typeof body === "string" ? "text/plain; charset=utf-8" : "application/json", "Content-Length": buf.length, "Cache-Control": "no-store", ...headers });
    res.end(buf);
  };

  function serveStatic(req, res, urlPath) {
    let rel = decodeURIComponent(urlPath);
    if (rel === "/" || rel === "") rel = "/index.html";
    const file = path.resolve(UI_DIR, "." + rel);
    if (!file.startsWith(UI_DIR + path.sep)) return send(res, 403, "forbidden");
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) return send(res, 404, "not found");
      const ext = path.extname(file).toLowerCase();
      const headers = {
        "Content-Type": STATIC_MIME[ext] || "application/octet-stream",
        "Content-Length": st.size,
        "Cache-Control": rel.startsWith("/vendor/") ? "public, max-age=604800" : "no-cache",
        "Cross-Origin-Resource-Policy": "same-origin",
        // Cross-origin isolation lets the speech model use multiple threads (pages and workers alike).
        "Cross-Origin-Opener-Policy": "same-origin",
        "Cross-Origin-Embedder-Policy": "credentialless",
        "X-Content-Type-Options": "nosniff",
      };
      if (ext === ".html") {
        headers["Content-Security-Policy"] = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval' blob:; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self' https://huggingface.co https://*.huggingface.co https://*.hf.co https://cdn-lfs.hf.co https://storage.googleapis.com; frame-src 'self'; object-src 'self'";
      }
      res.writeHead(200, headers);
      fs.createReadStream(file).pipe(res);
    });
  }

  function serveRaw(req, res, file) {
    const st = fs.statSync(file);
    if (!st.isFile()) return send(res, 400, { error: "not a file" });
    const type = mimeOf(file);
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || "");
    const base = { "Content-Type": type, "Accept-Ranges": "bytes", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "sandbox; default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'", "Cross-Origin-Resource-Policy": "same-origin" };
    if (range) {
      let start = range[1] ? +range[1] : st.size - +range[2];
      let end = range[1] && range[2] ? +range[2] : st.size - 1;
      if (!range[1]) end = st.size - 1;
      start = Math.max(0, start); end = Math.min(st.size - 1, end);
      if (start > end) { res.writeHead(416, { "Content-Range": `bytes */${st.size}` }); return res.end(); }
      res.writeHead(206, { ...base, "Content-Range": `bytes ${start}-${end}/${st.size}`, "Content-Length": end - start + 1 });
      fs.createReadStream(file, { start, end }).pipe(res);
    } else {
      res.writeHead(200, { ...base, "Content-Length": st.size });
      fs.createReadStream(file).pipe(res);
    }
  }

  async function rootListing() {
    const items = [];
    for (const r of roots()) {
      try {
        const st = fs.statSync(r.path);
        const ds = index.dirStats(r.path);
        items.push({ name: r.label, path: r.path, kind: "folder", isDir: true, isRoot: true, size: ds?.bytes ?? 0, items: ds?.files, kinds: ds?.kinds, mtime: Math.round(st.mtimeMs) });
      } catch { items.push({ name: r.label, path: r.path, kind: "folder", isDir: true, isRoot: true, missing: true, size: 0, mtime: 0 }); }
    }
    return { path: "", items };
  }

  async function api(req, res, url) {
    const route = url.pathname.slice(4); // strip "/api"
    const q = url.searchParams;
    const isGet = req.method === "GET";
    if (!isGet && req.headers["x-dennis"] !== "1") return send(res, 403, { error: "missing X-Dennis header" });

    if (route === "/state" && isGet) {
      return send(res, 200, { version: VERSION, config: config.publicView(), index: index.status, mock, electron: !!platform.electron, platform: process.platform });
    }
    if (route === "/events" && isGet) {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
      res.write(`data: ${JSON.stringify({ type: "index", status: index.status })}\n\n`);
      eventClients.add(res);
      setTimeout(() => agent.reminders?.tick(), 2500); // anything that came due while no window was open
      const ping = setInterval(() => res.write(": ping\n\n"), 25000);
      req.on("close", () => { clearInterval(ping); eventClients.delete(res); });
      return;
    }
    // the window says you're at the computer (so updates don't also buzz your phone)
    if (route === "/presence" && req.method === "POST") { presence.lastActive = Date.now(); return send(res, 200, { ok: true }); }
    // ---- messaging: WhatsApp and Teams
    if (route === "/remote" && isGet) return send(res, 200, remote.status());
    if (route === "/remote" && req.method === "POST") {
      const b = await readJson(req);
      try {
        if (b.action === "restart") { await remote.restart(); return send(res, 200, { ok: true, status: remote.status() }); }
        if (b.action === "test") {
          const r = await remote.message(`Hello from D.E.N.N.I.S. \u{1F44B} This is ${b.channel === "teams" ? "Teams" : "WhatsApp"} working. Message me here any time - and reply STOP whenever you want me to stop what I'm doing.`, b.channel || "any");
          return send(res, 200, typeof r === "string" ? { ok: true, text: r } : { ok: false, error: r.error });
        }
        if (b.action === "wa-check") return send(res, 200, await remote.wa.checkTunnel());
        if (b.action === "teams-signin") return send(res, 200, { ok: true, ...(await remote.teams.startSignIn()) });
        if (b.action === "teams-signout") { remote.teams.signOut(); return send(res, 200, { ok: true }); }
        if (b.action === "teams-chats") return send(res, 200, { ok: true, chats: await remote.teams.listChats() });
        // where a OneDrive inbox would sync to on this computer (OneDrive for work / school, else personal)
        if (b.action === "inbox-suggest") {
          const od = process.env.OneDriveCommercial || process.env.OneDrive || "";
          return send(res, 200, { ok: true, folder: od ? path.join(od, "Dennis", "Inbox") : "", oneDrive: od, onedrivePath: "/Dennis/Inbox" });
        }
      } catch (e) { return send(res, 200, { ok: false, error: e.message }); }
      return send(res, 400, { error: "unknown action" });
    }
    if (route === "/settings" && req.method === "POST") {
      const patch = await readJson(req);
      if (typeof patch.city === "string") {
        // "Your city" for the weather: looked up once with Open-Meteo's free geocoder
        const q = patch.city.trim();
        if (!q) patch.location = null;
        else if (q !== config.get("location")?.query) {
          try {
            const g = await (await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q.split(",")[0].trim())}&count=1&format=json`, { signal: AbortSignal.timeout(6000) })).json();
            const hit = g.results?.[0];
            if (hit) patch.location = { query: q, name: [hit.name, hit.country].filter(Boolean).join(", "), lat: hit.latitude, lon: hit.longitude };
            else return send(res, 200, { ok: false, error: `I couldn't find a place called "${q}".`, config: config.publicView() });
          } catch { return send(res, 200, { ok: false, error: "Couldn't look up that city right now.", config: config.publicView() }); }
        }
        delete patch.city;
      }
      const before = JSON.stringify(config.get("roots")) + config.get("showHidden");
      config.update(patch);
      dlog("SETTINGS", describePatch(patch));
      if (JSON.stringify(config.get("roots")) + config.get("showHidden") !== before) index.rebuild();
      if ("roots" in patch || "watch" in patch) watcher.restart();
      if ("remote" in patch || "waToken" in patch || "waAppSecret" in patch || "teamsWebhook" in patch) await remote.restart();
      if ("email" in patch && !config.get("email")?.enabled) outlook.close(); // switched off: let go of Outlook
      if (patch.voice && "engine" in patch.voice) { // the Chatterbox voice runs only while it's the voice in use (it holds graphics memory)
        if (patch.voice.engine === "chatterbox" && chatterbox.installed) chatterbox.ensure().catch((e) => dlog("VOICE", `the Chatterbox voice didn't start: ${e.message}`));
        else if (patch.voice.engine !== "chatterbox") chatterbox.stop();
      }
      // settings that shape the system prompt or tools start a fresh conversation; the look, the
      // hands, messaging and the small voice switches (continuous, wake word, speak) don't
      const quiet = ["visuals", "hands", "remote", "waToken", "waAppSecret", "teamsWebhook", "logs"];
      const quietVoice = ["continuous", "wakeWord", "speak", "micId", "rate", "pitch"];
      const reshapes = Object.keys(patch).some((k) => !quiet.includes(k) && !(k === "voice" && Object.keys(patch.voice || {}).every((v) => quietVoice.includes(v))));
      if (reshapes) agent.conv = null; // next message starts fresh
      agent.docsBlocked = null; // and give document skills another try
      return send(res, 200, { ok: true, config: config.publicView() });
    }
    if (route === "/list" && isGet) {
      const p = q.get("path") || "";
      if (!p) return send(res, 200, await rootListing());
      const dir = safe(p);
      const { items, truncated } = await listDir(dir, { showHidden: config.get("showHidden"), index });
      return send(res, 200, { path: dir, items, truncated, stats: index.dirStats(dir) });
    }
    if (route === "/raw" && isGet) return serveRaw(req, res, safe(q.get("path")));
    if (route === "/text" && isGet) {
      const file = safe(q.get("path"));
      const max = Math.min(+q.get("max") || 60_000, 400_000);
      const office = officeText(file);
      if (office != null) return send(res, 200, { text: office.slice(0, max), truncated: office.length > max });
      if (!isTextLike(file)) return send(res, 200, { text: null });
      const fd = fs.openSync(file, "r");
      try {
        const buf = Buffer.alloc(Math.min(fs.fstatSync(fd).size, max));
        fs.readSync(fd, buf, 0, buf.length, 0);
        if (buf.includes(0)) return send(res, 200, { text: null });
        return send(res, 200, { text: buf.toString("utf8"), truncated: buf.length === max });
      } finally { fs.closeSync(fd); }
    }
    if (route === "/activity" && isGet) {
      const p = q.get("path") || "";
      const under = p ? safe(p) : undefined;
      const days = index.activity(under, 30);
      return send(res, 200, { days, week: days.slice(-7).reduce((a, b) => a + b, 0), month: days.reduce((a, b) => a + b, 0) });
    }
    if (route === "/search" && isGet) {
      return send(res, 200, { results: index.search(q.get("q") || "", { kind: q.get("kind") || undefined, limit: Math.min(+q.get("limit") || 60, 300) }), index: index.status });
    }
    if (route === "/info" && isGet) {
      const items = [];
      for (const p of (q.get("paths") || "").split("\n").filter(Boolean).slice(0, 300)) {
        try {
          const f = safe(p);
          const st = fs.statSync(f);
          const ds = st.isDirectory() ? index.dirStats(f) : null;
          items.push({ name: path.basename(f), path: f, isDir: st.isDirectory(), kind: kindOf(f, st.isDirectory()), size: ds ? ds.bytes : st.size, items: ds?.files, mtime: Math.round(st.mtimeMs) });
        } catch { /* skip */ }
      }
      return send(res, 200, { items });
    }
    if (route === "/chat" && req.method === "POST") {
      const body = await readJson(req);
      if (current) current.abort.abort();
      const abort = new AbortController();
      const mine = (current = { abort });
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive", "X-Accel-Buffering": "no" });
      res.on("close", () => { if (!res.writableFinished) abort.abort(); });
      const emit = (ev) => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(ev)}\n\n`); };
      try {
        await agent.turn({ text: String(body.text || ""), context: body.context || {}, emit, signal: abort.signal });
      } finally {
        if (current === mine) current = null;
        res.end();
      }
      return;
    }
    // the window answering a tool's request (show_diagram: did it draw, and the picture if asked)
    if (route === "/ui-reply" && req.method === "POST") {
      const { id, result } = await readJson(req, 40_000_000);
      return send(res, 200, { ok: agent.resolveUi(String(id || ""), result) });
    }
    // a diagram's SAVE button: SVG and PNG into the data folder
    if (route === "/diagram-save" && req.method === "POST") {
      const b = await readJson(req, 40_000_000);
      const dir = path.join(config.publicView().dataDir, "diagrams");
      fs.mkdirSync(dir, { recursive: true });
      const d = new Date(), p2 = (n) => String(n).padStart(2, "0");
      const stamp = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
      const name = `${stamp} ${String(b.title || "Diagram").replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").trim().slice(0, 60) || "Diagram"}`;
      if (typeof b.svg !== "string" || !/^\s*<svg[\s>]/.test(b.svg)) return send(res, 400, { error: "not an SVG" });
      fs.writeFileSync(path.join(dir, name + ".svg"), b.svg);
      let file = path.join(dir, name + ".svg");
      if (typeof b.png === "string" && b.png) { file = path.join(dir, name + ".png"); fs.writeFileSync(file, Buffer.from(b.png, "base64")); }
      return send(res, 200, { ok: true, path: file });
    }
    if (route === "/approve" && req.method === "POST") {
      const { id, yes } = await readJson(req);
      return send(res, 200, { ok: agent.resolveApproval(id, yes) });
    }
    if (route === "/stop" && req.method === "POST") {
      current?.abort.abort();
      return send(res, 200, { ok: true });
    }
    if (route === "/new" && req.method === "POST") {
      current?.abort.abort();
      agent.conv = null;
      return send(res, 200, { ok: true });
    }
    if (route === "/reindex" && req.method === "POST") {
      index.rebuild();
      return send(res, 200, { ok: true });
    }
    if (route === "/open" && req.method === "POST") {
      const { path: p } = await readJson(req);
      const f = safe(p);
      // A click on "Open" for a program reveals it instead of running it.
      if (!fs.statSync(f).isDirectory() && isExecutable(f)) { platform.revealPath(f); return send(res, 200, { ok: true, revealed: true }); }
      const err = await platform.openPath(f);
      return send(res, err ? 500 : 200, err ? { error: err } : { ok: true });
    }
    if (route === "/reveal" && req.method === "POST") {
      const { path: p } = await readJson(req);
      platform.revealPath(safe(p));
      return send(res, 200, { ok: true });
    }
    if (route === "/tts" && req.method === "POST") {
      // ElevenLabs voice: the key stays here on the server; the page only ever gets audio back
      const key = config.getSecret("elevenKey");
      if (!key) return send(res, 400, { error: "no ElevenLabs key in Settings" });
      const { text, lang } = await readJson(req, 20_000);
      const v = config.get("voice") || {};
      const voiceId = encodeURIComponent(v.elevenVoice || "onwK4e9ZLuTAKqWW03F9");
      const model = v.elevenModel || "eleven_flash_v2_5";
      const body = { text: String(text || "").slice(0, 2500), model_id: model, voice_settings: { stability: 0.45, similarity_boost: 0.8 } };
      // tell the v2.5 models which language it is, so a short Arabic or Japanese line isn't read with the wrong accent
      if (/_v2_5$/.test(model) && ["en", "ar", "fr", "ja", "zh"].includes(lang)) body.language_code = lang;
      const speak = (b) => fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`, {
        method: "POST",
        headers: { "xi-api-key": key, "Content-Type": "application/json", Accept: "audio/mpeg" },
        body: JSON.stringify(b),
        signal: AbortSignal.timeout(20_000),
      });
      let r;
      try {
        r = await speak(body);
        if (!r.ok && r.status === 400 && body.language_code) { delete body.language_code; r = await speak(body); } // never lose the voice over the hint
      } catch (e) {
        const why = e.name === "TimeoutError" ? "ElevenLabs took too long to answer" : `Couldn't reach ElevenLabs: ${e.cause?.code || e.message}`;
        dlog("VOICE", `ElevenLabs failed: ${why} - the local voice stood in`);
        return send(res, 502, { error: why });
      }
      if (!r.ok) {
        const detail = await r.text().catch(() => "");
        dlog("VOICE", `ElevenLabs failed: it answered ${r.status} - the local voice stood in`, detail.slice(0, 300));
        return send(res, r.status === 401 ? 401 : 502, { error: r.status === 401 ? "ElevenLabs rejected the key" : `ElevenLabs error ${r.status}: ${detail.slice(0, 200)}` });
      }
      const audio = Buffer.from(await r.arrayBuffer());
      return send(res, 200, audio, { "Content-Type": "audio/mpeg" });
    }
    if (route === "/diag" && req.method === "POST") {
      // the interface reports voice attempts and errors here, so problems can be diagnosed afterwards
      const entry = await readJson(req, 20_000);
      const dir = path.join(DATA_DIR, "logs");
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, "diag.log");
      try { if (fs.statSync(file).size > 1_000_000) fs.renameSync(file, file + ".old"); } catch { /* first entry */ }
      fs.appendFileSync(file, JSON.stringify({ t: new Date().toISOString(), ...entry }) + "\n");
      if (entry.kind === "voice") dlog("VOICE", entry.reason || `listened ${((entry.ms || 0) / 1000).toFixed(1)} s - ${entry.ok ? "heard you" : "heard nothing usable"}${entry.ended ? ` (${entry.ended})` : ""}`, entry.mic ? `mic: ${entry.mic}${entry.model ? ` - ${entry.model}` : ""}` : "");
      else if (entry.kind === "instant") dlog("INSTANT", `"${entry.heard || ""}" - done on the spot: ${entry.action}${entry.arg ? ` ${entry.arg}` : ""}`);
      else if (entry.kind === "error" || entry.kind === "rejection") dlog("UI ERROR", String(entry.message || ""), String(entry.at || ""));
      else dlog("UI", JSON.stringify(entry).slice(0, 500));
      return send(res, 200, { ok: true });
    }
    // ---- skills
    if (route === "/skills" && isGet) {
      const skills = listSkills(config.get("skillsDisabled") || []).map(({ id, name, description, enabled }) => ({ id, name, description, enabled }));
      return send(res, 200, { dir: SKILLS_DIR, skills, canPick: !!platform.pickFolder });
    }
    if (route === "/skills" && req.method === "POST") {
      const b = await readJson(req);
      const disabled = new Set(config.get("skillsDisabled") || []);
      try {
        if (b.action === "install") {
          let src = typeof b.path === "string" ? b.path.trim() : "";
          if (!src && b.kind === "file") src = (await platform.pickFile?.({ title: "Choose a skill (.zip or SKILL.md)", filters: [{ name: "Skills", extensions: ["zip", "md"] }] })) || "";
          else if (!src) src = (await platform.pickFolder?.()) || "";
          if (!src) return send(res, 200, { ok: false, cancelled: true });
          const sk = installSkill(src);
          agent.conv = null; // the skill list lives in the system prompt
          return send(res, 200, { ok: true, skill: { id: sk.id, name: sk.name } });
        }
        if (b.action === "toggle") {
          if (b.enabled) disabled.delete(String(b.id)); else disabled.add(String(b.id));
          config.update({ skillsDisabled: [...disabled] });
          agent.conv = null;
          return send(res, 200, { ok: true });
        }
        if (b.action === "remove") {
          removeSkill(b.id);
          disabled.delete(String(b.id));
          config.update({ skillsDisabled: [...disabled] });
          agent.conv = null;
          return send(res, 200, { ok: true });
        }
        if (b.action === "reveal") {
          fs.mkdirSync(SKILLS_DIR, { recursive: true });
          await platform.openPath?.(SKILLS_DIR);
          return send(res, 200, { ok: true });
        }
      } catch (e) { return send(res, 200, { ok: false, error: e.message }); }
      return send(res, 400, { error: "unknown action" });
    }
    // ---- MCP connections
    if (route === "/mcp" && isGet) {
      const cd = claudeDesktopConfigPath();
      return send(res, 200, { servers: agent.mcp.status(), config: config.get("mcpServers") || {}, claudeDesktop: fs.existsSync(cd) ? cd : null });
    }
    if (route === "/mcp" && req.method === "POST") {
      const b = await readJson(req);
      try {
        if (b.action === "save") {
          const servers = normalizeServers(b.servers ?? {});
          config.update({ mcpServers: servers });
          agent.conv = null;
          agent.mcp.start();
          return send(res, 200, { ok: true, config: servers });
        }
        if (b.action === "reconnect") {
          for (const name of [...agent.mcp.servers.keys()]) await agent.mcp.disconnect(name);
          agent.conv = null;
          agent.mcp.start();
          return send(res, 200, { ok: true });
        }
        if (b.action === "import-claude") {
          // read Claude Desktop's servers for the user to review; nothing is saved here
          const raw = JSON.parse(fs.readFileSync(claudeDesktopConfigPath(), "utf8"));
          const servers = {}, skipped = [];
          for (const [name, def] of Object.entries(raw?.mcpServers || {})) {
            try { Object.assign(servers, normalizeServers({ [name]: def })); } catch (e) { skipped.push(`${name}: ${e.message}`); }
          }
          return send(res, 200, { ok: true, servers, skipped });
        }
      } catch (e) { return send(res, 200, { ok: false, error: e.message }); }
      return send(res, 400, { error: "unknown action" });
    }
    // ---- Claude talking to him (mcp-server.js): on/off, the address, the token and ready-made configs
    if (route === "/mcp-server" && (isGet || req.method === "POST")) {
      const b = isGet ? {} : await readJson(req);
      if (b.action === "enable" || b.action === "disable") {
        config.update({ mcpServer: { enabled: b.action === "enable" } });
        dlog("SETTINGS", `Claude over MCP: ${b.action === "enable" ? "switched on" : "switched off"}`);
      } else if (b.action === "new-token") {
        config.ensureMcpToken(true);
        dlog("SETTINGS", "Claude over MCP: new token made (the old one stops working)");
      } else if (!isGet) return send(res, 400, { error: "unknown action" });
      const on = !!config.get("mcpServer")?.enabled;
      const url = `http://127.0.0.1:${actualPort}${ENDPOINT_PATH}`;
      const token = on ? config.ensureMcpToken() : null;
      const bridge = path.join(SERVER_DIR, "mcp-stdio.mjs");
      return send(res, 200, {
        ok: true, enabled: on, url, token, bridge,
        // the Claude desktop app starts local MCP servers as programs: the stdio door reads the token itself
        desktop: { mcpServers: { dennis: { command: "node", args: [bridge] } } },
        claudeCode: on ? `claude mcp add --transport http dennis ${url} --header "Authorization: Bearer ${token}"` : null,
      });
    }
    // ---- meeting notes: the raw transcript is kept in the data folder the moment notes end
    if (route === "/notes" && req.method === "POST") {
      const b = await readJson(req, 5_000_000);
      const dir = path.join(config.publicView().dataDir, "notes");
      fs.mkdirSync(dir, { recursive: true });
      const d = new Date(), p2 = (n) => String(n).padStart(2, "0");
      const stamp = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}${p2(d.getMinutes())}`; // local time
      const title = String(b.title || "Meeting").replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").slice(0, 60);
      const file = path.join(dir, `${stamp} ${title}.txt`);
      fs.writeFileSync(file, String(b.text || ""));
      return send(res, 200, { ok: true, path: file });
    }
    // ---- undo: "undo that" / Ctrl+Z, straight from you (no approval needed)
    if (route === "/undo" && isGet) return send(res, 200, { history: undoHistory(10) });
    if (route === "/undo" && req.method === "POST") {
      const b = await readJson(req);
      const refreshed = [];
      const text = applyUndo(Math.max(1, Math.min(10, +b.count || 1)), { config, index, ui: (ev) => refreshed.push(ev.path) });
      return send(res, 200, { ok: true, text, refresh: [...new Set(refreshed)] });
    }
    // ---- brains: which models a provider offers (for the Settings picker)
    if (route === "/brains/models" && req.method === "POST") {
      const b = await readJson(req);
      const p = PROVIDERS[b.provider];
      if (b.provider === "anthropic" || b.provider === "auto") {
        try {
          const models = [];
          for await (const m of agent.client().models.list({ limit: 100 })) if (m.lifecycle !== "retired") models.push({ id: m.id, name: m.display_name || m.id });
          return send(res, 200, { ok: true, models: models.map((m) => m.id), names: Object.fromEntries(models.map((m) => [m.id, m.name])) });
        } catch (e) { return send(res, 200, { ok: false, error: `Couldn't ask Anthropic for the list: ${e.message}` }); }
      }
      if (!p) return send(res, 400, { error: "pick a brain first" });
      const saved = config.get("provider") === b.provider ? brainOf(config) : { ...brainOf({ get: (k) => (k === "provider" ? b.provider : config.get(k)), getSecret: (k) => config.getSecret(k) }) };
      const brain = { ...saved, provider: b.provider, label: p.label, baseUrl: String(b.baseUrl || saved.baseUrl || p.baseUrl || "").replace(/\/+$/, ""), apiKey: b.apiKey || (p.keyName ? config.getSecret(p.keyName) : null) };
      try { return send(res, 200, { ok: true, models: await listModels(brain) }); }
      catch (e) { return send(res, 200, { ok: false, error: e.message }); }
    }
    // ---- minions
    if (route === "/minions" && isGet) {
      return send(res, 200, { definitions: agent.minions.definitions(), runs: agent.minions.list(), toolsets: TOOLSETS });
    }
    if (route === "/minions" && req.method === "POST") {
      const b = await readJson(req);
      try {
        if (b.action === "define") { const d = agent.minions.define(b.definition || {}); agent.conv = null; return send(res, 200, { ok: true, definition: d }); }
        if (b.action === "remove") { agent.minions.undefine(b.name); agent.conv = null; return send(res, 200, { ok: true }); }
        if (b.action === "deploy") return send(res, 200, { ok: true, run: agent.minions.deploy({ minion: b.minion, task: b.task }) });
        if (b.action === "recall") return send(res, 200, { ok: agent.minions.recall(b.id) });
      } catch (e) { return send(res, 200, { ok: false, error: e.message }); }
      return send(res, 400, { error: "unknown action" });
    }
    // ---- email through classic Outlook (outlook.js)
    if (route === "/email" && (isGet || req.method === "POST")) {
      const b = isGet ? {} : await readJson(req);
      const base = { enabled: outlook.enabled, available: outlook.available };
      if (!base.available) return send(res, 200, { ...base, ok: false, error: "Email through Outlook needs Windows with classic Outlook." });
      if (!base.enabled && b.action !== "test") return send(res, 200, { ...base, ok: true, status: null });
      try { return send(res, 200, { ...base, ok: true, status: await outlook.call("status", {}, { timeoutMs: 40_000 }) }); }
      catch (e) { return send(res, 200, { ...base, ok: false, error: e.message }); }
    }
    // ---- apps you've authorized (apps.js)
    if (route === "/apps" && isGet) return send(res, 200, { apps: apps.list(), canPick: !!platform.pickFile, browser: !!platform.electron });
    if (route === "/apps" && req.method === "POST") {
      const b = await readJson(req);
      try {
        if (b.action === "save") { config.update({ apps: b.apps }); agent.conv = null; broadcast({ type: "apps", apps: apps.list() }); return send(res, 200, { ok: true, apps: apps.list() }); } // the list is in his prompt; windows hear of it for "open X"
        if (b.action === "find") return send(res, 200, { ok: true, found: findApps(b.query || "") });
        if (b.action === "pick") {
          const p = await platform.pickFile?.({ title: "Choose the program, script or shortcut", filters: [{ name: "Programs and shortcuts", extensions: ["exe", "bat", "cmd", "lnk", "url", "appref-ms", "app"] }, { name: "All files", extensions: ["*"] }] });
          return send(res, 200, { ok: !!p, path: p || null });
        }
        if (b.action === "open") { const r = await apps.open(String(b.name || "")); dlog("APP", `open ${b.name} (from the screen)`, r.error || r.text || ""); return send(res, 200, r.error ? { ok: false, error: r.error } : { ok: true, ...r }); }
        if (b.action === "check") { const a = apps.find(b.name); return send(res, 200, { ok: !!a, up: a?.page ? await apps.isUp(a) : null }); }
      } catch (e) { return send(res, 200, { ok: false, error: e.message }); }
      return send(res, 400, { error: "unknown action" });
    }
    // ---- his own voice (chatterbox.js)
    if (route === "/voice" && isGet) return send(res, 200, await chatterbox.status());
    if (route === "/voice" && req.method === "POST") {
      const b = await readJson(req);
      try {
        if (b.action === "setup") return send(res, 200, chatterbox.setup());
        if (b.action === "cancel") return send(res, 200, { ok: chatterbox.cancel() });
        if (b.action === "pick-sample") {
          const p = await platform.pickFile?.({ title: "Choose a voice sample: 10-20 seconds of clear speech", filters: [{ name: "Audio", extensions: ["wav", "mp3", "flac", "ogg"] }] });
          if (!p) return send(res, 200, { ok: false, cancelled: true });
          return send(res, 200, { ok: true, sample: chatterbox.useSample(p) });
        }
        if (b.action === "default-sample") return send(res, 200, { ok: true, sample: chatterbox.useSample("") });
      } catch (e) { return send(res, 200, { ok: false, error: e.message }); }
      return send(res, 400, { error: "unknown action" });
    }
    if (route === "/voice/speak" && req.method === "POST") {
      const { text, lang } = await readJson(req, 20_000);
      try {
        const r = await chatterbox.speak(String(text || ""), String(lang || "en"));
        return send(res, 200, r.audio, { "Content-Type": "audio/wav", "X-Took": String(r.took), "X-Model": r.model });
      } catch (e) {
        dlog("VOICE", `Chatterbox failed: ${e.message} - another voice stood in`);
        return send(res, 503, { error: e.message });
      }
    }
    // ---- the free brain (ollama.js)
    if (route === "/ollama" && isGet) return send(res, 200, await ollama.status());
    if (route === "/ollama" && req.method === "POST") {
      const b = await readJson(req);
      if (b.action === "setup") return send(res, 200, ollama.setup({ model: b.model ? String(b.model).trim() : undefined }));
      if (b.action === "cancel") return send(res, 200, { ok: ollama.cancel() });
      return send(res, 400, { error: "unknown action" });
    }
    // ---- his daily log (log.js)
    if (route === "/logs" && isGet) return send(res, 200, { dir: LOG_DIR, days: listDays().slice(0, 400), today: q.get("today") ? readLog({ day: "today", limit: 200 }) : undefined });
    if (route === "/logs" && req.method === "POST") {
      const b = await readJson(req);
      if (b.action === "reveal") { fs.mkdirSync(LOG_DIR, { recursive: true }); await platform.openPath?.(LOG_DIR); return send(res, 200, { ok: true }); }
      return send(res, 400, { error: "unknown action" });
    }
    if (route === "/pick-folder" && req.method === "POST") {
      if (!platform.pickFolder) return send(res, 200, { path: null });
      return send(res, 200, { path: await platform.pickFolder() });
    }
    return send(res, 404, { error: "unknown endpoint" });
  }

  let actualPort = port || config.get("port") || 47800;
  const hostOk = (h) => {
    const allowed = [`127.0.0.1:${actualPort}`, `localhost:${actualPort}`, `[::1]:${actualPort}`];
    return allowed.includes(String(h || "").toLowerCase());
  };

  const server = http.createServer(async (req, res) => {
    try {
      if (!hostOk(req.headers.host)) return send(res, 421, "wrong host");
      const url = new URL(req.url, `http://127.0.0.1:${actualPort}`);
      if (url.pathname === "/" && url.searchParams.has("k")) {
        if (!safeEqual(url.searchParams.get("k"), token)) return send(res, 403, "bad key");
        const rest = new URLSearchParams(url.searchParams);
        rest.delete("k");
        res.writeHead(302, {
          "Set-Cookie": `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`,
          Location: "/" + (rest.toString() ? "?" + rest : ""),
          "Cache-Control": "no-store",
        });
        return res.end();
      }
      if (url.pathname.startsWith("/api/")) {
        if (!safeEqual(readCookie(req, COOKIE), token)) return send(res, 401, { error: "locked" });
        return await api(req, res, url);
      }
      // Claude over MCP: its own bearer token, checked there (404 while switched off)
      if (url.pathname === ENDPOINT_PATH) return await claude.handle(req, res);
      return serveStatic(req, res, url.pathname);
    } catch (e) {
      if (res.headersSent) { try { res.end(); } catch { /* gone */ } return; }
      if (e instanceof PathError) return send(res, 403, { error: e.message });
      if (e.code === "ENOENT") return send(res, 404, { error: "not found" });
      if (e.code === "EACCES" || e.code === "EPERM") return send(res, 403, { error: "permission denied" });
      console.error("[server]", e);
      return send(res, 500, { error: e.message });
    }
  });

  // Fixed port keeps the page's origin stable (camera permission, cached speech
  // model, saved layout). If it's taken, walk up a few.
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(actualPort, "127.0.0.1", () => { server.off("error", reject); resolve(); });
      });
      break;
    } catch (e) {
      if (e.code !== "EADDRINUSE" || attempt === 19) throw e;
      actualPort++;
    }
  }
  const base = `http://127.0.0.1:${actualPort}`;
  // where he's listening, for mcp-stdio.mjs (the port walks up when 47800 is taken)
  const RUN_FILE = path.join(DATA_DIR, "run.json");
  try { fs.writeFileSync(RUN_FILE, JSON.stringify({ port: actualPort, pid: process.pid, startedAt: new Date().toISOString() })); } catch { /* the stdio door falls back to the configured port */ }
  { const b = agent.brain(); dlog("START", `D.E.N.N.I.S. ${VERSION} is up on port ${actualPort}${platform.electron ? " (desktop app)" : ""} - brain: ${b.label}${b.model ? ` (${b.model})` : ""} - ${roots().length} mapped folders`); }
  return {
    port: actualPort,
    url: base,
    openUrl: `${base}/?k=${token}`,
    index,
    agent,
    close: async () => {
      dlog("STOP", "shutting down");
      for (const r of agent.minions.running()) agent.minions.recall(r.id);
      claude.close();
      try { if (JSON.parse(fs.readFileSync(RUN_FILE, "utf8")).pid === process.pid) fs.rmSync(RUN_FILE); } catch { /* already gone */ }
      agent.reminders?.close();
      watcher.close();
      remote.close();
      apps.close();
      outlook.close();
      ollama.cancel();
      chatterbox.close();
      await agent.mcp.close().catch(() => {}); // stops local MCP server processes
      await new Promise((r) => { for (const c of eventClients) c.end(); server.close(() => r()); });
    },
  };
}
