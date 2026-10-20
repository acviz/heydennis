// Hologram document windows for folders and files, drawn on a canvas and used as
// textures in the 3D scene: glass panel, bright edge, title strip, bulleted details,
// and (for images and text) a live preview inside the window.
const FONT = `"Bahnschrift", "Segoe UI", "Helvetica Neue", Arial, sans-serif`;
const MONO = `"Cascadia Mono", Consolas, "SF Mono", Menlo, monospace`;
export const CARD_W = 512, CARD_H = 300;

function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.lineTo(x + w - r, y); g.quadraticCurveTo(x + w, y, x + w, y + r);
  g.lineTo(x + w, y + h - r); g.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  g.lineTo(x + r, y + h); g.quadraticCurveTo(x, y + h, x, y + h - r);
  g.lineTo(x, y + r); g.quadraticCurveTo(x, y, x + r, y);
  g.closePath();
}

function fit(g, text, max) {
  if (g.measureText(text).width <= max) return text;
  let lo = 0, hi = text.length;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (g.measureText(text.slice(0, mid) + "…").width <= max) lo = mid; else hi = mid - 1; }
  return text.slice(0, lo) + "…";
}

function rgba(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

/**
 * Draw a hologram window.
 * o: { title, lines[], accent (#hex), folder (bool), tag (small label), thumb (Image|null), snippet (string|null) }
 */
export function drawCard(canvas, o) {
  canvas.width = CARD_W;
  canvas.height = CARD_H;
  const g = canvas.getContext("2d");
  const W = CARD_W, H = CARD_H, pad = 10, top = o.folder ? 30 : 10;
  g.clearRect(0, 0, W, H);
  const x = pad, y = top, w = W - pad * 2, h = H - top - pad;

  // folder tab
  if (o.folder) {
    g.beginPath();
    g.moveTo(x + 14, y + 2); g.lineTo(x + 26, y - 20); g.lineTo(x + 190, y - 20); g.lineTo(x + 206, y + 2); g.closePath();
    g.fillStyle = "rgba(60,110,145,0.22)"; g.fill();
    g.strokeStyle = "rgba(120,175,205,0.75)"; g.lineWidth = 1.5; g.stroke();
  }
  // glass body
  roundRect(g, x, y, w, h, 16);
  const body = g.createLinearGradient(0, y, 0, y + h);
  body.addColorStop(0, "rgba(55,95,125,0.24)");
  body.addColorStop(1, "rgba(15,28,40,0.20)");
  g.fillStyle = body; g.fill();
  g.save();
  g.shadowColor = "rgba(100,165,205,0.6)"; g.shadowBlur = 6;
  g.strokeStyle = "rgba(125,180,212,0.85)"; g.lineWidth = 2; g.stroke();
  g.restore();
  // inner hairline
  roundRect(g, x + 7, y + 7, w - 14, h - 14, 11);
  g.strokeStyle = "rgba(120,170,200,0.16)"; g.lineWidth = 1; g.stroke();
  // corner ticks, HUD style
  g.strokeStyle = "rgba(225,235,242,0.85)"; g.lineWidth = 2.5;
  for (const [cx, cy, dx, dy] of [[x + w - 34, y + 14, 20, 0], [x + w - 14, y + 14, 0, 20]]) { g.beginPath(); g.moveTo(cx, cy); g.lineTo(cx + dx, cy + dy); g.stroke(); }

  // kind accent stripe
  g.fillStyle = rgba(o.accent || "#5f9fc6", 0.9);
  g.fillRect(x + 16, y + 20, 4, 44);

  // title
  g.fillStyle = "rgba(226,236,242,0.96)";
  g.font = `500 34px ${FONT}`;
  g.textBaseline = "top";
  g.fillText(fit(g, String(o.title || "").toUpperCase(), w - 80), x + 32, y + 22);
  if (o.tag) {
    // a small amber tag, the only warm colour on the card
    g.font = `600 16px ${FONT}`;
    const tag = o.tag.toUpperCase(), tw = g.measureText(tag).width + 16;
    g.fillStyle = "rgba(233,161,59,0.9)";
    g.fillRect(x + 32, y + 64, tw, 22);
    g.fillStyle = "rgba(20,14,6,0.95)";
    g.fillText(tag, x + 40, y + 67);
  }

  const contentTop = y + 92;
  if (o.thumb) {
    // a media window inside the card
    const tw = w - 48, th = h - (contentTop - y) - 16;
    const tx = x + 24, ty = contentTop - 4;
    const iw = o.thumb.naturalWidth || o.thumb.width, ih = o.thumb.naturalHeight || o.thumb.height;
    const s = Math.max(tw / iw, th / ih), dw = iw * s, dh = ih * s;
    g.save();
    roundRect(g, tx, ty, tw, th, 8); g.clip();
    g.globalAlpha = 0.9;
    g.drawImage(o.thumb, tx + (tw - dw) / 2, ty + (th - dh) / 2, dw, dh);
    g.globalAlpha = 1;
    g.fillStyle = "rgba(40,90,130,0.2)"; g.fillRect(tx, ty, tw, th); // a cool hologram cast
    g.restore();
    roundRect(g, tx, ty, tw, th, 8);
    g.strokeStyle = "rgba(125,180,212,0.7)"; g.lineWidth = 1.5; g.stroke();
  } else if (o.snippet) {
    g.font = `15px ${MONO}`;
    g.fillStyle = "rgba(170,200,218,0.78)";
    const lines = String(o.snippet).replace(/\t/g, "  ").split(/\r?\n/).filter((l) => l.trim()).slice(0, 6);
    lines.forEach((l, i) => g.fillText(fit(g, l, w - 64), x + 32, contentTop + i * 22));
    g.font = `500 18px ${FONT}`;
    (o.lines || []).slice(0, 1).forEach((l) => { g.fillStyle = "rgba(200,218,228,0.85)"; g.fillText(fit(g, l, w - 64), x + 32, y + h - 34); });
  } else {
    g.font = `500 22px ${FONT}`;
    (o.lines || []).slice(0, 4).forEach((l, i) => {
      const ly = contentTop + i * 34;
      g.fillStyle = rgba(o.accent || "#5f9fc6", 0.9);
      g.fillRect(x + 32, ly + 7, 8, 8);
      g.fillStyle = "rgba(205,220,230,0.9)";
      g.fillText(fit(g, l, w - 90), x + 52, ly);
    });
  }
  return canvas;
}

/** A small tile for big folders, where full windows would pile on top of each other. */
export function drawTile(canvas, accent) {
  canvas.width = 160;
  canvas.height = 100;
  const g = canvas.getContext("2d");
  roundRect(g, 6, 6, 148, 88, 10);
  g.fillStyle = rgba(accent, 0.16); g.fill();
  g.save();
  g.shadowColor = rgba(accent, 0.6); g.shadowBlur = 5;
  g.strokeStyle = rgba(accent, 0.85); g.lineWidth = 2; g.stroke();
  g.restore();
  g.fillStyle = rgba(accent, 0.9);
  g.fillRect(20, 26, 60, 7); g.fillRect(20, 44, 100, 5); g.fillRect(20, 58, 84, 5);
  return canvas;
}
