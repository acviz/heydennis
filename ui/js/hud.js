// The HUD around the galaxy: a digital clock, and four small minimal instruments fed
// by real data - what the current folder is made of, how much changed in the last 30
// days, a live audio waveform (your voice or his), and a telemetry readout.
import { KIND_COLORS, KIND_NAMES } from "./galaxy.js";

const $ = (s) => document.querySelector(s);
const DPR = () => Math.min(devicePixelRatio || 1, 2);

function fitCanvas(c) {
  const r = c.getBoundingClientRect();
  const w = Math.max(1, Math.round(r.width * DPR())), h = Math.max(1, Math.round(r.height * DPR()));
  if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
  const g = c.getContext("2d");
  g.setTransform(DPR(), 0, 0, DPR(), 0, 0);
  return { g, w: r.width, h: r.height };
}

export class Hud {
  constructor({ voice }) {
    this.voice = voice;
    this.kinds = [];
    this.activity = null;
    this.telemetry = {};
    this.wave = new Float32Array(256);
    this.fps = 60;
    this.frames = 0;
    this.lastFps = performance.now();
    this.tickClock();
    setInterval(() => this.tickClock(), 1000);
  }

  tickClock() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    const h12 = d.getHours() % 12 || 12, ampm = d.getHours() < 12 ? "AM" : "PM";
    $("#clock-time").innerHTML = `${h12}<i>:</i>${p(d.getMinutes())}<small>${p(d.getSeconds())}</small><em>${ampm}</em>`;
    $("#clock-date").textContent = d.toLocaleDateString(undefined, { weekday: "short", day: "2-digit", month: "short", year: "numeric" }).toUpperCase();
  }

  /** Kind composition of what's on screen: files directly here plus everything inside subfolders. */
  setLevel(level) {
    if (!$("#w-types")) return; // panel removed from the layout
    const tally = {};
    for (const it of level?.items || []) {
      if (it.more) continue;
      if (it.isDir) { for (const [k, n] of Object.entries(it.kinds || {})) tally[k] = (tally[k] || 0) + n; }
      else tally[it.kind] = (tally[it.kind] || 0) + 1;
    }
    this.kinds = Object.entries(tally).sort((a, b) => b[1] - a[1]).slice(0, 6);
    $("#w-types small").textContent = level?.mode === "present" ? "RESULTS" : level?.mode === "root" ? "ALL" : "HERE";
    this.drawTypes();
  }

  setActivity(a) { this.activity = a; this.drawActivity(); }
  setTelemetry(t) { Object.assign(this.telemetry, t); }

  drawTypes() {
    const c = $("#w-types canvas");
    const { g, w, h } = fitCanvas(c);
    g.clearRect(0, 0, w, h);
    const total = this.kinds.reduce((a, [, n]) => a + n, 0) || 1;
    const row = h / 6;
    this.kinds.forEach(([k, n], i) => {
      const y = i * row + row * 0.25, bw = Math.max(2, (w - 96) * (n / this.kinds[0][1]));
      g.fillStyle = "rgba(125,170,200,0.10)";
      g.fillRect(70, y, w - 96, row * 0.5);
      g.fillStyle = KIND_COLORS[k] || KIND_COLORS.other;
      g.globalAlpha = 0.85;
      g.fillRect(70, y, bw, row * 0.5);
      g.globalAlpha = 1;
      g.font = "10px Consolas, monospace";
      g.fillStyle = "rgba(185,205,218,0.85)";
      g.textBaseline = "middle";
      g.fillText((KIND_NAMES[k] || k).toUpperCase().slice(0, 9), 0, y + row * 0.25);
      g.fillStyle = "rgba(225,235,242,0.9)";
      g.textAlign = "right";
      g.fillText(`${Math.round((n / total) * 100)}%`, w, y + row * 0.25);
      g.textAlign = "left";
    });
    if (!this.kinds.length) { g.font = "10px Consolas, monospace"; g.fillStyle = "rgba(125,147,160,0.8)"; g.fillText("NO FILES", 0, 12); }
  }

  drawActivity() {
    const a = this.activity;
    $("#w-activity .big").textContent = a ? a.week.toLocaleString() : "--";
    const c = $("#w-activity canvas");
    const { g, w, h } = fitCanvas(c);
    g.clearRect(0, 0, w, h);
    // grid
    g.strokeStyle = "rgba(111,179,217,0.08)";
    g.lineWidth = 1;
    for (let i = 1; i < 4; i++) { const y = (h * i) / 4; g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke(); }
    if (!a) return;
    const max = Math.max(1, ...a.days);
    const pts = a.days.map((v, i) => [(i / (a.days.length - 1)) * w, h - 4 - (v / max) * (h - 10)]);
    const grad = g.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, "rgba(111,179,217,0.28)");
    grad.addColorStop(1, "rgba(111,179,217,0)");
    g.beginPath();
    g.moveTo(0, h);
    for (const [x, y] of pts) g.lineTo(x, y);
    g.lineTo(w, h);
    g.closePath();
    g.fillStyle = grad;
    g.fill();
    g.beginPath();
    pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
    g.strokeStyle = "rgba(190,220,236,0.9)";
    g.lineWidth = 1.2;
    g.stroke();
    // today, in amber
    const [lx, ly] = pts[pts.length - 1];
    g.fillStyle = "#e9a13b";
    g.fillRect(lx - 3, ly - 3, 6, 6);
  }

  /** Called every animation frame. */
  frame(t) {
    this.frames++;
    if (t - this.lastFps > 1000) { this.fps = Math.round((this.frames * 1000) / (t - this.lastFps)); this.frames = 0; this.lastFps = t; this.drawTelemetry(); }
    this.drawWave(t);
  }

  drawWave(t) {
    const c = $("#w-wave canvas");
    const { g, w, h } = fitCanvas(c);
    g.clearRect(0, 0, w, h);
    const v = this.voice;
    let src = null;
    if (v.speaking && v.outAn) { v.outAn.getFloatTimeDomainData(v.outBuf); src = v.outBuf; }
    else if (v.mic?.an) { v.mic.an.getFloatTimeDomainData(v.mic.buf); src = v.mic.buf; }
    g.strokeStyle = "rgba(111,179,217,0.12)";
    g.beginPath(); g.moveTo(0, h / 2); g.lineTo(w, h / 2); g.stroke();
    g.beginPath();
    const n = 160;
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * w;
      let s = src ? src[Math.floor((i / n) * src.length)] * 2.2 : Math.sin(i * 0.25 + t / 400) * 0.015;
      s *= Math.sin((i / (n - 1)) * Math.PI); // taper at both ends
      const y = h / 2 - Math.max(-1, Math.min(1, s)) * (h / 2 - 2);
      i ? g.lineTo(x, y) : g.moveTo(x, y);
    }
    g.strokeStyle = v.speaking ? "rgba(225,238,246,0.95)" : "rgba(140,195,225,0.85)";
    g.lineWidth = 1.2;
    g.stroke();
    $("#w-wave small").textContent = v.speaking ? "OUT" : v.mic ? "MIC" : "IDLE";
  }

  drawTelemetry() {
    if (!$("#w-telemetry")) return; // panel removed from the layout
    const t = { ...this.telemetry, fps: this.fps };
    const rows = [
      ["core", t.state], ["brain", t.brain], ["voice", t.voice], ["mic", t.mic], ["hands", t.hands], ["index", t.index], ["render", `${t.renderer || "?"} · ${t.fps} fps`],
    ];
    const el = $("#w-telemetry pre");
    const html = rows.map(([k, v]) => `<span>${k.padEnd(6)}</span> ${escape(String(v ?? "--"))}`).join("\n");
    if (el.innerHTML !== html) el.innerHTML = html;
  }
}

function escape(s) {
  return s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
}
