// D.E.N.N.I.S. interface controller: navigation, panels, the conversation, and
// one input model fed by three sources (mouse, hands, voice).
import { api, LockedError } from "./api.js";
import { Galaxy, KIND_COLORS, KIND_NAMES, MAX_NODES, fmtBytes, escapeHtml } from "./galaxy.js";
import { Gestures, HandTracker, synthHand, handMetrics, dedupe, cameraRank } from "./hands.js";
import { Voice } from "./voice.js";
import { HandsFree, isStopPhrase, isRepeatPhrase } from "./handsfree.js";
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
  onStatus: (msg, err) => { if (err) toast(msg, true); else if (/download|loading|transcrib/.test(msg)) showProgress(msg); else if (/ready/.test(msg)) hideProgress(); else if (/system voice/.test(msg)) toast(msg); },
});

const instruments = new Hud({ voice });

// once a second: telemetry + the corner readouts
setInterval(() => {
  const st = $("#state-label").textContent;
  const v = voice.cfg;
  const engine = voice.engineNow();
  instruments.setTelemetry({
    state: st.toLowerCase(),
    brain: S.mock ? "mock" : `${S.config?.model || "?"} · ${S.config?.effort || "?"}`,
    voice: !v.speak ? "muted" : engine === "kokoro" ? `${(v.kokoroVoice || "bm_daniel").replace("bm_", "")} · local gpu` : engine === "elevenlabs" ? "elevenlabs" : "system",
    mic: voice.mic ? (voice.mic.label || "on").replace(/^Default - /, "").slice(0, 26) : S.hf === "off" ? "off" : "waking",
    hands: S.handsLive ? (tracker.cameraLabel || "on").slice(0, 26) : "off",
    index: $("#chip-index").textContent.replace(/^INDEX(ING)? /, "").toLowerCase() + " files",
    renderer: galaxy.backend,
  });
  const d = new Date(), p2 = (n) => String(n).padStart(2, "0");
  $("#ro-time").textContent = `${d.getHours() % 12 || 12}:${p2(d.getMinutes())}:${p2(d.getSeconds())} ${d.getHours() < 12 ? "AM" : "PM"}`;
  $("#ro-files").textContent = $("#chip-index").textContent.replace(/^INDEX(ING)? /, "");
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
    listening: convo ? "IN CONVERSATION" : "LISTENING", thinking: "THINKING", speaking: "SPEAKING",
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
  closePreview(true);
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
    const sel = S.selected?.path;
    show(level, null);
    if (sel) { const it = level.items.find((i) => i.path === sel); if (it) showPreview(it); }
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
  } else if (S.selected?.path === it.path) {
    closePreview();
  } else showPreview(it);
}

// ---------------------------------------------------------------- preview
const IMG = /\.(png|jpe?g|gif|webp|bmp|svg|avif|ico)$/i, VID = /\.(mp4|webm|mov|m4v|mkv)$/i, AUD = /\.(mp3|wav|flac|m4a|aac|ogg|opus)$/i;
// The file window floats in the 3D scene beside its card (galaxy.showWindow places it), so it
// only joins the page while a file is open.
const PV = $("#preview");
PV.remove();
async function showPreview(item) {
  const fresh = !PV.classList.contains("open");
  S.selected = item;
  galaxy.select(item.path);
  const p = PV;
  p.querySelector(".kdot").style.color = KIND_COLORS[item.kind] || KIND_COLORS.other;
  p.querySelector(".ptitle b").textContent = item.name;
  p.querySelector(".ptitle small").textContent = `${KIND_NAMES[item.kind] || item.kind} · ${fmtBytes(item.size)} · ${fmtDate(item.mtime)}`;
  p.querySelector("[data-act=open]").textContent = item.isDir ? "OPEN FOLDER" : "OPEN";
  const body = p.querySelector(".pbody");
  body.innerHTML = "";
  body.className = "pbody";
  const meta = `<div class="meta"><b>${escapeHtml(item.path)}</b><br>${fmtBytes(item.size)} · modified ${fmtDate(item.mtime)}</div>`;
  const src = api.raw(item.path);
  if (item.isDir) {
    body.innerHTML = meta + (item.kinds ? `<div class="kinds">${Object.entries(item.kinds).sort((a, b) => b[1] - a[1]).map(([k, n]) => `<span style="color:${KIND_COLORS[k]}">${KIND_NAMES[k] || k} ${n}</span>`).join("")}</div>` : "");
  } else if (IMG.test(item.name)) { body.classList.add("media"); body.innerHTML = `<div class="stage"><img src="${src}" alt=""></div>` + meta; }
  else if (VID.test(item.name)) { body.classList.add("media"); body.innerHTML = `<div class="stage"><video src="${src}" controls playsinline></video></div>` + meta; }
  else if (AUD.test(item.name)) body.innerHTML = meta + `<audio src="${src}" controls></audio>`;
  else if (/\.pdf$/i.test(item.name)) { body.classList.add("media"); body.innerHTML = `<div class="stage"><iframe src="${src}" title="PDF preview"></iframe></div>`; }
  else body.innerHTML = meta + `<div class="empty">reading...</div>`;
  if (fresh) setWindowMax(false);
  galaxy.showWindow(PV, item.path);
  p.classList.add("open");
  document.body.classList.add("preview-open");
  if (!item.isDir && !IMG.test(item.name) && !VID.test(item.name) && !AUD.test(item.name) && !/\.pdf$/i.test(item.name)) {
    try {
      const { text, truncated } = await api.text(item.path);
      if (S.selected !== item) return;
      body.innerHTML = text != null ? `<pre></pre>` : meta + `<div class="empty">NO PREVIEW FOR THIS KIND OF FILE<br><br>Ask D.E.N.N.I.S. about it, or open it.</div>`;
      if (text != null) body.querySelector("pre").textContent = text + (truncated ? "\n\n[... preview truncated]" : "");
    } catch (e) { body.innerHTML = meta + `<div class="empty">${escapeHtml(e.message)}</div>`; }
  }
}
function closePreview(silent) {
  S.selected = null;
  galaxy.select(null);
  const p = PV;
  p.classList.remove("open");
  setWindowMax(false);
  document.body.classList.remove("preview-open");
  galaxy.closeWindow(!!silent); // folds back into its card
  if (!silent) setTimeout(() => { if (!S.selected) p.querySelector(".pbody").innerHTML = ""; }, 420); // stops media playback
  else p.querySelector(".pbody").innerHTML = "";
}
/** Expand the file window to fill the screen, or shrink it back beside its card. */
function setWindowMax(on) {
  if (on && !galaxy.maximizeWindow(true)) return;
  if (!on) galaxy.maximizeWindow(false);
  PV.classList.toggle("max", on);
  PV.querySelector("[data-act=max]").title = on ? "Restore (F or Esc)" : "Full screen (F)";
}
const windowOpen = () => PV.classList.contains("open");
PV.querySelector(".phead").addEventListener("dblclick", (e) => { if (!e.target.closest("button")) setWindowMax(!galaxy.windowMaximized); });
galaxy.winRenderer.domElement.addEventListener("click", (e) => { if (e.target === galaxy.winRenderer.domElement) setWindowMax(false); }); // click outside an expanded window
PV.addEventListener("click", (e) => {
  const act = e.target.closest("[data-act]")?.dataset.act;
  const it = S.selected;
  if (!act) return;
  if (act === "close") return closePreview();
  if (act === "max") return setWindowMax(!galaxy.windowMaximized);
  if (!it) return;
  if (act === "ask") askAbout(it);
  if (act === "open") it.isDir ? openFolder(it.path) : api.open(it.path).then((r) => toast(r.revealed ? "That's a program - revealed it instead of running it" : `Opening ${it.name}`)).catch((er) => toast(er.message, true));
  if (act === "reveal") api.reveal(it.path).catch((er) => toast(er.message, true));
});
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
};
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
      const label = (TOOL_LABEL[ev.name] || (() => ev.name))(ev.input || toolLines.get(ev.id)?.input || {});
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
  if (S.compact && ["navigate", "present", "refresh", "home", "back"].includes(ev.action)) setCompact(false);
  switch (ev.action) {
    case "compact": setCompact(true); break;
    case "reboot": reboot(); break;
    case "navigate":
      openFolder(ev.path).then((level) => {
        if (level && ev.select) { const it = level.items.find((i) => i.path.toLowerCase() === ev.select.toLowerCase()); if (it) showPreview(it); }
      });
      break;
    case "present": present(ev.title, ev.paths); break;
    case "refresh": refresh(ev.path); break;
    case "home": home(); break;
    case "back": back(); break;
    case "close_preview": closePreview(); break;
    case "toggle_camera": cycleCam(); break;
    case "toggle_hands": toggleHands(); break;
    case "fullscreen": if (windowOpen()) setWindowMax(!galaxy.windowMaximized); else toggleFullscreen(); break;
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

async function ask(text, { input = "text", selected } = {}) {
  text = String(text || "").trim();
  if (!text) return;
  if (S.approvals.length) {
    const a = S.approvals[0];
    if (YES.test(text)) return answerApproval(a.id, true);
    if (NO.test(text)) return answerApproval(a.id, false);
  }
  if (isStopPhrase(text)) return hush();
  if (isRepeatPhrase(text)) return sayAgain();
  if (S.turn) await stopTurn();
  voice.stopSpeaking();
  addMsg("user", text);
  setBusy(true);
  setState("thinking");
  S.botEl = null; S.caption = ""; S.progressBuf = ""; S.replyBuf = "";
  caption("");
  const context = { view: describeView(), selected: selected || S.selected?.path || null, input, greeting: S.greetPending || undefined };
  S.greetPending = null;
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

function stopAll() {
  if (S.hf === "conversation") handsFree.endConversation("esc");
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
  voice.say(pick(SPOKEN_ASK[a.tool] || SPOKEN_ASK.default));
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
  onState: (st) => { S.hf = st; updateChips(); setState(restState()); },
  onWake: (cmd) => {
    flashHint("HEY DENNIS");
    if (cmd) { caption(`"${cmd}"`); ask(cmd, { input: "voice" }); return; }
    const a = pick(ACKS);
    S.acking = true;
    voice.say(a);
    caption(a, 2500);
  },
  onCommand: (text) => { caption(`"${text}"`); ask(text, { input: "voice" }); },
  onEnd: (reason) => {
    if (reason === "user") { const s = pick(SIGNOFFS); voice.say(s); caption(s, 3000); }
    else caption("Standing by. Say \u201cHey Dennis\u201d when you need me.", 4000);
    setState(restState());
  },
  onStop: () => hush(),
  onRepeat: () => sayAgain(),
  onHeard: (t) => caption(`"${t}"`, 1500),
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
  const on = S.hf === "off";
  if (on) startHandsFree(); else handsFree.stop();
  api.settings({ voice: { wakeWord: on } }).then(({ config }) => { S.config = config; }).catch(() => {});
};

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
$("#brand").onclick = async () => { await stopTurn(); await api.newChat(); $("#msgs").innerHTML = ""; addMsg("sys", "new conversation"); };
$("#log-new").onclick = () => $("#brand").click();
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
  pinchStart(i, p) {
    const dom = domTargetAt(p.x, p.y);
    if (dom) {
      S.grabs[i] = dom.matches(".pbody") || dom.closest(".pbody") ? { type: "scroll", el: dom.closest(".pbody") } : { type: "dom", el: dom };
      dom.classList.add("hand-press");
      return;
    }
    const t = galaxy.pick(p.x, p.y, 30);
    S.grabs[i] = { type: t === "core" ? "core" : t ? (t.item.isDir || t.item.more ? "dir" : "file") : "space", node: t, x0: p.x, y0: p.y, carry: false };
  },
  pinchMove(i, p, d) {
    const g = S.grabs[i];
    if (!g) return;
    if (g.type === "scroll") g.el.scrollTop -= d.y * 2.2;
    else if (g.type === "file") {
      if (!g.carry && Math.hypot(p.x - g.x0, p.y - g.y0) > 34) { g.carry = true; galaxy.beginCarry(g.node); }
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
  galaxy.setCameraFeed($("#cam"), mode, S.config?.hands?.mirror !== false); // "stage": drawn inside the 3D scene as a hologram
  updateChips();
}
const cycleCam = () => setCam(CAM_MODES[(CAM_MODES.indexOf(S.cam) + 1) % CAM_MODES.length]);
async function toggleFullscreen() {
  if (shell) { S.fullscreen = await shell.toggleFullscreen(); updateShellChips(); return; }
  if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen().catch(() => {});
}

// ---------------------------------------------------------------- desktop shell: compact orb, fullscreen, reboot
// window.dennisShell comes from the desktop app's preload; in a plain browser it's absent.
const shell = window.dennisShell || null;
const orbCh = new BroadcastChannel("dennis-orb"); // the compact orb mirrors his state and voice
orbCh.onmessage = (e) => { if (e.data?.hello) orbCh.postMessage({ state: galaxy.state, level: galaxy.level }); };
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
let rebootArmed = 0;
$("#chip-reboot").onclick = () => {
  if (performance.now() - rebootArmed < 3000) return reboot();
  rebootArmed = performance.now();
  $("#chip-reboot").classList.add("warn");
  toast("Tap again to reboot D.E.N.N.I.S.");
  setTimeout(() => $("#chip-reboot").classList.remove("warn"), 3000);
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

function drawHud(t) {
  hg.clearRect(0, 0, innerWidth, innerHeight);
  const accent = getComputedStyle(document.body).getPropertyValue("--accent").trim() || "#5ef2ff";
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
function updateChips() {
  const h = $("#chip-hands");
  h.textContent = S.handsLive ? "HANDS ON" : tracker.running ? "HANDS ..." : SIM ? "HANDS SIM" : "HANDS OFF";
  h.classList.toggle("off", !S.handsLive && !SIM);
  $("#chip-cam").textContent = "CAM " + S.cam.toUpperCase();
  $("#chip-cam").classList.toggle("off", S.cam === "off");
  const v = $("#chip-voice");
  v.textContent = voice.cfg.speak ? "VOICE ON" : "VOICE OFF";
  v.classList.toggle("off", !voice.cfg.speak);
  const w = $("#chip-wake");
  w.textContent = { off: "HEY DENNIS OFF", starting: "MIC ...", standby: "STANDBY", conversation: "IN CONVERSATION" }[S.hf || "off"];
  w.classList.toggle("off", !S.hf || S.hf === "off");
  w.classList.toggle("live", S.hf === "conversation");
}
function updateIndexChip(st) {
  const c = $("#chip-index");
  if (!st) return;
  if (st.state === "scanning") { c.textContent = `INDEXING ${st.scanned.toLocaleString()}`; c.classList.add("warn"); }
  else { c.textContent = `INDEX ${(st.total || 0).toLocaleString()}`; c.classList.remove("warn"); }
  if (st.state === "ready" && S.level?.mode === "root" && !S.indexRefreshed) { S.indexRefreshed = true; refresh(""); }
}
$("#chip-index").onclick = () => api.reindex().then(() => { S.indexRefreshed = false; toast("Rescanning your folders"); });
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
function openSettings(first = false) {
  const c = S.config;
  const f = $("#settings-form");
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
  f.model.value = c.model || "claude-opus-5-5";
  f.effort.value = c.effort || "low";
  f.permissionMode.value = c.permissionMode || "ask";
  f.webSearch.checked = !!c.webSearch;
  f.speak.checked = !!c.voice?.speak;
  f.engine.value = c.voice?.engine || "kokoro";
  f.kokoroVoice.value = c.voice?.kokoroVoice || "bm_daniel";
  f.elevenVoice.value = c.voice?.elevenVoice || "";
  f.elevenKey.value = "";
  $("#eleven-state").textContent = c.hasElevenKey ? "· SAVED" : "";
  f.sttModel.value = c.voice?.sttModel || "Xenova/whisper-base.en";
  voice.microphones().then((mics) => {
    f.micId.innerHTML = `<option value="">system default</option>` + mics.map((m, i) => `<option value="${escapeHtml(m.deviceId)}">${escapeHtml(m.label || `microphone ${i + 1}`)}</option>`).join("");
    f.micId.value = c.voice?.micId || "";
    if (f.micId.value !== (c.voice?.micId || "")) f.micId.value = "";
  });
  f.handsEnabled.checked = c.hands?.enabled !== false;
  f.mirrorCam.checked = c.hands?.mirror !== false;
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
$("#settings-cancel").onclick = () => $("#settings").classList.remove("show");
$("#open-memory").onclick = () => api.reveal((S.config.dataDir || "") + (S.config.dataDir?.includes("\\") ? "\\" : "/") + "memory.md").catch(() => toast("No memories saved yet"));
$("#settings-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  const patch = {
    userName: f.userName.value.trim(), address: f.address.value.trim(), personality: f.personality.value.trim(), model: f.model.value.trim() || "claude-opus-5-5",
    effort: f.effort.value, permissionMode: f.permissionMode.value, webSearch: f.webSearch.checked, showHidden: f.showHidden.checked,
    roots: draftRoots,
    voice: { speak: f.speak.checked, voiceName: f.voiceName.value, sttModel: f.sttModel.value, micId: f.micId.value, wakeWord: f.wakeWord.checked,
      engine: f.engine.value, kokoroVoice: f.kokoroVoice.value, elevenVoice: f.elevenVoice.value.trim() || "onwK4e9ZLuTAKqWW03F9" },
    hands: { enabled: f.handsEnabled.checked, palmToTalk: f.palmToTalk.checked, cameraId: f.cameraId.value, mirror: f.mirrorCam.checked },
  };
  if (f.apiKey.value.trim()) patch.apiKey = f.apiKey.value.trim();
  if (f.elevenKey.value.trim()) patch.elevenKey = f.elevenKey.value.trim();
  try {
    const rootsChanged = JSON.stringify(patch.roots) !== JSON.stringify(S.config.roots);
    const prevHands = { ...(S.config.hands || {}) };
    const { config } = await api.settings(patch);
    applyConfig(config);
    $("#settings").classList.remove("show");
    toast("Saved. New settings apply from the next message.");
    if (rootsChanged) { S.indexRefreshed = false; home(); }
    const camChanged = patch.hands.cameraId !== (prevHands.cameraId || "");
    if (patch.hands.enabled && (!tracker.running || camChanged)) restartHands();
    if (patch.voice.wakeWord && S.hf === "off") startHandsFree();
    if (!patch.voice.wakeWord && S.hf !== "off") handsFree.stop();
    if (!patch.hands.enabled && tracker.running) toggleHands();
  } catch (er) { toast(er.message, true); }
});

function applyConfig(c) {
  S.config = c;
  voice.configure({ speak: c.voice?.speak !== false, voiceName: c.voice?.voiceName || "", rate: c.voice?.rate || 0.96, pitch: c.voice?.pitch ?? 0.85, sttModel: c.voice?.sttModel || "Xenova/whisper-base.en", micId: c.voice?.micId || "",
    engine: c.voice?.engine || "kokoro", kokoroVoice: c.voice?.kokoroVoice || "bm_daniel", elevenOk: !!c.hasElevenKey });
  voice.elevenFailed = false;
  gestures.palmEnabled = c.hands?.palmToTalk !== false;
  gestures.mirror = c.hands?.mirror !== false;
  galaxy.setCameraFeed($("#cam"), S.cam, c.hands?.mirror !== false);
  document.body.classList.toggle("cam-unmirrored", c.hands?.mirror === false);
  updateChips();
}

function lockUp() { $("#locked").classList.add("show"); }

// ---------------------------------------------------------------- keyboard
addEventListener("keydown", (e) => {
  const typing = e.target.matches("input, textarea, select");
  const emptyAsk = e.target.id === "q" && !e.target.value;
  if (e.key === "Escape") {
    if ($("#settings").classList.contains("show")) return $("#settings").classList.remove("show");
    if (S.approvals.length) return answerApproval(S.approvals[0].id, false);
    if (galaxy.windowMaximized) return setWindowMax(false);
    if (S.selected) closePreview();
    stopAll();
    if (typing) e.target.blur();
    return;
  }
  if (e.code === "Space" && (!typing || emptyAsk)) { e.preventDefault(); if (!e.repeat) pressStart("space"); return; }
  if (typing) return;
  if (S.approvals.length && (e.key === "y" || e.key === "n")) return answerApproval(S.approvals[0].id, e.key === "y");
  if (e.key === "Backspace") { e.preventDefault(); back(); }
  else if (e.key === "Home") home();
  else if (e.key === "/" || e.key === "Enter") { e.preventDefault(); $("#q").focus(); }
  else if (e.key === "c") cycleCam();
  else if (e.key === "h") toggleHands();
  else if (e.key === "?") $("#legend").classList.toggle("show");
  else if (e.key === "m") setCompact(!S.compact);
  else if (e.key === "f") { if (windowOpen()) setWindowMax(!galaxy.windowMaximized); else toggleFullscreen(); }
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
    peace: () => log.push(["peace"]), fist: () => log.push(["fist"]), palm: (ph) => log.push(["palm", ph]),
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
  ok("fist held fires (and never pinches)", log.some((e) => e[0] === "fist") && !log.some((e) => e[0] === "ps"));
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
  compact: setCompact, reboot,
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
      ["BRAIN", st.mock ? "MOCK" : String(st.config.model || "claude").toUpperCase()],
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
  api.events((ev) => { if (ev.type === "index") updateIndexChip(ev.status); });
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
  addMsg("sys", st.mock ? "mock brain - no Claude calls" : `brain: ${st.config.model}`);
  if (PROBE) { runProbe(); return; }
  await booted;
  if (!name || (!st.config.hasApiKey && !st.mock)) openSettings(true);
  else { caption(greet, 9000); voice.feed(greet + " "); voice.flush(); S.lastReply = greet; }
  if (st.config.hands?.enabled !== false) startHands();
  if (st.config.voice?.wakeWord !== false && !SIM) setTimeout(startHandsFree, 1500);
  if (SIM) runSim();
  setTimeout(() => voice.preload(), 5000); // fetch the speech model in the background so the first talk is quick
})();
