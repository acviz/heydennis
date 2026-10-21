// Themes: different looks for the scene around D.E.N.N.I.S.'s core. Switch with the theme
// chip (top right), the T key, in Settings, or by asking ("switch to the neural theme").
//
//   reactor  the original: blueprint grid, arc-reactor rings, a quiet starfield
//   spiral   a tilted spiral galaxy: long light trails orbiting a white-hot nucleus
//   neural   a glowing neuron: fine filaments reaching out, sparks running along them
//   grid     cyberspace: circuit traces and data walls, light pulses streaming into the core
//
// Everything is drawn live (no video, no images), so it moves with him: the scenery speeds up
// while he thinks and swells with his voice. It's a backdrop: kept dim enough that the core and
// the file windows stay the brightest things on screen. Each theme builds its own scenery when you switch
// to it and frees it when you leave, and says how much of the default pieces still show.
import * as THREE from "/vendor/three/three.webgpu.js";
import {
  uniform, attribute, instancedBufferAttribute, vec2, vec3, float, sin, cos, mix, smoothstep, fract, pow, exp, abs, length, max,
  uv, step, hash, floor, texture, positionLocal, cameraPosition,
} from "/vendor/three/three.tsl.js";

const lin = (r, g, b) => new THREE.Color().setRGB(r, g, b); // linear light

export const THEMES = {
  reactor: {
    label: "Reactor",
    note: "The original: blueprint grid, arc-reactor rings, a quiet starfield.",
    base: { grid: 1, stars: 1, floor: 1, dais: 1, bloom: 0.55 },
    bg: [lin(0.0003, 0.0005, 0.0008), lin(0.0003, 0.0005, 0.0008)], // [top, bottom]
  },
  spiral: {
    label: "Spiral",
    note: "A tilted spiral galaxy: light trails orbiting a white-hot core.",
    base: { grid: 0, stars: 0.35, floor: 0, dais: 0, bloom: 0.6 },
    bg: [lin(0.0016, 0.0085, 0.036), lin(0.0002, 0.0008, 0.0035)],
    palette: { idle: ["#1747b0", "#a9c8f5"], speaking: ["#1d5fd6", "#bcd6ff"] },
    frame: { idle: "#3f7fe0", speaking: "#7fb0ff" },
  },
  neural: {
    label: "Neural",
    note: "A glowing neuron: filaments reaching out, sparks running along them.",
    base: { grid: 0, stars: 0.75, floor: 0, dais: 0, bloom: 0.6 },
    bg: [lin(0.001, 0.0048, 0.011), lin(0.0003, 0.0012, 0.003)],
    palette: { idle: ["#0f5c9a", "#a6e2f5"], speaking: ["#1478c0", "#bdeaf8"] },
    frame: { idle: "#3aa6d8", speaking: "#86d4f5" },
  },
  grid: {
    label: "Grid",
    note: "Cyberspace: circuit traces and data walls, light pulses streaming into the core.",
    base: { grid: 0.3, stars: 0.25, floor: 0, dais: 1, bloom: 0.58 },
    bg: [lin(0.0012, 0.006, 0.034), lin(0.0003, 0.0014, 0.008)],
    palette: { idle: ["#123f9a", "#9ccff5"], speaking: ["#1a5ec0", "#b8dcff"] },
    frame: { idle: "#3b86e0", speaking: "#86c4ff" },
  },
};
export const THEME_ORDER = ["reactor", "spiral", "neural", "grid"];
export const themeName = (name) => (THEMES[name] ? name : "reactor");

/** The scenery for a theme: { group, fade (uniform 0..1), update(dt, ctx), dispose() }, or null. */
export function buildScenery(name, env) {
  if (name === "spiral") return spiral(env);
  if (name === "neural") return neural(env);
  if (name === "grid") return grid(env);
  return null;
}

// ---------------------------------------------------------------- shared bits
const ADD = { transparent: true, depthWrite: false, blending: THREE.AdditiveBlending };
const col = (hex) => uniform(new THREE.Color(hex));
const inst = (arr, n) => instancedBufferAttribute(new THREE.InstancedBufferAttribute(arr, n));
function spriteMat() {
  const m = new THREE.PointsNodeMaterial({ ...ADD, sizeAttenuation: true });
  m.fog = false;
  return m;
}
function lineMat() {
  const m = new THREE.LineBasicNodeMaterial(ADD);
  m.fog = false;
  return m;
}
/** One draw call for many camera-facing sprites (positions come from the shader). */
function sprites(mat, n) {
  const s = new THREE.Sprite(mat);
  s.count = n;
  s.frustumCulled = false;
  return s;
}
/** Line segments with extra per-vertex data (attributes named a0, a1, ...). */
function segments(mat, positions, attrs = []) {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  attrs.forEach((arr, i) => g.setAttribute(`a${i}`, new THREE.Float32BufferAttribute(arr, 4)));
  const l = new THREE.LineSegments(g, mat);
  l.frustumCulled = false;
  return l;
}
const roundDot = () => float(1).sub(length(uv().sub(0.5)).mul(2)).clamp(0, 1);
function rng(seed) {
  let a = seed || 1;
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const gauss = (r) => (r() + r() + r() + r() - 2) / 2; // roughly normal, in [-1, 1]
const randDir = (r) => { const z = r() * 2 - 1, a = r() * Math.PI * 2, s = Math.sqrt(1 - z * z); return new THREE.Vector3(Math.cos(a) * s, Math.sin(a) * s, z); };
function basis(n) {
  const a = Math.abs(n.x) > 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
  const e1 = a.clone().cross(n).normalize();
  return [e1, n.clone().cross(e1).normalize()];
}
function raysTexture(size = 512) {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const g = c.getContext("2d"), m = size / 2, r = rng(5);
  g.translate(m, m);
  for (let i = 0; i < 90; i++) {
    const a = r() * Math.PI * 2, len = m * (0.35 + r() * 0.65), w = 0.6 + r() * 1.8;
    const grad = g.createLinearGradient(0, 0, Math.cos(a) * len, Math.sin(a) * len);
    grad.addColorStop(0, `rgba(255,255,255,${0.35 + r() * 0.4})`);
    grad.addColorStop(1, "rgba(255,255,255,0)");
    g.strokeStyle = grad;
    g.lineWidth = w;
    g.beginPath(); g.moveTo(0, 0); g.lineTo(Math.cos(a) * len, Math.sin(a) * len); g.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
function glowSprite(tex, hex, scale, opacity) {
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, color: new THREE.Color(hex), transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }));
  s.scale.setScalar(scale);
  s.userData.opacity = opacity;
  return s;
}
/** Uniforms every scenery shares: clock, voice level, fade, and where the group sits (for near-camera fades). */
function common(y = 0) {
  const group = new THREE.Group();
  group.position.y = y;
  return { group, T: uniform(0), L: uniform(0), F: uniform(0), ORG: uniform(new THREE.Vector3(0, y, 0)), SC: uniform(1) };
}
/** Fade out what comes too close to the camera (it can orbit right through the scenery). */
const nearFade = (c, local, from, to) => smoothstep(from, to, length(local.mul(c.SC).add(c.ORG).sub(cameraPosition)));
function finish(c, extra = {}) {
  const sprites2d = [];
  c.group.traverse((o) => { if (o.isSprite && o.userData.opacity != null) sprites2d.push(o); });
  return {
    group: c.group,
    fade: c.F,
    update(dt, ctx) {
      c.T.value += dt * ctx.speed;
      c.L.value = ctx.level;
      // big folders pull the camera far out: grow the scenery with it so it stays around you
      const want = Math.max(1, Math.min(2.2, (ctx.extent || 0) / 1100));
      const s = c.group.scale.x + (want - c.group.scale.x) * (1 - Math.exp(-dt * 1.5));
      c.group.scale.setScalar(s);
      c.SC.value = s;
      c.ORG.value.copy(c.group.position);
      for (const sp of sprites2d) sp.material.opacity = sp.userData.opacity * c.F.value * (1 + ctx.level * 0.35);
      extra.update?.(dt, ctx);
    },
    dispose() {
      c.group.traverse((o) => {
        if (!o.isSprite) o.geometry?.dispose(); // every Sprite shares one geometry (the core's particles too): never dispose it
        if (o.material) { if (o.userData.ownMap) o.material.map?.dispose(); o.material.dispose(); } // the glow texture is shared too
      });
      extra.dispose?.();
    },
  };
}

// ---------------------------------------------------------------- spiral: a galaxy of light trails
function spiral({ tex }) {
  const c = common(-58); // the disk lies just under the dais, so the core floats over the nucleus
  const { group, T, L, F } = c;
  const disk = new THREE.Group();
  group.add(disk);
  const r = rng(2024);
  const blue = col("#1f5cff"), mid = col("#4f8dff"), ice = col("#a6c6ff");
  const RMIN = 110, RMAX = 2300, ARMS = 2, WIND = 3.3;

  // stars: two arms, the dust between them, and a bright central bulge
  const N = 20000;
  const S0 = new Float32Array(N * 4), S1 = new Float32Array(N * 4);
  for (let i = 0; i < N; i++) {
    const kind = r();
    let x, y, z, br, sz, w;
    if (kind < 0.08) {
      const d = randDir(r), rr = Math.pow(r(), 1.8) * 260;
      x = d.x * rr; y = d.y * rr * 0.4; z = d.z * rr;
      br = 0.2 + r() * 0.4; sz = 1.6 + r() * 2.4; w = 0.5 + r() * 0.5;
    } else {
      const rad = RMIN + Math.pow(r(), 1.25) * (RMAX - RMIN), t = rad / RMAX;
      let a;
      if (kind < 0.36) { a = r() * Math.PI * 2; br = 0.08 + r() * 0.2; } // between the arms
      else { a = Math.floor(r() * ARMS) * ((Math.PI * 2) / ARMS) + WIND * Math.log(rad / RMIN) + gauss(r) * (0.55 + t * 0.5); br = 0.22 + Math.pow(r(), 2.2) * 0.78; }
      x = Math.cos(a) * rad; z = Math.sin(a) * rad; y = gauss(r) * (10 + 70 * Math.exp(-rad / 380));
      sz = 1.8 + Math.pow(r(), 2) * 4.2; w = r() < 0.15 ? 0.6 + r() * 0.4 : r() * 0.3;
      if (r() < 0.025) { br = 1; sz *= 1.8; w = 0.9; } // the odd bright star
    }
    S0.set([x, y, z, br], i * 4);
    S1.set([sz, r() * 6.283, 0.5 + r() * 2.5, w], i * 4);
  }
  {
    const a0 = inst(S0, 4), a1 = inst(S1, 4);
    const m = spriteMat();
    const twinkle = sin(T.mul(a1.z).add(a1.y)).mul(0.35).add(0.65);
    m.positionNode = a0.xyz;
    m.sizeNode = a1.x.mul(L.mul(0.35).add(1));
    m.colorNode = mix(mid, ice, a1.w).mul(a0.w.add(0.35));
    m.opacityNode = pow(roundDot(), 1.7).mul(a0.w.mul(0.6).add(0.15)).mul(twinkle).mul(smoothstep(RMAX * 1.05, RMAX * 0.6, length(a0.xz))).mul(F);
    disk.add(sprites(m, N));
  }

  // light trails: long arcs orbiting the core in bundles, brightest at the head; the inner ones are faster
  const TR = 480, SEG = 36;
  const P = new Float32Array(TR * SEG * 2 * 3), A0 = new Float32Array(TR * SEG * 2 * 4), A1 = new Float32Array(TR * SEG * 2 * 4), A2 = new Float32Array(TR * SEG * 2 * 4);
  const H0 = new Float32Array(TR * 4), H1 = new Float32Array(TR * 4), H2 = new Float32Array(TR * 4);
  let v = 0;
  for (let i = 0; i < TR; i++) {
    const band = r();
    const rad = band < 0.3 ? 150 + r() * 260 : band < 0.68 ? 480 + r() * 600 : 1150 + r() * 1100;
    const n = new THREE.Vector3(gauss(r) * 0.12, 1, gauss(r) * 0.12).normalize(); // each orbit tilted a touch
    const e1 = new THREE.Vector3(1, 0, 0).sub(n.clone().multiplyScalar(n.x)).normalize();
    const e2 = e1.clone().cross(n);
    const phase = r() * Math.PI * 2, spd = 0.2 * Math.pow(300 / rad, 0.55) * (0.8 + r() * 0.4);
    const len = 0.5 + r() * 1.7, bright = r() < 0.07 ? 1.6 : 0.25 + r() * 0.75;
    for (let s = 0; s < SEG; s++) {
      for (const f of [s / SEG, (s + 1) / SEG]) {
        A0.set([e1.x, e1.y, e1.z, phase], v * 4);
        A1.set([e2.x, e2.y, e2.z, spd], v * 4);
        A2.set([rad, f, len, bright], v * 4);
        v++;
      }
    }
    H0.set([e1.x, e1.y, e1.z, phase], i * 4);
    H1.set([e2.x, e2.y, e2.z, spd], i * 4);
    H2.set([rad, Math.min(1, bright), 2.6 + bright * 3, 0], i * 4);
  }
  {
    const a0 = attribute("a0", "vec4"), a1 = attribute("a1", "vec4"), a2 = attribute("a2", "vec4");
    const f = a2.y;
    const ang = a0.w.sub(T.mul(a1.w)).add(f.mul(a2.z)); // the head leads, the tail follows
    const m = lineMat();
    m.positionNode = a0.xyz.mul(cos(ang)).add(a1.xyz.mul(sin(ang))).mul(a2.x.mul(f.mul(0.045).add(1))); // tails drift outward: a spiral sweep
    m.colorNode = mix(blue, ice, pow(f.oneMinus(), 7)).mul(a2.w).mul(L.mul(0.6).add(0.8));
    m.opacityNode = pow(f.oneMinus(), 2.4).mul(a2.w.min(1)).mul(0.55).mul(F);
    group.add(segments(m, P, [A0, A1, A2]));
  }
  {
    const h0 = inst(H0, 4), h1 = inst(H1, 4), h2 = inst(H2, 4);
    const ang = h0.w.sub(T.mul(h1.w));
    const m = spriteMat();
    m.positionNode = h0.xyz.mul(cos(ang)).add(h1.xyz.mul(sin(ang))).mul(h2.x);
    m.sizeNode = h2.z.mul(L.mul(0.5).add(1));
    m.colorNode = ice.mul(h2.y.mul(0.8).add(0.4));
    m.opacityNode = pow(roundDot(), 2.2).mul(h2.y.mul(0.75)).mul(F);
    group.add(sprites(m, TR));
  }

  // the nucleus: a flat white-hot glow in the disk's plane, a blue haze around it, a bright heart
  const flat = (size, hex, op) => {
    const m = new THREE.MeshBasicNodeMaterial({ ...ADD, side: THREE.DoubleSide });
    m.fog = false;
    const t = texture(tex.glow);
    m.colorNode = col(hex).mul(t.rgb);
    m.opacityNode = t.a.mul(op).mul(F).mul(L.mul(0.35).add(1));
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(size, size), m);
    mesh.rotation.x = -Math.PI / 2;
    return mesh;
  };
  group.add(flat(4200, "#0f3594", 0.14), flat(1300, "#2f6dff", 0.16), flat(380, "#4a86f0", 0.22)); // blue, never a white blob
  group.add(glowSprite(tex.glow, "#3f74d8", 170, 0.1));

  // bokeh: big soft out-of-focus glints toward the rim (often right in front of the camera)
  const B = 260, B0 = new Float32Array(B * 4), B1 = new Float32Array(B * 4);
  for (let i = 0; i < B; i++) {
    const a = r() * Math.PI * 2, rad = 700 + Math.pow(r(), 0.7) * 2100;
    B0.set([Math.cos(a) * rad, gauss(r) * 260 + 30, Math.sin(a) * rad, 0.025 + r() * 0.07], i * 4);
    B1.set([24 + r() * 70, r() * 6.283, 0.2 + r() * 0.6, r()], i * 4);
  }
  {
    const b0 = inst(B0, 4), b1 = inst(B1, 4);
    const m = spriteMat();
    m.positionNode = b0.xyz;
    m.sizeNode = b1.x;
    m.colorNode = mix(mid, ice, b1.w.mul(0.5));
    const disc = smoothstep(0, 0.3, roundDot());
    m.opacityNode = disc.mul(b0.w).mul(sin(T.mul(b1.z).add(b1.y)).mul(0.4).add(0.6)).mul(nearFade(c, b0.xyz, 60, 420)).mul(F);
    group.add(sprites(m, B));
  }

  return finish(c, { update(dt, ctx) { disk.rotation.y += dt * 0.012 * ctx.speed; } });
}

// ---------------------------------------------------------------- neural: filaments and sparks
function neural({ tex, coreR }) {
  const c = common(0); // follows the core (see update)
  const { group, T, L, F } = c;
  const r = rng(77);
  const blue = col("#2a7dff"), cyan = col("#5fd8ff"), ice = col("#8fdcff"), pink = col("#e070ff");
  const R0 = coreR * 1.08;

  const FIL = 260, SEG = 42;
  const fil = [];
  for (let i = 0; i < FIL; i++) {
    const d = randDir(r), [e1, e2] = basis(d), len = 420 + Math.pow(r(), 0.8) * 2300;
    fil.push({ d, e1, e2, len, amp: (0.06 + r() * 0.1) * len, bend: gauss(r) * 0.5, f1: 0.5 + r() * 1.6, f2: 0.4 + r() * 1.3, p1: r() * 6.283, p2: r() * 6.283, bright: 0.2 + Math.pow(r(), 2) * 0.8, tint: r() < 0.06 ? 1 : 0 });
  }
  const pack = (q, A, k) => {
    A[0].set([q.d.x, q.d.y, q.d.z, q.len], k * 4);
    A[1].set([q.e1.x, q.e1.y, q.e1.z, q.amp], k * 4);
    A[2].set([q.e2.x, q.e2.y, q.e2.z, q.bend], k * 4);
    A[3].set([q.f1, q.f2, q.p1, q.p2], k * 4);
  };
  // a point s (0 at the core, 1 at the tip) along a filament: straight out, waving slowly, bending a little
  const along = (a0, a1, a2, a3, s) => {
    const w = fract(a3.z.mul(3.7)).mul(0.45).add(0.3);
    const amp = a1.w.mul(pow(s, 1.2)).mul(L.mul(0.6).add(1));
    const w1 = sin(s.mul(a3.x).mul(6.2832).add(T.mul(w)).add(a3.z));
    const w2 = sin(s.mul(a3.y).mul(6.2832).sub(T.mul(w.mul(0.8))).add(a3.w));
    return a0.xyz.mul(a0.w.mul(s).add(R0))
      .add(a1.xyz.mul(w1.mul(amp).add(a2.w.mul(s).mul(s).mul(a0.w).mul(0.25))))
      .add(a2.xyz.mul(w2.mul(amp)));
  };
  {
    const V = FIL * SEG * 2, A = [0, 1, 2, 3, 4].map(() => new Float32Array(V * 4));
    let v = 0;
    for (const q of fil) {
      for (let s = 0; s < SEG; s++) {
        for (const f of [s / SEG, (s + 1) / SEG]) { pack(q, A, v); A[4].set([f, q.bright, q.tint, 0], v * 4); v++; }
      }
    }
    const a = [0, 1, 2, 3, 4].map((i) => attribute(`a${i}`, "vec4"));
    const s = a[4].x;
    const m = lineMat();
    m.positionNode = along(a[0], a[1], a[2], a[3], s);
    m.colorNode = mix(mix(blue, ice, pow(s.oneMinus(), 6)), pink, a[4].z).mul(L.mul(0.5).add(0.85));
    m.opacityNode = pow(s.oneMinus(), 1.3).mul(a[4].y).mul(0.36).mul(F);
    group.add(segments(m, new Float32Array(V * 3), A));
  }
  // sparks running out along the filaments - faster while he thinks
  {
    const K = 1500, A = [0, 1, 2, 3, 4].map(() => new Float32Array(K * 4));
    for (let k = 0; k < K; k++) {
      const q = fil[Math.floor(r() * FIL)];
      pack(q, A, k);
      A[4].set([r(), 0.03 + r() * 0.08, 2.6 + r() * 3.6, r() < 0.1 ? 1 : q.tint], k * 4);
    }
    const a = A.map((arr) => inst(arr, 4));
    const s = fract(T.mul(a[4].y).add(a[4].x));
    const m = spriteMat();
    m.positionNode = along(a[0], a[1], a[2], a[3], s);
    m.sizeNode = a[4].z.mul(L.mul(0.6).add(1));
    m.colorNode = mix(cyan, pink, a[4].w).mul(1.2);
    m.opacityNode = pow(roundDot(), 2).mul(smoothstep(0, 0.05, s)).mul(pow(s.oneMinus(), 0.7)).mul(0.8).mul(F);
    group.add(sprites(m, K));
  }
  // dust: specks hanging in the dark around it
  {
    const D = 1600, D0 = new Float32Array(D * 4), D1 = new Float32Array(D * 4);
    for (let i = 0; i < D; i++) {
      const d = randDir(r).multiplyScalar(160 + Math.pow(r(), 0.6) * 2600);
      D0.set([d.x, d.y, d.z, 0.12 + r() * 0.38], i * 4);
      D1.set([1.2 + r() * 1.8, r() * 6.283, 0.4 + r() * 2, r() < 0.06 ? 1 : 0], i * 4);
    }
    const d0 = inst(D0, 4), d1 = inst(D1, 4);
    const m = spriteMat();
    m.positionNode = d0.xyz;
    m.sizeNode = d1.x;
    m.colorNode = mix(cyan, pink, d1.w);
    m.opacityNode = pow(roundDot(), 2).mul(d0.w).mul(sin(T.mul(d1.z).add(d1.y)).mul(0.4).add(0.6)).mul(F);
    group.add(sprites(m, D));
  }
  // the glowing heart and its rays
  const rays = glowSprite(raysTexture(), "#7fd0ff", coreR * 16, 0.15);
  rays.userData.ownMap = true;
  group.add(glowSprite(tex.glow, "#2f8fe6", coreR * 6, 0.24), rays); // a cyan halo, no white heart

  return finish(c, {
    update(dt, ctx) {
      if (ctx.center) group.position.copy(ctx.center);
      rays.material.rotation += dt * 0.015 * ctx.speed;
    },
  });
}

// ---------------------------------------------------------------- grid: cyberspace
function grid() {
  const c = common(-112); // the circuit floor lies under the dais
  const { group, T, L, F } = c;
  const r = rng(909);
  const blue = col("#1d5cff"), cyan = col("#38c8ff"), ice = col("#86d2ff");
  const CELL = 40;
  const spread = (p) => smoothstep(3300, 1300, length(p.xz)).mul(smoothstep(110, 260, length(p.xz))); // fades into the dark, and clear of the core

  // circuit traces: right-angled paths from near the core out toward the horizon. Light pulses run
  // inward along them - data streaming into D.E.N.N.I.S.
  const tv = [], t0 = [], t1 = [], vias = [];
  for (let i = 0; i < 300; i++) {
    const th = r() * Math.PI * 2, r0 = 180 + r() * 300;
    let x = Math.round((Math.cos(th) * r0) / CELL) * CELL, z = Math.round((Math.sin(th) * r0) / CELL) * CELL;
    const out = Math.abs(Math.cos(th)) > Math.abs(Math.sin(th)) ? [Math.sign(Math.cos(th)), 0] : [0, Math.sign(Math.sin(th))];
    const side = [out[1], out[0]];
    const pts = [[x, z]], maxR = 1500 + r() * 1700;
    for (let run = 0; run < 30 && Math.hypot(x, z) < maxR; run++) {
      const jog = run % 2 === 1 && r() < 0.55, sg = r() < 0.5 ? -1 : 1;
      const [dx, dz] = jog ? [side[0] * sg, side[1] * sg] : out;
      const n = jog ? 1 + Math.floor(r() * 3) : 2 + Math.floor(r() * 8);
      x += dx * n * CELL; z += dz * n * CELL;
      pts.push([x, z]);
    }
    let q = 0;
    const segs = [];
    for (let k = 1; k < pts.length; k++) { const l = Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]); segs.push([pts[k - 1], pts[k], q, q + l]); q += l; }
    const len = q, off = r(), spd = (120 + r() * 160) / (len + 1200), bright = 0.4 + r() * 0.6;
    for (const [a, b, q0, q1] of segs) {
      tv.push(a[0], 0, a[1], b[0], 0, b[1]);
      t0.push(q0, len, off, spd, q1, len, off, spd);
      t1.push(bright, 0, 0, 0, bright, 0, 0, 0);
    }
    for (const [px, pz] of pts) if (r() < 0.5) vias.push(px, 0, pz, bright);
  }
  {
    const a0 = attribute("a0", "vec4"), a1 = attribute("a1", "vec4");
    const head = a0.y.sub(fract(T.mul(a0.w).add(a0.z)).mul(a0.y.add(1200))); // a pulse is on its trace about half the time
    const d = a0.x.sub(head), front = smoothstep(-10, 0, d);
    const pulse = front.mul(exp(max(d, 0).div(-60))), tip = front.mul(exp(max(d, 0).div(-14)));
    const m = lineMat();
    m.colorNode = mix(blue.mul(0.75), cyan, pulse).add(cyan.mul(tip).mul(0.35));
    m.opacityNode = a1.x.mul(0.13).add(pulse.mul(0.5)).mul(spread(positionLocal)).mul(L.mul(0.4).add(1)).mul(F);
    group.add(segments(m, new Float32Array(tv), [new Float32Array(t0), new Float32Array(t1)]));
  }
  // vias: little pads where traces turn, some blinking
  {
    const n = vias.length / 4, V0 = new Float32Array(vias), V1 = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) V1.set([3.5 + r() * 3.5, r() * 6.283, 0.5 + r() * 2.5, r() < 0.3 ? 1 : 0], i * 4);
    const v0 = inst(V0, 4), v1 = inst(V1, 4);
    const m = spriteMat();
    m.positionNode = v0.xyz;
    m.sizeNode = v1.x;
    m.colorNode = cyan;
    const blink = mix(float(1), step(0, sin(T.mul(v1.z).add(v1.y))), v1.w);
    m.opacityNode = pow(roundDot(), 1.5).mul(v0.w.mul(0.32)).mul(blink).mul(spread(v0.xyz)).mul(F);
    group.add(sprites(m, n));
  }
  // the floor grid itself, faint, fading to the horizon
  {
    const g = [], g0 = [], E = 3200;
    for (let k = -E; k <= E; k += 80) {
      const major = k % 400 === 0 ? 1 : 0;
      g.push(-E, 0, k, E, 0, k, k, 0, -E, k, 0, E);
      for (let j = 0; j < 4; j++) g0.push(major, 0, 0, 0);
    }
    const a0 = attribute("a0", "vec4");
    const m = lineMat();
    m.colorNode = blue;
    m.opacityNode = a0.x.mul(0.05).add(0.035).mul(spread(positionLocal)).mul(F);
    group.add(segments(m, new Float32Array(g), [new Float32Array(g0)]));
  }

  // data walls: frames, ruled panels and tall bars standing in a wide ring, light running up the bars
  const wv = [], w0 = [], cols = [];
  for (let i = 0; i < 160; i++) {
    const th = r() * Math.PI * 2, R = 1500 + r() * 1300;
    const cx = Math.cos(th) * R, cz = Math.sin(th) * R, tx = -Math.sin(th), tz = Math.cos(th);
    const W = 50 + r() * 280, H = 120 + Math.pow(r(), 1.4) * 1300, y0 = r() < 0.7 ? 0 : 80 + r() * 700;
    const br = 0.3 + r() * 0.7, ph = r(), rate = 0.08 + r() * 0.2;
    const at = (u, y) => [cx + tx * u, y, cz + tz * u];
    const seg = (a, b, va, vb) => { wv.push(...a, ...b); w0.push(br, va, ph, rate, br, vb, ph, rate); };
    const kind = r();
    if (kind < 0.4) {
      const a = at(-W / 2, y0), b = at(W / 2, y0), cc = at(W / 2, y0 + H), d = at(-W / 2, y0 + H);
      seg(a, b, -1, -1); seg(b, cc, 0, 1); seg(cc, d, -1, -1); seg(d, a, 1, 0);
      for (let k = Math.floor(r() * 5); k > 0; k--) { const y = y0 + H * (0.1 + r() * 0.8); seg(at(-W / 2 + r() * W * 0.3, y), at(W / 2 - r() * W * 0.3, y), -1, -1); }
    } else if (kind < 0.75) {
      for (let k = 1 + Math.floor(r() * 4); k > 0; k--) { const u = (r() - 0.5) * W; seg(at(u, y0), at(u, y0 + H * (0.5 + r() * 0.5)), 0, 1); }
    } else {
      cols.push([cx, cz, y0, H, br]);
      seg(at(-W / 2, y0), at(W / 2, y0), -1, -1);
    }
  }
  {
    const a0 = attribute("a0", "vec4");
    const head = fract(T.mul(a0.w).add(a0.z));
    const pulse = exp(abs(a0.y.sub(head)).mul(-18)).mul(step(0, a0.y));
    const m = lineMat();
    m.colorNode = mix(blue, cyan.mul(1.2), pulse);
    m.opacityNode = a0.x.mul(0.09).add(pulse.mul(0.4))
      .mul(smoothstep(1700, 200, positionLocal.y)).mul(smoothstep(3300, 2700, length(positionLocal.xz)))
      .mul(nearFade(c, positionLocal, 300, 1100)).mul(F);
    group.add(segments(m, new Float32Array(wv), [new Float32Array(w0)]));
  }
  // dotted data columns: square specks climbing the walls, flickering like bits
  {
    const PER = 30, n = cols.length * PER, C0 = new Float32Array(n * 4), C1 = new Float32Array(n * 4);
    cols.forEach(([x, z, y0, H, br], i) => {
      const spd = 0.03 + r() * 0.06;
      for (let k = 0; k < PER; k++) { C0.set([x, y0, z, H], (i * PER + k) * 4); C1.set([k / PER, spd, br, i * PER + k], (i * PER + k) * 4); }
    });
    const c0 = inst(C0, 4), c1 = inst(C1, 4);
    const y = c0.y.add(fract(c1.x.add(T.mul(c1.y))).mul(c0.w));
    const p = vec3(c0.x, y, c0.z);
    const bit = step(0.42, hash(c1.w.mul(13).add(floor(T.mul(1.6)))));
    const q = abs(uv().sub(0.5));
    const m = spriteMat();
    m.positionNode = p;
    m.sizeNode = float(4.2);
    m.colorNode = cyan;
    m.opacityNode = step(max(q.x, q.y), float(0.32)).mul(bit.mul(0.4).add(0.08)).mul(c1.z)
      .mul(smoothstep(1700, 300, y)).mul(nearFade(c, p, 150, 700)).mul(F);
    group.add(sprites(m, n));
  }
  // flares: bright points hanging in the space, each with a long horizontal streak
  {
    const n = 44, P0 = new Float32Array(n * 4), P1 = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
      const a = r() * Math.PI * 2, rad = 300 + r() * 2300;
      P0.set([Math.cos(a) * rad, 60 + Math.pow(r(), 1.3) * 900, Math.sin(a) * rad, 0.5 + r() * 0.5], i * 4);
      P1.set([16 + r() * 18, 260 + r() * 360, r() * 6.283, 0.3 + r() * 0.9], i * 4);
    }
    const p0 = inst(P0, 4), p1 = inst(P1, 4);
    const twinkle = sin(T.mul(p1.w).add(p1.z)).mul(0.3).add(0.7);
    const near = nearFade(c, p0.xyz, 120, 600);
    const glow = spriteMat();
    glow.positionNode = p0.xyz;
    glow.sizeNode = p1.x;
    glow.colorNode = ice.mul(1.1);
    glow.opacityNode = pow(roundDot(), 2.5).mul(p0.w.mul(0.7)).mul(twinkle).mul(near).mul(F);
    const streak = spriteMat();
    streak.positionNode = p0.xyz;
    streak.sizeNode = vec2(p1.y, 2.8);
    streak.colorNode = cyan;
    const sx = float(1).sub(abs(uv().x.sub(0.5)).mul(2)), sy = float(1).sub(abs(uv().y.sub(0.5)).mul(2));
    streak.opacityNode = pow(sx, 2.5).mul(sy).mul(p0.w.mul(0.28)).mul(twinkle).mul(near).mul(F);
    group.add(sprites(glow, n), sprites(streak, n));
  }
  // a haze on the horizon, all the way round
  {
    const m = new THREE.MeshBasicNodeMaterial({ ...ADD, side: THREE.DoubleSide });
    m.fog = false;
    m.colorNode = blue.mul(0.9);
    // rises softly from the floor line (no hard edge where the view drops below it) and thins out upward
    m.opacityNode = smoothstep(0, 0.12, uv().y).mul(exp(uv().y.mul(-6))).mul(0.09).mul(nearFade(c, positionLocal, 200, 900)).mul(F);
    const geo = new THREE.CylinderGeometry(3100, 3100, 1000, 96, 1, true);
    geo.translate(0, 500, 0); // in the geometry, so positionLocal is group-local like everything else
    group.add(new THREE.Mesh(geo, m));
  }
  return finish(c);
}
