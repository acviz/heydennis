// The Capabilities panel (skills, minions, MCP connections, document skills) and the
// small MINIONS widget that shows who's out working.
import { api } from "./api.js";

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const ago = (ms) => { const s = Math.max(0, Math.round((Date.now() - ms) / 1000)); return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h`; };

export class Caps {
  /** hooks: toast(msg, err), getConfig(), saveSettings(patch), showReport(run) */
  constructor(hooks) {
    this.h = hooks;
    this.runs = new Map();
    this.toolsets = {};
    this.el = $("#caps");
    this.el.querySelectorAll("[data-tab]").forEach((b) => (b.onclick = () => this.tab(b.dataset.tab)));
    $("#caps-close").onclick = () => this.close();
    this.el.addEventListener("click", (e) => { if (e.target === this.el) this.close(); });
    // skills
    $("#skill-folder").onclick = () => this.install({ kind: "folder" });
    $("#skill-zip").onclick = () => this.install({ kind: "file" });
    $("#skill-path-add").onclick = () => { const p = $("#skill-path").value.trim(); if (p) this.install({ path: p }); };
    $("#skill-open").onclick = () => api.skillsDo({ action: "reveal" }).catch((e) => this.h.toast(e.message, true));
    // minions
    $("#minion-save").onclick = () => this.defineMinion();
    $("#brief-minions").onchange = (e) => this.h.saveSettings({ briefMinions: e.target.checked });
    // mcp
    $("#mcp-save").onclick = () => this.saveMcp();
    $("#mcp-reconnect").onclick = () => api.mcpDo({ action: "reconnect" }).then(() => this.h.toast("Reconnecting...")).catch((e) => this.h.toast(e.message, true));
    $("#mcp-import").onclick = () => this.importClaude();
    $("#mcp-json").oninput = () => (this.mcpDirty = true);
    // documents
    this.el.querySelectorAll("[name=docSkill], #docs-on").forEach((c) => (c.onchange = () => this.saveDocs()));
    setInterval(() => { if (this.running().length) this.renderWidget(); }, 1000);
  }

  // ---------------------------------------------------------------- panel
  async open(tab = "skills") {
    this.el.classList.add("show");
    this.tab(tab);
    await Promise.all([this.loadSkills(), this.loadMinions(), this.loadMcp()]).catch((e) => this.h.toast(e.message, true));
    const cfg = this.h.getConfig() || {};
    $("#docs-on").checked = cfg.docSkills?.enabled !== false;
    const on = new Set(cfg.docSkills?.skills || ["docx", "pptx", "xlsx", "pdf"]);
    this.el.querySelectorAll("[name=docSkill]").forEach((c) => (c.checked = on.has(c.value)));
    $("#brief-minions").checked = cfg.briefMinions !== false;
  }
  close() { this.el.classList.remove("show"); }
  get isOpen() { return this.el.classList.contains("show"); }
  tab(name) {
    this.el.querySelectorAll("[data-tab]").forEach((b) => b.classList.toggle("on", b.dataset.tab === name));
    this.el.querySelectorAll("[data-pane]").forEach((p) => (p.hidden = p.dataset.pane !== name));
  }

  // ---------------------------------------------------------------- skills
  async loadSkills() {
    const { skills, dir, canPick } = await api.skills();
    $("#skill-dir").textContent = dir;
    $("#skill-folder").hidden = $("#skill-zip").hidden = !canPick;
    const list = $("#skill-list");
    list.innerHTML = skills.length ? "" : `<div class="empty">No skills installed yet. Install one below, or ask Dennis to save a procedure as a skill.</div>`;
    for (const s of skills) {
      const row = document.createElement("div");
      row.className = "item" + (s.enabled ? "" : " off");
      row.innerHTML = `<label class="tgl"><input type="checkbox" ${s.enabled ? "checked" : ""}></label><div class="txt"><b>${esc(s.name)}</b><small>${esc(s.description || "no description")}</small></div><button type="button" class="x" title="Remove (moved to skills-removed, so it can be restored)">&times;</button>`;
      $("input", row).onchange = (e) => api.skillsDo({ action: "toggle", id: s.id, enabled: e.target.checked }).then(() => this.loadSkills()).catch((er) => this.h.toast(er.message, true));
      $(".x", row).onclick = () => api.skillsDo({ action: "remove", id: s.id }).then(() => { this.h.toast(`Removed ${s.name}`); this.loadSkills(); }).catch((er) => this.h.toast(er.message, true));
      list.appendChild(row);
    }
  }
  async install(body) {
    try {
      const r = await api.skillsDo({ action: "install", ...body });
      if (r.cancelled) return;
      if (!r.ok) return this.h.toast(r.error || "Couldn't install that skill", true);
      this.h.toast(`Installed the skill "${r.skill.name}"`);
      $("#skill-path").value = "";
      this.loadSkills();
    } catch (e) { this.h.toast(e.message, true); }
  }

  // ---------------------------------------------------------------- minions
  async loadMinions() {
    const { definitions, runs, toolsets } = await api.minions();
    this.toolsets = toolsets;
    for (const r of runs) this.runs.set(r.id, r);
    this.renderDefs(definitions);
    const boxes = $("#minion-tools");
    if (!boxes.children.length) {
      boxes.innerHTML = Object.entries(toolsets).map(([k, v]) => `<label class="check" title="${esc(v)}"><input type="checkbox" value="${k}" ${k === "files" ? "checked" : ""}> ${k}</label>`).join("");
    }
    this.renderRuns();
    this.renderWidget();
  }
  renderDefs(defs) {
    const list = $("#minion-defs");
    list.innerHTML = defs.length ? "" : `<div class="empty">No minions yet.</div>`;
    for (const d of defs) {
      const row = document.createElement("div");
      row.className = "item";
      row.innerHTML = `<div class="txt"><b>${esc(d.name)}</b><small>${esc(d.role)}</small><span class="tags">${d.tools.map((t) => `<i>${esc(t)}</i>`).join("")}</span></div><button type="button" class="ghost" data-act="edit">EDIT</button><button type="button" class="x" title="Delete this minion">&times;</button>`;
      $("[data-act=edit]", row).onclick = () => {
        const f = $("#minion-form");
        f.open = true;
        $("#minion-name").value = d.name;
        $("#minion-role").value = d.role;
        $("#minion-effort").value = d.effort || "medium";
        $("#minion-tools").querySelectorAll("input").forEach((c) => (c.checked = d.tools.includes(c.value)));
        $("#minion-name").focus();
      };
      $(".x", row).onclick = () => api.minionsDo({ action: "remove", name: d.name }).then(() => this.loadMinions()).catch((e) => this.h.toast(e.message, true));
      list.appendChild(row);
    }
  }
  async defineMinion() {
    const definition = {
      name: $("#minion-name").value,
      role: $("#minion-role").value,
      effort: $("#minion-effort").value,
      tools: [...$("#minion-tools").querySelectorAll("input:checked")].map((c) => c.value),
    };
    const r = await api.minionsDo({ action: "define", definition }).catch((e) => ({ ok: false, error: e.message }));
    if (!r.ok) return this.h.toast(r.error, true);
    this.h.toast(`${r.definition.name} is ready for duty`);
    $("#minion-name").value = $("#minion-role").value = "";
    $("#minion-form").open = false;
    this.loadMinions();
  }
  running() { return [...this.runs.values()].filter((r) => r.status === "running"); }
  renderRuns() {
    const list = $("#minion-runs");
    const runs = [...this.runs.values()].sort((a, b) => b.startedAt - a.startedAt).slice(0, 12);
    list.innerHTML = runs.length ? "" : `<div class="empty">None deployed yet. Ask Dennis to send one, e.g. "send Scout to research LED volume suppliers".</div>`;
    for (const r of runs) list.appendChild(this.runRow(r, true));
  }
  runRow(r, full = false) {
    const row = document.createElement("div");
    row.className = `run st-${r.status}`;
    row.dataset.hand = "";
    const detail = r.status === "running" ? (r.activity || "thinking") + ` · ${ago(r.startedAt)}` : r.status === "done" ? `done in ${ago(Date.now() - ((r.endedAt || Date.now()) - r.startedAt))}` : r.status;
    row.innerHTML = `<i class="dot"></i><div class="txt"><b>${esc(r.name)}</b><small>${esc(full ? r.task : r.task.slice(0, 80))}</small><em>${esc(detail)}</em></div>${r.status === "running" ? `<button type="button" class="x" title="Recall">&times;</button>` : ""}`;
    row.onclick = (e) => {
      if (e.target.closest(".x")) { api.minionsDo({ action: "recall", id: r.id }).catch(() => {}); return; }
      if (r.report || r.error) this.h.showReport(r);
    };
    return row;
  }
  renderWidget() {
    const w = $("#w-minions");
    const runs = [...this.runs.values()].filter((r) => r.status === "running" || Date.now() - (r.endedAt || 0) < 10 * 60_000).sort((a, b) => b.startedAt - a.startedAt).slice(0, 5);
    w.classList.toggle("show", runs.length > 0);
    $("small", w).textContent = this.running().length ? `${this.running().length} OUT` : "BACK";
    const list = $(".list", w);
    list.innerHTML = "";
    for (const r of runs) list.appendChild(this.runRow(r));
  }

  // ---------------------------------------------------------------- MCP
  async loadMcp() {
    const { servers, config, claudeDesktop } = await api.mcp();
    if (!this.mcpDirty) $("#mcp-json").value = JSON.stringify({ mcpServers: config }, null, 2);
    $("#mcp-import").hidden = !claudeDesktop;
    this.renderMcp(servers);
  }
  renderMcp(servers) {
    const list = $("#mcp-status");
    list.innerHTML = servers.length ? "" : `<div class="empty">No connections yet. Add servers below (or import them from Claude Desktop), then SAVE &amp; CONNECT.</div>`;
    for (const s of servers) {
      const row = document.createElement("div");
      row.className = `item mcp st-${s.status}`;
      const tools = s.tools.map((t) => t.name);
      row.innerHTML = `<i class="dot"></i><div class="txt"><b>${esc(s.name)}</b><small>${s.status === "connected" ? `${tools.length} tool${tools.length === 1 ? "" : "s"}: ${esc(tools.slice(0, 12).join(", "))}${tools.length > 12 ? ", ..." : ""}` : s.status === "connecting" ? "connecting..." : esc(s.error || s.status)}</small></div>`;
      list.appendChild(row);
    }
  }
  async saveMcp() {
    let servers;
    try { servers = JSON.parse($("#mcp-json").value || "{}"); } catch (e) { return this.h.toast(`That isn't valid JSON: ${e.message}`, true); }
    const r = await api.mcpDo({ action: "save", servers }).catch((e) => ({ ok: false, error: e.message }));
    if (!r.ok) return this.h.toast(r.error, true);
    this.mcpDirty = false;
    $("#mcp-json").value = JSON.stringify({ mcpServers: r.config }, null, 2);
    this.h.toast("Saved. Connecting...");
  }
  async importClaude() {
    const r = await api.mcpDo({ action: "import-claude" }).catch((e) => ({ ok: false, error: e.message }));
    if (!r.ok) return this.h.toast(r.error, true);
    let cur = {};
    try { const j = JSON.parse($("#mcp-json").value || "{}"); cur = j.mcpServers || j; } catch { /* replace */ }
    const added = Object.keys(r.servers).filter((k) => !(k in cur));
    $("#mcp-json").value = JSON.stringify({ mcpServers: { ...r.servers, ...cur } }, null, 2);
    this.mcpDirty = true;
    this.h.toast(added.length ? `Imported ${added.join(", ")} - check them, then SAVE & CONNECT` : "Nothing new to import");
    if (r.skipped?.length) this.h.toast(`Skipped: ${r.skipped.join("; ")}`, true);
  }

  // ---------------------------------------------------------------- documents
  saveDocs() {
    const skills = [...this.el.querySelectorAll("[name=docSkill]:checked")].map((c) => c.value);
    this.h.saveSettings({ docSkills: { enabled: $("#docs-on").checked && skills.length > 0, skills } });
  }

  // ---------------------------------------------------------------- live events
  /** Returns the run when a minion has just come back (so the app can brief you). */
  onEvent(ev) {
    if (ev.type === "minion") {
      const prev = this.runs.get(ev.run.id);
      this.runs.set(ev.run.id, ev.run);
      this.renderWidget();
      if (this.isOpen) this.renderRuns();
      if (prev?.status === "running" && ev.run.status !== "running") return ev.run;
    } else if (ev.type === "minions" && this.isOpen) this.renderDefs(ev.definitions);
    else if (ev.type === "mcp" && this.isOpen) this.renderMcp(ev.servers);
    return null;
  }
}
