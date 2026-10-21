// Diagrams D.E.N.N.I.S. draws (the show_diagram tool): Mermaid text in, a themed SVG out, shown
// in a floating window. Mermaid is loaded the first time it's needed (it's big), runs with
// securityLevel "strict" (no scripts, no click handlers, sanitised labels), and draws labels as
// plain SVG text, so a saved copy looks the same in any viewer.
let mermaidP = null;
const load = () => (mermaidP ||= import("/vendor/mermaid/mermaid.esm.min.mjs").then((m) => m.default));
let seq = 0;
let queue = Promise.resolve(); // Mermaid renders one diagram at a time

// the HUD's colours (they follow the theme); Mermaid wants hex
const hex = (c, fallback) => {
  c = String(c || "").trim();
  const m = /rgba?\(([^)]+)\)/.exec(c);
  if (!m) return c || fallback;
  return "#" + m[1].split(/[\s,/]+/).slice(0, 3).map((x) => Math.round(+x).toString(16).padStart(2, "0")).join("");
};
function palette() {
  const cs = getComputedStyle(document.body);
  return { line: hex(cs.getPropertyValue("--cyan"), "#6fb3d9"), text: hex(cs.getPropertyValue("--text"), "#d5e3ea"), muted: hex(cs.getPropertyValue("--muted"), "#7d93a0"), accent: hex(cs.getPropertyValue("--amber"), "#e9a13b") };
}

/** Mermaid text -> SVG markup. Throws Mermaid's own message when the syntax is wrong. */
export function renderDiagram(code) {
  const run = async () => {
    const mermaid = await load();
    const p = palette();
    const deep = "#0b1f2e", deeper = "#08141d", panel = "#0d2738";
    mermaid.initialize({
      startOnLoad: false, securityLevel: "strict", suppressErrorRendering: true, theme: "base", htmlLabels: false,
      fontFamily: '"Bahnschrift", "Segoe UI", sans-serif',
      flowchart: { htmlLabels: false, curve: "basis", padding: 12, nodeSpacing: 46, rankSpacing: 56 },
      gantt: { useWidth: 1000, fontSize: 14, sectionFontSize: 14, barHeight: 26, barGap: 6, topPadding: 56, leftPadding: 120, gridLineStartPadding: 40 }, // Mermaid's defaults are tiny
      themeVariables: {
        darkMode: true, background: "#05090d", fontFamily: '"Bahnschrift", "Segoe UI", sans-serif', fontSize: "15px",
        primaryColor: panel, primaryTextColor: p.text, primaryBorderColor: p.line,
        secondaryColor: deep, secondaryTextColor: p.text, secondaryBorderColor: p.muted,
        tertiaryColor: deeper, tertiaryTextColor: p.text, tertiaryBorderColor: p.muted,
        mainBkg: panel, nodeBorder: p.line, lineColor: p.line, textColor: p.text, titleColor: p.text,
        clusterBkg: deeper, clusterBorder: p.muted, edgeLabelBackground: "#071019",
        noteBkgColor: "#1a2733", noteTextColor: p.text, noteBorderColor: p.accent,
        actorBkg: panel, actorBorder: p.line, actorTextColor: p.text, actorLineColor: p.muted, signalColor: p.line, signalTextColor: p.text,
        labelBoxBkgColor: panel, labelBoxBorderColor: p.line, labelTextColor: p.text, loopTextColor: p.text,
        activationBkgColor: "#133047", activationBorderColor: p.line, sequenceNumberColor: "#05090d",
        sectionBkgColor: panel, altSectionBkgColor: deeper, sectionBkgColor2: "#10283a",
        taskBkgColor: "#16405c", taskBorderColor: p.line, taskTextColor: p.text, taskTextLightColor: p.text, taskTextDarkColor: p.text, taskTextOutsideColor: p.text,
        activeTaskBkgColor: "#1d5578", activeTaskBorderColor: p.accent, doneTaskBkgColor: "#13303f", doneTaskBorderColor: p.muted,
        critBkgColor: "#4a2326", critBorderColor: "#d96c6c", gridColor: "#1c3344", todayLineColor: p.accent,
      },
    });
    await mermaid.parse(code);
    const { svg } = await mermaid.render(`dennis-diagram-${++seq}`, code);
    return svg;
  };
  const p = queue.then(run, run);
  queue = p.catch(() => {});
  return p;
}

/** The drawing as a file of its own: real pixel size and a dark backdrop (its text is light). */
export function standaloneSvg(svgText) {
  const doc = new DOMParser().parseFromString(svgText, "image/svg+xml");
  const svg = doc.documentElement;
  const [x, y, w, h] = (svg.getAttribute("viewBox") || "0 0 800 600").split(/[\s,]+/).map(Number);
  svg.setAttribute("width", String(Math.ceil(w)));
  svg.setAttribute("height", String(Math.ceil(h)));
  svg.removeAttribute("style");
  const bg = doc.createElementNS("http://www.w3.org/2000/svg", "rect");
  for (const [k, v] of Object.entries({ x, y, width: w, height: h, fill: "#05090d" })) bg.setAttribute(k, String(v));
  svg.insertBefore(bg, svg.firstChild);
  return { text: new XMLSerializer().serializeToString(svg), w, h };
}

/** A PNG of the drawing (base64), at `scale` x its size. */
export async function toPng(svgText, scale = 2) {
  const { text, w, h } = standaloneSvg(svgText);
  const url = URL.createObjectURL(new Blob([text], { type: "image/svg+xml" }));
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = Math.ceil(w * scale);
    c.height = Math.ceil(h * scale);
    const g = c.getContext("2d");
    g.scale(scale, scale);
    g.drawImage(img, 0, 0, w, h);
    return c.toDataURL("image/png").split(",")[1];
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Scale a drawing to its stage: as large as fits, but never so small the text can't be read (it scrolls instead). */
export const MIN_SCALE = 0.85, MAX_SCALE = 1.6;
export function fitScale(nat, w, h) { return Math.max(MIN_SCALE, Math.min(MAX_SCALE, w / nat.w, h / nat.h)); }

/** The drawing's natural size, from its viewBox. */
export function diagramSize(svgText) {
  const vb = /viewBox="([^"]+)"/.exec(svgText)?.[1].split(/[\s,]+/).map(Number);
  return vb && vb[2] > 0 && vb[3] > 0 ? { w: vb[2], h: vb[3] } : null;
}
