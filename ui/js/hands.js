// Hand tracking + gestures.
//
// Tracking is Google MediaPipe Hand Landmarker (Apache-2.0), self-hosted in
// ui/vendor so no CDN sits in the path. The gesture layer adapts the
// field-tuned techniques from holo-gestures by Zubair Trabzada (MIT,
// github.com/zubair-trabzada/holo-gestures):
//   - a pinch is fingers actually touching, with hysteresis and a 2-frame earn
//   - One Euro smoothing (steady at rest, no lag when moving fast)
//   - identity-stable hand slots (MediaPipe's hand order swaps between frames)
//   - ghost-hand dedupe and a minimum hand size (phantoms from faces / shirts)
//   - quick-tap gate on time AND palm drift, not on fingertip motion
//   - static held poses (peace, fist, palm, thumbs-up) instead of fragile motion gestures
// Camera frames never leave the page.

export const TUNING = {
  PINCH_IN: 0.30, PINCH_OUT: 0.42, PINCH_EARN: 2,
  SPAN_MIN: 0.025, // hands smaller than this (fraction of frame) are background noise
  AMP: 1.4, // a comfortable central hand zone reaches the whole screen
  TAP_MS: 450, TAP_PX: 60,
  PEACE_FRAMES: 8, FIST_FRAMES: 12, THUMB_FRAMES: 14, PALM_MS: 900,
  TWO_HAND_MIN_PX: 140,
  STALE_MS: 280,
};

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

export function handMetrics(lm) {
  const span = Math.max(1e-4, dist(lm[0], lm[9]));
  const curl = (i) => dist(lm[i], lm[0]) / span;
  const tips = [curl(8), curl(12), curl(16), curl(20)];
  // thumbs-up: fingers curled, thumb out and pointing up, well above the index knuckle
  // (in a fist the thumb tip rests over the fingers, below the knuckles)
  const thumbUp = tips.every((t) => t < 1.2) && dist(lm[4], lm[5]) / span > 0.75 && (lm[5].y - lm[4].y) / span > 0.55 && lm[4].y < lm[3].y;
  return {
    span,
    tips,
    pinch: dist(lm[4], lm[8]) / span,
    spread: dist(lm[8], lm[20]) / span, // fingers fanned out like a "stop" sign vs. held together
    open: tips.every((t) => t > 1.45),
    openish: tips.every((t) => t > 1.32),
    fist: tips.every((t) => t < 1.05) && !thumbUp,
    thumbUp,
    peace: tips[0] > 1.45 && tips[1] > 1.45 && tips[2] < 1.15 && tips[3] < 1.15,
    palm: { x: (lm[0].x + lm[9].x) / 2, y: (lm[0].y + lm[9].y) / 2 },
    tip: lm[8],
  };
}

function oneEuro(st, raw, now) {
  const f = st.oe || (st.oe = { t: now, x: raw.x, y: raw.y, dx: 0, dy: 0 });
  let dt = (now - f.t) / 1000;
  if (!(dt > 1 / 240)) dt = 1 / 60;
  if (dt > 0.2) dt = 0.2;
  f.t = now;
  const al = (cut) => { const r = 2 * Math.PI * cut * dt; return r / (r + 1); };
  const ad = al(2.5);
  f.dx += ((raw.x - f.x) / dt - f.dx) * ad;
  f.dy += ((raw.y - f.y) / dt - f.dy) * ad;
  const a = al(1.3 + 0.009 * Math.hypot(f.dx, f.dy));
  f.x += (raw.x - f.x) * a;
  f.y += (raw.y - f.y) * a;
  return { x: f.x, y: f.y };
}

function peakVelocity(tr) {
  let best = { vx: 0, vy: 0, sp: 0 };
  for (let i = 1; i < tr.length; i++) {
    const dt = Math.max(8, tr[i].t - tr[i - 1].t);
    const vx = ((tr[i].x - tr[i - 1].x) / dt) * 16, vy = ((tr[i].y - tr[i - 1].y) / dt) * 16;
    const sp = Math.hypot(vx, vy);
    if (sp > best.sp) best = { vx, vy, sp };
  }
  return best;
}

const fresh = () => ({ present: false, seen: 0, upT: 0, lm: null, m: null, smooth: null, oe: null, trail: [],
  pinch: false, pinchN: 0, pinchT: 0, startPalm: null, last: null, peaceN: 0, fistN: 0, thumbN: 0, palm: null });

/**
 * Turns landmark frames into gesture callbacks. Coordinates handed to handlers
 * are screen pixels. handlers: { cursor(states), pinchStart(i,p), pinchMove(i,p,d),
 * pinchEnd(i,p,info), two(phase,info), peace(i,p), fist(i,p), thumbUp(i,p), palm(phase,i,p,progress) }
 */
export class Gestures {
  constructor(handlers = {}) {
    this.h = handlers;
    this.hands = [fresh(), fresh()];
    this.map = { sx: innerWidth, sy: innerHeight, ox: 0, oy: 0, id: true };
    this.twoActive = null;
    this.lastPeace = -1e9;
    this.lastFist = -1e9;
    this.palmEnabled = true;
  }

  setVideoSize(vw, vh) {
    const W = innerWidth, H = innerHeight;
    if (!vw || !vh) { this.map = { sx: W, sy: H, ox: 0, oy: 0, id: true }; return; }
    const s = Math.max(W / vw, H / vh); // object-fit: cover
    this.map = { sx: vw * s, sy: vh * s, ox: (W - vw * s) / 2, oy: (H - vh * s) / 2, id: false };
  }

  /** landmark (normalised video coords) -> screen px, mirrored like the selfie view (unless the camera mirrors already). */
  px(p) {
    let nx = p.x, ny = p.y;
    if (!this.map.id) { nx = 0.5 + (nx - 0.5) * TUNING.AMP; ny = 0.5 + (ny - 0.5) * TUNING.AMP; }
    const x = nx * this.map.sx + this.map.ox;
    return { x: this.mirror === false && !this.map.id ? x : innerWidth - x, y: ny * this.map.sy + this.map.oy };
  }

  /** Each detection claims the slot whose last palm is nearest, so hand state survives order swaps. */
  assign(lms) {
    const out = [null, null], cand = lms.slice(0, 2), claimed = [false, false];
    const palmPx = (lm) => this.px({ x: (lm[0].x + lm[9].x) / 2, y: (lm[0].y + lm[9].y) / 2 });
    const order = [0, 1].filter((i) => this.hands[i].present && this.hands[i].m).sort((a, b) => this.hands[b].seen - this.hands[a].seen);
    for (const i of order) {
      const last = this.px(this.hands[i].m.palm);
      let bi = -1, bd = 1e9;
      cand.forEach((lm, k) => { if (!lm || claimed[k]) return; const d = dist(palmPx(lm), last); if (d < bd) { bd = d; bi = k; } });
      if (bi >= 0 && bd < 260) { out[i] = cand[bi]; claimed[bi] = true; }
    }
    cand.forEach((lm, k) => {
      if (!lm || claimed[k]) return;
      const slot = out[0] == null && !this.hands[0].present ? 0 : out[1] == null && !this.hands[1].present ? 1 : out[0] == null ? 0 : out[1] == null ? 1 : -1;
      if (slot >= 0) { out[slot] = lm; claimed[k] = true; }
    });
    return out;
  }

  drop(i) {
    const st = this.hands[i];
    if (st.present && st.pinch) this.release(i, st.smooth || { x: 0, y: 0 });
    if (st.palm?.active) this.h.palm?.("end", i, st.smooth, 1);
    else if (st.palm) this.h.palm?.("cancel", i, st.smooth, 0);
    this.hands[i] = fresh();
  }

  reapStale(now = performance.now()) {
    for (let i = 0; i < 2; i++) if (this.hands[i].present && now - this.hands[i].upT > TUNING.STALE_MS) this.drop(i);
    this.emitCursor();
  }

  /** Feed one frame: up to two landmark arrays (already de-ghosted), slot-assigned unless `positional`. */
  ingest(lms, { now = performance.now(), positional = false } = {}) {
    this.now = now;
    const slots = positional ? [lms[0] || null, lms[1] || null] : this.assign(lms.filter(Boolean));
    for (let i = 0; i < 2; i++) {
      const st = this.hands[i];
      let lm = slots[i];
      let m = lm ? handMetrics(lm) : null;
      if (m && m.span < TUNING.SPAN_MIN) { lm = null; m = null; }
      if (!lm) { if (st.present) this.drop(i); continue; }
      st.present = true; st.seen++; st.upT = now; st.lm = lm; st.m = m;
      const cur = (st.smooth = oneEuro(st, this.px(m.tip), now));
      st.trail.push({ ...cur, t: now });
      if (st.trail.length > 10) st.trail.shift();

      // pinch: earn it, hold it with hysteresis
      if (!st.pinch && st.seen >= 3 && m.pinch < TUNING.PINCH_IN && !m.fist) {
        if (++st.pinchN >= TUNING.PINCH_EARN) {
          st.pinch = true; st.pinchT = now; st.startPalm = this.px(m.palm); st.last = { ...cur };
          this.cancelPalm(i);
          this.h.pinchStart?.(i, cur);
        }
      } else if (!st.pinch && m.pinch >= TUNING.PINCH_IN) st.pinchN = 0;
      else if (st.pinch && m.pinch > TUNING.PINCH_OUT) this.release(i, cur);
      else if (st.pinch) {
        const d = { x: cur.x - st.last.x, y: cur.y - st.last.y };
        st.last = { ...cur };
        if (!this.twoActive) this.h.pinchMove?.(i, cur, d);
      }

      // held poses
      if (m.peace && !st.pinch) {
        if (++st.peaceN === TUNING.PEACE_FRAMES && now - this.lastPeace > 2500) { this.lastPeace = now; this.h.peace?.(i, cur); }
      } else st.peaceN = 0;
      if (m.fist && !st.pinch) {
        if (++st.fistN === TUNING.FIST_FRAMES && now - this.lastFist > 1500) { this.lastFist = now; this.h.fist?.(i, cur); }
      } else st.fistN = 0;
      if (m.thumbUp && !st.pinch) {
        if (++st.thumbN === TUNING.THUMB_FRAMES && now - (this.lastThumb || 0) > 2500) { this.lastThumb = now; this.h.thumbUp?.(i, cur); }
      } else st.thumbN = 0;
      this.palmStep(i, st, m, now);
    }
    this.twoHand();
    this.emitCursor();
  }

  palmStep(i, st, m, now) {
    if (!this.palmEnabled) return;
    const p = this.px(m.palm);
    if (st.palm?.active) {
      if (m.openish) st.palm.lastOpen = now;
      else if (now - st.palm.lastOpen > 500) { st.palm = null; this.h.palm?.("end", i, p, 1); }
      return;
    }
    const other = this.hands[1 - i];
    // a deliberate "stop sign": all fingers out AND fanned apart, held still
    if (m.open && m.spread > 1.0 && !st.pinch && !(other.palm?.active)) {
      if (!st.palm) st.palm = { t0: now, x0: p.x, y0: p.y };
      // the hand has to be held still: waving at the screen is not "talk to me"
      if (Math.hypot(p.x - st.palm.x0, p.y - st.palm.y0) > 55) { st.palm = { t0: now, x0: p.x, y0: p.y }; }
      const prog = (now - st.palm.t0) / TUNING.PALM_MS;
      if (prog >= 1) { st.palm = { active: true, lastOpen: now }; this.h.palm?.("start", i, p, 1); }
      else this.h.palm?.("charge", i, p, prog);
    } else this.cancelPalm(i);
  }

  cancelPalm(i) {
    const st = this.hands[i];
    if (st.palm && !st.palm.active) { st.palm = null; this.h.palm?.("cancel", i, st.smooth, 0); }
  }

  release(i, cur) {
    const st = this.hands[i];
    st.pinch = false; st.pinchN = 0;
    const palmNow = st.m ? this.px(st.m.palm) : st.startPalm;
    const quick = (this.now ?? performance.now()) - st.pinchT < TUNING.TAP_MS && st.startPalm && dist(st.startPalm, palmNow) < TUNING.TAP_PX;
    const v = peakVelocity(st.trail);
    this.h.pinchEnd?.(i, cur, { quick, vx: v.vx, vy: v.vy, speed: v.sp, during2: !!this.twoActive });
  }

  twoHand() {
    const [a, b] = this.hands;
    const on = a.present && b.present && a.pinch && b.pinch && dist(a.smooth, b.smooth) > TUNING.TWO_HAND_MIN_PX;
    if (!on) { if (this.twoActive) { this.twoActive = null; this.h.two?.("end", {}); } return; }
    const d = dist(a.smooth, b.smooth), ang = Math.atan2(b.smooth.y - a.smooth.y, b.smooth.x - a.smooth.x);
    const mid = { x: (a.smooth.x + b.smooth.x) / 2, y: (a.smooth.y + b.smooth.y) / 2 };
    if (!this.twoActive) { this.twoActive = { d0: d, a0: ang }; this.h.two?.("start", { mid }); return; }
    const scale = Math.min(1.08, Math.max(0.92, d / Math.max(40, this.twoActive.d0)));
    let rot = ang - this.twoActive.a0;
    if (rot > Math.PI) rot -= 2 * Math.PI;
    if (rot < -Math.PI) rot += 2 * Math.PI;
    this.twoActive = { d0: d, a0: ang };
    this.h.two?.("move", { scale, rot, mid });
  }

  emitCursor() {
    this.h.cursor?.(this.hands.map((st, i) => ({
      i, present: st.present && st.seen >= 3, x: st.smooth?.x ?? 0, y: st.smooth?.y ?? 0, pinch: st.pinch,
      pinchRatio: st.m?.pinch ?? 1, lm: st.lm, palm: st.palm ? (st.palm.active ? 1 : Math.min(1, (performance.now() - st.palm.t0) / TUNING.PALM_MS)) : 0,
      palmActive: !!st.palm?.active,
    })));
  }
}

/**
 * Camera preference when none is chosen in Settings: a phone/tablet bridge (Camo,
 * iVCam, DroidCam, EpocCam, Continuity Camera) first, then real webcams, and
 * virtual feeds (NDI, OBS, ...) last - those are usually not a camera at all.
 */
export function cameraRank(label = "") {
  if (/camo|ivcam|droidcam|epoccam|iphone|ipad|continuity/i.test(label)) return 0;
  if (/\bndi\b|obs|virtual|snap camera|xsplit|manycam|nvidia broadcast|screen/i.test(label)) return 2;
  return 1;
}

/** Webcam + MediaPipe. Calls onFrame(landmarkArrays, videoW, videoH) per new video frame. */
export class HandTracker {
  constructor(video, { onFrame, onStatus }) {
    this.video = video;
    this.onFrame = onFrame;
    this.onStatus = onStatus || (() => {});
    this.landmarker = null;
    this.running = false;
    this.stream = null;
    this.lastT = -1;
  }

  async load() {
    if (this.landmarker) return;
    this.onStatus("loading hand tracking");
    const mp = await import("/vendor/mediapipe/vision_bundle.mjs");
    const files = await mp.FilesetResolver.forVisionTasks("/vendor/mediapipe/wasm");
    let model = "/vendor/mediapipe/hand_landmarker.task";
    try { const r = await fetch(model, { method: "HEAD" }); if (!r.ok) throw 0; }
    catch { model = "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task"; }
    // confidence floors raised off the .5 defaults: a face or shirt fold at .5-.6 is the classic phantom hand
    const opts = (delegate) => ({ baseOptions: { modelAssetPath: model, delegate }, runningMode: "VIDEO", numHands: 2,
      minHandDetectionConfidence: 0.6, minHandPresenceConfidence: 0.6, minTrackingConfidence: 0.6 });
    try { this.landmarker = await mp.HandLandmarker.createFromOptions(files, opts("GPU")); this.delegate = "GPU"; }
    catch (e) { console.warn("[hands] GPU delegate failed, using CPU", e); this.landmarker = await mp.HandLandmarker.createFromOptions(files, opts("CPU")); this.delegate = "CPU"; }
  }

  static async cameras() {
    try { return (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "videoinput"); }
    catch { return []; }
  }

  /** The best camera by label when none is pinned (labels exist once camera permission was granted). */
  static async bestCamera() {
    const cams = (await HandTracker.cameras()).filter((c) => c.label);
    cams.sort((a, b) => cameraRank(a.label) - cameraRank(b.label));
    return cams[0] || null;
  }

  /** cameraId: a deviceId from Settings, or "" for automatic. */
  async start(cameraId = "") {
    if (this.running) return;
    await this.load();
    this.onStatus("waiting for camera");
    const size = { width: { ideal: 1280 }, height: { ideal: 720 } };
    let deviceId = cameraId || (await HandTracker.bestCamera())?.deviceId || "";
    try {
      try {
        this.stream = await navigator.mediaDevices.getUserMedia({ video: deviceId ? { ...size, deviceId: { exact: deviceId } } : { ...size, facingMode: "user" }, audio: false });
      } catch (e) {
        if (!deviceId || (e.name !== "OverconstrainedError" && e.name !== "NotFoundError")) throw e;
        deviceId = ""; // the chosen camera is gone (e.g. Camo closed): take whatever is there
        this.stream = await navigator.mediaDevices.getUserMedia({ video: { ...size, facingMode: "user" }, audio: false });
      }
    } catch (e) {
      const why = e?.name === "NotAllowedError" ? "camera blocked - allow it and retry" : e?.name === "NotFoundError" ? "no camera found" : e?.name === "NotReadableError" ? "camera busy in another app" : `camera unavailable (${e?.name || e})`;
      this.onStatus(why, true);
      throw e;
    }
    // first run: labels only appear after permission, so re-pick if a better camera exists
    const track = this.stream.getVideoTracks()[0];
    this.cameraLabel = track?.label || "";
    this.pinned = !!cameraId;
    if (!cameraId) {
      const best = await HandTracker.bestCamera();
      if (best && best.deviceId !== track?.getSettings().deviceId && cameraRank(best.label) < cameraRank(this.cameraLabel)) {
        for (const t of this.stream.getTracks()) t.stop();
        this.stream = await navigator.mediaDevices.getUserMedia({ video: { ...size, deviceId: { exact: best.deviceId } }, audio: false });
        this.cameraLabel = this.stream.getVideoTracks()[0]?.label || best.label;
      }
    }
    this.video.srcObject = this.stream;
    await this.video.play().catch(() => {});
    this.running = true;
    this.onStatus("hands live", false, this.delegate);
    const tick = () => {
      if (!this.running) return;
      const v = this.video;
      if (v.readyState >= 2 && v.currentTime !== this.lastT && v.videoWidth) {
        this.lastT = v.currentTime;
        let res = null;
        try { res = this.landmarker.detectForVideo(v, performance.now()); } catch (e) { console.warn("[hands]", e); }
        if (res) this.onFrame(dedupe(res, this.prevLive), v.videoWidth, v.videoHeight);
      }
      if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(tick); else requestAnimationFrame(tick);
    };
    tick();
  }

  stop() {
    this.running = false;
    for (const t of this.stream?.getTracks() || []) t.stop();
    this.stream = null;
    this.video.srcObject = null;
  }
}

/**
 * MediaPipe often reports one physical hand twice, slightly offset (a "ghost").
 * Two palms closer than ~1.35 hand spans are one hand: keep the more confident.
 * A second detection much smaller and less confident than the first is noise.
 */
export function dedupe(res) {
  const scores = (res.handedness || res.handednesses || []).map((h) => h?.[0]?.score ?? 1);
  let pair = (res.landmarks || []).map((lm, i) => ({ lm, s: scores[i] ?? 1 })).filter((p) => p.s > 0.5);
  if (pair.length === 2) {
    const P = (p) => ({ x: (p.lm[0].x + p.lm[9].x) / 2, y: (p.lm[0].y + p.lm[9].y) / 2 });
    const S = (p) => Math.hypot(p.lm[0].x - p.lm[9].x, p.lm[0].y - p.lm[9].y);
    const dd = dist(P(pair[0]), P(pair[1]));
    if (dd < Math.max(S(pair[0]), S(pair[1])) * 1.35) pair = [pair[0].s >= pair[1].s ? pair[0] : pair[1]];
    else {
      const [big, small] = S(pair[0]) >= S(pair[1]) ? [pair[0], pair[1]] : [pair[1], pair[0]];
      if (S(small) < S(big) * 0.55 && small.s < 0.9) pair = [big];
    }
  }
  return pair.map((p) => p.lm);
}

/** Synthetic hand in landmark space (for ?sim=1 and the self-test). x,y are landmark coords. */
export function synthHand(x, y, pose = "open", s = 0.09) {
  const lm = [];
  const curled = pose === "fist" || pose === "thumbsup";
  const spread = pose === "open" || pose === "palm" ? 1.0 : curled ? 0.38 : 0.78;
  lm[0] = { x, y: y + s * 0.9 };
  lm[9] = { x, y: y - s * 0.1 };
  lm[1] = { x: x - s * 0.35, y: y + s * 0.55 }; lm[2] = { x: x - s * 0.5, y: y + s * 0.3 }; lm[3] = { x: x - s * 0.55, y: y + s * 0.1 };
  lm[5] = { x: x - s * 0.3, y: y - s * 0.15 }; lm[13] = { x: x + s * 0.15, y: y - s * 0.15 }; lm[17] = { x: x + s * 0.32, y: y - s * 0.1 };
  const ext = pose === "palm" ? 1.25 : 1.05;
  const fan = pose === "palm" ? 2.1 : 1; // palm: fingers fanned wide apart
  const tipY = y - s * (curled ? 0.35 : ext) * spread;
  lm[8] = {
    x: pose === "pinch" ? x - s * 0.18 : pose === "point" ? x - s * 0.28 : x - s * 0.28 * spread * fan,
    y: pose === "pinch" ? y - s * 0.5 : pose === "point" ? y - s * 1.05 : tipY,
  };
  lm[4] = { x: pose === "pinch" ? x - s * 0.16 : x - s * 0.62 * spread, y: pose === "pinch" ? y - s * 0.48 : y + s * 0.05 };
  if (pose === "thumbsup") { lm[2] = { x: x - s * 0.45, y: y - s * 0.05 }; lm[3] = { x: x - s * 0.42, y: y - s * 0.5 }; lm[4] = { x: x - s * 0.4, y: y - s * 0.95 }; }
  const curlY = y - s * 0.133;
  lm[12] = { x: x - s * 0.05, y: pose === "point" ? curlY : tipY };
  lm[16] = { x: x + s * 0.16 * fan, y: (pose === "point" || pose === "peace" ? curlY : tipY) + s * 0.06 };
  lm[20] = { x: x + s * 0.3 * fan, y: (pose === "point" || pose === "peace" ? curlY : tipY) + s * 0.14 };
  for (const [a, b, i] of [[5, 8, 6], [5, 8, 7], [9, 12, 10], [9, 12, 11], [13, 16, 14], [13, 16, 15], [17, 20, 18], [17, 20, 19]]) {
    const p = lm[a], q = lm[b], k = i % 2 ? 0.66 : 0.33;
    lm[i] = { x: p.x + (q.x - p.x) * k, y: p.y + (q.y - p.y) * k };
  }
  return lm;
}

export const HAND_EDGES = [[0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8], [5, 9], [9, 10], [10, 11], [11, 12], [9, 13], [13, 14], [14, 15], [15, 16], [13, 17], [17, 18], [18, 19], [19, 20], [0, 17]];
