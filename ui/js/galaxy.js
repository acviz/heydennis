// The file galaxy, rendered with WebGPU (three.js falls back to WebGL 2 by itself).
//
//   - D.E.N.N.I.S.'s core: a digital particle sphere (dotted streams wrapping its
//     surface, a glowing network inside) that swells and ripples as he speaks and
//     draws in as he listens, framed by a holographic arc-reactor HUD
//   - subfolders orbit it and files trail out on spiral arms (one arm per kind, newest
//     nearest the core), each as a floating hologram document window - with a real
//     thumbnail for images and the opening lines for text; in big folders files
//     shrink to compact tiles so the scene stays readable
//   - a blueprint grid behind everything, with the webcam feed shown through it as
//     a dim hologram in "stage" mode; bloom makes the light bleed like a projection
// Picking is done in screen space with generous radii so a jittery fingertip can
// still land on a small star.
import * as THREE from "/vendor/three/three.webgpu.js";
import {
  uniform, sin, cos, vec2, vec3, float, mix, smoothstep, fract, abs, pow, dot, length, uv, screenUV, screenSize,
  texture, normalView, positionViewDirection, instancedBufferAttribute, pass, max, min, select, positionLocal,
} from "/vendor/three/three.tsl.js";
import { bloom } from "/vendor/three/addons/tsl/display/BloomNode.js";
import { CSS2DRenderer, CSS2DObject } from "/vendor/three/addons/renderers/CSS2DRenderer.js";
import { CSS3DRenderer, CSS3DObject } from "/vendor/three/addons/renderers/CSS3DRenderer.js";
import { drawCard, drawTile, CARD_W, CARD_H } from "./cards.js";

export const KIND_COLORS = {
  folder: "#5f9fc6", image: "#b9809f", video: "#b87079", audio: "#c39663", document: "#c3d0d8", sheet: "#74a98c",
  slides: "#c2ab6a", code: "#8d88bd", data: "#6f9ebd", archive: "#a48f72", design: "#bf8c6a", model3d: "#72aea6",
  font: "#a3a3a3", app: "#b86b6b", other: "#7d929f",
};
export const KIND_NAMES = {
  folder: "folders", image: "images", video: "video", audio: "audio", document: "documents", sheet: "spreadsheets",
  slides: "slides", code: "code", data: "data", archive: "archives", design: "design", model3d: "3D", font: "fonts",
  app: "apps", other: "other",
};
// [deep, hot]: the sphere blends from the deep colour to the hot one with brightness and voice level
const STATE_COLORS = {
  idle: ["#1b4a6e", "#a7cfe6"], listening: ["#1d5e4b", "#bde8d4"], thinking: ["#7a5222", "#efcb92"], speaking: ["#24618e", "#e3f1fa"],
};
const FRAME_COLOR = { idle: "#4f8fb5", listening: "#5aa88a", thinking: "#c0904f", speaking: "#7fb4d6" };
const ACCENT = "#e9a13b"; // the sparse amber highlights
export const MAX_NODES = 360;
const CORE_R = 64;
const SPHERE_Y = 34; // the sphere floats above the ring dais

function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function rng(seed) {
  let a = seed || 1;
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

function radialTexture(stops, size = 128) {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const g = c.getContext("2d");
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  for (const [o, col] of stops) grad.addColorStop(o, col);
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
function ringTexture(size = 128) {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const g = c.getContext("2d");
  g.strokeStyle = "rgba(255,255,255,.95)";
  g.lineWidth = size * 0.035;
  g.beginPath(); g.arc(size / 2, size / 2, size * 0.42, 0, Math.PI * 2); g.stroke();
  g.lineWidth = size * 0.015;
  for (let i = 0; i < 4; i++) { g.beginPath(); g.arc(size / 2, size / 2, size * 0.48, i * Math.PI / 2 + 0.2, i * Math.PI / 2 + 1.1); g.stroke(); }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

const easeOut = (t) => 1 - Math.pow(1 - t, 3);
const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const _wv = new THREE.Vector3(), _wd = new THREE.Vector3();

// ---------- hologram materials ----------
// drifting horizontal scanlines, shared by every hologram surface
const SCAN = sin(screenUV.y.mul(screenSize.y).mul(0.75)).mul(0.14).add(0.86);

/** Additive hologram surface. `rim` brightens edges (fresnel) like a projected shell. */
function holoMat(hex, opacity, { rim = false, wireframe = false } = {}) {
  const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, wireframe });
  const c = uniform(new THREE.Color(hex)), o = uniform(opacity);
  m.colorNode = c.mul(SCAN);
  m.opacityNode = rim ? o.mul(pow(float(1).sub(abs(dot(normalView, positionViewDirection))), 1.7).mul(1.5).add(0.06)) : o;
  m.userData = { c, o };
  return m;
}
function lineMat(hex, opacity) {
  const m = new THREE.LineBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  const c = uniform(new THREE.Color(hex)), o = uniform(opacity);
  m.colorNode = c.mul(SCAN);
  m.opacityNode = o;
  m.userData = { c, o };
  return m;
}

/** A hologram window: the card texture, scanlined, additive; `hot` brightens it on hover. */
function cardMat(tex) {
  const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
  const hot = uniform(0), fade = uniform(1);
  const t = texture(tex);
  m.colorNode = t.rgb.mul(SCAN).mul(hot.mul(0.6).add(0.82));
  m.opacityNode = t.a.mul(fade);
  m.userData = { hot, fade };
  return m;
}
const CARD_ASPECT = CARD_H / CARD_W;
const IMG_RE = /\.(png|jpe?g|gif|webp|bmp|avif)$/i;
const TEXT_RE = /\.(txt|md|markdown|log|csv|tsv|json|xml|ya?ml|toml|ini|js|mjs|cjs|ts|tsx|jsx|py|rb|go|rs|java|c|cc|cpp|h|cs|php|swift|sh|ps1|bat|sql|html?|css|scss|docx|pptx|xlsx)$/i;
const fmtDay = (ms) => (ms ? new Date(ms).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "");

// ---------- reactor geometry helpers (in the XY plane; the HUD faces the camera) ----------
function sectorFill(sectors, steps = 6) {
  const pos = [], idx = [];
  for (const [r1, r2, a0, a1] of sectors) {
    const base = pos.length / 3;
    for (let i = 0; i <= steps; i++) {
      const a = a0 + ((a1 - a0) * i) / steps;
      pos.push(Math.cos(a) * r1, Math.sin(a) * r1, 0, Math.cos(a) * r2, Math.sin(a) * r2, 0);
    }
    for (let i = 0; i < steps; i++) { const k = base + i * 2; idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  return g;
}
function sectorOutline(sectors, steps = 6) {
  const pts = [];
  const P = (r, a) => [Math.cos(a) * r, Math.sin(a) * r, 0];
  for (const [r1, r2, a0, a1] of sectors) {
    for (const r of [r1, r2]) for (let i = 0; i < steps; i++) pts.push(...P(r, a0 + ((a1 - a0) * i) / steps), ...P(r, a0 + ((a1 - a0) * (i + 1)) / steps));
    pts.push(...P(r1, a0), ...P(r2, a0), ...P(r1, a1), ...P(r2, a1));
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
  return g;
}
function circlePts(r, segs = 180, keep = () => true) {
  const pts = [];
  for (let i = 0; i < segs; i++) {
    if (!keep(i)) continue;
    const a = (i / segs) * Math.PI * 2, b = ((i + 1) / segs) * Math.PI * 2;
    pts.push(Math.cos(a) * r, Math.sin(a) * r, 0, Math.cos(b) * r, Math.sin(b) * r, 0);
  }
  return pts;
}
function lines(pts, mat) {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
  return new THREE.LineSegments(g, mat);
}

export class Galaxy {
  constructor(el) {
    this.el = el;
    this.renderer = new THREE.WebGPURenderer({ antialias: true, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 1.75));
    el.appendChild(this.renderer.domElement);
    this.labelRenderer = new CSS2DRenderer();
    this.labelRenderer.domElement.className = "labels";
    el.appendChild(this.labelRenderer.domElement);
    // floating file windows: real DOM (video, text, buttons) placed in the 3D scene. A layer of
    // its own above the canvas, so it can rise over the HUD when a window goes full screen.
    this.winRenderer = new CSS3DRenderer();
    this.winRenderer.domElement.id = "windows";
    document.body.appendChild(this.winRenderer.domElement);
    this.winScene = new THREE.Scene();
    this.win = null;
    this.insetL = 0; this.insetR = 0;

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.FogExp2(0x000000, 0.0007);
    this.camera = new THREE.PerspectiveCamera(55, 1, 1, 9000);
    this.orbit = { theta: 0.7, phi: 1.08, radius: 900, goalRadius: 560, target: new THREE.Vector3(), goalTarget: new THREE.Vector3(), vTheta: 0, vPhi: 0 };

    this.tex = {
      glow: radialTexture([[0, "rgba(255,255,255,1)"], [0.12, "rgba(255,255,255,.9)"], [0.3, "rgba(255,255,255,.28)"], [0.6, "rgba(255,255,255,.05)"], [1, "rgba(255,255,255,0)"]]),
      soft: radialTexture([[0, "rgba(255,255,255,.5)"], [0.4, "rgba(255,255,255,.12)"], [1, "rgba(255,255,255,0)"]]),
      ring: ringTexture(),
    };
    // shader inputs driven from JavaScript every frame
    this.u = {
      level: uniform(0), // voice level, smoothed (his speech or your voice)
      pull: uniform(0), // 1 while listening: the sphere draws in
      t: uniform(0), // particle flow clock (runs faster while thinking)
      deep: uniform(new THREE.Color(STATE_COLORS.idle[0])),
      hot: uniform(new THREE.Color(STATE_COLORS.idle[1])),
      cam: uniform(0), // camera feed visibility in the background
      mirror: uniform(1),
      sAspect: uniform(1),
      vAspect: uniform(16 / 9),
      assemble: uniform(1), // 0 -> 1 during boot: particles fly in and form the sphere
      gridFade: uniform(1), // 0 -> 1 during boot
    };
    this.nodes = [];
    this.armLabels = [];
    this.hovered = null;
    this.selected = null;
    this.carried = null;
    this.state = "idle";
    this.level = 0;
    this.smoothLevel = 0;
    this.autoRotate = true;
    this.lastInput = performance.now();
    this.t = 0;
    this.shift = 0; this.goalShift = 0;
    this.camGoal = 0;
    this.tiles = new Map(); // kind -> shared tile texture
    this.loads = []; // thumbnail / preview jobs for the current level
    this.loading = 0;

    this.buildBackground();
    this.buildBackdrop();
    this.buildCore();
    this.links = new THREE.LineSegments(new THREE.BufferGeometry(), lineMat("#4f8fb5", 0.12));
    this.scene.add(this.links);
    this.selRing = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.tex.ring, color: 0xffffff, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
    this.selRing.visible = false;
    this.scene.add(this.selRing);
    this.hoverLabel = this.makeLabel("", "nlabel hot");
    this.hoverLabel.visible = false;
    this.scene.add(this.hoverLabel);

    this.resize();
    addEventListener("resize", () => this.resize());
    this.ready = this.renderer.init().then(() => {
      this.backend = this.renderer.backend?.isWebGPUBackend ? "WebGPU" : "WebGL 2";
      const scenePass = pass(this.scene, this.camera);
      const color = scenePass.getTextureNode("output");
      this.bloom = bloom(color, 0.55, 0.4, 0.32);
      const Pipeline = THREE.RenderPipeline || THREE.PostProcessing;
      this.post = new Pipeline(this.renderer);
      this.post.outputNode = color.add(this.bloom);
      this.initialized = true;
    }).catch((e) => { console.error("[galaxy] renderer failed", e); this.failed = e; });
  }

  resize() {
    const w = innerWidth, h = innerHeight;
    this.w = w; this.h = h;
    this.renderer.setSize(w, h);
    this.labelRenderer.setSize(w, h);
    this.winRenderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.u.sAspect.value = w / h;
    this.applyShift();
  }

  /** Side panels cover part of the screen: centre the galaxy in the space that's left. */
  setInsets(left, right) { this.goalShift = (right - left) / 2; this.insetL = left; this.insetR = right; }
  applyShift() {
    if (Math.abs(this.shift) < 0.5) this.camera.clearViewOffset();
    else this.camera.setViewOffset(this.w, this.h, this.shift, 0, this.w, this.h);
    this.camera.updateProjectionMatrix();
  }

  // ---------- background: blueprint grid + the camera feed as a dim hologram ----------
  buildBackground() {
    const u = this.u;
    const px = screenUV.mul(screenSize);
    const gridLine = (cell, w) => {
      const g = fract(px.div(cell));
      const d = min(min(g.x, g.x.oneMinus()), min(g.y, g.y.oneMinus())).mul(cell);
      return float(1).sub(smoothstep(0, w, d));
    };
    const grid = gridLine(46, 1.0).mul(0.013).add(gridLine(46 * 5, 1.2).mul(0.022));
    const vignette = smoothstep(1.2, 0.2, length(screenUV.sub(0.5).mul(vec2(1.5, 1.0))));
    const base = mix(vec3(0, 0, 0), vec3(0.0003, 0.0005, 0.0008), vignette); // linear light: black, the faintest lift at the centre
    // cover-fit the video, mirrored like a selfie view
    const k = u.sAspect.div(u.vAspect);
    const vx0 = select(k.greaterThan(1), screenUV.x, screenUV.x.sub(0.5).mul(k).add(0.5));
    const vy = select(k.greaterThan(1), screenUV.y.sub(0.5).div(k).add(0.5), screenUV.y);
    const vx = mix(vx0, vx0.oneMinus(), u.mirror);
    this.blank = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
    this.blank.needsUpdate = true;
    this.vidNode = texture(this.blank, vec2(vx, vy));
    const vid = this.vidNode.rgb;
    const lum = dot(vid, vec3(0.3, 0.59, 0.11));
    // crush the blacks so the room behind you stays dark and only you show through
    const holoVid = mix(vid, vec3(0.55, 0.8, 1.0).mul(lum), 0.6).mul(pow(lum, 1.4).mul(0.32)).mul(SCAN);
    this.scene.backgroundNode = base.add(vec3(0.4, 0.62, 0.8).mul(grid).mul(u.gridFade)).mul(vignette.mul(0.6).add(0.4)).add(holoVid.mul(u.cam));
  }

  /** Show the webcam inside the scene ("stage"), or not ("pip" / "off" use the DOM video). */
  setCameraFeed(video, mode, mirror = true) {
    if (video && !this.videoTex) {
      this.videoTex = new THREE.VideoTexture(video);
      this.videoTex.colorSpace = THREE.SRGBColorSpace;
      this.vidNode.value = this.videoTex;
      this.video = video;
    }
    this.camGoal = mode === "stage" ? 1 : 0;
    this.u.mirror.value = mirror ? 1 : 0;
  }

  // ---------- scenery ----------
  buildBackdrop() {
    const n = 2400, pos = new Float32Array(n * 3), col = new Float32Array(n * 3);
    const r = rng(7), c = new THREE.Color();
    for (let i = 0; i < n; i++) {
      const uu = r() * 2 - 1, th = r() * Math.PI * 2, rad = 1800 + r() * 2600, s = Math.sqrt(1 - uu * uu);
      pos.set([Math.cos(th) * s * rad, uu * rad * 0.7, Math.sin(th) * s * rad], i * 3);
      c.set(r() < 0.8 ? "#8fb6cc" : "#ffffff").multiplyScalar(0.18 + r() * 0.4);
      col.set([c.r, c.g, c.b], i * 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setAttribute("color", new THREE.BufferAttribute(col, 3));
    this.stars = new THREE.Points(g, new THREE.PointsMaterial({ vertexColors: true, transparent: true, opacity: 0.8, depthWrite: false, fog: false }));
    this.scene.add(this.stars);

    // holographic floor: concentric rings + spokes
    const pts = [];
    for (const rad of [160, 300, 480, 720, 1020]) {
      for (let i = 0; i < 128; i++) {
        const a = (i / 128) * Math.PI * 2, b = ((i + 1) / 128) * Math.PI * 2;
        pts.push(Math.cos(a) * rad, 0, Math.sin(a) * rad, Math.cos(b) * rad, 0, Math.sin(b) * rad);
      }
    }
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * Math.PI * 2;
      pts.push(Math.cos(a) * 120, 0, Math.sin(a) * 120, Math.cos(a) * 1020, 0, Math.sin(a) * 1020);
    }
    this.floor = lines(pts, lineMat("#4f8fb5", 0.045));
    this.floor.position.y = -80;
    this.scene.add(this.floor);
  }

  // ---------- the core: a particle sphere floating over a holographic ring dais ----------
  buildCore() {
    const g = new THREE.Group();
    this.scene.add(g);
    const sphere = this.buildSphere(CORE_R);
    sphere.group.position.y = SPHERE_Y;
    g.add(sphere.group);

    const frameMats = [];
    const fm = (o) => { const m = lineMat(FRAME_COLOR.idle, o); frameMats.push(m); return m; };
    const hm = (o) => { const m = holoMat(FRAME_COLOR.idle, o); frameMats.push(m); return m; };
    const amber = lineMat(ACCENT, 0.9), white = lineMat("#e6eef3", 0.8);
    // a ring lies flat (XZ) at height y and spins about the vertical axis on its own
    const layer = (y, speed, ...objs) => {
      const grp = new THREE.Group();
      grp.rotation.x = -Math.PI / 2;
      grp.position.y = y;
      grp.add(...objs);
      grp.userData.speed = speed;
      g.add(grp);
      return grp;
    };
    const r = rng(11);
    const arcs = (rad, n, len, jitter = 0) => {
      const pts = [];
      for (let i = 0; i < n; i++) {
        const a0 = (i / n) * Math.PI * 2 + (jitter ? r() * jitter : 0);
        for (let k = 0; k < 8; k++) { const a = a0 + (len * k) / 8, b = a0 + (len * (k + 1)) / 8; pts.push(Math.cos(a) * rad, Math.sin(a) * rad, 0, Math.cos(b) * rad, Math.sin(b) * rad, 0); }
      }
      return pts;
    };
    const ticks = (r1, r2, n, every = 0, r3 = r2) => {
      const pts = [];
      for (let i = 0; i < n; i++) { const a = (i / n) * Math.PI * 2, rr = every && i % every === 0 ? r3 : r2; pts.push(Math.cos(a) * r1, Math.sin(a) * r1, 0, Math.cos(a) * rr, Math.sin(a) * rr, 0); }
      return pts;
    };
    // centre: a grid disc under the sphere
    const grid = [], GR = 36;
    for (let v = -GR; v <= GR; v += 6) {
      const h = Math.sqrt(Math.max(0, GR * GR - v * v));
      grid.push(-h, v, 0, h, v, 0, v, -h, 0, v, h, 0);
    }
    const bands = (r1, r2, n, len, o) => {
      const sec = [];
      for (let i = 0; i < n; i++) { const a = (i / n) * Math.PI * 2; sec.push([r1, r2, a, a + len]); }
      return [new THREE.Mesh(sectorFill(sec, 16), hm(o)), new THREE.LineSegments(sectorOutline(sec, 16), fm(o * 6))];
    };
    const rings = [
      layer(-30, 0, lines(grid.concat(circlePts(GR + 0.5, 120)), fm(0.3))),
      layer(-26, -0.05, lines(circlePts(48).concat(ticks(48, 51, 120, 10, 55)), fm(0.55))),
      layer(-34, 0.035, lines(circlePts(60, 200, (i) => i % 3 !== 0), fm(0.35)), lines(arcs(60.5, 3, 0.18, 6.28), amber)),
      layer(-38, 0.06, ...bands(70, 80, 8, 0.55, 0.06)),
      layer(-28, -0.025, lines(circlePts(90).concat(ticks(90, 96, 4)), fm(0.4)), lines(ticks(89, 99, 12, 3, 104), white)),
      layer(-42, 0.018, ...bands(102, 114, 3, 1.6, 0.035)),
      layer(-33, -0.04, lines(circlePts(122, 240, (i) => i % 2 === 0), fm(0.3)), lines(arcs(122, 6, 0.07, 1.5), amber)),
      layer(-46, 0.012, lines(circlePts(138).concat(ticks(138, 143, 72, 6, 149)), fm(0.28))),
    ];
    // drop target shown while carrying a file to the core
    const dropMat = lineMat("#e6eef3", 0);
    const drop = layer(-24, 0.4, lines(circlePts(CORE_R + 26, 180, (i) => i % 4 !== 3), dropMat));

    // two thin gyroscope rings around the sphere
    const gyros = [0, 1].map((i) => {
      const m = holoMat(FRAME_COLOR.idle, 0.2, { rim: true });
      frameMats.push(m);
      const t = new THREE.Mesh(new THREE.TorusGeometry(CORE_R + 8 + i * 4, 0.35, 8, 200), m);
      t.rotation.set(1.2 + i * 0.7, i * 0.9, 0);
      t.position.y = SPHERE_Y;
      g.add(t);
      return t;
    });

    const shockMat = lineMat("#9cc7e0", 0);
    const shock = layer(-30, 0, lines(circlePts(1, 160), shockMat));
    shock.visible = false;

    this.core = { group: g, rings, drop, dropMat, gyros, frameMats, sphere, shock, shockMat, shockT0: -1e9, center: new THREE.Vector3(0, SPHERE_Y, 0), frameColor: new THREE.Color(FRAME_COLOR.idle), pulse: 0 };
  }

  /** The power-up: grid fades in, rings deploy one by one, particles fly in to form the sphere, the camera swoops down. */
  boot(ms = 3200) {
    this.bootT0 = performance.now();
    this.bootMs = ms;
    this.u.assemble.value = 0;
    this.u.gridFade.value = 0;
    this.orbit.radius = 2600;
    this.orbit.phi = 0.32;
    this.orbit.theta -= 1.2;
    for (const r of this.core.rings) r.scale.setScalar(0.001);
    for (const gy of this.core.gyros) gy.scale.setScalar(0.001);
  }
  skipBoot() { if (this.bootT0) this.bootT0 = performance.now() - this.bootMs; }
  get booting() { return !!this.bootT0 && performance.now() - this.bootT0 < this.bootMs; }

  /** The digital sphere: dotted streams over the surface, dust inside, and a glowing network. */
  buildSphere(R) {
    const u = this.u;
    const group = new THREE.Group();
    const r = rng(42);
    const randDir = () => { const z = r() * 2 - 1, a = r() * Math.PI * 2, s = Math.sqrt(1 - z * z); return new THREE.Vector3(Math.cos(a) * s, Math.sin(a) * s, z); };

    // particles: each moves on a circle  pos = U cos(phase + t*speed) + V sin(...)
    //   streams: great circles (U, V an orthonormal pair)   dust: V = 0, speed = 0 (static)
    // four populations share one shader:  pos = (U cos(phase + t*speed) + V sin(...)) * radius
    //   streams  dotted great-circle arcs flowing over the surface
    //   dust     specks inside the sphere (V = 0, speed = 0)
    //   disc     a tilted ring of particles orbiting outside the sphere, faster near it
    //   sparks   specks that stream off the surface and fade, again and again (emit = 1)
    const STREAMS = 96, PER = 210, DUST = 5200, DISC = 4200, SPARKS = 2400;
    const SZ = R / 40; // particle size scales with the sphere
    const N = STREAMS * PER + DUST + DISC + SPARKS;
    const U = new Float32Array(N * 3), V = new Float32Array(N * 3), ph = new Float32Array(N), sp = new Float32Array(N), rad = new Float32Array(N), br = new Float32Array(N), sz = new Float32Array(N), em = new Float32Array(N), cy = new Float32Array(N);
    let k = 0;
    const basis = (n) => {
      const a = Math.abs(n.x) > 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
      const e1 = a.clone().cross(n).normalize();
      return [e1, n.clone().cross(e1).normalize()];
    };
    for (let s2 = 0; s2 < STREAMS; s2++) {
      const [e1, e2] = basis(randDir());
      const speed = (0.18 + r() * 0.42) * (r() < 0.5 ? -1 : 1);
      const radius = 0.96 + r() * 0.08;
      const gap = r() * Math.PI * 2, gapLen = 0.8 + r() * 1.8; // streams are broken arcs, not full rings
      for (let i = 0; i < PER; i++, k++) {
        const ang = (i / PER) * (Math.PI * 2 - gapLen) + gap + (r() - 0.5) * 0.02;
        U.set([e1.x, e1.y, e1.z], k * 3); V.set([e2.x, e2.y, e2.z], k * 3);
        ph[k] = ang; sp[k] = speed; rad[k] = radius + (r() - 0.5) * 0.015;
        br[k] = r() < 0.12 ? 1 : 0.35 + r() * 0.4;
        sz[k] = (0.9 + r() * 1.1) * SZ;
      }
    }
    for (let i = 0; i < DUST; i++, k++) {
      const d = randDir(), l = 0.25 + Math.pow(r(), 0.5) * 0.75;
      U.set([d.x * l, d.y * l, d.z * l], k * 3);
      ph[k] = 0; sp[k] = 0; rad[k] = 1; br[k] = 0.15 + r() * 0.5; sz[k] = (0.45 + r() * 0.8) * SZ;
    }
    const discN = new THREE.Vector3(0.18, 1, 0.32).normalize();
    for (let i = 0; i < DISC; i++, k++) {
      // each particle on a slightly different inclination, so the disc has thickness
      const n = discN.clone().add(new THREE.Vector3((r() - 0.5) * 0.12, 0, (r() - 0.5) * 0.12)).normalize();
      const [e1, e2] = basis(n);
      const radius = 1.18 + Math.pow(r(), 1.6) * 0.65;
      U.set([e1.x, e1.y, e1.z], k * 3); V.set([e2.x, e2.y, e2.z], k * 3);
      ph[k] = r() * Math.PI * 2; sp[k] = 0.55 / Math.pow(radius, 1.5); rad[k] = radius;
      br[k] = r() < 0.08 ? 1 : 0.2 + r() * 0.45; sz[k] = (0.6 + r() * 0.9) * SZ;
    }
    for (let i = 0; i < SPARKS; i++, k++) {
      const d = randDir();
      U.set([d.x, d.y, d.z], k * 3);
      ph[k] = 0; sp[k] = 0; rad[k] = 1; br[k] = 0.4 + r() * 0.6; sz[k] = (0.7 + r() * 1.0) * SZ;
      em[k] = 1; cy[k] = 0.12 + r() * 0.3; // each spark rises over 3-8 s, then starts again
      V.set([r(), 0, 0], k * 3); // a random start in the cycle so they don't pulse together
    }
    const A = (arr, n) => instancedBufferAttribute(new THREE.InstancedBufferAttribute(arr, n));
    // WebGPU allows at most 8 vertex buffers per draw, so the per-particle data is packed into three vec4s:
    //   [U, phase]  [V, speed]  [radius, brightness, size, emit]   (sparks keep their cycle speed in "speed")
    const P0 = new Float32Array(N * 4), P1 = new Float32Array(N * 4), P2 = new Float32Array(N * 4);
    for (let i = 0; i < N; i++) {
      P0.set([U[i * 3], U[i * 3 + 1], U[i * 3 + 2], ph[i]], i * 4);
      P1.set([V[i * 3], V[i * 3 + 1], V[i * 3 + 2], em[i] ? cy[i] : sp[i]], i * 4);
      P2.set([rad[i], br[i], sz[i], em[i]], i * 4);
    }
    const a0 = A(P0, 4), a1 = A(P1, 4), a2 = A(P2, 4);
    const aU = a0.xyz, aPh = a0.w, aV = a1.xyz, aSp = a1.w, aRad = a2.x, aBr = a2.y, aSz = a2.z, aEm = a2.w;
    const ang = aPh.add(u.t.mul(aSp).mul(aEm.oneMinus()));
    // sparks keep V for their cycle offset only, so they don't use it as a direction
    const dir = aU.mul(cos(ang)).add(aV.mul(sin(ang)).mul(aEm.oneMinus()));
    // spark life: 0 -> 1 as it rises off the surface; faster and brighter while he talks
    const life = fract(u.t.mul(aSp).mul(u.level.mul(1.5).add(1)).add(aV.x));
    const rise = aEm.mul(life.mul(0.85));
    // a constant shimmer, plus voice ripples and a swell; listening pulls everything in
    const wave = sin(dir.y.mul(6).add(dir.x.mul(2.5)).add(u.t.mul(7)).add(aPh.mul(2)));
    const shimmer = sin(dir.x.mul(9).add(dir.z.mul(7)).add(u.t.mul(2.3))).mul(0.018);
    const swell = float(1).add(shimmer).add(u.level.mul(0.14)).add(u.level.mul(wave).mul(0.12)).sub(u.pull.mul(0.07));
    const pm = new THREE.PointsNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true });
    const scatter = float(1).add(u.assemble.oneMinus().mul(aBr.mul(9).add(3)));
    pm.positionNode = dir.mul(aRad.add(rise)).mul(swell).mul(R).mul(scatter);
    pm.sizeNode = aSz.mul(float(1).add(u.level.mul(0.9)));
    const dotShape = float(1).sub(length(uv().sub(0.5)).mul(2)).clamp(0, 1);
    pm.colorNode = mix(u.deep, u.hot, pow(aBr, 2.2).add(u.level.mul(0.3)).clamp(0, 1));
    const sparkFade = mix(float(1), life.oneMinus().mul(smoothstep(0, 0.12, life)), aEm); // sparks fade as they rise
    pm.opacityNode = pow(dotShape, 1.6).mul(aBr.mul(0.7).add(0.3)).mul(u.level.mul(0.6).add(0.85)).mul(u.assemble).mul(sparkFade);
    const particles = new THREE.Sprite(pm);
    particles.count = N;
    particles.frustumCulled = false;
    group.add(particles);

    // the inner network ("plexus"): points joined to their nearest neighbours
    const P = [];
    for (let i = 0; i < 320; i++) { const d = randDir(); P.push(d.multiplyScalar(R * (0.3 + Math.pow(r(), 0.4) * 0.62))); }
    const seg = [];
    for (let i = 0; i < P.length; i++) {
      const near = P.map((q, j) => [j, P[i].distanceTo(q)]).filter(([j, dd]) => j !== i && dd < R * 0.3).sort((a, b) => a[1] - b[1]).slice(0, 3);
      for (const [j] of near) if (j > i) seg.push(P[i].x, P[i].y, P[i].z, P[j].x, P[j].y, P[j].z);
    }
    const net = new THREE.Group();
    const lm = new THREE.LineBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    lm.positionNode = positionLocal.mul(float(1).add(u.level.mul(0.12)).sub(u.pull.mul(0.05)));
    lm.colorNode = mix(u.deep, u.hot, 0.35);
    lm.opacityNode = u.level.mul(0.35).add(0.16).mul(u.assemble.mul(u.assemble));
    const ng = new THREE.BufferGeometry();
    ng.setAttribute("position", new THREE.Float32BufferAttribute(seg, 3));
    net.add(new THREE.LineSegments(ng, lm));
    // bright nodes where the lines meet
    const NP = new Float32Array(P.length * 3);
    P.forEach((q, i) => NP.set([q.x, q.y, q.z], i * 3));
    const vm = new THREE.PointsNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true });
    vm.positionNode = A(NP, 3).mul(float(1).add(u.level.mul(0.12)).sub(u.pull.mul(0.05)));
    vm.sizeNode = float(1.8 * SZ).add(u.level.mul(2));
    vm.colorNode = mix(u.deep, u.hot, 0.7);
    vm.opacityNode = pow(dotShape, 2).mul(0.7).mul(u.assemble);
    const verts = new THREE.Sprite(vm);
    verts.count = P.length;
    verts.frustumCulled = false;
    net.add(verts);
    group.add(net);

    // soft inner light
    const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.tex.soft, color: 0x1e5a86, transparent: true, opacity: 0.24, blending: THREE.AdditiveBlending, depthWrite: false }));
    glow.scale.setScalar(R * 2.6);
    group.add(glow);
    return { group, particles, net, glow };
  }

  makeLabel(html, cls) {
    const div = document.createElement("div");
    div.className = cls;
    div.innerHTML = html;
    const obj = new CSS2DObject(div);
    obj.center.set(0.5, 1); // anchor the label's bottom edge at its position, so it sits above the node
    return obj;
  }

  // ---------- levels ----------
  /**
   * Show a new set of items. `opts.mode`: "root" | "folder" | "present".
   * `opts.from`: "in" (diving into a folder) | "out" (going back) | null.
   */
  setItems(items, opts = {}) {
    const mode = opts.mode || "folder";
    // retire the old level: windows glide out and fade (diving in) or glide back into the core (going back)
    const t0 = performance.now();
    const old = this.nodes.filter((n) => !n.dying);
    old.forEach((n, i) => { n.dying = t0 + Math.min(i * 8, 220); n.dieDir = opts.from === "out" ? -1 : 1; n.dieFrom = n.group.position.clone(); });
    for (const l of this.armLabels) this.scene.remove(l);
    this.armLabels = [];
    this.setHover(null);
    this.select(null);

    const shown = items.slice(0, MAX_NODES);
    this.fileCards = shown.filter((i) => !i.isDir).length <= 60; // full windows for files, or compact tiles
    this.loads = [];
    const homes = this.layout(shown, mode);
    // new windows glide out of the core one after another (after the boot, if it's still running)
    const bootLeft = this.bootT0 ? Math.max(0, this.bootT0 + this.bootMs * 0.55 - t0) : 0;
    const start = t0 + (old.length ? 260 : 0) + bootLeft;
    const step = Math.max(10, Math.min(45, 900 / Math.max(1, shown.length)));
    const fresh = shown.map((item, i) => this.makeNode(item, homes[i], mode, start + i * step));
    for (const n of fresh) { n.from = opts.from === "out" ? n.home.clone().multiplyScalar(1.35) : this.core.center.clone(); n.seed = (hash(n.item.path || n.item.name) % 1000) / 1000; }
    this.core.shockT0 = old.length ? t0 : -1e9;
    this.core.pulse = 1;
    this.nodes.push(...fresh);
    this.current = fresh;
    this.mode = mode;
    this.pumpLoads();
    this.updateLinks();
    let ext = 0;
    for (const h of homes) ext = Math.max(ext, Math.hypot(h.x, h.z), Math.abs(h.y) * 2);
    this.orbit.goalRadius = Math.max(460, Math.min(3600, ext * 1.6 + 190));
    this.orbit.goalTarget.set(0, -20, 0); // aim a little below the dais so near windows clear the input bar
    this.lastInput = performance.now();
  }

  layout(items, mode) {
    const homes = items.map(() => new THREE.Vector3());
    const r = rng(hash(items.map((i) => i.name).join("|").slice(0, 2000)));
    if (mode === "root") {
      const n = items.length, R = Math.max(190 + n * 10, (n * 125) / (Math.PI * 2));
      items.forEach((it, i) => {
        const a = (i / n) * Math.PI * 2 + 0.4;
        homes[i].set(Math.cos(a) * R, Math.sin(i * 2.1) * 26, Math.sin(a) * R);
      });
      return homes;
    }
    if (mode === "present") {
      const n = items.length, R = 185 + Math.sqrt(n) * 20;
      const order = items.map((it, i) => i).sort((a, b) => (items[a].kind || "").localeCompare(items[b].kind || ""));
      order.forEach((idx, k) => {
        const y = 1 - (2 * (k + 0.5)) / n, rad = Math.sqrt(1 - y * y), th = k * 2.39996323;
        homes[idx].set(Math.cos(th) * rad * R, y * R * 0.55, Math.sin(th) * rad * R);
      });
      return homes;
    }
    // folder mode: windows on orbits around the core; files on spiral arms by kind
    const folderIdx = [], byKind = new Map();
    const fileCount = items.filter((it) => !(it.isDir || it.more)).length;
    items.forEach((it, i) => {
      // a handful of files simply join the orbits - an arm of three windows looks lost
      if (it.isDir || it.more || fileCount <= 14) folderIdx.push(i);
      else { if (!byKind.has(it.kind)) byKind.set(it.kind, []); byKind.get(it.kind).push(i); }
    });
    const nf = folderIdx.length;
    const rings = nf > 40 ? 3 : nf > 16 ? 2 : 1;
    const R1 = Math.max(165 + Math.sqrt(nf) * 12, (Math.ceil(nf / rings) * 96) / (Math.PI * 2)); // room for each window
    folderIdx.forEach((idx, k) => {
      const ring = k % rings, perRing = Math.ceil(nf / rings);
      const a = (Math.floor(k / rings) / perRing) * Math.PI * 2 + ring * 0.5;
      const rad = R1 + ring * 95;
      homes[idx].set(Math.cos(a) * rad, (r() - 0.5) * 30 + ring * 12, Math.sin(a) * rad);
    });
    // files: one spiral arm per kind; big kinds get a thicker arm (several lanes) rather than a longer one
    const arms = [...byKind.entries()].sort((a, b) => b[1].length - a[1].length);
    const R2 = nf ? R1 + (rings - 1) * 95 + 85 : 170;
    const armOffset = r() * Math.PI * 2;
    arms.forEach(([kind, idxs], ai) => {
      idxs.sort((a, b) => (items[b].mtime || 0) - (items[a].mtime || 0));
      const base = armOffset + (ai / arms.length) * Math.PI * 2;
      const lanes = Math.max(1, Math.min(7, Math.round(Math.sqrt(idxs.length) / 2.2)));
      const spacing = this.fileCards ? 34 : Math.max(10, Math.min(17, 900 / Math.max(10, idxs.length / lanes)));
      const width = Math.min(0.5, (Math.PI * 2) / arms.length * 0.45); // angular width an arm may use
      let tip = null;
      idxs.forEach((idx, j) => {
        const lane = j % lanes, step = Math.floor(j / lanes);
        const rad = R2 + step * spacing + (r() - 0.5) * spacing * 0.7;
        const laneA = lanes > 1 ? (lane / (lanes - 1) - 0.5) * width * ((this.fileCards ? 260 : 140) / Math.max(140, rad * 0.6)) : 0;
        const a = base + laneA + (rad - R2) / 300 + (r() - 0.5) * (6 / rad);
        homes[idx].set(Math.cos(a) * rad, (r() - 0.5) * (14 + step * 0.5), Math.sin(a) * rad);
        if (!tip || rad > tip.length()) tip = homes[idx];
      });
      if (tip) {
        const at = tip.clone().multiplyScalar(1 + 46 / tip.length());
        const lab = this.makeLabel(`${KIND_NAMES[kind] || kind} <small>${idxs.length}</small>`, "nlabel folder");
        lab.element.style.color = KIND_COLORS[kind] || "#fff";
        lab.position.copy(at);
        this.scene.add(lab);
        this.armLabels.push(lab);
      }
    });
    return homes;
  }

  makeNode(item, home, mode, born) {
    const color = new THREE.Color(item.more ? "#ffffff" : KIND_COLORS[item.kind] || KIND_COLORS.other);
    const accent = `#${color.getHexString()}`;
    const group = new THREE.Group();
    const isDir = item.isDir || item.more;
    const full = isDir || this.fileCards;
    let tex, canvas = null, worldW;
    if (full) {
      canvas = document.createElement("canvas");
      drawCard(canvas, this.cardInfo(item, mode, accent));
      tex = new THREE.CanvasTexture(canvas);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = 4;
      const count = item.items ?? 0;
      worldW = mode === "root" ? 104 : isDir ? 74 + Math.min(18, Math.log2(1 + count) * 1.6) : 62 + Math.min(14, Math.max(0, Math.log10(1 + (item.size || 0)) - 3) * 3);
    } else {
      tex = this.tileTexture(item.kind, accent);
      worldW = 15 + Math.min(10, Math.max(0, Math.log10(1 + (item.size || 0)) - 2) * 1.6);
    }
    const mat = cardMat(tex);
    const card = new THREE.Mesh(new THREE.PlaneGeometry(worldW, worldW * CARD_ASPECT), mat);
    group.add(card);
    group.position.set(0, 0, 0);
    group.scale.setScalar(0.001);
    this.scene.add(group);
    const n = { item, group, card, mat, tex, canvas, full, home, size: worldW * 0.42, color, accent, born, scale: 0.001, goal: 1, label: null, dying: 0, tilt: 0, hot: 0 };
    if (full && !isDir) {
      if (IMG_RE.test(item.name) && (item.size || 0) < 15_000_000) this.loads.push({ n, kind: "thumb" });
      else if (TEXT_RE.test(item.name) && (item.size || 0) < 50_000_000) this.loads.push({ n, kind: "text" });
    }
    return n;
  }

  /** What a window says about a folder or file. */
  cardInfo(item, mode, accent) {
    if (item.more) return { title: item.name, accent, lines: ["pinch or click to see the next set"], tag: "more" };
    if (item.isDir) {
      const kinds = item.kinds ? Object.entries(item.kinds).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k]) => KIND_NAMES[k] || k).join(" · ") : "";
      return {
        title: item.name, accent, folder: true,
        tag: item.missing ? "unavailable" : mode === "root" ? "mapped folder" : "folder",
        lines: [item.items != null ? `${item.items.toLocaleString()} files` : "not indexed yet", item.size ? fmtBytes(item.size) : "", kinds, item.mtime ? `updated ${fmtDay(item.mtime)}` : ""].filter(Boolean),
      };
    }
    const ext = (item.name.match(/\.([^.]+)$/) || [])[1];
    return { title: item.name, accent, tag: `${KIND_NAMES[item.kind] || item.kind}${ext ? " · " + ext : ""}`, lines: [fmtBytes(item.size), `modified ${fmtDay(item.mtime)}`] };
  }

  tileTexture(kind, accent) {
    if (!this.tiles.has(kind)) {
      const t = new THREE.CanvasTexture(drawTile(document.createElement("canvas"), accent));
      t.colorSpace = THREE.SRGBColorSpace;
      this.tiles.set(kind, t);
    }
    return this.tiles.get(kind);
  }

  /** Fill windows with thumbnails / opening lines, a few at a time. */
  pumpLoads() {
    while (this.loading < 4 && this.loads.length) {
      const job = this.loads.shift();
      const n = job.n;
      if (n.dying) continue;
      this.loading++;
      const done = () => { this.loading--; this.pumpLoads(); };
      const redraw = (extra) => {
        if (n.dying || !n.canvas) return;
        drawCard(n.canvas, { ...this.cardInfo(n.item, this.mode, n.accent), ...extra });
        n.tex.needsUpdate = true;
      };
      if (job.kind === "thumb") {
        const img = new Image();
        img.decoding = "async";
        img.onload = () => { redraw({ thumb: img }); done(); };
        img.onerror = done;
        img.src = "/api/raw?" + new URLSearchParams({ path: n.item.path });
      } else {
        fetch("/api/text?" + new URLSearchParams({ path: n.item.path, max: 600 }))
          .then((r) => (r.ok ? r.json() : null))
          .then((d) => { if (d?.text) redraw({ snippet: d.text }); })
          .catch(() => {})
          .finally(done);
      }
    }
  }

  attachLabel(n, html, cls) {
    const l = this.makeLabel(html, cls);
    l.position.set(0, n.size * 0.9 + 3, 0);
    n.group.add(l);
    return l;
  }

  updateLinks() {
    const pts = [];
    for (const n of this.current || []) {
      if (!n.item.isDir) continue;
      const start = n.home.clone().setLength(CORE_R + 22); // links start just off the sphere
      pts.push(start.x, start.y, start.z, n.home.x, n.home.y, n.home.z);
    }
    this.links.geometry.dispose();
    this.links.geometry = new THREE.BufferGeometry();
    this.links.geometry.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
  }

  // ---------- interaction ----------
  toScreen(v) {
    const p = v.clone().project(this.camera);
    return { x: (p.x * 0.5 + 0.5) * this.w, y: (-p.y * 0.5 + 0.5) * this.h, behind: p.z > 1 || p.z < -1, z: p.z };
  }

  screenRadius(n) {
    const d = this.camera.position.distanceTo(n.group.position);
    return (n.size * 1.25 * n.scale) / Math.max(1, d) * (this.h / (2 * Math.tan((this.camera.fov * Math.PI) / 360)));
  }

  /** Nearest node (or the core) to a screen point. Returns a node, "core", or null. */
  pick(x, y, slack = 24) {
    let best = null, bd = Infinity;
    for (const n of this.current || []) {
      if (n.dying || n === this.carried) continue;
      const p = this.toScreen(n.group.position);
      if (p.behind) continue;
      const d = Math.hypot(p.x - x, p.y - y);
      const r = Math.max(slack, this.screenRadius(n) + 6);
      if (d < r && d - r * 0.25 < bd) { best = n; bd = d - r * 0.25; }
    }
    if (!best && this.overCore(x, y)) return "core";
    return best;
  }

  overCore(x, y) {
    const c = this.toScreen(this.core.center);
    const r = Math.max(40, ((CORE_R + 8) / this.camera.position.distanceTo(this.core.center)) * (this.h / (2 * Math.tan((this.camera.fov * Math.PI) / 360))));
    return Math.hypot(c.x - x, c.y - y) < r;
  }

  coreScreen() { return this.toScreen(this.core.center); }

  setHover(n) {
    if (this.hovered === n) return;
    if (this.hovered && this.hovered !== "core" && this.hovered.label) this.hovered.label.element.classList.remove("hot");
    this.hovered = n;
    if (n && n !== "core" && !n.full) {
      this.hoverLabel.element.textContent = n.item.name;
      this.hoverLabel.visible = true;
    } else this.hoverLabel.visible = false;
  }

  select(path) {
    this.selected = path ? (this.current || []).find((n) => n.item.path === path) || null : null;
    this.selRing.visible = false; // the selected window lights up instead
    if (this.selected) {
      this.orbit.goalTarget.copy(this.selected.home).multiplyScalar(0.35);
      this.lastInput = performance.now();
    } else this.orbit.goalTarget.set(0, -20, 0);
    return this.selected;
  }

  nodeByPath(path) { return (this.current || []).find((n) => n.item.path === path) || null; }

  orbitBy(dx, dy) {
    this.orbit.theta -= dx * 0.0055;
    this.orbit.phi = Math.max(0.22, Math.min(1.5, this.orbit.phi - dy * 0.0045));
    this.orbit.vTheta = -dx * 0.0055;
    this.orbit.vPhi = -dy * 0.0045;
    this.lastInput = performance.now();
  }

  fling(vx, vy) { this.orbit.vTheta = -vx * 0.0055; this.orbit.vPhi = -vy * 0.0045; }

  zoomBy(f) {
    this.orbit.goalRadius = Math.max(140, Math.min(4200, this.orbit.goalRadius * f));
    this.lastInput = performance.now();
  }

  beginCarry(n) { this.carried = n; this.lastInput = performance.now(); }
  carryTo(x, y) {
    const n = this.carried;
    if (!n) return;
    const z = n.home.clone().project(this.camera).z;
    const v = new THREE.Vector3((x / this.w) * 2 - 1, -(y / this.h) * 2 + 1, z).unproject(this.camera);
    n.group.position.lerp(v, 0.5);
  }
  endCarry() { this.carried = null; }

  // ---------- the floating file window ----------
  /**
   * Float `el` in the scene where the card for `path` is: it grows out of the card, faces you,
   * and follows the card as the view moves (kept fully on screen). Calling it again with
   * another path glides the open window over to that card.
   */
  showWindow(el, path) {
    const node = path ? this.nodeByPath(path) : null;
    const w = this.win;
    if (w && w.el === el && !w.closing) { w.node = node; this.lastInput = performance.now(); return; }
    if (w) this.dropWindow();
    const obj = new CSS3DObject(el);
    el.style.opacity = "0";
    this.winScene.add(obj);
    this.win = { obj, el, node, t0: performance.now(), closing: 0, max: 0, maxGoal: 0, pos: null, depth: 0 };
    this.lastInput = performance.now();
  }

  /** Fold the window back into its card (or just fade, if the card is gone). */
  closeWindow(now = false) {
    const w = this.win;
    if (!w) return;
    if (now) return this.dropWindow();
    if (!w.closing) { w.closing = performance.now(); w.maxGoal = 0; document.body.classList.remove("window-max"); }
  }

  dropWindow() {
    const w = this.win;
    if (!w) return;
    this.winScene.remove(w.obj); // CSS3DObject detaches its element from the page
    w.el.style.opacity = "";
    this.win = null;
    this.winRenderer.domElement.classList.remove("max");
    document.body.classList.remove("window-max");
  }

  /** Expand the window to fill the screen, or bring it back to its card. */
  maximizeWindow(on) {
    const w = this.win;
    if (!w || w.closing) return false;
    w.maxGoal = on ? 1 : 0;
    document.body.classList.toggle("window-max", on);
    return true;
  }
  get windowMaximized() { return !!this.win && this.win.maxGoal === 1; }

  /** The point at screen (x, y) that lies `depth` units in front of the camera. */
  screenToWorld(x, y, depth, out = new THREE.Vector3()) {
    const cam = this.camera;
    const z = _wv.copy(cam.position).addScaledVector(cam.getWorldDirection(_wd), depth).project(cam).z;
    return out.set((x / this.w) * 2 - 1, -(y / this.h) * 2 + 1, z).unproject(cam);
  }

  updateWindow(dt, now) {
    const w = this.win;
    if (!w) return;
    const cam = this.camera;
    cam.updateMatrixWorld();
    const fwd = cam.getWorldDirection(_wd);
    const fovPx = cam.projectionMatrix.elements[5] * this.h * 0.5;
    const node = w.node && !w.node.dying && this.nodes.includes(w.node) ? w.node : null;

    // size: a comfortable window when floating, the whole screen (less a margin) when expanded
    const top = 96, bottom = 104, left = 18 + this.insetL, right = 18 + this.insetR;
    const safeW = Math.max(240, this.w - left - right), safeH = Math.max(200, this.h - top - bottom);
    const fw = Math.min(safeW, Math.max(420, Math.min(680, this.w * 0.42)));
    const fh = Math.min(safeH, Math.max(300, fw * 0.66));
    w.max += (w.maxGoal - w.max) * (1 - Math.exp(-dt * 9));
    if (Math.abs(w.maxGoal - w.max) < 0.002) w.max = w.maxGoal;
    const m = easeInOut(w.max);
    const ww = fw + (this.w - 48 - fw) * m, wh = fh + (this.h - 48 - fh) * m;
    // the window layer rises above the HUD while expanded (and until it has shrunk back)
    const raised = w.maxGoal === 1 || w.max > 0.02;
    if (raised !== w.raised) { w.raised = raised; this.winRenderer.domElement.classList.toggle("max", raised); }
    w.el.style.width = `${Math.round(ww)}px`;
    w.el.style.height = `${Math.round(wh)}px`;

    // where it floats: centred on its card, nudged so the whole window stays on screen
    let sx = this.w / 2 - (this.insetR - this.insetL) / 2, sy = top + safeH / 2, depth;
    if (node) {
      const p = _wv.copy(node.group.position).project(cam);
      sx = (p.x + 1) * 0.5 * this.w;
      sy = (1 - p.y) * 0.5 * this.h;
      depth = Math.max(80, node.group.position.clone().sub(cam.position).dot(fwd) * 0.85);
    } else depth = w.depth || Math.max(80, this.orbit.radius * 0.8);
    w.depth = depth;
    sx = Math.min(this.w - right - fw / 2, Math.max(left + fw / 2, sx));
    sy = Math.min(this.h - bottom - fh / 2, Math.max(top + fh / 2, sy)) + Math.sin(this.t * 0.8) * 3; // a slow hover
    // ...or dead centre when expanded
    sx += (this.w / 2 - sx) * m;
    sy += (this.h / 2 - sy) * m;
    const goal = this.screenToWorld(sx, sy, depth);
    if (!w.pos) w.pos = goal.clone();
    else w.pos.lerp(goal, 1 - Math.exp(-dt * 10));

    // one CSS pixel per screen pixel at that depth, so text and video stay sharp
    let scale = depth / fovPx;
    let pos = w.pos;
    let alpha = 1;
    const tilt = -((sx - this.w / 2) / this.w) * 0.32 * (1 - m); // angled toward the centre like a curved HUD
    // opening: grow out of the card; closing: fold back into it
    const open = easeInOut(Math.min(1, (now - w.t0) / 520));
    const close = w.closing ? easeInOut(Math.min(1, (now - w.closing) / 380)) : 0;
    const k = open * (1 - close);
    if (k < 1) {
      const from = node ? node.group.position : pos;
      const fromScale = node ? (node.card.geometry.parameters.width * node.group.scale.x) / fw : scale * 0.6;
      pos = from.clone().lerp(pos, k);
      scale = fromScale + (scale - fromScale) * k;
      alpha = k;
    }
    w.obj.position.copy(pos);
    w.obj.quaternion.copy(cam.quaternion);
    w.obj.rotateY(tilt);
    w.obj.scale.setScalar(scale);
    w.el.style.opacity = alpha.toFixed(3);
    if (w.closing && close >= 1) this.dropWindow();
  }

  setState(s) { this.state = s; }
  setLevel(v) { this.level = Math.max(0, Math.min(1, v)); }
  pulse() { this.core.pulse = 1; }

  // ---------- frame ----------
  render(dt) {
    this.t += dt;
    const now = performance.now();
    const o = this.orbit;

    // inertia after a drag ends (while dragging, orbitBy moves the camera directly) + idle auto-rotate
    const idle = now - this.lastInput > 6000;
    this.idleBlend = Math.max(0, Math.min(1, (this.idleBlend || 0) + (idle ? dt / 2.5 : -dt * 4))); // the idle orbit eases in
    o.vTheta *= Math.pow(0.04, dt);
    o.vPhi *= Math.pow(0.04, dt);
    if (now - this.lastInput > 120) { o.theta += o.vTheta; o.phi = Math.max(0.22, Math.min(1.5, o.phi + o.vPhi)); }
    if (this.autoRotate && !this.carried && !this.win) o.theta += dt * 0.035 * this.idleBlend;
    // boot: ease the camera down from high above
    if (this.bootT0) {
      const b = Math.min(1, (now - this.bootT0) / this.bootMs);
      const e = easeOut(b);
      this.u.gridFade.value = Math.min(1, b * 3);
      this.u.assemble.value = easeOut(Math.max(0, Math.min(1, (b - 0.12) / 0.6)));
      o.phi += (1.08 - o.phi) * (1 - Math.exp(-dt * (1 + e * 3)));
      this.core.rings.forEach((r, i) => {
        const k = Math.max(0, Math.min(1, (b - 0.05 - i * 0.055) / 0.35));
        const back = k < 1 ? 1 + Math.sin(k * Math.PI) * 0.18 : 1; // overshoot a little, then settle
        r.scale.setScalar(Math.max(0.001, easeOut(k) * back));
        r.rotation.z += dt * (1 - k) * 6 * (i % 2 ? -1 : 1); // spin up into place
      });
      const gk = Math.max(0, Math.min(1, (b - 0.6) / 0.3));
      for (const gy of this.core.gyros) gy.scale.setScalar(Math.max(0.001, easeOut(gk)));
      if (b >= 1) { this.bootT0 = 0; this.u.assemble.value = 1; this.u.gridFade.value = 1; }
    }
    o.radius += (o.goalRadius - o.radius) * (1 - Math.exp(-dt * 3.2));
    if (Math.abs(this.goalShift - this.shift) > 0.3) { this.shift += (this.goalShift - this.shift) * (1 - Math.exp(-dt * 6)); this.applyShift(); }
    o.target.lerp(o.goalTarget, 1 - Math.exp(-dt * 2.5));
    const sp = Math.sin(o.phi);
    this.camera.position.set(o.target.x + o.radius * sp * Math.sin(o.theta), o.target.y + o.radius * Math.cos(o.phi), o.target.z + o.radius * sp * Math.cos(o.theta));
    this.camera.lookAt(o.target);

    // the core reacts to state and voice
    const c = this.core, u = this.u;
    const k6 = 1 - Math.exp(-dt * 6);
    const voiced = this.state === "listening" || this.state === "speaking";
    this.smoothLevel += ((voiced ? this.level : 0) - this.smoothLevel) * (1 - Math.exp(-dt * 14));
    c.pulse *= Math.pow(0.02, dt);
    u.level.value = Math.min(1, this.smoothLevel + c.pulse * 0.25);
    u.pull.value += ((this.state === "listening" ? 1 : 0) - u.pull.value) * (1 - Math.exp(-dt * 4));
    const [deep, hot] = STATE_COLORS[this.state] || STATE_COLORS.idle;
    u.deep.value.lerp(new THREE.Color(deep), k6);
    u.hot.value.lerp(new THREE.Color(hot), k6);
    c.frameColor.lerp(new THREE.Color(FRAME_COLOR[this.state] || FRAME_COLOR.idle), k6);
    for (const m of c.frameMats) m.userData.c.value.copy(c.frameColor);
    const speed = this.state === "thinking" ? 3.4 : this.state === "listening" ? 0.6 : this.state === "speaking" ? 1.6 : 1;
    u.t.value += dt * speed;
    c.sphere.group.rotation.y += dt * 0.08 * speed;
    c.sphere.net.rotation.y -= dt * 0.12 * speed;
    c.sphere.net.rotation.x += dt * 0.05;
    c.sphere.glow.material.opacity = 0.2 + u.level.value * 0.3;
    for (const ring of c.rings) ring.rotation.z += dt * ring.userData.speed * speed * (1 + u.level.value * 1.5);
    c.gyros.forEach((g, i) => { g.rotation.x += dt * (0.2 + i * 0.1) * speed; g.rotation.y += dt * (0.14 - i * 0.06) * speed; });
    const lift = Math.sin(this.t * (this.state === "thinking" ? 4 : 1.1)) * 1.5 + u.level.value * 4;
    c.sphere.group.position.y = SPHERE_Y + lift;
    c.dropMat.userData.o.value += ((this.carried ? 0.9 : 0) - c.dropMat.userData.o.value) * (1 - Math.exp(-dt * 8));
    const sk = (now - c.shockT0) / 900;
    c.shock.visible = sk >= 0 && sk < 1;
    if (c.shock.visible) { c.shock.scale.setScalar(60 + easeOut(sk) * 520); c.shockMat.userData.o.value = 0.55 * (1 - sk); }
    if (this.bloom) this.bloom.strength.value = 0.55 + u.level.value * 0.6 + (this.state === "thinking" ? 0.1 : 0);

    // camera feed fade + aspect
    u.cam.value += (this.camGoal - u.cam.value) * (1 - Math.exp(-dt * 4));
    if (this.video?.videoWidth) u.vAspect.value = this.video.videoWidth / this.video.videoHeight;

    // nodes
    const camRight = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 0);
    const keep = [];
    for (const n of this.nodes) {
      if (n.dying) {
        const k = Math.max(0, Math.min(1, (now - n.dying) / 520));
        const e = easeInOut(k);
        if (n.dieDir > 0) n.group.position.copy(n.dieFrom).multiplyScalar(1 + e * 0.25); // drifts outward
        else n.group.position.lerpVectors(n.dieFrom, this.core.center, e); // glides back into the core
        n.group.scale.setScalar(Math.max(0.001, n.scale * (1 - e * 0.5)));
        n.mat.userData.fade.value = 1 - e;
        n.card.quaternion.copy(this.camera.quaternion);
        if (k >= 1) { this.disposeNode(n); continue; }
        keep.push(n);
        continue;
      }
      const p = Math.max(0, Math.min(1, (now - n.born) / 900));
      if (p <= 0) { n.group.visible = false; keep.push(n); continue; }
      n.group.visible = true;
      const e = easeInOut(p);
      const bob = Math.sin(this.t * 0.7 + n.seed * 6.283) * (2.5 + n.seed * 2) * (0.4 + this.idleBlend * 0.6); // a gentle hover
      if (n !== this.carried) {
        if (p < 1) {
          // glide straight out to its place; the hover fades in with it so there's no hitch at the end
          n.group.position.lerpVectors(n.from, n.home, e);
          n.group.position.y += bob * e;
        } else {
          n.group.position.lerp(new THREE.Vector3(n.home.x, n.home.y + bob, n.home.z), 1 - Math.exp(-dt * 5.5));
        }
      }
      const isHot = n === this.hovered || n === this.selected;
      const hotN = n === this.hovered ? 1.22 : n === this.selected ? 1.15 : 1;
      n.scale += (n.goal * hotN - n.scale) * (1 - Math.exp(-dt * 9));
      n.group.scale.setScalar(Math.max(0.001, n.scale * (0.35 + 0.65 * e)));
      n.hot += ((isHot ? 1 : 0) - n.hot) * (1 - Math.exp(-dt * 10));
      n.mat.userData.hot.value = n.hot;
      n.mat.userData.fade.value = e;
      // face the viewer, angled a little toward the centre like a curved HUD
      n.card.quaternion.copy(this.camera.quaternion);
      const side = n.group.position.clone().sub(o.target).dot(camRight) / Math.max(200, o.radius);
      n.tilt += (Math.max(-0.45, Math.min(0.45, -side * 0.9)) - n.tilt) * 0.2;
      n.card.rotateY(n.tilt);
      keep.push(n);
    }
    this.nodes = keep;

    if (this.hovered && this.hovered !== "core" && !this.hovered.label) {
      this.hoverLabel.position.copy(this.hovered.group.position).add(new THREE.Vector3(0, this.hovered.size * 0.9 + 4, 0));
    }
    if (this.selected) {
      this.selRing.position.copy(this.selected.group.position);
      this.selRing.scale.setScalar(this.selected.size * 4.2 * (1 + Math.sin(this.t * 4) * 0.06));
      this.selRing.material.color.copy(this.selected.color);
      this.selRing.material.rotation += dt * 0.8;
    }
    this.stars.rotation.y += dt * 0.004;
    this.floor.rotation.y -= dt * 0.01;

    if (this.initialized) this.post.render();
    this.labelRenderer.render(this.scene, this.camera);
    this.updateWindow(dt, now);
    if (this.win) this.winRenderer.render(this.winScene, this.camera);
  }

  disposeNode(n) {
    this.scene.remove(n.group);
    if (n.canvas && n.tex) n.tex.dispose();
    n.group.traverse((obj) => {
      if (obj.geometry) obj.geometry.dispose();
      if (obj.material) obj.material.dispose();
      if (obj.element) obj.element.remove();
    });
  }
}

export function fmtBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n < 10 && i ? 1 : 0)} ${units[i]}`;
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}
