// D.E.N.N.I.S. interface controller: navigation, panels, the conversation, and
// one input model fed by three sources (mouse, hands, voice).
import { api, LockedError } from "./api.js";
import { Galaxy, KIND_COLORS, KIND_NAMES, MAX_NODES, fmtBytes, escapeHtml } from "./galaxy.js";
import { Gestures, HandTracker, synthHand, handMetrics, dedupe, cameraRank } from "./hands.js";
import { openReader, READABLE } from "./reader.js";
import { Voice } from "./voice.js";
import { HandsFree, isStopPhrase, isRepeatPhrase } from "./handsfree.js";
import { Caps } from "./caps.js";
import { matchCommand } from "./commands.js";
import { THEMES, THEME_ORDER, themeName } from "./themes.js";
import { renderDiagram, standaloneSvg, toPng, diagramSize, fitScale } from "./diagram.js";
import { Hud } from "./hud.js";

const $ = (s) => document.querySelector(s);
const Q = new URLSearchParams(location.search);
const SIM = Q.has("sim"), PROBE = Q.has("probe");

const S = {
  config: null, mock: false, electron: false,
  level: null, stack: [], selected: null,
  busy: false, turn: null, botEl: null, caption: "", progressBuf: "",
  approvals: [], cam: "stage", handsOn: true, handsLive: false,
  cursor: [], domHover: null, nodeHover: null, grabs: [null, null],
  listenSource: null, palmCharge: [null, null],
};

// ---------------------------------------------------------------- galaxy
const galaxy = new Galaxy($("#galaxy"));

// ---------------------------------------------------------------- voice
const voice = new Voice({
  onSpeaking: (on) => { if (!on) S.acking = false; if (on) setState("speaking"); else if (!S.busy && !voice.listening) setState("idle"); else if (S.busy) setState("thinking"); },
  onLevel: (v) => { galaxy.setLevel(v); document.getElementById("mic")?.style.setProperty("--lvl", v.toFixed(2)); },
  onWord: () => { galaxy.pulse(); if (S.compact) orbCh.postMessage({ pulse: 1 }); },
  onStatus: (msg, err) => { if (err) toast(msg, true); else if (/download|loading|transcrib/.test(msg)) showProgress(msg); else if (/ready/.test(msg)) hideProgress(); else if (/system voice|not spoken/.test(msg)) toast(msg); },
});

const instruments = new Hud({ voice });

// once a second: telemetry + the corner readouts
setInterval(() => {
  const st = $("#state-label").textContent;
  const v = voice.cfg;
  const engine = voice.engineNow();
  instruments.setTelemetry({
    state: st.toLowerCase(),
    brain: S.mock ? "mock" : `${brainLabel(S.config)} · ${S.config?.effort || "?"}`,
    voice: !v.speak ? "muted" : engine === "kokoro" ? `${(v.kokoroVoice || "bm_daniel").replace("bm_", "")} · local gpu` : engine === "elevenlabs" ? "elevenlabs" : "system",
    mic: voice.mic ? (voice.mic.label || "on").replace(/^Default - /, "").slice(0, 26) : S.hf === "off" ? "off" : "waking",
    hands: S.handsLive ? (tracker.cameraLabel || "on").slice(0, 26) : "off",
    index: `${S.indexCount} files`,
    renderer: galaxy.backend,
  });
  const d = new Date(), p2 = (n) => String(n).padStart(2, "0");
  $("#ro-time").textContent = `${d.getHours() % 12 || 12}:${p2(d.getMinutes())}:${p2(d.getSeconds())} ${d.getHours() < 12 ? "AM" : "PM"}`;
}, 1000);

// ---------------------------------------------------------------- state + small UI helpers
function setState(s) {
  // in an open hands-free conversation, "idle" means "listening for your next sentence"
  const convo = S.hf === "conversation" && !voice.listening;
  if (s === "idle" && convo) s = "listening";
  document.body.classList.remove("st-idle", "st-listening", "st-thinking", "st-speaking");
  document.body.classList.add("st-" + s);
  galaxy.setState(s);
  $("#state-label").textContent = {
    idle: S.mock ? "ONLINE · MOCK" : S.hf === "standby" ? "STANDBY · SAY \u201cHEY DENNIS\u201d" : "ONLINE",
    listening: convo ? (S.continuous ? "CONTINUOUS CONVERSATION" : "IN CONVERSATION") : "LISTENING", thinking: "THINKING", speaking: "SPEAKING",
  }[s] || s.toUpperCase();
}
const restState = () => (S.busy ? "thinking" : voice.speaking ? "speaking" : "idle");
function setBusy(b) { S.busy = b; document.body.classList.toggle("busy", b); }

let toastTimer;
function toast(msg, err = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.toggle("err", err);
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), err ? 6000 : 3000);
}
let progTimer;
function showProgress(text) {
  const p = $("#progress");
  p.textContent = text;
  p.classList.add("show");
  clearTimeout(progTimer);
  progTimer = setTimeout(hideProgress, 12000);
}
function hideProgress() { $("#progress").classList.remove("show"); }

let capTimer;
function caption(text, hold = 2600) {
  const c = $("#caption");
  if (!text) { c.classList.remove("show"); return; }
  c.textContent = text.length > 260 ? "..." + text.slice(-260) : text;
  c.classList.add("show");
  clearTimeout(capTimer);
  capTimer = setTimeout(() => { if (!voice.speaking && !S.busy) c.classList.remove("show"); else capTimer = setTimeout(() => c.classList.remove("show"), 4000); }, hold);
}

const fmtDate = (ms) => ms ? new Date(ms).toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "";

function updateInsets() {
  const log = $("#log");
  const right = !log.classList.contains("hidden") && getComputedStyle(log).display !== "none" ? log.offsetWidth + 18 : 0;
  galaxy.setInsets(0, right);
}
addEventListener("resize", updateInsets);

// ---------------------------------------------------------------- navigation
function rootOf(path) {
  const roots = S.config?.roots || [];
  const low = path.toLowerCase();
  return roots.filter((r) => low === r.path.toLowerCase() || low.startsWith(r.path.toLowerCase().replace(/[\\/]$/, "") + (r.path.includes("\\") ? "\\" : "/"))).sort((a, b) => b.path.length - a.path.length)[0] || null;
}

function pageItems(level) {
  const items = level.items;
  if (items.length <= MAX_NODES) return items;
  const off = level.offset || 0;
  const slice = items.slice(off, off + MAX_NODES - 1);
  const left = items.length - off - slice.length;
  if (left > 0) slice.push({ name: `+${left.toLocaleString()} more`, more: true, isDir: false, kind: "other", path: `more:${off + slice.length}` });
  else if (off > 0) slice.push({ name: "back to start", more: true, isDir: false, kind: "other", path: "more:0" });
  return slice;
}

function show(level, from) {
  S.level = level;
  galaxy.setItems(pageItems(level), { mode: level.mode, from });
  renderCrumbs();
  instruments.setLevel(level);
  api.activity(level.mode === "folder" ? level.path : "").then((a) => instruments.setActivity(a)).catch(() => {});
}

async function load(desc) {
  if (desc.mode === "present") {
    const { items } = await api.info(desc.paths);
    return { ...desc, items };
  }
  const res = await api.list(desc.path || "");
  return { mode: desc.path ? "folder" : "root", path: res.path || "", title: desc.path ? (desc.path.split(/[\\/]/).filter(Boolean).pop() || desc.path) : "HOME", items: res.items, stats: res.stats, truncated: res.truncated };
}

async function navigate(desc, { push = true, from = "in" } = {}) {
  try {
    const level = await load(desc);
    if (push && S.level) S.stack.push(levelDesc(S.level));
    show(level, from);
    return level;
  } catch (e) {
    if (e instanceof LockedError) return lockUp();
    toast(e.message, true);
    return null;
  }
}
const levelDesc = (l) => ({ mode: l.mode, path: l.path, title: l.title, paths: l.paths });
const openFolder = (path, opts) => navigate({ mode: "folder", path }, opts);
const present = (title, paths) => navigate({ mode: "present", title, paths });

async function back() {
  if (S.selected) { closePreview(); return; }
  const prev = S.stack.pop();
  if (!prev) {
    if (S.level?.mode !== "root") return home();
    return;
  }
  await navigate(prev, { push: false, from: "out" });
}
async function home() {
  S.stack = [];
  await navigate({ mode: "root", path: "" }, { push: false, from: "out" });
}
async function refresh(path) {
  if (!S.level || S.level.mode === "present") return;
  if (path && S.level.path && path.toLowerCase() !== S.level.path.toLowerCase()) return;
  try {
    const level = await load(levelDesc(S.level));
    level.offset = S.level.offset;
    show(level, null);
  } catch { /* folder vanished */ }
}

function renderCrumbs() {
  const nav = $("#crumbs");
  nav.innerHTML = "";
  const add = (label, onClick) => {
    if (nav.children.length) { const s = document.createElement("span"); s.className = "sep"; s.textContent = "›"; nav.appendChild(s); }
    const b = document.createElement("button");
    b.textContent = label;
    b.dataset.hand = "";
    b.onclick = onClick;
    nav.appendChild(b);
  };
  add("HOME", () => home());
  const l = S.level;
  if (!l || l.mode === "root") return;
  if (l.mode === "present") { add(l.title, () => {}); return; }
  const root = rootOf(l.path);
  if (!root) { add(l.title, () => {}); return; }
  const sep = l.path.includes("\\") ? "\\" : "/";
  const rel = l.path.slice(root.path.replace(/[\\/]$/, "").length).split(/[\\/]/).filter(Boolean);
  let acc = root.path.replace(/[\\/]$/, "");
  const chain = [{ label: root.label, path: root.path }];
  for (const part of rel) { acc += sep + part; chain.push({ label: part, path: acc }); }
  chain.forEach((c, i) => add(c.label, () => {
    if (i === chain.length - 1) return;
    S.stack = [{ mode: "root", path: "" }, ...chain.slice(0, i).map((x) => ({ mode: "folder", path: x.path }))];
    openFolder(c.path, { push: false, from: "out" });
  }));
}

// ---------------------------------------------------------------- activation (mouse click / pinch tap)
function activate(target) {
  if (!target) return;
  if (target === "core") { toggleListen("core"); return; }
  const it = target.item;
  if (it.more) { S.level.offset = +it.path.slice(5); show(S.level, "in"); return; }
  if (it.isDir) {
    if (it.missing) return toast(`${it.name} isn't available right now`, true);
    openFolder(it.path);
  } else if (S.selected?.path === it.path && windowFor(it.path)) {
    closePreview();
  } else showPreview(it);
}

// ---------------------------------------------------------------- preview
const IMG = /\.(png|jpe?g|gif|webp|bmp|svg|avif|ico)$/i, VID = /\.(mp4|webm|mov|m4v|mkv)$/i, AUD = /\.(mp3|wav|flac|m4a|aac|ogg|opus)$/i;
// Floating file windows, as many as you like (galaxy.openWindow places them in the 3D scene).
// A window grows out of its card and follows it until you drag it by its title bar; its corner
// grip resizes it; the tab strip (or the wheel over it, or Ctrl+Tab) switches between them.
const WIN_TPL = $("#fwin-tpl");
const WINS = new Map(); // window id -> { id, item, el }
const MAX_WINDOWS = 8;
const focused = () => WINS.get(S.focusWin) || null;
const windowFor = (path) => [...WINS.values()].find((w) => w.item.path === path) || null;

/** Open the window for a file (or bring it to the front if it's already open). */
async function showPreview(item) {
  const have = windowFor(item.path);
  if (have) { focusWindow(have.id); return have; }
  if (WINS.size >= MAX_WINDOWS) closeWindow([...WINS.keys()][0]); // the oldest makes room
  const el = WIN_TPL.content.firstElementChild.cloneNode(true);
  const w = { id: 0, item, el };
  w.id = galaxy.openWindow(el, item.path);
  WINS.set(w.id, w);
  wireWindow(w);
  el.classList.add("open");
  focusWindow(w.id);
  await fillWindow(w);
  return w;
}

async function fillWindow(w) {
  const { el, item } = w;
  if (item.kind === "diagram") return fillDiagram(w);
  el.querySelector(".kdot").style.color = KIND_COLORS[item.kind] || KIND_COLORS.other;
  el.querySelector(".ptitle b").textContent = item.name;
  el.querySelector(".ptitle small").textContent = `${KIND_NAMES[item.kind] || item.kind} · ${fmtBytes(item.size)} · ${fmtDate(item.mtime)}`;
  el.querySelector("[data-act=open]").textContent = item.isDir ? "OPEN FOLDER" : "OPEN";
  const body = el.querySelector(".pbody");
  body.className = "pbody";
  const meta = `<div class="meta"><b>${escapeHtml(item.path)}</b><br>${fmtBytes(item.size)} · modified ${fmtDate(item.mtime)}</div>`;
  const src = api.raw(item.path);
  if (item.isDir) {
    body.innerHTML = meta + (item.kinds ? `<div class="kinds">${Object.entries(item.kinds).sort((a, b) => b[1] - a[1]).map(([k, n]) => `<span style="color:${KIND_COLORS[k]}">${KIND_NAMES[k] || k} ${n}</span>`).join("")}</div>` : "");
  } else if (IMG.test(item.name)) { body.classList.add("media"); body.innerHTML = `<div class="stage"><img src="${src}" alt=""></div>` + meta; }
  else if (VID.test(item.name)) { body.classList.add("media"); body.innerHTML = `<div class="stage"><video src="${src}" controls playsinline></video></div>` + meta; }
  else if (AUD.test(item.name)) body.innerHTML = meta + `<audio src="${src}" controls></audio>`;
  else if (READABLE.test(item.name)) { // PDF, Word, Excel / CSV, PowerPoint, Markdown: drawn by the document reader
    body.innerHTML = `<div class="empty rd-loading">OPENING...</div>`;
    try {
      const reader = await openReader(body, item, src, { rawUrl: api.raw });
      if (!WINS.has(w.id)) { reader?.dispose(); return; }
      w.reader = reader;
    } catch (e) {
      if (!WINS.has(w.id)) return;
      body.innerHTML = meta + `<div class="empty">${escapeHtml(String(e.message || e).toUpperCase())}</div>`;
      try { // the plain text is still worth showing (Office files, Markdown)
        const { text } = await api.text(item.path);
        if (text && WINS.has(w.id)) { const pre = document.createElement("pre"); pre.textContent = text; body.appendChild(pre); }
      } catch { /* the message is enough */ }
    }
  }
  else {
    body.innerHTML = meta + `<div class="empty">reading...</div>`;
    try {
      const { text, truncated } = await api.text(item.path);
      if (!WINS.has(w.id)) return;
      body.innerHTML = text != null ? `<pre></pre>` : meta + `<div class="empty">NO PREVIEW FOR THIS KIND OF FILE<br><br>Ask D.E.N.N.I.S. about it, or open it.</div>`;
      if (text != null) body.querySelector("pre").textContent = text + (truncated ? "\n\n[... preview truncated]" : "");
    } catch (e) { body.innerHTML = meta + `<div class="empty">${escapeHtml(e.message)}</div>`; }
  }
}

/** Bring a window to the front; it becomes the "selected file" for D.E.N.N.I.S. */
function focusWindow(id) {
  const w = WINS.get(id);
  if (!w) return;
  S.focusWin = id;
  S.selected = w.item;
  galaxy.focusWindow(id);
  galaxy.select(w.item.path);
  for (const x of WINS.values()) x.el.classList.toggle("focus", x.id === id);
  document.body.classList.add("preview-open");
  renderTabs();
}

function closeWindow(id, silent = false) {
  const w = WINS.get(id);
  if (!w) return;
  WINS.delete(id);
  w.reader?.dispose(); // PDF.js workers, observers, picture URLs
  w.reader = null;
  galaxy.closeWindow(id, silent); // folds back into its card
  setTimeout(() => { w.el.querySelector(".pbody").innerHTML = ""; }, silent ? 0 : 420); // stops media playback
  if (S.focusWin === id) {
    const next = [...WINS.values()].pop();
    if (next) focusWindow(next.id);
    else { S.focusWin = null; S.selected = null; galaxy.select(null); document.body.classList.remove("preview-open"); }
  }
  renderTabs();
}
/** Close the front window. */
function closePreview(silent) { const w = focused(); if (w) closeWindow(w.id, silent); }
function closeAllWindows(silent) { for (const id of [...WINS.keys()]) closeWindow(id, silent); }

/** Expand a window to fill the screen, or bring it back. */
function setWindowMax(on, id = S.focusWin) {
  const w = WINS.get(id);
  if (!w) return;
  if (!galaxy.maximizeWindow(id, on)) return;
  w.el.classList.toggle("max", on);
  w.el.querySelector("[data-act=max]").title = on ? "Restore (F or Esc)" : "Full screen (F)";
  if (on) focusWindow(id);
}
const windowOpen = () => WINS.size > 0;
const focusedMax = () => !!S.focusWin && galaxy.isMaximized(S.focusWin);

/** Buttons, dragging by the title bar, resizing by the corner grip. */
function wireWindow(w) {
  const { el } = w;
  el.addEventListener("pointerdown", () => { if (S.focusWin !== w.id) focusWindow(w.id); }, true); // a touch anywhere brings it forward
  el.addEventListener("click", (e) => {
    const act = e.target.closest("[data-act]")?.dataset.act;
    const it = w.item;
    if (!act) return;
    if (act === "close") return closeWindow(w.id);
    if (act === "max") return setWindowMax(!galaxy.isMaximized(w.id), w.id);
    if (it.kind === "diagram") {
      if (act === "ask") ask(`Walk me through the "${it.name}" diagram.`);
      if (act === "open") saveDiagram(it);
      if (act === "reveal") copyText(it.diagram.code).then((ok) => toast(ok ? "Mermaid code copied" : "Couldn't reach the clipboard", !ok));
      return;
    }
    if (act === "ask") askAbout(it);
    if (act === "open") it.isDir ? openFolder(it.path) : api.open(it.path).then((r) => toast(r.revealed ? "That's a program - revealed it instead of running it" : `Opening ${it.name}`)).catch((er) => toast(er.message, true));
    if (act === "reveal") api.reveal(it.path).catch((er) => toast(er.message, true));
  });
  const head = el.querySelector(".phead");
  head.addEventListener("dblclick", (e) => { if (!e.target.closest("button")) setWindowMax(!galaxy.isMaximized(w.id), w.id); });
  // a pointer gesture that follows the mouse until release (pointer capture keeps it when you move fast)
  const gesture = (target, onMove) => (e) => {
    if (e.button !== 0 || galaxy.isMaximized(w.id)) return;
    const r = galaxy.windowRect(w.id);
    if (!r) return;
    e.preventDefault();
    e.stopPropagation();
    const start = { x: e.clientX, y: e.clientY, ...r };
    target.setPointerCapture(e.pointerId);
    el.classList.add("moving");
    const move = (ev) => onMove(start, ev.clientX - start.x, ev.clientY - start.y);
    const up = () => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", up);
      target.removeEventListener("pointercancel", up);
      el.classList.remove("moving");
      galaxy.endWindowGesture(w.id);
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
    target.addEventListener("pointercancel", up);
  };
  head.addEventListener("pointerdown", (e) => { if (!e.target.closest("button")) gesture(head, (st, dx, dy) => galaxy.placeWindow(w.id, st.cx + dx, st.cy + dy))(e); });
  const grip = el.querySelector(".rz");
  grip.addEventListener("pointerdown", gesture(grip, (st, dx, dy) => {
    // the top-left corner stays put while the bottom-right follows the pointer
    const size = galaxy.resizeWindow(w.id, st.w + dx, st.h + dy);
    if (size) galaxy.placeWindow(w.id, st.cx - st.w / 2 + size.w / 2, st.cy - st.h / 2 + size.h / 2);
  }));
}

// ---- the tab strip: one tab per window; click, wheel over it, or Ctrl+Tab to switch
function renderTabs() {
  const nav = $("#wintabs");
  nav.classList.toggle("show", WINS.size > 1);
  nav.innerHTML = "";
  for (const w of WINS.values()) {
    const b = document.createElement("button");
    b.className = "wtab" + (w.id === S.focusWin ? " on" : "");
    b.dataset.hand = "";
    b.title = w.item.path;
    b.innerHTML = `<i style="color:${KIND_COLORS[w.item.kind] || KIND_COLORS.other}"></i><span>${escapeHtml(w.item.name)}</span><em data-close title="Close">&times;</em>`;
    b.onclick = (e) => { if (e.target.closest("[data-close]")) closeWindow(w.id); else focusWindow(w.id); };
    nav.appendChild(b);
  }
  nav.querySelector(".on")?.scrollIntoView({ block: "nearest", inline: "nearest" });
}
function cycleWindows(dir) {
  const ids = [...WINS.keys()];
  if (ids.length < 2) return;
  const i = ids.indexOf(S.focusWin);
  focusWindow(ids[(i + dir + ids.length) % ids.length]);
}
let wheelAt = 0;
$("#wintabs").addEventListener("wheel", (e) => {
  e.preventDefault();
  const now = performance.now();
  if (now - wheelAt < 160) return; // one step per flick, even on a trackpad
  wheelAt = now;
  cycleWindows((e.deltaY || e.deltaX) > 0 ? 1 : -1);
}, { passive: false });
galaxy.winRenderer.domElement.addEventListener("click", (e) => { if (e.target === galaxy.winRenderer.domElement) setWindowMax(false); }); // click outside an expanded window
// ---- messaging: what you and he say over WhatsApp / Teams shows in COMMS too (not spoken aloud)
function remoteMsg(ev) {
  const el = addMsg(ev.dir === "in" ? "user" : ev.update ? "minion" : "bot", ev.text);
  el.classList.add("remote");
  el.dataset.who = ev.dir === "in" ? `YOU · ${String(ev.label || ev.channel).toUpperCase()}` : `${ev.update ? "UPDATE" : "REPLY"} · ${String(ev.label || ev.channel).toUpperCase()}`;
}
// you're at the computer: the server holds updates back from your phone meanwhile
let presenceAt = 0;
function markPresent() {
  const now = Date.now();
  if (now - presenceAt < 60_000) return;
  presenceAt = now;
  api.presence().catch(() => {});
}
for (const type of ["pointerdown", "keydown", "wheel"]) addEventListener(type, markPresent, { passive: true, capture: true });
markPresent();

// ---- diagrams (show_diagram): Mermaid drawn into a window of its own, styled like the HUD
let diagramSeq = 0;
async function showDiagram(ev) {
  let svg;
  try { svg = await renderDiagram(ev.mermaid); } catch (e) {
    const error = String(e?.message || e?.str || e).slice(0, 1500);
    if (ev.reply) api.uiReply(ev.reply, { ok: false, error }).catch(() => {});
    else toast(`Couldn't draw that diagram: ${error.split("\n")[0]}`, true);
    return;
  }
  if (S.compact) setCompact(false);
  const item = { path: `diagram:${++diagramSeq}`, name: ev.title || "Diagram", kind: "diagram", isDir: false, size: 0, mtime: Date.now(), diagram: { code: ev.mermaid, svg } };
  const w = await showPreview(item);
  const nat = diagramSize(svg);
  if (w && nat) { // size the window to the drawing, within the screen (wide ones scroll rather than shrink to nothing)
    const W = Math.min(innerWidth * 0.86, Math.max(560, nat.w * 0.95 + 48));
    const s = fitScale(nat, W - 48, Infinity), scrolls = nat.w * s > W - 48;
    galaxy.resizeWindow(w.id, W, Math.min(innerHeight * 0.78, Math.max(300, nat.h * s + 178 + (scrolls ? 14 : 0))));
  }
  if (!ev.reply) return;
  const reply = { ok: true };
  try {
    if (ev.want === "png") reply.png = await toPng(svg);
    if (ev.want === "svg") reply.svg = standaloneSvg(svg).text;
  } catch (e) { reply.pngError = String(e?.message || e); }
  api.uiReply(ev.reply, reply).catch(() => {});
}
function fillDiagram(w) {
  const { el, item } = w;
  el.querySelector(".kdot").style.color = "var(--cyan)";
  el.querySelector(".ptitle b").textContent = item.name;
  el.querySelector(".ptitle small").textContent = "Diagram · drawn by D.E.N.N.I.S.";
  el.querySelector("[data-act=open]").textContent = "SAVE";
  el.querySelector("[data-act=reveal]").textContent = "COPY MERMAID";
  const body = el.querySelector(".pbody");
  body.className = "pbody diagram";
  body.innerHTML = `<div class="dstage">${item.diagram.svg}</div>`; // Mermaid's own output, sanitised (securityLevel strict)
  const svg = body.querySelector("svg"), nat = diagramSize(item.diagram.svg);
  if (!svg || !nat) return;
  svg.removeAttribute("style");
  // as big as the window allows (re-fitted when it's resized or goes full screen), never too small to read
  // (measured on the window body, whose size doesn't depend on the drawing - so no resize loop - once per frame)
  let last = 0, queued = false;
  const fit = () => {
    queued = false;
    const s = fitScale(nat, body.clientWidth - 36, body.clientHeight - 28);
    if (Math.abs(s - last) < 0.005) return;
    last = s;
    svg.setAttribute("width", String(Math.round(nat.w * s)));
    svg.setAttribute("height", String(Math.round(nat.h * s)));
  };
  fit();
  new ResizeObserver(() => { if (!queued) { queued = true; requestAnimationFrame(fit); } }).observe(body); // goes with the window
}
async function saveDiagram(it) {
  try {
    const svg = standaloneSvg(it.diagram.svg).text;
    let png = null;
    try { png = await toPng(it.diagram.svg); } catch { /* the SVG alone will do */ }
    const r = await api.saveDiagram(it.name, svg, png);
    toast(`Saved: ${base(r.path)}`);
    api.reveal(r.path).catch(() => {});
  } catch (e) { toast(e.message, true); }
}
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* fall back */ }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.cssText = "position:fixed;opacity:0";
  document.body.appendChild(ta);
  ta.select();
  const ok = document.execCommand("copy");
  ta.remove();
  return ok;
}

function askAbout(item) {
  S.selected = item;
  ask(item.isDir ? "What's in this folder? Give me the highlights." : "Tell me about this file.", { selected: item.path });
}

// ---------------------------------------------------------------- conversation
function addMsg(kind, text) {
  const el = document.createElement("div");
  el.className = kind === "tool" ? "toolline" : kind === "prog" ? "progline" : `m ${kind}`;
  el.textContent = text;
  const box = $("#msgs");
  box.appendChild(el);
  box.scrollTop = box.scrollHeight;
  return el;
}

const TOOL_LABEL = {
  list_folder: (i) => `scanning ${base(i.path)}`, search_files: (i) => `searching "${i.query}"${i.kind ? ` (${i.kind})` : ""}`,
  read_file: (i) => `reading ${base(i.path)}`, file_info: (i) => `checking ${base(i.path)}`, analyze_folder: (i) => `analysing ${base(i.path)}`,
  show_on_screen: (i) => `bringing up ${base(i.path)}`, present_files: (i) => `presenting ${i.paths?.length || 0} files`,
  open_file: (i) => `opening ${base(i.path)}`, reveal_in_folder: (i) => `revealing ${base(i.path)}`, create_file: (i) => `creating ${base(i.path)}`,
  create_folder: (i) => `creating folder ${base(i.path)}`, move_file: (i) => `moving ${base(i.source)} -> ${base(i.destination)}`,
  remember: () => "saving to memory", system_status: () => "checking systems", control_interface: (i) => `interface: ${i.action}`,
  web_search: () => "searching the web",
  use_skill: (i) => `using the ${i.name} skill`, read_skill_file: (i) => `reading ${base(i.path)} from ${i.skill}`, create_skill: (i) => `saving the skill "${i.name}"`,
  save_generated_file: (i) => `saving ${i.filename || "the new file"} to ${base(i.folder)}`,
  code_execution: () => "working in the sandbox", bash_code_execution: () => "running code in the sandbox", text_editor_code_execution: () => "editing in the sandbox",
  show_diagram: (i) => `drawing ${i.title ? `"${i.title}"` : "a diagram"}`,
  deploy_minion: (i) => `deploying ${i.minion || "a helper"}`, create_minion: (i) => `creating the minion ${i.name}`, minion_status: () => "checking on the minions", recall_minion: (i) => `recalling ${i.id}`,
};
const toolLabel = (name, input) => (TOOL_LABEL[name] || (() => (name.startsWith("mcp__") ? name.slice(5).replace("__", ": ").replace(/_/g, " ") : name)))(input || {});
const base = (p) => String(p || "").split(/[\\/]/).filter(Boolean).pop() || p || "";
const toolLines = new Map();

function onAgentEvent(ev) {
  switch (ev.type) {
    case "text_start":
      if (!S.botEl) S.botEl = addMsg("bot", "");
      break;
    case "text":
      if (!S.botEl) S.botEl = addMsg("bot", "");
      S.botEl.textContent += ev.delta;
      $("#msgs").scrollTop = $("#msgs").scrollHeight;
      S.caption += ev.delta;
      S.replyBuf += ev.delta;
      caption(S.caption, 4000);
      voice.feed(ev.delta);
      hideProgress();
      break;
    case "progress":
      S.progressBuf += ev.delta;
      showProgress(S.progressBuf.trim().split("\n").pop());
      break;
    case "block_stop":
      if (S.progressBuf.trim()) { addMsg("prog", S.progressBuf.trim()); S.progressBuf = ""; }
      if (S.botEl) S.botEl = null; // a later text block (after tools) gets its own bubble
      if (S.replyBuf && !/\s$/.test(S.replyBuf)) S.replyBuf += "\n";
      break;
    case "tool": {
      if (ev.status === "start") { setState("thinking"); break; }
      const label = toolLabel(ev.name, ev.input || toolLines.get(ev.id)?.input);
      if (ev.status === "run") { const el = addMsg("tool", label); el.classList.add("run"); toolLines.set(ev.id, { el, input: ev.input }); showProgress(label); }
      else { const t = toolLines.get(ev.id); if (t) { t.el.classList.remove("run"); t.el.classList.add(ev.status); } else if (ev.name === "web_search") addMsg("tool", "searched the web").classList.add("done"); }
      break;
    }
    case "ui": handleUi(ev); break;
    case "approval": showApproval(ev); break;
    case "approval_done": closeApproval(ev.id); break;
    case "refusal": {
      const t = "That one I'll have to decline, I'm afraid.";
      addMsg("bot", t); voice.say(t); caption(t);
      S.lastReply = t;
      break;
    }
    case "error":
      addMsg("err", ev.message);
      voice.say(ev.message.split(/(?<=\.)\s/)[0]);
      caption(ev.message, 6000);
      break;
    case "done":
      if (ev.stop_reason === "max_tokens") addMsg("sys", "(reply cut short)");
      break;
  }
}

function handleUi(ev) {
  // he's about to show you something: come back from compact mode first
  if (S.compact && ["navigate", "present", "refresh", "home", "back", "diagram"].includes(ev.action)) setCompact(false);
  switch (ev.action) {
    case "compact": setCompact(true); break;
    case "reboot": reboot(); break;
    case "theme": setTheme(ev.theme === "next" || !ev.theme ? nextTheme() : ev.theme); break;
    case "conversation_on": setContinuous(true, { quiet: true }); break;
    case "conversation_off": setContinuous(false, { quiet: true }); break;
    case "notes_start": setTimeout(() => startNotes(ev.title, { quiet: true }), 200); break;
    case "capture_flash": document.body.classList.remove("flash"); void document.body.offsetWidth; document.body.classList.add("flash"); setTimeout(() => document.body.classList.remove("flash"), 700); toast("Looked at your screen"); break;
    case "navigate":
      openFolder(ev.path).then((level) => {
        if (level && ev.select) { const it = level.items.find((i) => i.path.toLowerCase() === ev.select.toLowerCase()); if (it) showPreview(it); }
      });
      break;
    case "present": present(ev.title, ev.paths); break;
    case "diagram": showDiagram(ev); break;
    case "refresh": refresh(ev.path); break;
    case "home": home(); break;
    case "back": back(); break;
    case "close_preview": closeAllWindows(); break;
    case "toggle_camera": cycleCam(); break;
    case "toggle_hands": toggleHands(); break;
    case "fullscreen": if (windowOpen()) setWindowMax(!focusedMax()); else toggleFullscreen(); break;
  }
}

function describeView() {
  const l = S.level;
  if (!l || l.mode === "root") return "overview of all mapped folders";
  if (l.mode === "present") return `a presented set of ${l.items.length} files titled "${l.title}"`;
  return `the folder ${l.path} (${l.items.length} items)`;
}

const YES = /^(yes|yeah|yep|yup|sure|ok(ay)?|do it|go ahead|allow|approved?|confirm(ed)?|please do)\b/i;
const NO = /^(no|nope|nah|don'?t|deny|cancel|stop|never ?mind|negative)\b/i;

async function ask(text, { input = "text", selected, silent = false } = {}) {
  text = String(text || "").trim();
  if (!text) return;
  if (S.approvals.length && input !== "event") {
    const a = S.approvals[0];
    if (YES.test(text)) return answerApproval(a.id, true);
    if (NO.test(text)) return answerApproval(a.id, false);
  }
  if (input !== "event") markPresent();
  if (input !== "event" && isStopPhrase(text)) return hush();
  if (input !== "event" && isRepeatPhrase(text)) return sayAgain();
  if (input !== "event") {
    const cmd = matchCommand(text, { places: instantPlaces() });
    if (cmd) return runInstant(cmd, text); // done on the spot, no round trip to the brain
  }
  if (S.turn) await stopTurn();
  voice.stopSpeaking();
  if (!silent) addMsg("user", text);
  setBusy(true);
  setState("thinking");
  S.botEl = null; S.caption = ""; S.progressBuf = ""; S.replyBuf = "";
  caption("");
  const context = { view: describeView(), selected: selected || (S.selected?.kind === "diagram" ? null : S.selected?.path) || null, input, greeting: S.greetPending || undefined, offer: S.offerPending || undefined, lang: input === "voice" ? voice.lastLang || undefined : undefined };
  S.greetPending = null;
  S.offerPending = null;
  const turn = api.chat({ text, context }, onAgentEvent);
  S.turn = turn;
  try {
    await turn.done;
  } catch (e) {
    if (e instanceof LockedError) lockUp();
    else if (e.name !== "AbortError") addMsg("err", `Lost contact with the core: ${e.message}`);
  } finally {
    if (S.turn === turn) {
      S.turn = null;
      setBusy(false);
      voice.flush();
      if (S.replyBuf.trim()) S.lastReply = S.replyBuf.trim();
      if (S.progressBuf.trim()) addMsg("prog", S.progressBuf.trim());
      S.progressBuf = "";
      hideProgress();
      if (!voice.speaking && !voice.listening) setState("idle");
      for (const a of [...S.approvals]) closeApproval(a.id);
    }
  }
}

async function stopTurn() {
  const t = S.turn;
  S.turn = null;
  if (t) { t.abort(); api.stop().catch(() => {}); }
  setBusy(false);
  for (const a of [...S.approvals]) closeApproval(a.id);
}

/** "Stop" / "Shut up" / "Put a sock in it": silence now, and drop whatever he was working on. */
function hush() {
  voice.stopSpeaking();
  if (S.turn) stopTurn();
  caption("");
  flashHint("HUSH");
  setState(restState());
}

/** "Say that again?" / "Can you repeat?": his last reply, from the top. */
function sayAgain() {
  if (S.busy) return; // still working on an answer; it'll be along shortly
  voice.stopSpeaking();
  const t = S.lastReply || "I haven't said anything worth repeating yet.";
  caption(t, 6000);
  voice.feed(t);
  voice.flush();
}

// ---------------------------------------------------------------- the folder watcher's notices
const NUMBER = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty"];
const KIND_NOUN = { image: "images", video: "videos", audio: "audio files", document: "documents", sheet: "spreadsheets", slides: "decks", code: "code files", data: "data files", archive: "archives", design: "design files", model3d: "3D files", font: "fonts", app: "programs", other: "files" };
function watchNotice(n) {
  let line;
  if (n.type === "new_files") {
    const count = n.count <= 20 ? NUMBER[n.count] : n.count.toLocaleString();
    const what = KIND_NOUN[n.kind] || "files";
    const where = n.folder.split(/[\\/]/).filter(Boolean).pop();
    line = `${count[0].toUpperCase()}${count.slice(1)} new ${what} just landed in ${where}. ${["image", "video", "audio"].includes(n.kind) ? "Shall I sort them?" : "Want a look?"}`;
  } else if (n.type === "disk_low") {
    line = `Heads up: ${n.drive} is down to ${fmtBytes(n.free)} free. Shall I find what's taking the space?`;
  } else return;
  const el = addMsg("minion", line);
  el.dataset.who = "WATCH";
  if (n.folder) { el.style.cursor = "pointer"; el.onclick = () => openFolder(n.folder); }
  S.offerPending = line; // so a plain "yes" means something
  toast(line);
  if (S.notes || S.busy || voice.speaking || voice.listening) return; // the log and the toast will do
  caption(line, 6000);
  voice.say(line);
  S.lastReply = line;
}

// ---------------------------------------------------------------- reminders
function chime() {
  try {
    const ac = new AudioContext(), t = ac.currentTime;
    [[880, 0], [1318.5, 0.16]].forEach(([f, d]) => {
      const o = ac.createOscillator(), g = ac.createGain();
      o.type = "sine"; o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t + d); g.gain.exponentialRampToValueAtTime(0.08, t + d + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + d + 0.6);
      o.connect(g).connect(ac.destination); o.start(t + d); o.stop(t + d + 0.65);
    });
    setTimeout(() => ac.close().catch(() => {}), 1200);
  } catch { /* no audio device */ }
}
function reminderDue(r, missed) {
  const when = new Date(r.at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const line = missed ? `You missed a reminder at ${when}: ${r.text}.` : `Reminder: ${r.text}.`;
  chime();
  const el = addMsg("minion", line);
  el.dataset.who = missed ? "REMINDER \u00b7 MISSED" : "REMINDER";
  toast(line);
  if (S.notes) return; // mid-meeting: the chime and the toast are enough
  setTimeout(() => { caption(line, 6000); voice.say(line); S.lastReply = line; }, 700);
}

// ---------------------------------------------------------------- meeting notes
// Everything said is transcribed locally until "stop taking notes"; then D.E.N.N.I.S. writes it up.
S.notes = null; // { title, started, entries: [{ at, text }] }
async function startNotes(title = "", { quiet = false } = {}) {
  if (S.notes) return reply("I'm already taking notes.");
  if (S.turn && !quiet) await stopTurn();
  S.notes = { title: String(title || "").trim(), started: Date.now(), entries: [] };
  renderNotes();
  if (!quiet) reply("Taking notes. Say \u201cstop taking notes\u201d when you're done.");
  // start listening once he's finished saying so, or he'd minute himself
  const t0 = performance.now();
  const go = async () => {
    if ((voice.speaking || S.busy) && performance.now() - t0 < 12000) return setTimeout(go, 200);
    try { await handsFree.startNotes(); } catch (e) { toast(`Notes need the microphone: ${e.message || e}`, true); S.notes = null; renderNotes(); }
  };
  setTimeout(go, 400);
}
function addNote(text, at) {
  if (!S.notes) return;
  S.notes.entries.push({ at: at ? performance.timeOrigin + at : Date.now(), text });
  renderNotes();
}
async function endNotes() {
  const n = S.notes;
  if (!n) return;
  S.notes = null;
  handsFree.endNotes();
  renderNotes();
  const mins = Math.max(1, Math.round((Date.now() - n.started) / 60000));
  if (!n.entries.length) return reply("Notes stopped. Nothing was said, so there's nothing to write up.");
  const stamp = (ms) => { const s = Math.max(0, Math.round((ms - n.started) / 1000)); return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`; };
  const transcript = n.entries.map((e) => `[${stamp(e.at)}] ${e.text}`).join("\n");
  let saved = "";
  try { saved = (await api.notes(n.title || "Meeting", transcript)).path; } catch { /* the write-up still goes ahead */ }
  addMsg("sys", `notes: ${mins} min, ${n.entries.length} lines${saved ? " - transcript kept in " + saved : ""}`);
  const docs = S.config?.docSkills?.enabled !== false && (S.config?.provider || "anthropic") === "anthropic";
  ask([
    `I've just recorded a meeting${n.title ? ` ("${n.title}")` : ""}: ${mins} minute${mins === 1 ? "" : "s"}. The transcript is below${saved ? `; the raw version is kept at ${saved}` : ""}.`,
    `Write up the notes: a short summary, the decisions made, action items (who, what, by when, where the transcript says), and open questions. Save them in my Documents folder, in a "Meeting Notes" folder, named with today's date and the meeting's subject - ${docs ? "as a Word document" : "as a Markdown file"}. Then tell me in a sentence or two what's in them.`,
    "", "<transcript>", transcript, "</transcript>",
  ].join("\n"), { input: "notes", silent: true });
}
function renderNotes() {
  const w = $("#w-notes");
  const n = S.notes;
  w.classList.toggle("show", !!n);
  if (!n) return;
  const s = Math.round((Date.now() - n.started) / 1000);
  w.querySelector("small").textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")} \u00b7 ${n.entries.reduce((a, e) => a + e.text.split(/\s+/).length, 0)} words`;
  w.querySelector(".last").textContent = n.entries.slice(-2).map((e) => e.text).join(" ") || "listening...";
}
setInterval(() => { if (S.notes) renderNotes(); }, 1000);
$("#notes-stop").onclick = () => endNotes();
$("#notes-discard").onclick = () => { if (!S.notes) return; S.notes = null; handsFree.endNotes(); renderNotes(); toast("Notes discarded"); };

// ---------------------------------------------------------------- instant commands and undo
/** Folders "open X" can name: the mapped folders and whatever is on screen. */
function instantPlaces() {
  const roots = (S.config?.roots || []).map((r) => ({ name: r.label, path: r.path, isDir: true }));
  const here = (S.level?.items || []).filter((i) => i.isDir && !i.more).map((i) => ({ name: i.name, path: i.path, isDir: true }));
  return [...here, ...roots];
}
function reply(text) {
  if (!text) return;
  addMsg("bot", text);
  caption(text, 3500);
  voice.say(text);
  S.lastReply = text;
}
async function runInstant(cmd, heard) {
  addMsg("user", heard);
  const now = new Date();
  switch (cmd.action) {
    case "home": home(); break;
    case "back": back(); break;
    case "open": openFolder(cmd.arg); break;
    case "fullscreen": if (windowOpen()) setWindowMax(true); else if (!S.fullscreen) toggleFullscreen(); break;
    case "exitFullscreen": if (focusedMax()) setWindowMax(false); else if (S.fullscreen) toggleFullscreen(); break;
    case "compact": setCompact(true); break;
    case "undo": return doUndo();
    case "close": if (!windowOpen()) return reply("Nothing's open."); closePreview(); break;
    case "closeAll": closeAllWindows(); break;
    case "voiceOff": reply("Going quiet."); setTimeout(() => { voice.configure({ speak: false }); updateChips(); api.settings({ voice: { speak: false } }).catch(() => {}); }, 1200); return;
    case "voiceOn": voice.configure({ speak: true }); updateChips(); api.settings({ voice: { speak: true } }).catch(() => {}); break;
    case "handsOn": if (!tracker.running) toggleHands(); break;
    case "handsOff": if (tracker.running) toggleHands(); break;
    case "cameraOff": setCam("off"); break;
    case "cameraOn": setCam("stage"); break;
    case "time": return reply(`It's ${now.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}.`);
    case "date": return reply(`It's ${now.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}.`);
    case "settings": openSettings(); break;
    case "capabilities": caps.open(); break;
    case "rescan": api.reindex().catch(() => {}); break;
    case "continuousOn": return setContinuous(true);
    case "continuousOff": return setContinuous(false);
    case "theme": {
      const t = setTheme(cmd.arg === "next" ? nextTheme() : cmd.arg);
      if (!cmd.ack) return reply(`${THEMES[t].label}.`);
      break;
    }
    case "dndOn": case "dndOff": {
      const dnd = cmd.action === "dndOn";
      try { S.config = (await api.settings({ watch: { dnd } })).config; } catch (e) { return toast(e.message, true); }
      break;
    }
    case "notesStart": return startNotes();
    case "notesStop": if (!S.notes) return reply("I'm not taking notes."); return endNotes();
    case "nextWindow": cycleWindows(1); break;
    case "prevWindow": cycleWindows(-1); break;
  }
  reply(cmd.ack);
}
/** "Undo that" / Ctrl+Z: reverse the last change to your files, and show where things went. */
async function doUndo() {
  try {
    const r = await api.undo(1);
    reply(r.text);
    for (const p of r.refresh || []) refresh(p);
  } catch (e) { toast(e.message, true); }
}

function stopAll() {
  if (S.hf === "conversation" && !S.continuous) handsFree.endConversation("esc");
  voice.stopSpeaking();
  if (voice.listening) { voice.cancelListening(); S.listenSource = null; S.listenAuto = false; $("#mic").classList.remove("on"); }
  stopTurn();
  caption("");
  setState("idle");
}

// ---------------------------------------------------------------- approvals
const SPOKEN_ASK = {
  create_file: ["Shall I create that file?", "A fresh file, hot off the press. Shall I?"],
  create_folder: ["Shall I make the folder?", "One more folder for the collection. Shall I?"],
  move_file: ["Shall I move it?", "I have a bad feeling about this. Shall I move it anyway?", "Rearranging the furniture, are we? Shall I?"],
  open_file: ["Shall I open it?", "Shall I bring it up?"],
  default: ["Shall I proceed?", "Your call. Shall I proceed?"],
};
const APPROVED = ["Affirmative.", "Certainly.", "Right away.", "Consider it done.", "Leave it with me."];
const DECLINED = ["Very well. Standing down.", "As you wish. I'll leave it be.", "Wise, perhaps."];
function showApproval(ev) {
  S.approvals.push(ev);
  if (S.approvals.length === 1) renderApproval();
}
function renderApproval() {
  const a = S.approvals[0];
  const m = $("#approve");
  if (!a) { m.classList.remove("show"); return; }
  m.querySelector("h3").textContent = a.title || "Allow this?";
  m.querySelector("pre").textContent = a.detail || "";
  m.classList.add("show");
  voice.say(a.minion ? `${a.minion} needs your go-ahead.` : pick(SPOKEN_ASK[a.tool] || SPOKEN_ASK.default));
}
function answerApproval(id, yes) {
  api.approve(id, yes).catch(() => {});
  voice.stopSpeaking();
  voice.say(pick(yes ? APPROVED : DECLINED));
  closeApproval(id);
}
function closeApproval(id) {
  const i = S.approvals.findIndex((a) => a.id === id);
  if (i < 0) return;
  S.approvals.splice(i, 1);
  if (i === 0) renderApproval();
}
$("#approve .yes").onclick = () => S.approvals[0] && answerApproval(S.approvals[0].id, true);
$("#approve .no").onclick = () => S.approvals[0] && answerApproval(S.approvals[0].id, false);

// ---------------------------------------------------------------- talking
// Space, the mic button and the core all work two ways: HOLD to talk and release to send,
// or TAP once and just speak - it sends by itself when you stop talking (tap again to send early).
const TAP_MS = 350;

async function toggleListen(source) {
  if (voice.listening) return endListen("tap");
  return beginListen(source, { auto: true });
}
async function beginListen(source, { auto = false } = {}) {
  if (voice.listening) return;
  S.listenSource = source;
  S.listenAuto = auto;
  $("#mic").classList.add("on");
  setState("listening");
  try {
    await voice.startListening({
      auto: () => S.listenAuto,
      onConnecting: () => caption("Waking the microphone...", 60000),
      onAutoStop: (why) => endListen(why),
    });
    if (!voice.listening || S.listenSource !== source) return; // released while the mic was waking up
    caption(S.listenAuto ? "Listening - just speak. I'll know when you're done." : "Listening - release to send.", 60000);
  } catch (e) {
    S.listenSource = null;
    $("#mic").classList.remove("on");
    setState(S.busy ? "thinking" : "idle");
    caption("");
    reportVoice({ reason: `microphone error: ${e?.name || ""} ${e?.message || e}` });
    toast(e?.name === "NotAllowedError" ? "Microphone blocked - allow it in Windows Settings > Privacy > Microphone (desktop apps)." : e?.name === "NotReadableError" ? "The microphone is busy in another app." : `Microphone unavailable: ${e.message || e}`, true);
  }
}
async function endListen(why = "release") {
  if (!voice.listening) return;
  $("#mic").classList.remove("on");
  S.listenSource = null;
  S.listenAuto = false;
  setState("thinking");
  caption("");
  try {
    const text = await voice.stopListening();
    hideProgress();
    reportVoice({ ...voice.lastDiag, ended: why, ok: !!text });
    if (text) { handsFree.enterConversation(); caption(`"${text}"`); await ask(text, { input: "voice" }); }
    else { setState(S.busy ? "thinking" : "idle"); caption(hintFor(voice.lastDiag), 5000); }
  } catch (e) {
    setState("idle");
    reportVoice({ reason: `speech recognition failed: ${e.message}` });
    toast(`Speech recognition failed: ${e.message}`, true);
  }
}
function hintFor(d = {}) {
  switch (d.reason) {
    case "released before the microphone was ready": return "A touch too quick - the microphone needs a second to wake up. Tap Space once and just talk.";
    case "too short": return "That was rather brief. Tap Space once and just speak, or hold it while you talk.";
    case "microphone delivered no sound": return `I'm getting pure silence from ${d.mic || "the microphone"}. Is it muted? You can pick another in Settings.`;
    case "only background noise": return "Only background noise reached me. Try again, a little closer to the mic.";
    default: return String(d.reason || "").startsWith("audio decode") ? "The recording arrived garbled. Try again?" : "I didn't catch that.";
  }
}
function reportVoice(d) { api.diag({ kind: "voice", ...d }).catch(() => {}); }

// ---------------------------------------------------------------- hands-free: "Hey Dennis" + open conversation
const ACKS = ["Yes?", "At your service.", "I'm listening.", "Go on.", "What can I do for you?", "Mm?", "You rang?", "Certainly. What do you need?",
  "Ready when you are.", "Shall we start cooking the next task?", "Standing by for orders.", "Affirmative. Go ahead."];
const SIGNOFFS = ["Very well. I'll be here.", "Standing by.", "As you wish. Just say the word.", "Until next time.", "I'll be around.",
  "Very well. I'll keep the kettle warm.", "Affirmative. Standing down.", "Off you go, then. I'll mind the files."];
const pick = (a) => a[Math.floor(Math.random() * a.length)];
S.hf = "off";
const handsFree = new HandsFree(voice, {
  isBusy: () => S.busy,
  isSpeaking: () => voice.speaking && !S.acking, // his short "Yes?" shouldn't swallow your reply
  onState: (st) => {
    S.hf = st;
    if (st === "off" && S.continuous) S.continuous = false; // the mic went away underneath it
    updateChips();
    setState(restState());
  },
  onWake: (cmd) => {
    flashHint("HEY DENNIS");
    if (cmd) { caption(`"${cmd}"`); ask(cmd, { input: "voice" }); return; }
    const a = pick(ACKS);
    S.acking = true;
    voice.say(a);
    caption(a, 2500);
  },
  onCommand: (text) => { if (S.notes) return; caption(`"${text}"`); ask(text, { input: "voice" }); },
  onEnd: (reason) => {
    if (reason === "convo-off") return setState(restState()); // setContinuous says its own piece
    if (reason === "user" && S.continuous) { // "that's all" ends continuous conversation too
      S.continuous = false;
      api.settings({ voice: { continuous: false } }).then(({ config }) => { S.config = config; }).catch(() => {});
      if (S.config?.voice?.wakeWord === false) handsFree.stop();
      updateChips();
    }
    if (reason === "user") { const s = pick(SIGNOFFS); voice.say(s); caption(s, 3000); }
    else caption("Standing by. Say \u201cHey Dennis\u201d when you need me.", 4000);
    setState(restState());
  },
  onStop: () => hush(),
  onRepeat: () => sayAgain(),
  onHeard: (t) => caption(`"${t}"`, 1500),
  onNote: (text, at) => addNote(text, at),
  onNotesEnd: () => endNotes(),
  onError: (e) => {
    reportVoice({ reason: `hands-free error: ${e?.name || ""} ${e?.message || e}` });
    toast(e?.name === "NotAllowedError" ? "Hands-free needs the microphone - allow it, then click STANDBY." : `Hands-free: ${e?.message || e}`, true);
  },
});
async function startHandsFree() {
  if (S.hf !== "off" || PROBE) return;
  S.hf = "starting"; updateChips();
  try { await handsFree.start(); } catch { S.hf = "off"; updateChips(); }
}
$("#chip-wake").onclick = () => {
  if (S.continuous) { // the mic stays open for continuous conversation; this only changes what happens after it
    const on = S.config?.voice?.wakeWord === false;
    api.settings({ voice: { wakeWord: on } }).then(({ config }) => { S.config = config; updateChips(); }).catch(() => {});
    return toast(on ? "\u201cHey Dennis\u201d on for after continuous conversation" : "\u201cHey Dennis\u201d off for after continuous conversation");
  }
  const on = S.hf === "off";
  if (on) startHandsFree(); else handsFree.stop();
  api.settings({ voice: { wakeWord: on } }).then(({ config }) => { S.config = config; }).catch(() => {});
};

// ---- continuous conversation: he listens all the time - no wake word, no key - until it's switched off
// (the speech-bubble button, L, "continuous mode" / "continuous mode off", a held thumbs-up, the orb's menu, or "that's all")
S.continuous = false;
const CONVO_ON = ["Continuous conversation on. Just talk - say \u201cthat's all\u201d when you're done.", "I'm all ears. No need to press anything.", "Very well, I'll keep listening. Talk whenever you like."];
const CONVO_OFF = ["Continuous conversation off.", "Very well. Press the key or call my name when you need me.", "Standing down from listening."];
async function setContinuous(on, { save = true, quiet = false } = {}) {
  on = !!on;
  if (on === S.continuous) { if (!quiet) reply(on ? "I'm already listening." : "Continuous conversation is already off."); return; }
  if (on && (PROBE || SIM)) return;
  S.continuous = on;
  updateChips();
  flashHint(on ? "CONVO ON" : "CONVO OFF");
  const remember = () => { if (save) api.settings({ voice: { continuous: on } }).then(({ config }) => { S.config = config; }).catch(() => {}); };
  if (on) {
    try { await handsFree.setContinuous(true); } catch { S.continuous = false; updateChips(); return; } // onError says why; nothing saved
    remember();
    if (!quiet) reply(pick(CONVO_ON));
  } else {
    remember();
    await handsFree.setContinuous(false);
    if (S.hf === "conversation") handsFree.endConversation("convo-off");
    if (S.config?.voice?.wakeWord === false) handsFree.stop(); // no wake word either: the mic closes
    if (!quiet) reply(pick(CONVO_OFF));
  }
  setState(restState());
}
$("#chip-convo").onclick = () => setContinuous(!S.continuous);

// press-and-hold vs. tap, shared by Space and the mic button
let pressAt = 0, pressSource = null;
function pressStart(source) {
  if (voice.listening && S.listenAuto) { endListen("tap"); pressSource = null; return; } // tap again = send now
  if (voice.listening) return;
  pressAt = performance.now();
  pressSource = source;
  beginListen(source, { auto: false });
}
function pressEnd(source) {
  if (pressSource !== source) return;
  pressSource = null;
  if (!voice.listening || S.listenSource !== source) return;
  if (performance.now() - pressAt < TAP_MS) { S.listenAuto = true; caption("Listening - just speak. I'll know when you're done.", 60000); }
  else endListen("release");
}
const mic = $("#mic");
mic.addEventListener("pointerdown", (e) => { e.preventDefault(); pressStart("mic"); });
addEventListener("pointerup", () => pressEnd("mic"));

// ---------------------------------------------------------------- input bar
$("#ask").addEventListener("submit", (e) => {
  e.preventDefault();
  const q = $("#q");
  const text = q.value;
  q.value = "";
  q.blur();
  ask(text);
});
$("#stop").onclick = () => stopAll();
$("#brand .words").onclick = async () => { await stopTurn(); await api.newChat(); $("#msgs").innerHTML = ""; addMsg("sys", "new conversation"); };
$("#log-new").onclick = () => $("#brand .words").click();
$("#log-hide").onclick = () => { $("#log").classList.add("hidden"); updateInsets(); };
$("#log-show").onclick = () => { $("#log").classList.remove("hidden"); updateInsets(); };

// ---------------------------------------------------------------- mouse
const canvasEl = galaxy.renderer.domElement;
let mouse = null;
canvasEl.addEventListener("pointerdown", (e) => {
  if (e.button === 1) {
    // middle button: drag to pan, click to re-centre
    e.preventDefault();
    mouse = { pan: true, x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, moved: false };
    canvasEl.setPointerCapture(e.pointerId);
    return;
  }
  if (e.button !== 0) return;
  const t = galaxy.pick(e.clientX, e.clientY);
  mouse = { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, t0: performance.now(), target: t, moved: false, carry: false };
  canvasEl.setPointerCapture(e.pointerId);
});
canvasEl.addEventListener("pointermove", (e) => {
  if (!mouse) {
    const t = galaxy.pick(e.clientX, e.clientY);
    setNodeHover(t, e.clientX, e.clientY);
    canvasEl.style.cursor = t ? "pointer" : "grab";
    return;
  }
  const dx = e.clientX - mouse.x, dy = e.clientY - mouse.y;
  mouse.x = e.clientX; mouse.y = e.clientY;
  if (!mouse.moved && Math.hypot(e.clientX - mouse.x0, e.clientY - mouse.y0) > 5) {
    mouse.moved = true;
    if (mouse.target && mouse.target !== "core" && !mouse.target.item.isDir && !mouse.target.item.more) { mouse.carry = true; galaxy.beginCarry(mouse.target); }
  }
  if (mouse.pan) { if (mouse.moved) { galaxy.panBy(dx, dy); canvasEl.style.cursor = "move"; } }
  else if (mouse.carry) galaxy.carryTo(e.clientX, e.clientY);
  else if (mouse.moved) { galaxy.orbitBy(dx, dy); canvasEl.style.cursor = "grabbing"; }
});
canvasEl.addEventListener("mousedown", (e) => { if (e.button === 1) e.preventDefault(); }); // no autoscroll cursor on middle click
canvasEl.addEventListener("pointerup", (e) => {
  if (!mouse) return;
  const m = mouse;
  mouse = null;
  if (m.pan) { if (!m.moved) galaxy.recenter(); canvasEl.style.cursor = "grab"; return; }
  if (m.carry) {
    const over = galaxy.overCore(e.clientX, e.clientY);
    galaxy.endCarry();
    if (over) askAbout(m.target.item);
  } else if (!m.moved) activate(m.target);
});
canvasEl.addEventListener("dblclick", (e) => {
  const t = galaxy.pick(e.clientX, e.clientY);
  if (t && t !== "core" && !t.item.isDir && !t.item.more) api.open(t.item.path).then(() => toast(`Opening ${t.item.name}`)).catch((er) => toast(er.message, true));
});
canvasEl.addEventListener("wheel", (e) => { e.preventDefault(); galaxy.zoomBy(Math.exp(e.deltaY * 0.0012)); }, { passive: false });
canvasEl.addEventListener("pointerleave", () => { if (!mouse) setNodeHover(null); });

function setNodeHover(t, x, y) {
  galaxy.setHover(t);
  S.nodeHover = t;
  const tip = $("#tip");
  if (!t || t === "core") {
    if (t === "core") {
      tip.innerHTML = `<b>D.E.N.N.I.S.</b><small>${voice.listening ? "tap to send" : "tap to talk · drop a file here to ask about it"}</small>`;
      placeTip(tip, x, y);
    } else tip.classList.remove("show");
    return;
  }
  const it = t.item;
  tip.innerHTML = `<b>${escapeHtml(it.name)}</b><small>${it.more ? "show more" : it.isDir ? `${it.items != null ? it.items.toLocaleString() + " files · " : ""}${fmtBytes(it.size)}` : `${KIND_NAMES[it.kind] || it.kind} · ${fmtBytes(it.size)} · ${fmtDate(it.mtime)}`}</small>`;
  placeTip(tip, x, y);
}
function placeTip(tip, x, y) {
  tip.classList.add("show");
  const r = tip.getBoundingClientRect();
  tip.style.left = Math.min(innerWidth - r.width - 12, x + 18) + "px";
  tip.style.top = Math.min(innerHeight - r.height - 12, y + 18) + "px";
}

// ---------------------------------------------------------------- hands -> the same actions
const HAND_DOM = "button, [data-hand], select, input, .pbody";
function domTargetAt(x, y) {
  const el = document.elementFromPoint(x, y);
  if (!el || el === canvasEl || el.closest("#galaxy")) return null;
  return el.closest(HAND_DOM);
}

const gestures = new Gestures({
  cursor(states) {
    S.cursor = states;
    const live = states.filter((s) => s.present);
    const primary = live.find((s) => s.pinch) || live[0];
    if (!primary) {
      if (S.domHover) { S.domHover.classList.remove("hand-hover"); S.domHover = null; }
      if (S.hoverByHand && !mouse) { S.hoverByHand = false; setNodeHover(null); }
      return;
    }
    if (S.grabs.some((g) => g)) return; // keep hover frozen during a grab
    const dom = domTargetAt(primary.x, primary.y);
    if (dom !== S.domHover) { S.domHover?.classList.remove("hand-hover"); S.domHover = dom; dom?.classList.add("hand-hover"); }
    S.hoverByHand = true;
    if (dom) setNodeHover(null);
    else if (!mouse) setNodeHover(galaxy.pick(primary.x, primary.y, 30), primary.x, primary.y);
  },
  pinchStart(i, p, cur = p) { // p: where you aimed just before pinching; cur: the fingertip now
    const dom = domTargetAt(p.x, p.y);
    if (dom) {
      S.grabs[i] = dom.matches(".pbody") || dom.closest(".pbody") ? { type: "scroll", el: dom.closest(".pbody") } : { type: "dom", el: dom };
      dom.classList.add("hand-press");
      return;
    }
    const t = galaxy.pick(p.x, p.y, 30);
    S.grabs[i] = { type: t === "core" ? "core" : t ? (t.item.isDir || t.item.more ? "dir" : "file") : "space", node: t, x0: cur.x, y0: cur.y, carry: false };
  },
  pinchMove(i, p, d) {
    const g = S.grabs[i];
    if (!g) return;
    if (g.type === "scroll") { g.el.scrollTop -= d.y * 2.2; g.el.scrollLeft -= d.x * 2.2; } // sideways too: wide sheets, zoomed PDFs
    else if (g.type === "file") {
      if (!g.carry && Math.hypot(p.x - g.x0, p.y - g.y0) > 50) { g.carry = true; galaxy.beginCarry(g.node); }
      if (g.carry) galaxy.carryTo(p.x, p.y);
    } else if (g.type === "space" || g.type === "dir" || g.type === "core") galaxy.orbitBy(d.x * 1.2, d.y * 1.2);
  },
  pinchEnd(i, p, info) {
    const g = S.grabs[i];
    S.grabs[i] = null;
    if (!g) return;
    g.el?.classList.remove("hand-press");
    if (info.during2) { if (g.carry) galaxy.endCarry(); return; }
    if (g.type === "dom" || g.type === "scroll") {
      if (info.quick && g.type === "dom") { const el = g.el; if (el.matches("input, select")) el.focus(); else el.click(); }
      return;
    }
    if (g.carry) {
      const over = galaxy.overCore(p.x, p.y);
      galaxy.endCarry();
      if (over) askAbout(g.node.item);
      return;
    }
    if (info.quick) activate(g.node);
    else if (info.speed > 6) galaxy.fling(info.vx * 0.6, info.vy * 0.6);
  },
  two(phase, info) {
    if (phase === "move") galaxy.zoomBy(1 / info.scale);
    for (let i = 0; i < 2; i++) if (S.grabs[i]?.carry) { galaxy.endCarry(); S.grabs[i].carry = false; }
  },
  peace() { back(); flashHint("BACK"); },
  fist() { voice.stopSpeaking(); closePreview(); caption(""); flashHint("HUSH"); },
  thumbUp() { setContinuous(!S.continuous); },
  palm(phase, i, p, prog) {
    S.palmCharge[i] = phase === "charge" ? { x: p.x, y: p.y, prog } : null;
    if (phase === "start" && !voice.listening) beginListen("palm", { auto: false });
    if (phase === "end" && S.listenSource === "palm") endListen("palm lowered");
  },
});

let hintTimer;
function flashHint(text) { showProgress(text); clearTimeout(hintTimer); hintTimer = setTimeout(hideProgress, 900); }

const tracker = new HandTracker($("#cam"), {
  onFrame(lms, vw, vh) {
    if (!S.handsOn) return;
    gestures.setVideoSize(vw, vh);
    gestures.ingest(lms);
  },
  onStatus(msg, err) {
    S.handsLive = msg === "hands live";
    updateChips();
    if (S.handsLive && tracker.cameraLabel) toast(`Hands live · camera: ${tracker.cameraLabel}`);
    if (err) toast(`Hands: ${msg}`, true);
  },
});

async function startHands() {
  if (SIM || PROBE) return;
  try { await tracker.start(S.config?.hands?.cameraId || ""); S.handsOn = true; }
  catch (e) { console.warn("[hands]", e); S.handsOn = false; }
  updateChips();
}
async function restartHands() {
  if (tracker.running) { tracker.stop(); for (let i = 0; i < 2; i++) gestures.drop(i); S.handsLive = false; }
  await startHands();
}
// Plugging in a camera (or starting Camo for the iPad) after D.E.N.N.I.S. is running:
// in automatic mode, switch to it if it ranks better than what we have.
navigator.mediaDevices?.addEventListener?.("devicechange", async () => {
  if (S.config?.hands?.enabled === false || S.config?.hands?.cameraId || SIM || PROBE) return;
  const best = await HandTracker.bestCamera();
  if (!best) return;
  if (!tracker.running || cameraRank(best.label) < cameraRank(tracker.cameraLabel || "")) {
    toast(`Camera found: ${best.label}`);
    restartHands();
  }
});
function toggleHands() {
  if (tracker.running) { tracker.stop(); S.handsOn = false; for (let i = 0; i < 2; i++) gestures.drop(i); S.handsLive = false; }
  else startHands();
  updateChips();
}
const CAM_MODES = ["stage", "pip", "off"];
function setCam(mode) {
  S.cam = mode;
  document.body.classList.remove("cam-stage", "cam-pip", "cam-off");
  document.body.classList.add("cam-" + mode);
  try { localStorage.setItem("dennis.cam", mode); } catch { /* storage blocked */ }
  if (S.config && S.config.hands?.camView !== mode) { // remembered in Settings, so it survives restarts and reinstalls
    S.config.hands = { ...(S.config.hands || {}), camView: mode };
    api.settings({ hands: { camView: mode } }).catch(() => {});
  }
  galaxy.setCameraFeed($("#cam"), mode, S.config?.hands?.mirror !== false, !!S.config?.hands?.stageFlip); // "stage": drawn inside the 3D scene as a hologram
  updateChips();
}
const cycleCam = () => setCam(CAM_MODES[(CAM_MODES.indexOf(S.cam) + 1) % CAM_MODES.length]);
async function toggleFullscreen() {
  if (shell) { S.fullscreen = await shell.toggleFullscreen(); updateShellChips(); return; }
  if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen().catch(() => {});
}

// ---------------------------------------------------------------- capabilities: skills, minions, connected apps, documents
const caps = new Caps({
  toast,
  getConfig: () => S.config,
  saveSettings: async (patch) => { try { S.config = (await api.settings(patch)).config; } catch (e) { toast(e.message, true); } },
  showReport: (run) => { addMinionMsg(run); $("#log").classList.remove("hidden"); updateInsets(); caption(`${run.name}: ${(run.report || run.error || "").slice(0, 220)}`, 8000); },
});
$("#chip-caps").onclick = () => caps.open();
$("#open-caps").onclick = () => { $("#settings").classList.remove("show"); caps.open(); };
function addMinionMsg(run) {
  const el = addMsg("minion", run.report || run.error || `(${run.status})`);
  el.dataset.who = `${run.name} \u00b7 ${run.status === "done" ? "report" : run.status}`;
  return el;
}
const BACK_LINES = (n) => [`${n} is back.`, `${n} has reported in.`, `${n} is back with the goods.`];
let briefTimer = null;
/** A minion came back: its report goes in the log, and he briefs you as soon as he's free. */
function minionBack(run) {
  addMinionMsg(run);
  if (run.status === "recalled") return;
  if (run.status === "failed") toast(`${run.name} hit a snag: ${run.error || "unknown error"}`, true);
  if (S.config?.briefMinions === false || S.mock) { const l = pick(BACK_LINES(run.name)); caption(l, 3000); voice.say(l); return; }
  clearTimeout(briefTimer);
  const tryBrief = () => {
    // not while he's answering, talking, listening to you, or waiting on a yes/no
    if (S.busy || voice.speaking || voice.listening || S.approvals.length) { briefTimer = setTimeout(tryBrief, 1500); return; }
    ask("A minion has reported back.", { input: "event", silent: true });
  };
  briefTimer = setTimeout(tryBrief, 700);
}

// ---------------------------------------------------------------- desktop shell: compact orb, fullscreen, reboot
// window.dennisShell comes from the desktop app's preload; in a plain browser it's absent.
const shell = window.dennisShell || null;
const orbCh = new BroadcastChannel("dennis-orb"); // the compact orb mirrors his state and voice
orbCh.onmessage = (e) => { if (e.data?.hello) orbCh.postMessage({ state: galaxy.state, level: galaxy.level, theme: S.theme }); };

// ---------------------------------------------------------------- themes (themes.js): the look of the scene
S.theme = "reactor";
/** Switch the look; `save` remembers it for next time. Returns the theme's name. */
function setTheme(name, { save = true } = {}) {
  const t = galaxy.setTheme(themeName(name));
  S.theme = t;
  for (const k of THEME_ORDER) document.body.classList.toggle(`theme-${k}`, k === t);
  $("#chip-theme").title = `Theme: ${THEMES[t].label} - ${THEMES[t].note} Click for the next one (T)`;
  orbCh.postMessage({ theme: t });
  if (save && (S.config?.visuals?.theme || "reactor") !== t) {
    api.settings({ visuals: { theme: t } }).then((r) => { if (r?.config) S.config = r.config; }).catch(() => {});
  }
  return t;
}
const nextTheme = () => THEME_ORDER[(THEME_ORDER.indexOf(S.theme) + 1) % THEME_ORDER.length];
$("#chip-theme").onclick = () => { const t = setTheme(nextTheme()); toast(`Theme: ${THEMES[t].label}`); };
/** Settings previews the theme as you pick it; leaving without saving puts the saved one back. */
const revertThemePreview = () => { const saved = themeName(S.config?.visuals?.theme); if (saved !== S.theme) setTheme(saved, { save: false }); };
S.compact = false;
S.fullscreen = false;
function setCompact(on) {
  if (!shell) return toast("Compact mode needs the desktop app", true);
  shell.compact(on);
}
shell?.onCompact((on) => {
  S.compact = on;
  if (on) {
    // nothing to point at while he's a wee orb: rest the camera and hand tracking
    S.handsPaused = tracker.running;
    if (S.handsPaused) { tracker.stop(); for (let i = 0; i < 2; i++) gestures.drop(i); S.handsLive = false; }
    orbCh.postMessage({ state: galaxy.state, level: galaxy.level });
  } else {
    lastT = performance.now();
    if (S.handsPaused) { S.handsPaused = false; startHands(); }
  }
  updateChips();
});
shell?.onFullscreen((on) => { S.fullscreen = on; updateShellChips(); });
function updateShellChips() {
  $("#chip-full").title = S.fullscreen ? "Exit fullscreen (F11)" : "Fullscreen (F11)";
  $("#chip-full").classList.toggle("on", S.fullscreen);
}
$("#chip-compact").hidden = !shell;
$("#chip-compact").onclick = () => setCompact(true);
$("#chip-full").onclick = () => toggleFullscreen();
// reboot: tap once to arm, again within 3 s to confirm (a stray pinch shouldn't restart him)
// the header's height (its rows of chips wrap on narrow windows): the panels below it follow
// (layout sizes, unaffected by the boot slide-in). File windows open below the clock too.
new ResizeObserver(() => {
  const css = document.documentElement.style, chips = $("#chips"), center = $("#center");
  css.setProperty("--top-h", `${$("#top").offsetHeight}px`);
  css.setProperty("--chips-h", `${chips.offsetTop + chips.offsetHeight}px`);
  css.setProperty("--center-h", `${center.offsetTop + center.offsetHeight}px`);
  galaxy.safeTop = center.offsetTop + center.offsetHeight + 14;
}).observe($("#top"));

// the arc-reactor logo (top left) is the reboot button
let rebootArmed = 0;
$("#reboot-ring").onclick = () => {
  if (performance.now() - rebootArmed < 3000) return reboot();
  rebootArmed = performance.now();
  $("#reboot-ring").classList.add("armed");
  toast("Tap the logo again to reboot D.E.N.N.I.S.");
  setTimeout(() => $("#reboot-ring").classList.remove("armed"), 3000);
};
const REBOOT_LINES = ["Rebooting. Back in a moment.", "Going down for a quick restart. Don't go anywhere.", "Restarting. Try not to miss me."];
function reboot() {
  const line = pick(REBOOT_LINES);
  stopAll();
  caption(line, 4000);
  voice.say(line);
  const t0 = performance.now();
  const go = () => {
    if (voice.speaking && performance.now() - t0 < 4500) return setTimeout(go, 150); // let him finish the line
    if (shell) shell.relaunch(); else location.reload();
  };
  setTimeout(go, 700);
}

// ---------------------------------------------------------------- HUD: hand reticles, palm charge
const hud = $("#hud"), hg = hud.getContext("2d");
function sizeHud() { hud.width = innerWidth * devicePixelRatio; hud.height = innerHeight * devicePixelRatio; hg.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0); }
sizeHud();
addEventListener("resize", () => { sizeHud(); gestures.setVideoSize(tracker.video.videoWidth, tracker.video.videoHeight); });

// HOLOGRAM HANDS: every tracked hand is drawn as a see-through hologram, like hand tracking in a VR headset:
// a smooth glassy body that fades out at the wrist, a glowing rim, faint knuckle creases and lit fingertips.
// Each layer is built opaque on a scratch canvas first, so overlapping fingers never double up.
const holoBody = document.createElement("canvas"), hb = holoBody.getContext("2d");
const holoRim = document.createElement("canvas"), hr = holoRim.getContext("2d");
const holoPts = [null, null]; // lightly smoothed screen points per hand slot
// joint radii as a fraction of the palm length (wrist -> middle knuckle): knuckle, middle joint, top joint, tip
const HOLO_FINGERS = [
  { j: [1, 2, 3, 4], r: [0.15, 0.112, 0.098, 0.086] }, // thumb
  { j: [5, 6, 7, 8], r: [0.1, 0.088, 0.08, 0.071] },
  { j: [9, 10, 11, 12], r: [0.104, 0.092, 0.082, 0.073] },
  { j: [13, 14, 15, 16], r: [0.097, 0.085, 0.077, 0.069] },
  { j: [17, 18, 19, 20], r: [0.085, 0.074, 0.067, 0.06] }, // pinky
];
const hv = {
  add: (a, b) => ({ x: a.x + b.x, y: a.y + b.y }), sub: (a, b) => ({ x: a.x - b.x, y: a.y - b.y }),
  mul: (a, k) => ({ x: a.x * k, y: a.y * k }), lerp: (a, b, k) => ({ x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k }),
  norm: (a) => { const l = Math.hypot(a.x, a.y) || 1; return { x: a.x / l, y: a.y / l }; },
};
/** The accent colour (it follows his state: cyan, green while listening, amber while thinking) as [r, g, b]. */
function holoRGB(c) {
  const h = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(c);
  if (h) { const x = h[1].length === 3 ? [...h[1]].map((d) => d + d).join("") : h[1]; return [0, 2, 4].map((i) => parseInt(x.slice(i, i + 2), 16)); }
  const r = /rgba?\(([^)]+)\)/.exec(c);
  return r ? r[1].split(/[ ,/]+/).slice(0, 3).map(Number) : [94, 242, 255];
}
const holoMix = (c, k, a = 1) => `rgba(${c.map((v) => Math.round(v + (255 - v) * k)).join(",")},${a})`; // toward white by k
const holoDim = (c, k, a = 1) => `rgba(${c.map((v) => Math.round(v * k)).join(",")},${a})`; // toward black by k

/** The hand as simple solids: a rounded palm (with thumb webbing and a wrist that runs off to fade) and tapered fingers. */
function holoGeom(P, span) {
  const u = hv.norm(hv.sub(P[0], P[9])); // toward the wrist
  const v = { x: -u.y, y: u.x };
  const side = Math.sign((P[1].x - P[0].x) * v.x + (P[1].y - P[0].y) * v.y) || 1; // which side the thumb is on
  const wrist = (k) => hv.add(P[0], hv.add(hv.mul(v, k * span * 0.27), hv.mul(u, span * 0.34)));
  const web = hv.lerp(hv.lerp(P[2], P[5], 0.5), P[1], 0.3); // skin between thumb and index
  const palm = [wrist(side), P[1], web, P[5], P[9], P[13], P[17], wrist(-side * 0.92)];
  // the soft pad at the base of the thumb, rounding off the corner between thumb and wrist
  const pads = [{ c: hv.add(hv.lerp(P[0], P[1], 0.62), hv.mul(v, -side * span * 0.04)), r: span * 0.21 }];
  const fingers = HOLO_FINGERS.map((f) => {
    const c = f.j.map((k) => P[k]), n = c.length - 1, r = f.r.map((x) => x * span);
    c[n] = hv.sub(c[n], hv.mul(hv.norm(hv.sub(c[n], c[n - 1])), r[n] * 0.55)); // the tip landmark sits at the very end of the finger
    return { c, r };
  });
  return { u, palm, pads, fingers, palmR: span * 0.085 };
}

/** Fill the hand silhouette, every part shrunk by `shrink` px (used to cut the rim out of the solid). */
function holoShape(g, G, shrink) {
  g.beginPath();
  G.palm.forEach((p, i) => (i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y)));
  g.closePath();
  g.fill();
  g.lineJoin = "round";
  g.lineWidth = Math.max(0.5, 2 * (G.palmR - shrink));
  g.stroke();
  for (const b of G.pads) { g.beginPath(); g.arc(b.c.x, b.c.y, Math.max(0.5, b.r - shrink), 0, Math.PI * 2); g.fill(); }
  for (const f of G.fingers) {
    for (let k = 0; k < f.c.length; k++) {
      const r = Math.max(0.5, f.r[k] - shrink);
      g.beginPath(); g.arc(f.c[k].x, f.c[k].y, r, 0, Math.PI * 2); g.fill();
      if (k) holoTaper(g, f.c[k - 1], Math.max(0.5, f.r[k - 1] - shrink), f.c[k], r);
    }
  }
}
/** A smoothly tapering limb between two joint circles (the outer tangents), so fingers have no steps. */
function holoTaper(g, a, ra, b, rb) {
  const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy);
  if (d <= Math.abs(ra - rb) + 0.01) return;
  const nx = dx / d, ny = dy / d, s = (ra - rb) / d, c = Math.sqrt(1 - s * s);
  const m1x = -ny * c + nx * s, m1y = nx * c + ny * s, m2x = ny * c + nx * s, m2y = -nx * c + ny * s;
  g.beginPath();
  g.moveTo(a.x + m1x * ra, a.y + m1y * ra); g.lineTo(b.x + m1x * rb, b.y + m1y * rb);
  g.lineTo(b.x + m2x * rb, b.y + m2y * rb); g.lineTo(a.x + m2x * ra, a.y + m2y * ra);
  g.closePath(); g.fill();
}

function drawHoloHand(s, accent, t = 0) {
  const raw = s.lm.map((p) => gestures.px(p));
  const prev = holoPts[s.i];
  const P = (holoPts[s.i] = prev ? raw.map((p, k) => hv.lerp(prev[k], p, 0.55)) : raw);
  const span = Math.hypot(P[0].x - P[9].x, P[0].y - P[9].y);
  if (!(span > 8)) return;
  const G = holoGeom(P, span);
  // work only inside the hand's own box, so the glow stays cheap
  const pts = [...G.palm, ...G.fingers.flatMap((f) => f.c)], pad = span * 0.3 + 24;
  const x0 = Math.max(0, Math.min(...pts.map((p) => p.x)) - pad), y0 = Math.max(0, Math.min(...pts.map((p) => p.y)) - pad);
  const x1 = Math.min(innerWidth, Math.max(...pts.map((p) => p.x)) + pad), y1 = Math.min(innerHeight, Math.max(...pts.map((p) => p.y)) + pad);
  if (x1 <= x0 || y1 <= y0) return;
  const bw = x1 - x0, bh = y1 - y0, d = devicePixelRatio;
  const tipward = hv.sub(P[0], hv.mul(G.u, span * 2.05)); // just past the fingertips
  const fadeA = hv.add(P[0], hv.mul(G.u, span * 0.34)), fadeB = hv.sub(P[0], hv.mul(G.u, span * 0.1));
  const C = holoRGB(accent);
  const grad = (g, stops, a = P[0], b = tipward) => { const gr = g.createLinearGradient(a.x, a.y, b.x, b.y); stops.forEach(([o, c]) => gr.addColorStop(o, c)); return gr; };

  for (const [cv, g] of [[holoBody, hb], [holoRim, hr]]) {
    if (cv.width !== hud.width || cv.height !== hud.height) { cv.width = hud.width; cv.height = hud.height; }
    g.setTransform(d, 0, 0, d, 0, 0);
    g.globalCompositeOperation = "source-over";
    g.clearRect(x0, y0, bw, bh);
    g.fillStyle = g.strokeStyle = "#fff";
    holoShape(g, G, 0);
  }
  // body: deep at the palm, bright toward the fingertips, a soft sheen on the palm and drifting scanlines
  hb.globalCompositeOperation = "source-in";
  hb.fillStyle = grad(hb, [[0, holoDim(C, 0.45)], [0.5, accent], [1, holoMix(C, 0.85)]]);
  hb.fillRect(x0, y0, bw, bh);
  hb.globalCompositeOperation = "source-atop";
  const pc = hv.lerp(P[0], P[9], 0.55), sheen = hb.createRadialGradient(pc.x, pc.y, 0, pc.x, pc.y, span * 0.75);
  sheen.addColorStop(0, "rgba(255,255,255,0.35)"); sheen.addColorStop(1, "rgba(255,255,255,0)");
  hb.fillStyle = sheen; hb.fillRect(x0, y0, bw, bh);
  hb.fillStyle = "rgba(255,255,255,0.16)";
  for (let y = y0 + ((t / 60) % 4) - 4; y < y1; y += 4) hb.fillRect(x0, y, bw, 1.2);
  // rim: cut the inside out of the solid, then light it brighter toward the fingertips
  hr.globalCompositeOperation = "destination-out";
  holoShape(hr, G, Math.max(1.4, span * 0.017));
  hr.globalCompositeOperation = "source-in";
  hr.fillStyle = grad(hr, [[0, accent], [0.6, holoMix(C, 0.6)], [1, "#ffffff"]]);
  hr.fillRect(x0, y0, bw, bh);
  // both melt away toward the wrist instead of ending in a hard edge
  for (const g of [hb, hr]) {
    g.globalCompositeOperation = "destination-in";
    g.fillStyle = grad(g, [[0, "rgba(0,0,0,0)"], [1, "rgba(0,0,0,1)"]], fadeA, fadeB);
    g.fillRect(x0, y0, bw, bh);
  }
  const blit = (cv, alpha, blur) => {
    hg.save(); hg.globalAlpha = alpha; hg.shadowColor = accent; hg.shadowBlur = blur;
    hg.drawImage(cv, x0 * d, y0 * d, bw * d, bh * d, x0, y0, bw, bh);
    hg.restore();
  };
  blit(holoBody, 0.36, 0);
  blit(holoRim, 1, 16);

  hg.save();
  hg.strokeStyle = accent; hg.fillStyle = accent; hg.lineCap = "round";
  // knuckle creases across each finger
  hg.globalAlpha = 0.38; hg.lineWidth = Math.max(1, span * 0.008);
  for (const f of G.fingers) for (let k = 1; k <= 2; k++) {
    const dir = hv.norm(hv.sub(f.c[k + 1], f.c[k - 1])), across = { x: -dir.y, y: dir.x }, w = f.r[k] * 0.62;
    hg.beginPath(); hg.moveTo(f.c[k].x - across.x * w, f.c[k].y - across.y * w); hg.lineTo(f.c[k].x + across.x * w, f.c[k].y + across.y * w); hg.stroke();
  }
  // fingertips glow; thumb and index brighten and join as a pinch closes
  const near = Math.max(0, Math.min(1, (0.9 - (s.pinchRatio ?? 1)) / 0.6));
  const tip = (p, r, a) => {
    const g = hg.createRadialGradient(p.x, p.y, 0, p.x, p.y, r);
    g.addColorStop(0, `rgba(255,255,255,${a})`); g.addColorStop(0.35, holoMix(C, 0.5, a * 0.6)); g.addColorStop(1, holoMix(C, 0, 0));
    hg.globalAlpha = 1; hg.fillStyle = g; hg.beginPath(); hg.arc(p.x, p.y, r, 0, Math.PI * 2); hg.fill();
  };
  for (const fi of [2, 3, 4]) tip(G.fingers[fi].c[3], span * 0.07, 0.35);
  for (const fi of [0, 1]) tip(G.fingers[fi].c[3], span * (0.08 + 0.05 * near), 0.5 + 0.5 * near);
  if (near > 0) {
    const a = G.fingers[0].c[3], b = G.fingers[1].c[3];
    hg.globalAlpha = near * 0.85; hg.strokeStyle = holoMix(C, 0.85); hg.lineWidth = Math.max(1.2, span * 0.01);
    hg.shadowColor = accent; hg.shadowBlur = 10;
    hg.beginPath(); hg.moveTo(a.x, a.y); hg.lineTo(b.x, b.y); hg.stroke();
  }
  if (s.pinch) {
    const m = hv.lerp(G.fingers[0].c[3], G.fingers[1].c[3], 0.5);
    tip(m, span * 0.2, 1);
  }
  hg.restore();
}

function drawHud(t) {
  hg.clearRect(0, 0, innerWidth, innerHeight);
  const accent = getComputedStyle(document.body).getPropertyValue("--accent").trim() || "#5ef2ff";
  for (const s of S.cursor) { if (s.present && s.lm) drawHoloHand(s, accent, t); else holoPts[s.i] = null; }
  for (const s of S.cursor) {
    if (!s.present) continue;
    const r = s.pinch ? 9 : 15 + Math.sin(t / 300) * 1.5;
    hg.strokeStyle = accent;
    hg.lineWidth = 2;
    hg.shadowColor = accent;
    hg.shadowBlur = 12;
    hg.beginPath(); hg.arc(s.x, s.y, r, 0, Math.PI * 2); hg.stroke();
    if (s.pinch) { hg.fillStyle = accent; hg.beginPath(); hg.arc(s.x, s.y, 4, 0, Math.PI * 2); hg.fill(); }
    else {
      for (let k = 0; k < 4; k++) { // crosshair ticks
        const a = k * Math.PI / 2 + t / 1400;
        hg.beginPath(); hg.moveTo(s.x + Math.cos(a) * (r + 4), s.y + Math.sin(a) * (r + 4)); hg.lineTo(s.x + Math.cos(a) * (r + 10), s.y + Math.sin(a) * (r + 10)); hg.stroke();
      }
    }
    hg.shadowBlur = 0;
  }
  for (const c of S.palmCharge) {
    if (!c) continue;
    hg.strokeStyle = "#5effa1";
    hg.lineWidth = 4;
    hg.beginPath(); hg.arc(c.x, c.y, 44, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * c.prog); hg.stroke();
    hg.fillStyle = "rgba(94,255,161,.9)";
    hg.font = "10px Consolas, monospace";
    hg.textAlign = "center";
    hg.fillText("HOLD TO TALK", c.x, c.y + 62);
  }
  if (S.listenSource === "palm") {
    const s = S.cursor.find((x) => x.palmActive) || S.cursor.find((x) => x.present);
    if (s) { hg.strokeStyle = "#5effa1"; hg.lineWidth = 3; hg.beginPath(); hg.arc(s.x, s.y, 40 + Math.sin(t / 120) * 4, 0, Math.PI * 2); hg.stroke(); }
  }
}

// ---------------------------------------------------------------- chips
// The header's toggles are icons: lit = on, dim = off, green = a live conversation, amber = starting.
// Their name and state are in the tooltip (and aria-label).
function setChip(el, { on, live = false, warn = false, label }) {
  el.classList.toggle("off", !on);
  el.classList.toggle("live", live);
  el.classList.toggle("warn", warn);
  if (el.title !== label) { el.title = label; el.setAttribute("aria-label", label); }
}
function updateChips() {
  setChip($("#chip-hands"), { on: S.handsLive || SIM, warn: tracker.running && !S.handsLive && !SIM,
    label: `Hand tracking: ${S.handsLive ? "on" : tracker.running ? "starting..." : SIM ? "simulated" : "off"} (H)` });
  setChip($("#chip-cam"), { on: S.cam !== "off", label: `Camera view: ${{ stage: "full stage", pip: "small window", off: "off" }[S.cam] || S.cam} - click to switch (C)` });
  setChip($("#chip-voice"), { on: !!voice.cfg.speak, label: `Spoken replies: ${voice.cfg.speak ? "on" : "off"}` });
  if (S.continuous) { // the conversation button shows the conversation; this one just says whether the wake word is on
    const wake = S.config?.voice?.wakeWord !== false;
    setChip($("#chip-wake"), { on: wake, label: `\u201cHey Dennis\u201d: ${wake ? "on" : "off"} (for after continuous conversation)` });
  } else {
    const hf = S.hf || "off";
    setChip($("#chip-wake"), { on: hf !== "off", live: hf === "conversation", warn: hf === "starting" || hf === "notes",
      label: { off: "\u201cHey Dennis\u201d: off - click to turn the wake word on", starting: "Microphone starting...", standby: "Standby - say \u201cHey Dennis\u201d", conversation: "In conversation - say \u201cthat's all\u201d to finish", notes: "Taking meeting notes" }[hf] || hf });
  }
  setChip($("#chip-convo"), { on: S.continuous, live: S.continuous,
    label: S.continuous ? `Continuous conversation: on - he's listening${S.hf === "notes" ? " (taking notes)" : ""}. Click or press L to stop, or say \u201cthat's all\u201d`
      : "Continuous conversation: off - click, press L, say \u201ccontinuous mode\u201d, or hold a thumbs-up" });
}
// the file index lives in the corner readout (click it to rescan)
S.indexCount = "--";
function updateIndexChip(st) {
  if (!st) return;
  const scanning = st.state === "scanning";
  S.indexCount = (scanning ? st.scanned : st.total || 0).toLocaleString();
  $("#ro-index").innerHTML = `<b id="ro-files">${S.indexCount}</b>FILES <i>${scanning ? "INDEXING" : "INDEXED"}</i>`;
  $("#ro-index").classList.toggle("scanning", scanning);
  if (st.state === "ready" && S.level?.mode === "root" && !S.indexRefreshed) { S.indexRefreshed = true; refresh(""); }
}
$("#ro-index").onclick = () => api.reindex().then(() => { S.indexRefreshed = false; toast("Rescanning your folders"); });
$("#chip-hands").onclick = () => toggleHands();
$("#chip-cam").onclick = () => cycleCam();
$("#chip-voice").onclick = async () => {
  voice.configure({ speak: !voice.cfg.speak });
  if (!voice.cfg.speak) voice.stopSpeaking();
  updateChips();
  api.settings({ voice: { speak: voice.cfg.speak } }).catch(() => {});
};
$("#chip-help").onclick = () => $("#legend").classList.toggle("show");
$("#chip-settings").onclick = () => openSettings();

// ---------------------------------------------------------------- settings
let draftRoots = [];
/** "claude-opus-5-5", or "ollama · <model>" for other brains. */
function brainLabel(c) {
  const p = c?.provider || "anthropic";
  return p === "anthropic" ? c?.model || "claude" : `${p} · ${c?.brains?.[p]?.model || "no model set"}`;
}

// ---- the brain picker (Settings): Claude or any OpenAI-compatible model
const BRAINS = {
  anthropic: { placeholder: "claude-opus-5-5" },
  openai: { url: "https://api.openai.com/v1", key: true, placeholder: "a model name from LIST MODELS" },
  gemini: { url: "https://generativelanguage.googleapis.com/v1beta/openai", key: true, placeholder: "a model name from LIST MODELS" },
  ollama: { url: "http://127.0.0.1:11434/v1", key: false, editUrl: true, placeholder: "a model you've pulled, e.g. from LIST MODELS" },
  custom: { url: "", key: true, editUrl: true, placeholder: "the model name your server expects" },
};
let brainDraft = null; // { provider, model, brains } while Settings is open
function brainFieldsOut(f) { // remember what's typed for the provider being shown
  const p = brainDraft.shown;
  if (!p) return;
  if (p === "anthropic") brainDraft.model = f.model.value.trim();
  else {
    brainDraft.brains[p] = { ...(brainDraft.brains[p] || {}), model: f.model.value.trim() };
    if (BRAINS[p].editUrl) brainDraft.brains[p].baseUrl = f.brainUrl.value.trim();
    if (f.brainKey.value.trim()) brainDraft.keys[p] = f.brainKey.value.trim();
  }
}
function showBrain(f, p) {
  const c = S.config, b = BRAINS[p];
  brainDraft.shown = p;
  f.provider.value = p;
  f.model.value = p === "anthropic" ? brainDraft.model || "claude-opus-5-5" : brainDraft.brains[p]?.model || "";
  f.model.placeholder = b.placeholder;
  f.brainUrl.value = b.editUrl ? brainDraft.brains[p]?.baseUrl || b.url : "";
  f.brainKey.value = brainDraft.keys[p] || "";
  $("#brain-key-state").textContent = c.brainKeys?.[p] ? "· SAVED" : "";
  $(".brain-url").hidden = !b.editUrl;
  $(".brain-key").hidden = !b.key;
  $(".claude-key").hidden = p !== "anthropic";
  $("#brain-list").hidden = p === "anthropic";
  $("#brain-models").innerHTML = "";
  const note = $("#brain-note");
  note.hidden = p === "anthropic";
  note.textContent = p === "anthropic" ? "" : `Pick a model that supports tool calling. Web search, document skills, the cloud sandbox and thinking notes need Claude, so they're off with this brain.${p === "ollama" ? " Ollama runs the model on this computer: install it, pull a model, then LIST MODELS." : ""}`;
}
$("#settings-form").provider.addEventListener("change", (e) => { const f = $("#settings-form"); brainFieldsOut(f); showBrain(f, e.target.value); });
$("#brain-list").onclick = async () => {
  const f = $("#settings-form");
  const p = f.provider.value;
  try {
    const r = await fetch("/api/brains/models", { method: "POST", headers: { "Content-Type": "application/json", "X-Dennis": "1" }, body: JSON.stringify({ provider: p, baseUrl: f.brainUrl.value.trim() || BRAINS[p].url, apiKey: f.brainKey.value.trim() || undefined }) }).then((x) => x.json());
    if (!r.ok) return toast(r.error || "Couldn't list the models", true);
    $("#brain-models").innerHTML = r.models.map((m) => `<option value="${escapeHtml(m)}">`).join("");
    toast(r.models.length ? `${r.models.length} models available - pick one in the Model field` : "That server lists no models");
    f.model.focus();
  } catch (e) { toast(e.message, true); }
};

function openSettings(first = false) {
  const c = S.config;
  const f = $("#settings-form");
  brainDraft = { model: c.model || "claude-opus-5-5", brains: JSON.parse(JSON.stringify(c.brains || {})), keys: {}, shown: null };
  showBrain(f, c.provider || "anthropic");
  $("#settings-title").textContent = first ? "SYSTEMS ONLINE" : "SETTINGS";
  $("#settings-intro").textContent = first
    ? "Good to meet you. I'm D.E.N.N.I.S. - Digital Entity Neural Network Intelligent System, your virtual production assistant. Tell me who you are, hand me a Claude API key so I can think, and choose which folders I may look after. The rest, I'll handle."
    : "";
  f.userName.value = c.userName || "";
  f.address.value = c.address || "";
  f.personality.value = c.personality || "";
  f.apiKey.value = "";
  $("#key-state").textContent = c.hasApiKey ? "· SAVED" : "";
  $("#key-storage").textContent = c.keyStorage === "os" ? ", encrypted by your OS keychain" : c.keyStorage === "env" ? " (currently read from ANTHROPIC_API_KEY)" : "";
  f.effort.value = c.effort || "low";
  f.permissionMode.value = c.permissionMode || "ask";
  f.webSearch.checked = !!c.webSearch;
  f.speak.checked = !!c.voice?.speak;
  f.engine.value = c.voice?.engine || "kokoro";
  f.kokoroVoice.value = c.voice?.kokoroVoice || "bm_daniel";
  f.elevenVoice.value = c.voice?.elevenVoice || "";
  f.elevenKey.value = "";
  // ElevenLabs chosen but no key: say plainly what that means (only English is spoken aloud)
  const noKey = !c.hasElevenKey && (c.voice?.engine || "kokoro") === "elevenlabs";
  $("#eleven-state").textContent = c.hasElevenKey ? "· SAVED" : noKey ? "· NOT SET - only English is spoken aloud until you add it" : "";
  $("#eleven-state").classList.toggle("warn", noKey);
  f.sttModel.value = c.voice?.sttModel || "Xenova/whisper-base.en";
  f.language.value = c.voice?.language || "en";
  f.city.value = c.location?.query || c.location?.name || "";
  f.briefOnBoot.checked = !!c.briefOnBoot;
  f.continuous.checked = S.continuous;
  f.theme.value = themeName(c.visuals?.theme);
  f.theme.onchange = () => setTheme(f.theme.value, { save: false });
  f.watchOn.checked = c.watch?.enabled !== false;
  f.quietFrom.value = c.watch?.quiet?.from || "22:00";
  f.quietTo.value = c.watch?.quiet?.to || "07:00";
  voice.microphones().then((mics) => {
    f.micId.innerHTML = `<option value="">system default</option>` + mics.map((m, i) => `<option value="${escapeHtml(m.deviceId)}">${escapeHtml(m.label || `microphone ${i + 1}`)}</option>`).join("");
    f.micId.value = c.voice?.micId || "";
    if (f.micId.value !== (c.voice?.micId || "")) f.micId.value = "";
  });
  f.handsEnabled.checked = c.hands?.enabled !== false;
  f.gestureFeel.value = c.hands?.feel === "calm" ? "calm" : "normal";
  f.mirrorCam.checked = c.hands?.mirror !== false;
  f.stageFlip.checked = !!c.hands?.stageFlip;
  HandTracker.cameras().then((cams) => {
    f.cameraId.innerHTML = `<option value="">automatic (prefers Camo / iPad)</option>` + cams.map((m, i) => `<option value="${escapeHtml(m.deviceId)}">${escapeHtml(m.label || `camera ${i + 1}`)}</option>`).join("");
    f.cameraId.value = c.hands?.cameraId || "";
    if (f.cameraId.value !== (c.hands?.cameraId || "")) f.cameraId.value = "";
  });
  f.palmToTalk.checked = c.hands?.palmToTalk !== false;
  f.wakeWord.checked = c.voice?.wakeWord !== false;
  f.showHidden.checked = !!c.showHidden;
  const sel = f.voiceName;
  sel.innerHTML = `<option value="">automatic${voice.voice ? ` (${voice.voice.name})` : ""}</option>` + voice.voices().map((v) => `<option>${escapeHtml(v.name)}</option>`).join("");
  sel.value = c.voice?.voiceName || "";
  draftRoots = (c.roots || []).map((r) => ({ ...r }));
  renderRoots();
  $("#data-dir").textContent = c.dataDir || "~/.dennis";
  $("#root-browse").style.display = S.electron ? "" : "none";
  $("#settings").classList.add("show");
  setTimeout(() => (first && !c.userName ? f.userName : f.apiKey).focus(), 50);
}
function renderRoots() {
  const box = $("#roots");
  box.innerHTML = "";
  if (!draftRoots.length) box.innerHTML = `<div class="root"><span>No folders yet - add at least one.</span></div>`;
  draftRoots.forEach((r, i) => {
    const row = document.createElement("div");
    row.className = "root";
    row.innerHTML = `<b></b><span></span><button type="button" title="Remove">&times;</button>`;
    row.querySelector("b").textContent = r.label;
    row.querySelector("span").textContent = r.path;
    row.querySelector("button").onclick = () => { draftRoots.splice(i, 1); renderRoots(); };
    box.appendChild(row);
  });
}
function addRoot(p) {
  p = String(p || "").trim().replace(/^["']|["']$/g, "");
  if (!p) return;
  const label = p.split(/[\\/]/).filter(Boolean).pop()?.replace(/:$/, " drive") || p;
  if (!draftRoots.some((r) => r.path.toLowerCase() === p.toLowerCase())) draftRoots.push({ path: p, label });
  $("#root-path").value = "";
  renderRoots();
}
$("#root-add").onclick = () => addRoot($("#root-path").value);
$("#root-path").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); addRoot(e.target.value); } });
$("#root-browse").onclick = async () => { const { path } = await api.pickFolder(); if (path) addRoot(path); };
$("#settings-cancel").onclick = () => { $("#settings").classList.remove("show"); revertThemePreview(); };
$("#open-memory").onclick = () => api.reveal((S.config.dataDir || "") + (S.config.dataDir?.includes("\\") ? "\\" : "/") + "memory.md").catch(() => toast("No memories saved yet"));
$("#settings-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  brainFieldsOut(f);
  const patch = {
    userName: f.userName.value.trim(), address: f.address.value.trim(), personality: f.personality.value.trim(), model: brainDraft.model || "claude-opus-5-5",
    provider: f.provider.value, brains: brainDraft.brains, city: f.city.value.trim(), briefOnBoot: f.briefOnBoot.checked,
    watch: { enabled: f.watchOn.checked, quiet: { from: f.quietFrom.value || "22:00", to: f.quietTo.value || "07:00" } },
    effort: f.effort.value, permissionMode: f.permissionMode.value, webSearch: f.webSearch.checked, showHidden: f.showHidden.checked,
    roots: draftRoots,
    visuals: { theme: f.theme.value },
    voice: { speak: f.speak.checked, voiceName: f.voiceName.value, sttModel: f.sttModel.value, language: f.language.value, micId: f.micId.value, wakeWord: f.wakeWord.checked, continuous: f.continuous.checked,
      engine: f.engine.value, kokoroVoice: f.kokoroVoice.value, elevenVoice: f.elevenVoice.value.trim() || "onwK4e9ZLuTAKqWW03F9" },
    hands: { enabled: f.handsEnabled.checked, palmToTalk: f.palmToTalk.checked, cameraId: f.cameraId.value, mirror: f.mirrorCam.checked, stageFlip: f.stageFlip.checked, feel: f.gestureFeel.value },
  };
  if (f.apiKey.value.trim()) patch.apiKey = f.apiKey.value.trim();
  for (const [p, key] of Object.entries(brainDraft.keys)) patch[`${p}Key`] = key; // openaiKey, geminiKey, customKey
  if (f.elevenKey.value.trim()) patch.elevenKey = f.elevenKey.value.trim();
  try {
    const rootsChanged = JSON.stringify(patch.roots) !== JSON.stringify(S.config.roots);
    const prevHands = { ...(S.config.hands || {}) };
    const saved = await api.settings(patch);
    if (saved.ok === false) return toast(saved.error || "Couldn't save those settings", true); // e.g. a city that can't be found
    const { config } = saved;
    applyConfig(config);
    $("#settings").classList.remove("show");
    toast("Saved. New settings apply from the next message.");
    if (rootsChanged) { S.indexRefreshed = false; home(); }
    const camChanged = patch.hands.cameraId !== (prevHands.cameraId || "");
    if (patch.hands.enabled && (!tracker.running || camChanged)) restartHands();
    if (patch.voice.continuous !== S.continuous) setContinuous(patch.voice.continuous, { save: false });
    else if (patch.voice.wakeWord && S.hf === "off") startHandsFree();
    else if (!patch.voice.wakeWord && !patch.voice.continuous && S.hf !== "off") handsFree.stop();
    if (!patch.hands.enabled && tracker.running) toggleHands();
  } catch (er) { toast(er.message, true); }
});

function applyConfig(c) {
  S.config = c;
  voice.configure({ speak: c.voice?.speak !== false, voiceName: c.voice?.voiceName || "", rate: c.voice?.rate || 0.96, pitch: c.voice?.pitch ?? 0.85, sttModel: c.voice?.sttModel || "Xenova/whisper-base.en", micId: c.voice?.micId || "",
    engine: c.voice?.engine || "kokoro", kokoroVoice: c.voice?.kokoroVoice || "bm_daniel", elevenOk: !!c.hasElevenKey,
    language: c.voice?.language || "en", languages: c.voice?.languages || ["en", "ar", "tl", "fr", "ja", "zh"] });
  voice.elevenFailed = false;
  gestures.palmEnabled = c.hands?.palmToTalk !== false;
  gestures.mirror = c.hands?.mirror !== false;
  gestures.calm = c.hands?.feel === "calm";
  galaxy.setCameraFeed($("#cam"), S.cam, c.hands?.mirror !== false, !!c.hands?.stageFlip);
  document.body.classList.toggle("cam-unmirrored", c.hands?.mirror === false);
  if (themeName(c.visuals?.theme) !== S.theme) setTheme(c.visuals?.theme, { save: false });
  updateChips();
}

function lockUp() { $("#locked").classList.add("show"); }

// ---------------------------------------------------------------- keyboard
addEventListener("keydown", (e) => {
  if (e.ctrlKey && e.key === "Tab") { e.preventDefault(); cycleWindows(e.shiftKey ? -1 : 1); return; } // switch file windows
  const typing = e.target.matches("input, textarea, select");
  const emptyAsk = e.target.id === "q" && !e.target.value;
  if (e.key === "Escape") {
    if ($("#settings").classList.contains("show")) { $("#settings").classList.remove("show"); return revertThemePreview(); }
    if (S.approvals.length) return answerApproval(S.approvals[0].id, false);
    if (focusedMax()) return setWindowMax(false);
    if (S.selected) closePreview();
    stopAll();
    if (typing) e.target.blur();
    return;
  }
  if (e.code === "Space" && (!typing || emptyAsk)) { e.preventDefault(); if (!e.repeat) pressStart("space"); return; }
  if (typing) return;
  if (S.approvals.length && (e.key === "y" || e.key === "n")) return answerApproval(S.approvals[0].id, e.key === "y");
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") { e.preventDefault(); doUndo(); return; } // undo the last change to your files
  if (e.key === "Backspace") { e.preventDefault(); back(); }
  else if (e.key === "Home") home();
  else if (e.key === "/" || e.key === "Enter") { e.preventDefault(); $("#q").focus(); }
  else if (e.key === "c") cycleCam();
  else if (e.key === "h") toggleHands();
  else if (e.key === "?") $("#legend").classList.toggle("show");
  else if (e.key === "m") setCompact(!S.compact);
  else if (e.key === "t") { const t = setTheme(nextTheme()); toast(`Theme: ${THEMES[t].label}`); }
  else if (e.key === "l") setContinuous(!S.continuous);
  else if (e.key === "f") { if (windowOpen()) setWindowMax(!focusedMax()); else toggleFullscreen(); }
});
addEventListener("keyup", (e) => {
  if (e.code === "Space") pressEnd("space");
});

// ---------------------------------------------------------------- frame loop
let lastT = performance.now();
function frame(t) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, (t - lastT) / 1000);
  lastT = t;
  if (S.compact) { orbCh.postMessage({ state: galaxy.state, level: galaxy.level }); return; }
  try {
    if (tracker.running) gestures.reapStale();
    galaxy.render(dt);
    drawHud(t);
    instruments.frame(t);
  } catch (e) {
    if (!window.__frameErr) { window.__frameErr = String(e?.message || e); console.error("[frame]", e); }
  }
}
requestAnimationFrame(frame);

// ---------------------------------------------------------------- simulated hands (?sim=1) and self-test (?probe=1)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function handAt(sx, sy, pose) {
  // place a synthetic hand so its index fingertip lands on screen point (sx, sy)
  const ref = synthHand(0.5, 0.5, pose);
  const tx = (innerWidth - sx) / innerWidth, ty = sy / innerHeight;
  return synthHand(0.5 + (tx - ref[8].x), 0.5 + (ty - ref[8].y), pose);
}
async function play(steps) {
  for (const [ms, a, b] of steps) {
    const t0 = performance.now();
    while (performance.now() - t0 < ms) {
      const k = Math.min(1, (performance.now() - t0) / ms);
      gestures.ingest([a ? a(k) : null, b ? b(k) : null], { positional: true });
      await sleep(33);
    }
  }
}
const lerp = (a, b, k) => a + (b - a) * k;
async function runSim() {
  S.handsLive = true; updateChips();
  gestures.setVideoSize(0, 0);
  await sleep(2500);
  for (;;) {
    const target = (galaxy.current || []).find((n) => n.item.isDir && !n.item.missing);
    if (target) {
      const p = galaxy.toScreen(target.group.position);
      const start = { x: innerWidth * 0.5, y: innerHeight * 0.75 };
      await play([[900, (k) => handAt(lerp(start.x, p.x, k), lerp(start.y, p.y, k), "point")]]);
      await play([[500, () => handAt(p.x, p.y, "point")], [160, () => handAt(p.x, p.y, "pinch")], [250, () => handAt(p.x, p.y, "point")]]);
      await sleep(1800);
    }
    const c = { x: innerWidth * 0.5, y: innerHeight * 0.6 };
    await play([[400, () => handAt(c.x - 200, c.y, "point")], [1300, (k) => handAt(c.x - 200 + 400 * k, c.y - 40 * k, "pinch")], [300, () => handAt(c.x + 200, c.y - 40, "point")]]);
    await play([[500, () => handAt(c.x - 120, c.y, "point"), () => handAt(c.x + 120, c.y, "point")],
      [1100, (k) => handAt(c.x - 120 - 140 * k, c.y, "pinch"), (k) => handAt(c.x + 120 + 140 * k, c.y, "pinch")],
      [300, () => handAt(c.x - 260, c.y, "point"), () => handAt(c.x + 260, c.y, "point")]]);
    await sleep(1200);
    await play([[600, () => handAt(c.x, c.y, "peace")], [300, () => handAt(c.x, c.y, "point")]]);
    await play([[200, null, null]]);
    await sleep(2500);
  }
}

async function runProbe() {
  const R = [];
  const ok = (name, pass, detail = "") => R.push({ name, pass: !!pass, detail });
  const log = [];
  const g = new Gestures({
    pinchStart: (i) => log.push(["ps", i]), pinchMove: (i, p, d) => log.push(["pm", i, d.x, d.y]),
    pinchEnd: (i, p, info) => log.push(["pe", i, info.quick]), two: (ph, info) => log.push(["two", ph, info.scale]),
    peace: () => log.push(["peace"]), fist: () => log.push(["fist"]), palm: (ph) => log.push(["palm", ph]), thumbUp: () => log.push(["thumb"]),
  });
  g.setVideoSize(0, 0);
  let now = 1000;
  const feed = (n, a, b) => { for (let k = 0; k < n; k++) { now += 33; g.ingest([a ? a(k / Math.max(1, n - 1)) : null, b ? b(k / Math.max(1, n - 1)) : null], { now, positional: true }); } };
  const reset = () => { feed(3, null, null); log.length = 0; };
  const at = (x, y, pose) => () => synthHand(x, y, pose);

  feed(5, at(0.5, 0.5, "point")); feed(3, at(0.5, 0.5, "pinch")); feed(3, at(0.5, 0.5, "point"));
  ok("pinch-tap registers as a quick tap", log.some((e) => e[0] === "pe" && e[2] === true), JSON.stringify(log.filter((e) => e[0] !== "pm")));
  reset();
  feed(5, at(0.3, 0.5, "point")); feed(20, (k) => synthHand(0.3 + 0.3 * k, 0.5, "pinch")); feed(3, at(0.6, 0.5, "point"));
  const moved = log.filter((e) => e[0] === "pm").reduce((s, e) => s + e[2], 0);
  ok("pinch-drag moves and is not a tap", Math.abs(moved) > 150 && log.some((e) => e[0] === "pe" && e[2] === false), `moved ${moved.toFixed(0)}px`);
  reset();
  feed(5, at(0.5, 0.5, "point")); feed(12, at(0.5, 0.5, "peace"));
  ok("peace held fires once", log.filter((e) => e[0] === "peace").length === 1);
  reset();
  feed(5, at(0.5, 0.5, "point")); feed(16, at(0.5, 0.5, "fist"));
  ok("fist held fires (and never pinches)", log.some((e) => e[0] === "fist") && !log.some((e) => e[0] === "ps") && !log.some((e) => e[0] === "thumb"));
  reset();
  feed(5, at(0.5, 0.5, "point")); feed(20, at(0.5, 0.5, "thumbsup"));
  ok("thumbs-up held fires once (and isn't a fist)", log.filter((e) => e[0] === "thumb").length === 1 && !log.some((e) => e[0] === "fist" || e[0] === "ps"), JSON.stringify(log.filter((e) => e[0] !== "pm")));
  reset();
  feed(4, at(0.4, 0.5, "point"), at(0.6, 0.5, "point"));
  feed(16, (k) => synthHand(0.4 - 0.15 * k, 0.5, "pinch"), (k) => synthHand(0.6 + 0.15 * k, 0.5, "pinch"));
  const twos = log.filter((e) => e[0] === "two" && e[1] === "move");
  ok("two-hand pinch apart zooms", twos.length > 3 && twos.some((e) => e[2] > 1), `${twos.length} moves`);
  reset();
  feed(5, at(0.5, 0.5, "point")); feed(34, at(0.5, 0.5, "palm")); feed(20, at(0.5, 0.5, "fist"));
  ok("held open palm starts and ends talk", log.some((e) => e[0] === "palm" && e[1] === "start") && log.some((e) => e[0] === "palm" && e[1] === "end"), JSON.stringify(log.filter((e) => e[0] === "palm" && e[1] !== "charge")));
  reset();
  feed(5, at(0.5, 0.5, "point")); feed(34, at(0.5, 0.5, "open"));
  ok("relaxed open hand does NOT start talk", !log.some((e) => e[0] === "palm" && e[1] === "start"));
  const ghost = dedupe({ landmarks: [synthHand(0.5, 0.5, "open"), synthHand(0.505, 0.5, "open")], handedness: [[{ score: 0.9 }], [{ score: 0.7 }]] });
  ok("ghost duplicate hand is merged", ghost.length === 1);
  const two = dedupe({ landmarks: [synthHand(0.3, 0.5, "open"), synthHand(0.7, 0.5, "open")], handedness: [[{ score: 0.9 }], [{ score: 0.9 }]] });
  ok("two real hands are kept", two.length === 2);
  ok("synthetic pinch metric", handMetrics(synthHand(0.5, 0.5, "pinch")).pinch < 0.3);
  const passed = R.filter((r) => r.pass).length;
  console.log(`[probe] ${passed}/${R.length}`, R);
  window.__probe = { passed, total: R.length, results: R };
  toast(`self-test ${passed}/${R.length}`, passed !== R.length);
  return window.__probe;
}

// ---------------------------------------------------------------- boot
addEventListener("error", (e) => api.diag({ kind: "error", message: String(e.message || e.error), at: `${e.filename || ""}:${e.lineno || ""}` }).catch(() => {}));
addEventListener("unhandledrejection", (e) => api.diag({ kind: "rejection", message: String(e.reason?.message || e.reason) }).catch(() => {}));

window.__dennis = {
  S, galaxy, gestures, voice, ask, navigate, home, back, present, activate, showPreview,
  summon: () => { if (!voice.listening) beginListen("summon", { auto: true }); },
  compact: setCompact, reboot, caps, setTheme, showDiagram, setContinuous,
  talk: { pressStart, pressEnd, endListen },
  handsFree,
  probe: runProbe,
};

// ---------------------------------------------------------------- the power-up sequence
const BOOT_MS = 3200;
function powerUpSound() {
  if (!voice.cfg.speak) return;
  try {
    const ac = new AudioContext(), t = ac.currentTime;
    const master = ac.createGain();
    master.gain.setValueAtTime(0.0001, t);
    master.gain.exponentialRampToValueAtTime(0.06, t + 0.35);
    master.gain.exponentialRampToValueAtTime(0.0001, t + 2.7);
    master.connect(ac.destination);
    const lp = ac.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.setValueAtTime(300, t);
    lp.frequency.exponentialRampToValueAtTime(4200, t + 2.1);
    lp.connect(master);
    const o1 = ac.createOscillator(), o2 = ac.createOscillator(), g2 = ac.createGain();
    o1.type = "sine"; o1.frequency.setValueAtTime(65, t); o1.frequency.exponentialRampToValueAtTime(210, t + 2);
    o2.type = "triangle"; o2.frequency.setValueAtTime(130, t); o2.frequency.exponentialRampToValueAtTime(840, t + 2.1);
    g2.gain.value = 0.22;
    o1.connect(lp); o2.connect(g2).connect(lp);
    // a soft chime as the systems come up
    const ch = ac.createOscillator(), cg = ac.createGain();
    ch.type = "sine"; ch.frequency.value = 1318.5;
    cg.gain.setValueAtTime(0.0001, t + 2.15); cg.gain.exponentialRampToValueAtTime(0.045, t + 2.18); cg.gain.exponentialRampToValueAtTime(0.0001, t + 3.4);
    ch.connect(cg).connect(ac.destination);
    o1.start(t); o2.start(t); ch.start(t + 2.15);
    o1.stop(t + 2.8); o2.stop(t + 2.8); ch.stop(t + 3.5);
    setTimeout(() => ac.close().catch(() => {}), 3800);
  } catch { /* no audio device */ }
}

/** Typed status lines over the 3D power-up; any click or key skips ahead. */
function bootSequence(st) {
  return new Promise((resolve) => {
    const el = $("#boot"), title = el.querySelector(".b-title"), log = el.querySelector(".b-log");
    document.body.classList.add("booting");
    galaxy.boot(BOOT_MS);
    powerUpSound();
    const v = st.config.voice || {};
    const lines = [
      ["CORE", "ONLINE"],
      ["BRAIN", st.mock ? "MOCK" : brainLabel(st.config).toUpperCase()],
      ["FILES", `${(st.index?.total || st.index?.scanned || 0).toLocaleString()} INDEXED`],
      ["VOICE", v.engine === "elevenlabs" ? "ELEVENLABS" : v.engine === "system" ? "SYSTEM" : `${String(v.kokoroVoice || "bm_daniel").replace("bm_", "").toUpperCase()} · LOCAL`],
      ["HANDS", st.config.hands?.enabled === false ? "STANDBY" : "TRACKING"],
      ["STATUS", "ALL SYSTEMS NOMINAL"],
    ];
    const timers = [];
    const at = (ms, fn) => timers.push(setTimeout(fn, ms));
    // the loading bar follows the sequence, naming each stage as it passes
    const fill = el.querySelector(".b-fill"), pct = el.querySelector(".b-pct"), what = el.querySelector(".b-what");
    const stages = ["INITIALIZING", "CORE", "NEURAL LINK", "FILE INDEX", "VOICE", "SENSORS", "ONLINE"];
    const t0 = performance.now();
    let barOn = true;
    const bar = () => {
      if (!barOn) return;
      const k = Math.min(1, (performance.now() - t0) / (BOOT_MS - 350));
      const shown = Math.min(100, Math.round((1 - Math.pow(1 - k, 1.6)) * 100)); // quick start, careful finish
      fill.style.width = shown + "%";
      pct.textContent = shown + "%";
      what.textContent = stages[Math.min(stages.length - 1, Math.floor(k * (stages.length - 1) + 0.0001))];
      requestAnimationFrame(bar);
    };
    bar();
    const name = "D.E.N.N.I.S.";
    for (let i = 0; i <= name.length; i++) at(120 + i * 55, () => { title.textContent = name.slice(0, i); });
    lines.forEach(([k, val], i) => at(700 + i * 300, () => {
      const row = document.createElement("div");
      row.innerHTML = `<span>${k.padEnd(7, " ")}</span><i>${"·".repeat(14)}</i><b></b>`;
      log.appendChild(row);
      let n = 0;
      const typer = setInterval(() => { n++; row.querySelector("b").textContent = val.slice(0, n); if (n >= val.length) clearInterval(typer); }, 18);
      timers.push(typer);
    }));
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      barOn = false;
      fill.style.width = "100%"; pct.textContent = "100%"; what.textContent = "ONLINE";
      timers.forEach((t) => { clearTimeout(t); clearInterval(t); });
      removeEventListener("pointerdown", finish, true);
      removeEventListener("keydown", finish, true);
      galaxy.skipBoot();
      document.body.classList.replace("booting", "booted");
      el.classList.add("done");
      setTimeout(() => { el.remove(); }, 900);
      resolve();
    };
    at(BOOT_MS - 300, finish);
    addEventListener("pointerdown", finish, true);
    addEventListener("keydown", finish, true);
  });
}

(async function boot() {
  setState("idle");
  updateInsets();
  try { setCam(localStorage.getItem("dennis.cam") || "stage"); } catch { setCam("stage"); }
  let st;
  try { st = await api.state(); }
  catch (e) { if (e instanceof LockedError) return lockUp(); toast(`Can't reach the D.E.N.N.I.S. server: ${e.message}`, true); return; }
  S.mock = st.mock; S.electron = st.electron;
  applyConfig(st.config);
  setCam(st.config.hands?.camView || "stage");
  setState("idle");
  updateIndexChip(st.index);
  api.events((ev) => {
    if (ev.type === "index") updateIndexChip(ev.status);
    else if (ev.type === "approval" && (ev.runId || ev.remote)) showApproval(ev); // a minion asking, or a request from your phone
    else if (ev.type === "approval_done" && ev.remote) closeApproval(ev.id);
    else if (ev.type === "remote") remoteMsg(ev);
    else if (ev.type === "ui" && ev.remote) handleUi(ev); // something he did from a phone conversation
    else if (ev.type === "reminder") reminderDue(ev.reminder, ev.missed);
    else if (ev.type === "watch") watchNotice(ev.notice);
    else if (ev.type === "approval_done" && ev.runId) closeApproval(ev.id);
    else { const back = caps.onEvent(ev); if (back) minionBack(back); }
  });
  const booted = PROBE ? Promise.resolve() : bootSequence(st);
  await home();
  const name = st.config.userName;
  const h = new Date().getHours();
  const tod = h < 5 ? "evening" : h < 12 ? "morning" : h < 18 ? "afternoon" : "evening";
  const who = name ? ", " + name : "";
  const openers = [
    `Good ${tod}${who}.`,
    `Good ${tod}${who}. D.E.N.N.I.S. at your service.`,
    `Good ${tod}${who}. All systems ready, and your files are precisely where you left them.`,
    h >= 23 || h < 5 ? `Working late${who}? Very well.` : `Good ${tod}${who}. Online, alert, and mildly curious.`,
    `Good ${tod}${who}. D.E.N.N.I.S. here: Digital Entity Neural Network Intelligent System. Your virtual production assistant, at your service.`,
    `Good ${tod}${who}. Digital Entity Neural Network Intelligent System, reporting for duty. D.E.N.N.I.S., to my friends.`,
  ];
  const now = new Date();
  const when = `It's ${now.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })} on ${now.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}.`;
  const JOKES = [
    "I told my computer I needed a break. It froze. Solidarity, I suppose.",
    "Your Downloads folder and I have an understanding. I don't judge it, and it doesn't organise itself.",
    "I once saw a file named final, final, actually final, version three. A tragedy in four acts.",
    "Why did the PDF see a therapist? Too many unresolved layers.",
    "I asked the cloud where your files were. It said: somewhere. Very reassuring.",
    "There are ten kinds of people. Those who understand binary, and those who don't.",
  ];
  const SMALL_TALK = [
    "How are you today, boss?",
    "Did you have your flat white already?",
    "Want me to catch you up with the latest in the NBA?",
    `Let's start this session with a joke. ${pick(JOKES)}`,
    "Say hi to everyone in the team for me. Hi, guys!",
    "Is the warden around?",
  ];
  const greet = `${pick(openers)} ${when} ${pick(SMALL_TALK)}`;
  S.greetPending = greet; // sent along with the first message, so "yes" to "want the NBA news?" makes sense
  addMsg("sys", st.mock ? "mock brain - no Claude calls" : `brain: ${brainLabel(st.config)}`);
  if (PROBE) { runProbe(); return; }
  await booted;
  if (!name || (!st.config.hasApiKey && !st.mock)) openSettings(true);
  else {
    caption(greet, 9000); voice.feed(greet + " "); voice.flush(); S.lastReply = greet;
    // the daily briefing, at the first start of the day (if asked for in Settings)
    const day = new Date().toDateString();
    let last = null; try { last = localStorage.getItem("dennis.briefed"); } catch { /* private mode */ }
    if (st.config.briefOnBoot && last !== day && !st.mock) {
      try { localStorage.setItem("dennis.briefed", day); } catch { /* fine */ }
      const wait = () => (voice.speaking || S.busy ? setTimeout(wait, 400) : ask("Give me my briefing for today.", { input: "briefing", silent: true }));
      setTimeout(wait, 1500);
    }
  }
  if (st.config.hands?.enabled !== false) startHands();
  if (st.config.voice?.continuous && !SIM && !PROBE) setTimeout(() => { setContinuous(true, { save: false, quiet: true }).then(() => { if (S.continuous) toast("Continuous conversation is on - just talk"); }); }, 1500);
  else if (st.config.voice?.wakeWord !== false && !SIM) setTimeout(startHandsFree, 1500);
  if (SIM) runSim();
  setTimeout(() => voice.preload(), 5000); // fetch the speech model in the background so the first talk is quick
})();
