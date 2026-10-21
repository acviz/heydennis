// The document reader: PDF, Word, Excel / CSV, PowerPoint and Markdown drawn inside a file window.
//
// Everything is rendered here in the page from the file's bytes (fetched from /api/raw), so the
// raw-file responses keep their strict sandbox CSP and the page keeps cross-origin isolation.
//   PDF        -> PDF.js (vendored): pages drawn on canvases as you scroll, zoom, page counter
//   .docx      -> mammoth (vendored): headings, lists, tables, images as a formatted page
//   .xlsx/.csv -> our own reader: a grid with column letters, row numbers, merged cells, sheet tabs
//   .pptx      -> our own reader: each slide laid out from its shapes, text boxes, pictures, tables
//   .md        -> marked (vendored): formatted text (raw HTML in the file is shown as text)
// The .pbody stays the scroll container, so a pinch-drag scrolls the document like any window.

export const READABLE = /\.(pdf|docx|xlsx|xlsm|csv|tsv|pptx|md|markdown)$/i;

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const ext = (name) => name.toLowerCase().split(".").pop();
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/**
 * Fill `body` (a window's .pbody) with a reader for `item`. Returns { dispose() } or null when
 * this kind of file has no reader. Throws when the file can't be read (the caller falls back).
 */
export async function openReader(body, item, url, { rawUrl } = {}) {
  const kind = ext(item.name);
  const ctl = { disposers: [], disposed: false, body, item, url, rawUrl };
  ctl.onDispose = (fn) => ctl.disposers.push(fn);
  const dispose = () => { if (ctl.disposed) return; ctl.disposed = true; for (const fn of ctl.disposers) { try { fn(); } catch { /* closing anyway */ } } };
  body.classList.add("reader");
  try {
    if (kind === "pdf") await pdfReader(ctl);
    else if (kind === "docx") await docxReader(ctl);
    else if (kind === "xlsx" || kind === "xlsm") await xlsxReader(ctl);
    else if (kind === "csv" || kind === "tsv") await csvReader(ctl, kind);
    else if (kind === "pptx") await pptxReader(ctl);
    else if (kind === "md" || kind === "markdown") await markdownReader(ctl);
    else { body.classList.remove("reader"); return null; }
  } catch (e) { dispose(); body.classList.remove("reader"); throw e; }
  return { dispose };
}

// ---------------------------------------------------------------- shared bits
async function fetchBytes(url) {
  const res = await fetch(url, { credentials: "same-origin" });
  if (!res.ok) throw new Error(`couldn't read the file (${res.status})`);
  return res.arrayBuffer();
}

/** The toolbar along the top of a reader: a label on the left, zoom buttons (optional) on the right. */
function toolbar(ctl, { zoom = null, extra = "" } = {}) {
  const bar = document.createElement("div");
  bar.className = "rd-bar";
  bar.innerHTML = `<span class="rd-label"></span>${extra}<span class="rd-sp"></span>` + (zoom ? `
    <button type="button" data-z="out" title="Zoom out">&minus;</button>
    <button type="button" data-z="fit" class="rd-zl" title="Fit to width">FIT</button>
    <button type="button" data-z="in" title="Zoom in">+</button>` : "");
  ctl.body.querySelector(".rd-loading")?.remove();
  ctl.body.appendChild(bar);
  const label = bar.querySelector(".rd-label");
  if (zoom) {
    const show = () => { bar.querySelector(".rd-zl").textContent = zoom.fit ? "FIT" : `${Math.round(zoom.level * 100)}%`; };
    bar.addEventListener("click", (e) => {
      const b = e.target.closest("[data-z]");
      if (!b) return;
      const z = b.dataset.z;
      zoom.set(z === "fit" ? null : clamp(zoom.level * (z === "in" ? 1.25 : 0.8), 0.25, 5));
      show();
    });
    zoom.show = show;
    show();
  }
  return { bar, label };
}

/** Drop anything active from converted HTML (it comes from a file, so it's data, not a page). */
function sanitize(html) {
  const t = document.createElement("template");
  t.innerHTML = html;
  t.content.querySelectorAll("script, style, iframe, frame, object, embed, link, meta, base, form, input, button, textarea, select, svg foreignObject").forEach((n) => n.remove());
  for (const el of t.content.querySelectorAll("*")) {
    for (const a of [...el.attributes]) {
      const n = a.name.toLowerCase();
      if (n.startsWith("on") || n === "srcdoc" || n === "formaction" || n === "action") el.removeAttribute(a.name);
      else if ((n === "href" || n === "src" || n === "xlink:href") && /^\s*(javascript|vbscript|data:(?!image\/))/i.test(a.value)) el.removeAttribute(a.name);
    }
  }
  return t.content;
}

/** Links in a document: web links open in the real browser, #anchors scroll inside the reader. */
function wireLinks(ctl, root) {
  root.addEventListener("click", (e) => {
    const a = e.target.closest("a[href]");
    if (!a) return;
    e.preventDefault();
    const href = a.getAttribute("href") || "";
    if (href.startsWith("#")) {
      const id = decodeURIComponent(href.slice(1));
      const target = root.querySelector(`[id="${CSS.escape(id)}"], a[name="${CSS.escape(id)}"]`);
      target?.scrollIntoView({ block: "start", behavior: "smooth" });
    } else if (/^(https?:|mailto:)/i.test(href)) window.open(href, "_blank", "noopener");
  });
}

/** CSS zoom for HTML-based readers (Word, Markdown, sheets, slides). */
function cssZoom(ctl, el, { fitWidth = null } = {}) {
  const zoom = {
    level: 1, fit: !!fitWidth,
    set(v) {
      zoom.fit = v == null && !!fitWidth;
      zoom.level = v == null ? (fitWidth ? fitWidth() : 1) : v;
      el.style.zoom = String(zoom.level);
      el.style.setProperty("--z", String(zoom.level));
    },
  };
  if (fitWidth) {
    const ro = new ResizeObserver(() => { if (zoom.fit) { zoom.set(null); zoom.show?.(); } });
    ro.observe(ctl.body);
    ctl.onDispose(() => ro.disconnect());
  }
  zoom.set(fitWidth ? null : 1);
  return zoom;
}

// ---------------------------------------------------------------- zip (Office files are zips of XML)
const NS = {
  a: "http://schemas.openxmlformats.org/drawingml/2006/main",
  p: "http://schemas.openxmlformats.org/presentationml/2006/main",
  r: "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
  s: "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
  rel: "http://schemas.openxmlformats.org/package/2006/relationships",
};

async function unzip(buf) {
  const u8 = new Uint8Array(buf), dv = new DataView(buf), td = new TextDecoder();
  let eocd = -1;
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 22 - 65535); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error("this file isn't a valid Office document");
  const count = dv.getUint16(eocd + 10, true);
  let off = dv.getUint32(eocd + 16, true);
  const files = new Map();
  for (let n = 0; n < count && off + 46 <= u8.length; n++) {
    if (dv.getUint32(off, true) !== 0x02014b50) break;
    const method = dv.getUint16(off + 10, true), csize = dv.getUint32(off + 20, true);
    const nameLen = dv.getUint16(off + 28, true), extraLen = dv.getUint16(off + 30, true), commentLen = dv.getUint16(off + 32, true);
    const local = dv.getUint32(off + 42, true);
    files.set(td.decode(u8.subarray(off + 46, off + 46 + nameLen)), { method, csize, local });
    off += 46 + nameLen + extraLen + commentLen;
  }
  const cache = new Map();
  const bytes = async (name) => {
    name = name.replace(/^\/+/, "");
    const f = files.get(name);
    if (!f) return null;
    if (cache.has(name)) return cache.get(name);
    const start = f.local + 30 + dv.getUint16(f.local + 26, true) + dv.getUint16(f.local + 28, true);
    const data = u8.subarray(start, start + f.csize);
    let out = null;
    if (f.method === 0) out = data.slice();
    else if (f.method === 8) out = new Uint8Array(await new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).arrayBuffer());
    cache.set(name, out);
    return out;
  };
  return {
    names: [...files.keys()],
    bytes,
    async text(name) { const b = await bytes(name); return b ? td.decode(b) : null; },
    async xml(name) { const t = await this.text(name); return t ? new DOMParser().parseFromString(t, "application/xml") : null; },
  };
}

/** "ppt/slides" + "../media/image1.png" -> "ppt/media/image1.png" */
function resolvePath(dir, target) {
  if (target.startsWith("/")) return target.slice(1);
  const parts = dir ? dir.split("/") : [];
  for (const seg of target.split("/")) {
    if (seg === "..") parts.pop();
    else if (seg && seg !== ".") parts.push(seg);
  }
  return parts.join("/");
}
const dirOf = (p) => p.split("/").slice(0, -1).join("/");

/** A part's relationships: rId -> { target (resolved path), type, external } */
async function rels(zip, part) {
  const doc = await zip.xml(`${dirOf(part)}/_rels/${part.split("/").pop()}.rels`);
  const map = new Map();
  if (!doc) return map;
  for (const r of doc.getElementsByTagNameNS(NS.rel, "Relationship")) {
    const external = r.getAttribute("TargetMode") === "External";
    const target = r.getAttribute("Target") || "";
    map.set(r.getAttribute("Id"), { target: external ? target : resolvePath(dirOf(part), target), type: r.getAttribute("Type") || "", external });
  }
  return map;
}

const kids = (el, ns, name) => (el ? [...el.children].filter((c) => c.namespaceURI === ns && c.localName === name) : []);
const kid = (el, ns, name) => kids(el, ns, name)[0] || null;
const desc = (el, ns, name) => (el ? el.getElementsByTagNameNS(ns, name)[0] || null : null);

const IMG_MIME = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", bmp: "image/bmp", svg: "image/svg+xml", webp: "image/webp", tif: "image/tiff", tiff: "image/tiff", emf: "", wmf: "" };
async function blobUrl(ctl, zip, path) {
  const mime = IMG_MIME[ext(path)];
  if (!mime) return null; // EMF/WMF can't be drawn by a browser
  const b = await zip.bytes(path);
  if (!b) return null;
  const u = URL.createObjectURL(new Blob([b], { type: mime }));
  ctl.onDispose(() => URL.revokeObjectURL(u));
  return u;
}

// ---------------------------------------------------------------- PDF (PDF.js)
let pdfjsLib = null;
async function pdfjs() {
  if (!pdfjsLib) {
    pdfjsLib = await import("/vendor/pdfjs/pdf.min.mjs");
    pdfjsLib.GlobalWorkerOptions.workerSrc = "/vendor/pdfjs/pdf.worker.min.mjs";
  }
  return pdfjsLib;
}

async function pdfReader(ctl) {
  const lib = await pdfjs();
  const task = lib.getDocument({
    url: ctl.url, cMapUrl: "/vendor/pdfjs/cmaps/", cMapPacked: true, standardFontDataUrl: "/vendor/pdfjs/standard_fonts/",
    wasmUrl: "/vendor/pdfjs/wasm/", iccUrl: "/vendor/pdfjs/iccs/", enableXfa: false,
  });
  ctl.onDispose(() => task.destroy());
  let doc;
  try { doc = await task.promise; } catch (e) {
    throw new Error(e?.name === "PasswordException" ? "this PDF is password-protected" : `couldn't open this PDF (${e?.message || e})`);
  }
  if (ctl.disposed) return;
  const n = doc.numPages;
  const first = await doc.getPage(1);
  const base = first.getViewport({ scale: 1 });
  const sizes = new Array(n).fill(null).map(() => ({ w: base.width, h: base.height }));
  const pagesEl = document.createElement("div");
  pagesEl.className = "rd-pages";
  const avail = () => Math.max(120, ctl.body.clientWidth - 28);
  const zoom = {
    level: 1, fit: true,
    set(v) {
      zoom.fit = v == null;
      zoom.level = v == null ? avail() / base.width : v;
      layout();
    },
  };
  const { label } = toolbar(ctl, { zoom });
  ctl.body.appendChild(pagesEl);
  const slots = [];
  for (let i = 0; i < n; i++) {
    const s = document.createElement("div");
    s.className = "rd-page";
    s.dataset.page = String(i + 1);
    pagesEl.appendChild(s);
    slots.push({ el: s, rendered: 0, task: null, busy: false, visible: false });
  }
  const render = async (i) => {
    const slot = slots[i];
    if (!slot.visible || slot.busy || slot.rendered === zoom.level) return;
    slot.busy = true;
    const want = zoom.level;
    try {
      const page = i === 0 ? first : await doc.getPage(i + 1);
      if (ctl.disposed) return;
      const vp = page.getViewport({ scale: want });
      sizes[i] = { w: vp.width / want, h: vp.height / want };
      // windows float in the 3D scene and can be shown larger than their own size: draw for what's on screen
      const shown = ctl.body.getBoundingClientRect().width / (ctl.body.offsetWidth || 1);
      const dpr = Math.min(3, (window.devicePixelRatio || 1) * clamp(shown || 1, 1, 2));
      const canvas = document.createElement("canvas");
      canvas.width = Math.floor(vp.width * dpr);
      canvas.height = Math.floor(vp.height * dpr);
      slot.task = page.render({ canvasContext: canvas.getContext("2d"), viewport: vp, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null });
      try { await slot.task.promise; } catch (e) { if (e?.name !== "RenderingCancelledException") console.warn("[reader] page", i + 1, e); return; }
      if (ctl.disposed || !slot.visible || zoom.level !== want) return; // finally{} below redraws if it's still wanted
      slot.el.style.width = `${vp.width}px`; slot.el.style.height = `${vp.height}px`;
      slot.el.replaceChildren(canvas);
      slot.rendered = want;
    } finally {
      slot.task = null; slot.busy = false;
      if (!ctl.disposed && slot.visible && slot.rendered !== zoom.level) queueMicrotask(() => render(i)); // zoom changed meanwhile
    }
  };
  const release = (i) => { // pages far off screen give their canvas back, so long PDFs stay light
    const slot = slots[i];
    slot.visible = false;
    slot.task?.cancel();
    if (slot.rendered) { slot.el.replaceChildren(); slot.rendered = 0; }
  };
  const io = new IntersectionObserver((entries) => {
    for (const en of entries) {
      const i = +en.target.dataset.page - 1;
      if (en.isIntersecting) { slots[i].visible = true; render(i); } else release(i);
    }
  }, { root: ctl.body, rootMargin: "1200px 0px" });
  slots.forEach((s) => io.observe(s.el));
  ctl.onDispose(() => { io.disconnect(); for (const s of slots) s.task?.cancel(); doc.destroy(); });
  function layout() {
    slots.forEach((s, i) => {
      s.el.style.width = `${sizes[i].w * zoom.level}px`;
      s.el.style.height = `${sizes[i].h * zoom.level}px`;
      render(i); // visible pages redraw sharp at the new size (the old drawing stretches until then)
    });
  }
  // page counter follows the scroll
  const counter = () => {
    const b = ctl.body, line = b.scrollTop + b.clientHeight * 0.35;
    let cur = 1;
    for (const s of slots) { if (s.el.offsetTop <= line) cur = +s.el.dataset.page; else break; }
    if (b.scrollTop > 0 && b.scrollTop + b.clientHeight >= b.scrollHeight - 2) cur = n; // scrolled to the end
    label.textContent = `PAGE ${cur} / ${n}`;
  };
  ctl.body.addEventListener("scroll", counter, { passive: true });
  ctl.onDispose(() => ctl.body.removeEventListener("scroll", counter));
  const ro = new ResizeObserver(() => { if (zoom.fit) { zoom.set(null); zoom.show?.(); } counter(); });
  ro.observe(ctl.body);
  ctl.onDispose(() => ro.disconnect());
  zoom.set(null);
  zoom.show?.();
  counter();
}

// ---------------------------------------------------------------- Word (mammoth)
let mammothLoad = null;
function mammoth() {
  mammothLoad ||= new Promise((resolve, reject) => {
    if (window.mammoth) return resolve(window.mammoth);
    const s = document.createElement("script");
    s.src = "/vendor/mammoth/mammoth.browser.min.js";
    s.onload = () => (window.mammoth ? resolve(window.mammoth) : reject(new Error("the Word reader didn't load")));
    s.onerror = () => { mammothLoad = null; reject(new Error("the Word reader is missing - run the installer again")); };
    document.head.appendChild(s);
  });
  return mammothLoad;
}

async function docxReader(ctl) {
  const [lib, buf] = await Promise.all([mammoth(), fetchBytes(ctl.url)]);
  const convert = (opts) => lib.convertToHtml({ arrayBuffer: buf }, opts).catch(() => {
    throw new Error("this Word file looks damaged, or it's an older .doc renamed to .docx");
  });
  const { value } = await convert({ styleMap: [
    "p[style-name='Title'] => h1.rd-title:fresh",
    "p[style-name='Subtitle'] => p.rd-subtitle:fresh",
    "p[style-name='Quote'] => blockquote > p:fresh",
    "p[style-name='Intense Quote'] => blockquote > p:fresh",
  ] });
  if (ctl.disposed) return;
  const page = document.createElement("article");
  page.className = "rd-doc";
  page.appendChild(sanitize(value || "<p><i>This document is empty.</i></p>"));
  wireLinks(ctl, page);
  const wrap = document.createElement("div");
  wrap.className = "rd-docwrap";
  wrap.appendChild(page);
  const zoom = cssZoom(ctl, wrap);
  const { label } = toolbar(ctl, { zoom });
  const words = (page.textContent.match(/\S+/g) || []).length;
  label.textContent = `WORD DOCUMENT · ${words.toLocaleString()} WORDS`;
  ctl.body.appendChild(wrap);
}

// ---------------------------------------------------------------- Markdown (marked)
let markedLib = null;
async function markdownReader(ctl) {
  if (!markedLib) {
    const { Marked } = await import("/vendor/marked/marked.esm.js");
    markedLib = new Marked({ gfm: true });
    markedLib.use({ renderer: { html: (tok) => esc(typeof tok === "string" ? tok : tok.text) } }); // raw HTML in a file stays text
  }
  const text = new TextDecoder().decode(await fetchBytes(ctl.url));
  if (ctl.disposed) return;
  const page = document.createElement("article");
  page.className = "rd-doc rd-md";
  page.appendChild(sanitize(markedLib.parse(text)));
  // pictures next to the file (relative paths) come through the same raw-file gate as everything else
  const sep = ctl.item.path.includes("\\") ? "\\" : "/";
  const dir = ctl.item.path.slice(0, ctl.item.path.lastIndexOf(sep));
  for (const img of page.querySelectorAll("img[src]")) {
    const src = img.getAttribute("src");
    if (/^(data:image\/|blob:)/i.test(src)) continue;
    if (/^[a-z]+:/i.test(src) || src.startsWith("//")) { img.replaceWith(Object.assign(document.createElement("span"), { className: "rd-noimg", textContent: `[image: ${img.alt || src}]` })); continue; }
    img.src = ctl.rawUrl(dir + sep + decodeURIComponent(src).replace(/[\\/]/g, sep));
  }
  wireLinks(ctl, page);
  const wrap = document.createElement("div");
  wrap.className = "rd-docwrap";
  wrap.appendChild(page);
  const zoom = cssZoom(ctl, wrap);
  const { label } = toolbar(ctl, { zoom });
  label.textContent = "MARKDOWN";
  ctl.body.appendChild(wrap);
}

// ---------------------------------------------------------------- spreadsheets (xlsx, csv, tsv)
const MAX_ROWS = 2000, MAX_COLS = 80;
const colName = (i) => { let s = ""; for (i++; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s; return s; };
const colIndex = (letters) => { let n = 0; for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1; };
const parseRef = (ref) => { const m = /^([A-Z]+)(\d+)$/.exec(ref || ""); return m ? { c: colIndex(m[1]), r: +m[2] - 1 } : null; };

/** A sheet: { name, rows: [[{ v, num }]], merges: [{ r, c, rs, cs }], widths: [px] } drawn as a grid. */
function gridTable(sheet) {
  const nRows = Math.min(MAX_ROWS, sheet.rows.length);
  let nCols = 0;
  for (let r = 0; r < nRows; r++) nCols = Math.max(nCols, sheet.rows[r]?.length || 0);
  nCols = Math.min(MAX_COLS, Math.max(nCols, 1));
  const covered = new Set(), span = new Map();
  for (const m of sheet.merges || []) {
    span.set(`${m.r},${m.c}`, m);
    for (let r = m.r; r < m.r + m.rs; r++) for (let c = m.c; c < m.c + m.cs; c++) if (r !== m.r || c !== m.c) covered.add(`${r},${c}`);
  }
  let html = `<table class="rd-grid"><colgroup><col class="rd-rh">`;
  for (let c = 0; c < nCols; c++) html += `<col style="width:${sheet.widths?.[c] || 96}px">`;
  html += `</colgroup><thead><tr><th class="rd-corner"></th>`;
  for (let c = 0; c < nCols; c++) html += `<th>${colName(c)}</th>`;
  html += `</tr></thead><tbody>`;
  for (let r = 0; r < nRows; r++) {
    const row = sheet.rows[r] || [];
    html += `<tr><th>${r + 1}</th>`;
    for (let c = 0; c < nCols; c++) {
      if (covered.has(`${r},${c}`)) continue;
      const cell = row[c];
      const m = span.get(`${r},${c}`);
      const attrs = (m ? `${m.rs > 1 ? ` rowspan="${m.rs}"` : ""}${m.cs > 1 ? ` colspan="${m.cs}"` : ""}` : "") + (cell?.num ? ` class="n"` : cell?.bold ? ` class="b"` : "");
      html += `<td${attrs}>${cell ? esc(cell.v) : ""}</td>`;
    }
    html += `</tr>`;
  }
  html += `</tbody></table>`;
  const more = sheet.rows.length > MAX_ROWS ? ` · first ${MAX_ROWS.toLocaleString()} of ${sheet.rows.length.toLocaleString()} rows` : "";
  return { html, more };
}

function sheetReader(ctl, sheets, kindLabel) {
  const tabs = sheets.length > 1 ? `<span class="rd-tabs">${sheets.map((s, i) => `<button type="button" data-sheet="${i}">${esc(s.name)}</button>`).join("")}</span>` : "";
  const wrap = document.createElement("div");
  wrap.className = "rd-sheet";
  const zoom = cssZoom(ctl, wrap);
  const { bar, label } = toolbar(ctl, { zoom, extra: tabs });
  ctl.body.appendChild(wrap);
  wrap.style.setProperty("--rd-top", `${bar.offsetHeight}px`);
  const show = (i) => {
    const s = sheets[i];
    const { html, more } = gridTable(s);
    wrap.innerHTML = html;
    const rows = s.rows.length;
    let cols = 0;
    for (const r of s.rows) cols = Math.max(cols, r?.length || 0);
    label.textContent = `${kindLabel}${sheets.length > 1 ? "" : ` · ${esc(s.name)}`} · ${rows.toLocaleString()} ROWS × ${cols} COLS${more}`.toUpperCase();
    bar.querySelectorAll("[data-sheet]").forEach((b) => b.classList.toggle("on", +b.dataset.sheet === i));
    ctl.body.scrollTop = 0; ctl.body.scrollLeft = 0;
  };
  bar.addEventListener("click", (e) => { const b = e.target.closest("[data-sheet]"); if (b) show(+b.dataset.sheet); });
  show(0);
}

const DATE_FMT_IDS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);
const BUILTIN_FMT = { 1: "0", 2: "0.00", 3: "#,##0", 4: "#,##0.00", 9: "0%", 10: "0.00%", 11: "0.00E+00", 37: "#,##0", 38: "#,##0", 39: "#,##0.00", 40: "#,##0.00", 48: "##0.0E+0" };
/** The common parts of an Excel number format: decimals, thousands separators, %, E, currency or text around it. */
function formatNumber(v, code) {
  const sections = (code || "").split(";");
  let sec = sections[0];
  if (v < 0 && sections[1]) { sec = sections[1]; v = Math.abs(v); }
  else if (v === 0 && sections[2]) sec = sections[2];
  if (!sec || /^general$/i.test(sec.trim())) return String(+v.toPrecision(11));
  const lit = [];
  const body = sec.replace(/\[\$([^-\]]*)[^\]]*\]/g, (_, cur) => { lit.push(cur); return `\u0001${String.fromCharCode(65 + lit.length - 1)}\u0001`; })
    .replace(/"([^"]*)"/g, (_, t) => { lit.push(t); return `\u0001${String.fromCharCode(65 + lit.length - 1)}\u0001`; })
    .replace(/\\(.)/g, (_, t) => { lit.push(t); return `\u0001${String.fromCharCode(65 + lit.length - 1)}\u0001`; })
    .replace(/\[[^\]]*\]|_.|\*./g, "");
  const m = /[#0?][#0?,]*(\.[#0?]+)?(E[+-]0+)?%?/i.exec(body);
  if (!m) return String(+v.toPrecision(11));
  const pat = m[0];
  const dec = (/\.([#0?]+)/.exec(pat)?.[1] || "").length;
  let out;
  if (/E/i.test(pat)) out = v.toExponential(dec).toUpperCase().replace(/E([+-])(\d)$/, "E$10$2");
  else {
    const pctN = (pat.match(/%/g) || []).length;
    const val = v * 100 ** pctN;
    out = val.toLocaleString("en-US", { minimumFractionDigits: dec, maximumFractionDigits: dec, useGrouping: /[#0],[#0]/.test(pat) }) + "%".repeat(pctN);
  }
  const around = body.replace(pat, "\u0002").replace(/\u0001([A-Z])\u0001/g, (_, ch) => lit[ch.charCodeAt(0) - 65]); // letters, so the number pattern never sees digits in them
  const [pre, post = ""] = around.split("\u0002");
  return (pre + out + post).replace(/[()]/g, (ch) => (sections[1] && sec === sections[1] ? ch : "")).trim();
}
function excelValue(raw, fmt, date1904) {
  const v = Number(raw);
  if (!Number.isFinite(v)) return { v: raw };
  if (fmt.date) {
    const ms = Math.round((v - (date1904 ? 24107 : 25569)) * 86400000);
    const d = new Date(ms);
    if (!Number.isNaN(d.getTime())) {
      const iso = d.toISOString();
      const hasTime = Math.abs(v % 1) > 1e-9, hasDate = Math.abs(v) >= 1;
      return { v: hasDate ? (hasTime && fmt.time ? `${iso.slice(0, 10)} ${iso.slice(11, 16)}` : iso.slice(0, 10)) : iso.slice(11, 16), num: true };
    }
  }
  return { v: formatNumber(v, fmt.code), num: true };
}

async function xlsxReader(ctl) {
  const zip = await unzip(await fetchBytes(ctl.url));
  const wb = await zip.xml("xl/workbook.xml");
  if (!wb) throw new Error("this workbook has no sheets I can read");
  const date1904 = ["1", "true"].includes(desc(wb, NS.s, "workbookPr")?.getAttribute("date1904"));
  const wbRels = await rels(zip, "xl/workbook.xml");
  const shared = [];
  const ss = await zip.xml("xl/sharedStrings.xml");
  if (ss) for (const si of ss.getElementsByTagNameNS(NS.s, "si")) shared.push([...si.getElementsByTagNameNS(NS.s, "t")].map((t) => t.textContent).join(""));
  // number formats: which style indexes are dates / times / percentages
  const fmts = [];
  const st = await zip.xml("xl/styles.xml");
  if (st) {
    const custom = new Map([...st.getElementsByTagNameNS(NS.s, "numFmt")].map((f) => [+f.getAttribute("numFmtId"), f.getAttribute("formatCode") || ""]));
    const fonts = [...(desc(st, NS.s, "fonts")?.children || [])].map((f) => !!kid(f, NS.s, "b"));
    for (const xf of kids(desc(st, NS.s, "cellXfs"), NS.s, "xf")) {
      const id = +xf.getAttribute("numFmtId") || 0;
      const code = (custom.get(id) || "").replace(/"[^"]*"|\[[^\]]*\]|\\./g, "");
      fmts.push({
        code: custom.get(id) || BUILTIN_FMT[id] || "",
        date: DATE_FMT_IDS.has(id) || /[dy]/i.test(code) || (/m/i.test(code) && /[dyh]/i.test(code)),
        time: [18, 19, 20, 21, 22, 45, 46, 47].includes(id) || /h/i.test(code),
        percent: id === 9 || id === 10 || code.includes("%"),
        bold: fonts[+xf.getAttribute("fontId") || 0] || false,
      });
    }
  }
  const sheets = [];
  for (const s of desc(wb, NS.s, "sheets")?.children || []) {
    if (s.localName !== "sheet") continue;
    const rel = wbRels.get(s.getAttributeNS(NS.r, "id"));
    const doc = rel && (await zip.xml(rel.target));
    if (!doc) continue;
    const rows = [];
    let r = -1;
    for (const row of doc.getElementsByTagNameNS(NS.s, "row")) {
      r = row.getAttribute("r") ? +row.getAttribute("r") - 1 : r + 1;
      if (r >= MAX_ROWS) { rows.length = Math.max(rows.length, r + 1); continue; }
      const out = (rows[r] = []);
      let c = -1;
      for (const cell of kids(row, NS.s, "c")) {
        const ref = parseRef(cell.getAttribute("r"));
        c = ref ? ref.c : c + 1;
        if (c >= MAX_COLS) continue;
        const t = cell.getAttribute("t") || "n";
        const fmt = fmts[+cell.getAttribute("s") || 0] || {};
        const vEl = kid(cell, NS.s, "v");
        let value;
        if (t === "s") value = { v: shared[+vEl?.textContent] ?? "" };
        else if (t === "inlineStr") value = { v: [...cell.getElementsByTagNameNS(NS.s, "t")].map((x) => x.textContent).join("") };
        else if (t === "b") value = { v: vEl?.textContent === "1" ? "TRUE" : "FALSE" };
        else if (t === "str" || t === "e") value = { v: vEl?.textContent ?? "" };
        else if (vEl) value = excelValue(vEl.textContent, fmt, date1904);
        else continue;
        if (fmt.bold) value.bold = true;
        out[c] = value;
      }
    }
    const merges = [...doc.getElementsByTagNameNS(NS.s, "mergeCell")].map((m) => {
      const [a, b] = (m.getAttribute("ref") || "").split(":").map(parseRef);
      return a && b ? { r: a.r, c: a.c, rs: b.r - a.r + 1, cs: b.c - a.c + 1 } : null;
    }).filter(Boolean);
    const widths = [];
    for (const col of doc.getElementsByTagNameNS(NS.s, "col")) {
      const w = parseFloat(col.getAttribute("width"));
      if (!w) continue;
      for (let i = +col.getAttribute("min") - 1; i < Math.min(MAX_COLS, +col.getAttribute("max")); i++) widths[i] = clamp(Math.round(w * 7 + 5), 24, 600);
    }
    sheets.push({ name: s.getAttribute("name") || `Sheet ${sheets.length + 1}`, rows, merges, widths });
  }
  if (!sheets.length) throw new Error("this workbook has no sheets I can read");
  if (ctl.disposed) return;
  sheetReader(ctl, sheets, "SPREADSHEET");
}

/** RFC 4180-ish CSV: quotes, doubled quotes, newlines inside quotes. */
function parseDelimited(text, sep) {
  const rows = [];
  let row = [], field = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += ch;
    } else if (ch === '"' && field === "") q = true;
    else if (ch === sep) { row.push(field); field = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field); rows.push(row); row = []; field = "";
      if (rows.length > MAX_ROWS) break;
    } else field += ch;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows;
}

async function csvReader(ctl, kind) {
  let text = new TextDecoder().decode(await fetchBytes(ctl.url));
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  let sep = "\t";
  if (kind === "csv") { // Excel in many locales writes ";" instead of ","
    const head = text.slice(0, 4000).split(/\r?\n/)[0] || "";
    sep = (head.match(/;/g) || []).length > (head.match(/,/g) || []).length ? ";" : ",";
  }
  const parsed = parseDelimited(text, sep);
  if (ctl.disposed) return;
  const isNum = (s) => /^\s*[-+]?(\d{1,3}(,\d{3})+|\d+)?(\.\d+)?([eE][-+]?\d+)?%?\s*$/.test(s) && /\d/.test(s);
  const rows = parsed.map((r, i) => r.map((v) => ({ v, num: isNum(v), bold: i === 0 })));
  sheetReader(ctl, [{ name: ctl.item.name, rows, merges: [], widths: [] }], kind === "csv" ? "CSV" : "TSV");
}

// ---------------------------------------------------------------- PowerPoint
// Each slide is rebuilt from its shapes: the master's and layout's decorations first, then the
// slide's own. Text sizes, colours, bullets and alignment follow PowerPoint's inheritance:
// the run, the shape's list style, its layout placeholder, the master placeholder, the master's
// title/body/other styles, then the presentation's default text style.
const EMU_PER_PT = 12700;

async function pptxReader(ctl) {
  const zip = await unzip(await fetchBytes(ctl.url));
  const pres = await zip.xml("ppt/presentation.xml");
  if (!pres) throw new Error("this presentation has no slides I can read");
  const sz = desc(pres, NS.p, "sldSz");
  const W = +sz?.getAttribute("cx") || 12192000, H = +sz?.getAttribute("cy") || 6858000;
  const presRels = await rels(zip, "ppt/presentation.xml");
  const slidePaths = [...(desc(pres, NS.p, "sldIdLst")?.children || [])].map((s) => presRels.get(s.getAttributeNS(NS.r, "id"))?.target).filter(Boolean);
  if (!slidePaths.length) throw new Error("this presentation has no slides");
  const defaultTextStyle = desc(pres, NS.p, "defaultTextStyle");

  // ---- colours: the theme's scheme, mapped through the master's colour map (dark templates swap them)
  const theme = {};
  const themeRel = [...presRels.values()].find((r) => r.type.endsWith("/theme"));
  const scheme = desc(await zip.xml(themeRel?.target || "ppt/theme/theme1.xml"), NS.a, "clrScheme");
  for (const c of scheme?.children || []) {
    const v = desc(c, NS.a, "srgbClr")?.getAttribute("val") || desc(c, NS.a, "sysClr")?.getAttribute("lastClr");
    if (v) theme[c.localName] = `#${v}`;
  }
  const clrMap = { tx1: "dk1", bg1: "lt1", tx2: "dk2", bg2: "lt2" };
  const firstMaster = [...presRels.values()].find((r) => r.type.endsWith("/slideMaster"));
  const masterMap = desc(firstMaster && (await zip.xml(firstMaster.target)), NS.p, "clrMap");
  for (const a of masterMap?.attributes || []) clrMap[a.name] = a.value;
  const schemeHex = (name) => theme[clrMap[name] || name] || null;
  const hexA = (hex, a) => `${hex}${Math.round(clamp(a, 0, 1) * 255).toString(16).padStart(2, "0")}`;
  /** a colour element (srgbClr / schemeClr / sysClr / prstClr) with its tint modifiers -> CSS colour */
  const colorEl = (el) => {
    if (!el) return null;
    const v = el.getAttribute("val");
    let hex = el.localName === "srgbClr" ? `#${v}` : el.localName === "schemeClr" ? schemeHex(v)
      : el.localName === "sysClr" ? `#${el.getAttribute("lastClr") || (v === "window" ? "FFFFFF" : "000000")}`
      : el.localName === "prstClr" ? ({ white: "#FFFFFF", black: "#000000", red: "#FF0000", blue: "#0000FF", green: "#008000", yellow: "#FFFF00", gray: "#808080" }[v] || null) : null;
    if (!hex || hex.length !== 7) return null;
    const mod = (n) => { const m = kid(el, NS.a, n); return m ? +m.getAttribute("val") / 100000 : null; };
    let ch = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
    const lumMod = mod("lumMod"), lumOff = mod("lumOff"), tint = mod("tint"), shade = mod("shade");
    if (lumMod != null || lumOff != null) ch = ch.map((x) => clamp(x * (lumMod ?? 1) + (lumOff ?? 0), 0, 1));
    if (tint != null) ch = ch.map((x) => x + (1 - x) * (1 - tint));
    if (shade != null) ch = ch.map((x) => x * shade);
    hex = "#" + ch.map((x) => Math.round(clamp(x, 0, 1) * 255).toString(16).padStart(2, "0")).join("");
    const alpha = mod("alpha");
    return alpha != null ? hexA(hex, alpha) : hex;
  };
  const COLOR_TAGS = ["srgbClr", "schemeClr", "sysClr", "prstClr"];
  const colorIn = (parent) => colorEl([...(parent?.children || [])].find((c) => COLOR_TAGS.includes(c.localName)));
  /** the fill a properties element declares: a solid colour, the first stop of a gradient, "none", or null if unset */
  const fillOf = (pr) => {
    if (!pr) return null;
    if (kid(pr, NS.a, "noFill")) return "none";
    const solid = kid(pr, NS.a, "solidFill");
    if (solid) return colorIn(solid);
    const grad = kid(pr, NS.a, "gradFill");
    if (grad) {
      const stops = kids(desc(grad, NS.a, "gsLst"), NS.a, "gs").map((g) => [+g.getAttribute("pos") / 1000, colorIn(g)]).filter((s) => s[1]);
      if (stops.length > 1) return `linear-gradient(${90 + (+desc(grad, NS.a, "lin")?.getAttribute("ang") || 0) / 60000}deg, ${stops.map(([p, c]) => `${c} ${p}%`).join(", ")})`;
      return stops[0]?.[1] || null;
    }
    return null;
  };

  // ---- masters and layouts: placeholders (with their positions and list styles), background, decorations
  const partCache = new Map();
  async function part(path) {
    if (!path) return null;
    if (partCache.has(path)) return partCache.get(path);
    const doc = await zip.xml(path);
    const info = { path, doc, rels: await rels(zip, path), phs: [] };
    for (const sp of doc ? doc.getElementsByTagNameNS(NS.p, "sp") : []) {
      const ph = desc(kid(sp, NS.p, "nvSpPr"), NS.p, "ph");
      if (ph) info.phs.push({ type: ph.getAttribute("type") || "obj", idx: ph.getAttribute("idx"), sp, xfrm: desc(kid(sp, NS.p, "spPr"), NS.a, "xfrm") });
    }
    info.txStyles = desc(doc, NS.p, "txStyles");
    partCache.set(path, info);
    return info;
  }
  const relOf = (info, kind) => [...(info?.rels.values() || [])].find((r) => r.type.endsWith(kind))?.target;
  const phFind = (info, type, idx) => {
    const list = info?.phs || [];
    return list.find((p) => idx != null && p.idx === idx && (p.type === type || type === "obj" || p.type === "obj"))
      || list.find((p) => p.type === type)
      || list.find((p) => (type === "ctrTitle" && p.type === "title") || (["subTitle", "obj"].includes(type) && p.type === "body"))
      || (idx != null ? list.find((p) => p.idx === idx) : null);
  };

  // ---- text style inheritance
  const lvlPr = (lst, lvl) => kid(lst, NS.a, `lvl${lvl + 1}pPr`);
  const styleFor = (master, type) => {
    const ts = master?.txStyles;
    if (!ts) return null;
    if (type === "title" || type === "ctrTitle") return kid(ts, NS.p, "titleStyle");
    if (type) return kid(ts, NS.p, "bodyStyle");
    return kid(ts, NS.p, "otherStyle");
  };
  /** the level properties (a:lvlNpPr) that apply, most specific first */
  const pprChain = (ctx, lvl) => [
    lvlPr(kid(ctx.tx, NS.a, "lstStyle"), lvl),
    lvlPr(kid(kid(ctx.layoutPh?.sp, NS.p, "txBody"), NS.a, "lstStyle"), lvl),
    lvlPr(kid(kid(ctx.masterPh?.sp, NS.p, "txBody"), NS.a, "lstStyle"), lvl),
    lvlPr(styleFor(ctx.master, ctx.type), lvl),
    lvlPr(defaultTextStyle, lvl),
  ].filter(Boolean);
  const pick = (chain, get) => { for (const el of chain) { const v = get(el); if (v != null && v !== "") return v; } return null; };

  // ---- layout
  const wrap = document.createElement("div");
  wrap.className = "rd-slides";
  const slideW = () => Math.max(160, ctl.body.clientWidth - 36);
  const zoom = {
    level: 1, fit: true,
    set(v) { zoom.fit = v == null; zoom.level = v == null ? 1 : v; wrap.style.setProperty("--slide-w", `${Math.round(slideW() * zoom.level)}px`); },
  };
  const { label } = toolbar(ctl, { zoom });
  ctl.body.appendChild(wrap);
  const ro = new ResizeObserver(() => zoom.set(zoom.fit ? null : zoom.level));
  ro.observe(ctl.body);
  ctl.onDispose(() => ro.disconnect());
  zoom.set(null);

  const pct = (v, of) => `${((v / of) * 100).toFixed(3)}%`;
  const cq = (pt) => `${((pt / (W / EMU_PER_PT)) * 100).toFixed(4)}cqw`; // sizes relative to the slide's width
  const place = (xfrm, T) => { // group shapes map their children's coordinates; T carries that down the tree
    const off = kid(xfrm, NS.a, "off"), ex = kid(xfrm, NS.a, "ext");
    const x = +off?.getAttribute("x") || 0, y = +off?.getAttribute("y") || 0, cx = +ex?.getAttribute("cx") || 0, cy = +ex?.getAttribute("cy") || 0;
    return { x: T.x + (x - T.ox) * T.sx, y: T.y + (y - T.oy) * T.sy, w: cx * T.sx, h: cy * T.sy, rot: (+xfrm?.getAttribute("rot") || 0) / 60000,
      flipH: xfrm?.getAttribute("flipH") === "1", flipV: xfrm?.getAttribute("flipV") === "1" };
  };
  const box = (b) => {
    const el = document.createElement("div");
    el.className = "rd-shape";
    Object.assign(el.style, { left: pct(b.x, W), top: pct(b.y, H), width: pct(b.w, W), height: pct(b.h, H) });
    const tf = [b.rot ? `rotate(${b.rot}deg)` : "", b.flipH ? "scaleX(-1)" : "", b.flipV ? "scaleY(-1)" : ""].join(" ").trim();
    if (tf) el.style.transform = tf;
    return el;
  };
  const T0 = { x: 0, y: 0, ox: 0, oy: 0, sx: 1, sy: 1 };

  async function drawSlide(path, n) {
    const doc = await zip.xml(path);
    const slideInfo = { path, doc, rels: await rels(zip, path) };
    const layout = await part(relOf(slideInfo, "/slideLayout"));
    const master = await part(relOf(layout, "/slideMaster"));
    const el = document.createElement("section");
    el.className = "rd-slide";
    el.style.aspectRatio = `${W} / ${H}`;
    el.style.color = schemeHex("tx1") || "#000";
    el.style.background = schemeHex("bg1") || "#fff";
    for (const p of [slideInfo, layout, master]) { // the first background found wins
      const bg = desc(desc(p?.doc, NS.p, "cSld"), NS.p, "bg");
      if (!bg) continue;
      const bgPr = kid(bg, NS.p, "bgPr"), bgRef = kid(bg, NS.p, "bgRef");
      const blip = desc(bgPr, NS.a, "blip");
      const u = blip && (await blobUrl(ctl, zip, p.rels.get(blip.getAttributeNS(NS.r, "embed"))?.target || ""));
      const f = u ? `center / cover no-repeat url("${u}")` : bgPr ? fillOf(bgPr) : colorIn(bgRef);
      if (f && f !== "none") el.style.background = f;
      break;
    }
    const ctx = { layout, master };
    const showMaster = (p) => desc(p?.doc, NS.p, "sld")?.getAttribute("showMasterSp") !== "0" && p?.doc?.documentElement?.getAttribute("showMasterSp") !== "0";
    if (master && showMaster(layout) && showMaster(slideInfo)) await drawTree(desc(desc(master.doc, NS.p, "cSld"), NS.p, "spTree"), el, T0, master, ctx, true);
    if (layout && showMaster(slideInfo)) await drawTree(desc(desc(layout.doc, NS.p, "cSld"), NS.p, "spTree"), el, T0, layout, ctx, true);
    await drawTree(desc(desc(doc, NS.p, "cSld"), NS.p, "spTree"), el, T0, slideInfo, ctx, false);
    const tag = document.createElement("i");
    tag.className = "rd-sn";
    tag.textContent = String(n);
    el.appendChild(tag);
    return el;
  }

  async function drawTree(tree, slideEl, T, owner, ctx, decorOnly) {
    for (const node of tree?.children || []) {
      const name = node.localName;
      if (name === "grpSp") {
        const xf = desc(kid(node, NS.p, "grpSpPr"), NS.a, "xfrm");
        if (!xf) { await drawTree(node, slideEl, T, owner, ctx, decorOnly); continue; }
        const g = place(xf, T);
        const chOff = kid(xf, NS.a, "chOff"), chExt = kid(xf, NS.a, "chExt"), ex = kid(xf, NS.a, "ext");
        const ccx = +chExt?.getAttribute("cx") || 1, ccy = +chExt?.getAttribute("cy") || 1;
        await drawTree(node, slideEl, {
          x: g.x, y: g.y, ox: +chOff?.getAttribute("x") || 0, oy: +chOff?.getAttribute("y") || 0,
          sx: T.sx * ((+ex?.getAttribute("cx") || ccx) / ccx), sy: T.sy * ((+ex?.getAttribute("cy") || ccy) / ccy),
        }, owner, ctx, decorOnly);
      } else if (name === "sp" || name === "cxnSp") drawShape(node, slideEl, T, owner, ctx, decorOnly);
      else if (name === "pic") await drawPic(node, slideEl, T, owner);
      else if (name === "graphicFrame") drawTableFrame(node, slideEl, T, ctx);
    }
  }

  function drawShape(sp, slideEl, T, owner, ctx, decorOnly) {
    const nv = kid(sp, NS.p, "nvSpPr") || kid(sp, NS.p, "nvCxnSpPr");
    const ph = desc(nv, NS.p, "ph");
    if (decorOnly && ph) return; // a layout's empty "Click to add title" boxes aren't drawn
    const type = ph ? ph.getAttribute("type") || "obj" : null, idx = ph?.getAttribute("idx");
    if (type && ["dt", "ftr", "sldNum", "hdr"].includes(type)) return;
    const layoutPh = ph ? phFind(ctx.layout, type, idx) : null;
    const masterPh = ph ? phFind(ctx.master, layoutPh?.type || type, null) : null;
    const spPr = kid(sp, NS.p, "spPr");
    const xfrm = desc(spPr, NS.a, "xfrm") || layoutPh?.xfrm || masterPh?.xfrm;
    if (!xfrm) return;
    const b = place(xfrm, T);
    const el = box(b);
    const style = kid(sp, NS.p, "style");
    const geom = desc(spPr, NS.a, "prstGeom")?.getAttribute("prst") || (sp.localName === "cxnSp" ? "line" : null);
    if (geom === "ellipse") el.style.borderRadius = "50%";
    else if (geom === "roundRect") el.style.borderRadius = "min(16%, 1.2cqw)";
    let fill = fillOf(spPr);
    if (fill == null && style && +kid(style, NS.a, "fillRef")?.getAttribute("idx") > 0) fill = colorIn(kid(style, NS.a, "fillRef"));
    if (fill && fill !== "none" && geom !== "line") el.style.background = fill;
    const ln = kid(spPr, NS.a, "ln");
    let lineColor = ln ? (kid(ln, NS.a, "noFill") ? null : fillOf(ln)) : (style && +kid(style, NS.a, "lnRef")?.getAttribute("idx") > 0 ? colorIn(kid(style, NS.a, "lnRef")) : null);
    if (lineColor === "none") lineColor = null;
    if (lineColor) {
      const w = `max(1px, ${cq(Math.max(0.5, (+ln?.getAttribute("w") || 12700) / EMU_PER_PT))})`;
      if (geom === "line") { el.style.borderTop = `${w} solid ${lineColor}`; el.style.height = "0"; if (b.h > b.w) { el.style.borderTop = "0"; el.style.borderLeft = `${w} solid ${lineColor}`; el.style.width = "0"; el.style.height = pct(b.h, H); } }
      else el.style.border = `${w} solid ${lineColor}`;
    }
    const tx = kid(sp, NS.p, "txBody");
    const fontRef = kid(style, NS.a, "fontRef");
    if (tx) drawText(tx, el, { type, layoutPh, masterPh, master: ctx.master, tx, shapeTextColor: fontRef ? colorIn(fontRef) : null });
    if (el.childNodes.length || (fill && fill !== "none") || lineColor) slideEl.appendChild(el);
  }

  function drawText(tx, el, ctx) {
    const bodyPr = kid(tx, NS.a, "bodyPr");
    const bodyChain = [bodyPr, kid(kid(ctx.layoutPh?.sp, NS.p, "txBody"), NS.a, "bodyPr"), kid(kid(ctx.masterPh?.sp, NS.p, "txBody"), NS.a, "bodyPr")].filter(Boolean);
    const anchor = pick(bodyChain, (e) => e.getAttribute("anchor")) || "t";
    const scale = (+desc(bodyPr, NS.a, "normAutofit")?.getAttribute("fontScale") || 100000) / 100000;
    const lnRed = (+desc(bodyPr, NS.a, "normAutofit")?.getAttribute("lnSpcReduction") || 0) / 100000;
    const inner = document.createElement("div");
    inner.className = "rd-tx";
    inner.style.justifyContent = anchor === "ctr" ? "center" : anchor === "b" ? "flex-end" : "flex-start";
    const ins = (a, d) => cq((+(pick(bodyChain, (e) => e.getAttribute(a)) ?? d)) / EMU_PER_PT);
    inner.style.padding = `${ins("tIns", 45720)} ${ins("rIns", 91440)} ${ins("bIns", 45720)} ${ins("lIns", 91440)}`;
    if (pick(bodyChain, (e) => e.getAttribute("wrap")) === "none") inner.style.whiteSpace = "nowrap";
    inner.style.lineHeight = String(+(1.15 * (1 - lnRed)).toFixed(3));
    const isTitle = ctx.type === "title" || ctx.type === "ctrTitle";
    const numbering = new Map();
    let any = false;
    for (const p of kids(tx, NS.a, "p")) {
      const pPr = kid(p, NS.a, "pPr");
      const lvl = +pPr?.getAttribute("lvl") || 0;
      const chain = [pPr, ...pprChain(ctx, lvl)].filter(Boolean);
      const rprChain = chain.map((e) => kid(e, NS.a, "defRPr")).filter(Boolean);
      const para = document.createElement("p");
      const algn = pick(chain, (e) => e.getAttribute("algn"));
      para.style.textAlign = algn === "ctr" ? "center" : algn === "r" ? "right" : algn === "just" ? "justify" : "left";
      const baseSz = +pick(rprChain, (e) => e.getAttribute("sz")) / 100 || (isTitle ? 40 : 18);
      const baseColor = pick(rprChain, (e) => { const f = kid(e, NS.a, "solidFill"); return f ? colorIn(f) : null; }) || ctx.shapeTextColor;
      const baseBold = pick(rprChain, (e) => e.getAttribute("b"));
      let text = "", firstSz = null;
      for (const r of p.children) {
        if (r.localName === "br") { para.appendChild(document.createElement("br")); continue; }
        if (r.localName !== "r" && r.localName !== "fld") continue;
        const t = kid(r, NS.a, "t")?.textContent || "";
        if (!t) continue;
        text += t;
        const rPr = kid(r, NS.a, "rPr");
        const ptSize = (+rPr?.getAttribute("sz") / 100 || baseSz) * scale;
        firstSz ??= ptSize;
        const span = document.createElement("span");
        span.textContent = t;
        span.style.fontSize = cq(ptSize);
        const bold = rPr?.getAttribute("b") ?? baseBold;
        if (bold === "1" || bold === "true") span.style.fontWeight = "700";
        if (rPr?.getAttribute("i") === "1") span.style.fontStyle = "italic";
        const u = rPr?.getAttribute("u");
        if (u && u !== "none") span.style.textDecoration = "underline";
        if (rPr?.getAttribute("strike") && rPr.getAttribute("strike") !== "noStrike") span.style.textDecoration = "line-through";
        const c = (rPr && (kid(rPr, NS.a, "solidFill") ? colorIn(kid(rPr, NS.a, "solidFill")) : null)) || baseColor;
        if (c) span.style.color = c;
        const cap = rPr?.getAttribute("cap");
        if (cap === "all") span.style.textTransform = "uppercase";
        para.appendChild(span);
      }
      const sizePt = (firstSz ?? baseSz * scale);
      const spcBef = pick(chain, (e) => kid(kid(e, NS.a, "spcBef"), NS.a, "spcPts")?.getAttribute("val"));
      para.style.marginTop = spcBef != null ? cq(+spcBef / 100) : cq(sizePt * 0.2);
      if (!text.trim()) { para.style.minHeight = cq(sizePt * 1.1); inner.appendChild(para); continue; }
      any = true;
      // bullets: from the paragraph, else inherited (master body style usually supplies them)
      const buNone = pick(chain, (e) => (kid(e, NS.a, "buNone") ? "none" : kid(e, NS.a, "buChar") || kid(e, NS.a, "buAutoNum") ? "some" : null));
      const marL = pick(chain, (e) => e.getAttribute("marL"));
      const indent = pick(chain, (e) => e.getAttribute("indent"));
      if (marL != null) para.style.paddingLeft = cq(+marL / EMU_PER_PT);
      if (buNone === "some") {
        const auto = pick(chain, (e) => kid(e, NS.a, "buAutoNum")?.getAttribute("type") || (kid(e, NS.a, "buChar") ? "" : null));
        const ch = pick(chain, (e) => kid(e, NS.a, "buChar")?.getAttribute("char"));
        let mark = ch || "•";
        if (auto) {
          const k = (numbering.get(lvl) || 0) + 1;
          numbering.set(lvl, k);
          mark = /alpha/i.test(auto) ? `${String.fromCharCode((/UC/.test(auto) ? 64 : 96) + k)}.` : /roman/i.test(auto) ? `${["i", "ii", "iii", "iv", "v", "vi", "vii", "viii", "ix", "x"][k - 1] || k}.` : `${k}.`;
        }
        const bulletColor = pick(chain, (e) => { const f = kid(e, NS.a, "buClr"); return f ? colorIn(f) : null; });
        const mk = document.createElement("span");
        mk.className = "rd-mark";
        mk.textContent = mark;
        mk.style.fontSize = cq(sizePt);
        if (bulletColor) mk.style.color = bulletColor;
        mk.style.width = cq(Math.max(0.5, Math.abs(+indent || 342900) / EMU_PER_PT));
        mk.style.marginLeft = indent != null ? cq(+indent / EMU_PER_PT) : cq(-27);
        para.insertBefore(mk, para.firstChild);
        if (marL == null) para.style.paddingLeft = cq(27 * (lvl + 1));
      } else numbering.delete(lvl);
      inner.appendChild(para);
    }
    if (any) el.appendChild(inner);
  }

  async function drawPic(pic, slideEl, T, owner) {
    const xfrm = desc(kid(pic, NS.p, "spPr"), NS.a, "xfrm");
    const blip = desc(kid(pic, NS.p, "blipFill"), NS.a, "blip");
    if (!xfrm || !blip) return;
    const rel = owner.rels.get(blip.getAttributeNS(NS.r, "embed"));
    const u = rel && !rel.external ? await blobUrl(ctl, zip, rel.target) : null;
    const el = box(place(xfrm, T));
    if (u) {
      const img = document.createElement("img");
      img.src = u; img.alt = "";
      const src = desc(kid(pic, NS.p, "blipFill"), NS.a, "srcRect"); // cropping
      if (src) {
        const l = (+src.getAttribute("l") || 0) / 1000, t = (+src.getAttribute("t") || 0) / 1000, r = (+src.getAttribute("r") || 0) / 1000, bt = (+src.getAttribute("b") || 0) / 1000;
        if (l || t || r || bt) {
          const wv = 100 - l - r, hv = 100 - t - bt;
          Object.assign(img.style, { position: "absolute", width: `${(100 / wv) * 100}%`, height: `${(100 / hv) * 100}%`, left: `${(-l / wv) * 100}%`, top: `${(-t / hv) * 100}%`, objectFit: "fill" });
          el.style.overflow = "hidden";
        }
      }
      el.appendChild(img);
    } else el.classList.add("rd-nopic");
    slideEl.appendChild(el);
  }

  function drawTableFrame(frame, slideEl, T, ctx) {
    const tbl = desc(frame, NS.a, "tbl");
    const xfrm = kid(frame, NS.p, "xfrm");
    if (!tbl || !xfrm) return;
    const el = box(place(xfrm, T));
    const table = document.createElement("table");
    table.className = "rd-stbl";
    const widths = kids(desc(tbl, NS.a, "tblGrid"), NS.a, "gridCol").map((g) => +g.getAttribute("w") || 0);
    const total = widths.reduce((a, b) => a + b, 0) || 1;
    const cg = document.createElement("colgroup");
    for (const w of widths) { const c = document.createElement("col"); c.style.width = `${(w / total) * 100}%`; cg.appendChild(c); }
    table.appendChild(cg);
    const firstRow = kid(tbl, NS.a, "tblPr")?.getAttribute("firstRow") === "1";
    kids(tbl, NS.a, "tr").forEach((tr, ri) => {
      const row = table.insertRow();
      for (const tc of kids(tr, NS.a, "tc")) {
        if (tc.getAttribute("hMerge") === "1" || tc.getAttribute("vMerge") === "1") continue;
        const td = row.insertCell();
        if (+tc.getAttribute("gridSpan") > 1) td.colSpan = +tc.getAttribute("gridSpan");
        if (+tc.getAttribute("rowSpan") > 1) td.rowSpan = +tc.getAttribute("rowSpan");
        td.textContent = [...tc.getElementsByTagNameNS(NS.a, "p")].map((p) => [...p.getElementsByTagNameNS(NS.a, "t")].map((t) => t.textContent).join("")).join("\n");
        const rPr = desc(tc, NS.a, "rPr");
        td.style.fontSize = cq(+rPr?.getAttribute("sz") / 100 || 14);
        if (rPr?.getAttribute("b") === "1" || (firstRow && ri === 0)) td.style.fontWeight = "700";
        const f = fillOf(kid(tc, NS.a, "tcPr"));
        if (f && f !== "none") td.style.background = f;
        else if (firstRow && ri === 0) { td.style.background = schemeHex("accent1") || "#4472c4"; td.style.color = "#fff"; }
        const c = rPr && kid(rPr, NS.a, "solidFill") ? colorIn(kid(rPr, NS.a, "solidFill")) : null;
        if (c) td.style.color = c;
      }
    });
    el.appendChild(table);
    slideEl.appendChild(el);
  }

  // slides are laid out as you scroll to them, so a long deck opens instantly
  const slots = slidePaths.map((p, i) => {
    const s = document.createElement("section");
    s.className = "rd-slide rd-pending";
    s.style.aspectRatio = `${W} / ${H}`;
    s.dataset.i = String(i);
    wrap.appendChild(s);
    return { el: s, path: p, done: false };
  });
  const io = new IntersectionObserver((entries) => {
    for (const en of entries) {
      if (!en.isIntersecting) continue;
      const i = +en.target.dataset.i, slot = slots[i];
      if (slot.done) continue;
      slot.done = true;
      io.unobserve(slot.el);
      drawSlide(slot.path, i + 1)
        .then((el) => { if (ctl.disposed) return; el.dataset.i = String(i); slot.el.replaceWith(el); slot.el = el; })
        .catch((e) => { console.warn("[reader] slide", slot.path, e); slot.el.classList.add("rd-nopic"); });
    }
  }, { root: ctl.body, rootMargin: "800px 0px" });
  slots.forEach((s) => io.observe(s.el));
  ctl.onDispose(() => io.disconnect());
  // counted from layout positions (the window's 3D tilt doesn't affect them), and again after every resize
  const counter = () => {
    const b = ctl.body, line = b.scrollTop + b.clientHeight * 0.35;
    let cur = 1;
    slots.forEach((s, i) => { if (s.el.offsetTop <= line) cur = i + 1; });
    if (b.scrollTop > 0 && b.scrollTop + b.clientHeight >= b.scrollHeight - 2) cur = slots.length; // scrolled to the end
    label.textContent = `SLIDE ${cur} / ${slots.length}`;
  };
  label.textContent = `SLIDE 1 / ${slots.length}`;
  ctl.body.addEventListener("scroll", counter, { passive: true });
  const recount = new ResizeObserver(counter);
  recount.observe(ctl.body);
  ctl.onDispose(() => { ctl.body.removeEventListener("scroll", counter); recount.disconnect(); });
  requestAnimationFrame(counter);
}
