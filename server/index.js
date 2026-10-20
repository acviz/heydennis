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
import { resolveSafe, PathError } from "./paths.js";
import { mimeOf, isExecutable, isTextLike, kindOf } from "./kinds.js";
import { officeText } from "./office.js";
import { DATA_DIR } from "./config.js";

const UI_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "ui");
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

export async function startServer({ config, platform, mock = false, port } = {}) {
  const index = new FileIndex(config);
  index.schedule();
  const agent = new Agent({ config, index, platform: { ...platform, resolveSafe }, mock });
  const token = config.get("token");
  let current = null; // { abort: AbortController }
  const eventClients = new Set();
  index.onStatus((status) => broadcast({ type: "index", status }));
  function broadcast(ev) {
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
      const ping = setInterval(() => res.write(": ping\n\n"), 25000);
      req.on("close", () => { clearInterval(ping); eventClients.delete(res); });
      return;
    }
    if (route === "/settings" && req.method === "POST") {
      const patch = await readJson(req);
      const before = JSON.stringify(config.get("roots")) + config.get("showHidden");
      config.update(patch);
      if (JSON.stringify(config.get("roots")) + config.get("showHidden") !== before) index.rebuild();
      agent.conv = null; // settings shape the system prompt and tools: next message starts fresh
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
      const { text } = await readJson(req, 20_000);
      const v = config.get("voice") || {};
      const voiceId = encodeURIComponent(v.elevenVoice || "onwK4e9ZLuTAKqWW03F9");
      const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`, {
        method: "POST",
        headers: { "xi-api-key": key, "Content-Type": "application/json", Accept: "audio/mpeg" },
        body: JSON.stringify({ text: String(text || "").slice(0, 2500), model_id: v.elevenModel || "eleven_flash_v2_5", voice_settings: { stability: 0.45, similarity_boost: 0.8 } }),
      });
      if (!r.ok) {
        const detail = await r.text().catch(() => "");
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
      return send(res, 200, { ok: true });
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
  return {
    port: actualPort,
    url: base,
    openUrl: `${base}/?k=${token}`,
    index,
    agent,
    close: () => new Promise((r) => { for (const c of eventClients) c.end(); server.close(() => r()); }),
  };
}
