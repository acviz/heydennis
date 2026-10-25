// The Capabilities panel (skills, minions, your apps, MCP connections, document skills, messaging) and
// the small MINIONS widget that shows who's out working.
import { api } from "./api.js";

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const ago = (ms) => { const s = Math.max(0, Math.round((Date.now() - ms) / 1000)); return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h`; };

export class Caps {
  /** hooks: toast(msg, err), getConfig(), saveSettings(patch), showReport(run), setApps(list), showUi(event) */
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
    // email (classic Outlook): saved the moment it's switched, then checked
    $("#mail-on").addEventListener("change", (e) => { e.stopPropagation(); this.setEmail(e.target.checked); });
    $("#mail-test").onclick = () => this.checkEmail(true);
    // your apps
    $("#app-save").onclick = () => this.saveApp();
    $("#app-cancel").onclick = () => this.editApp(null);
    $("#app-find-go").onclick = () => this.findApps();
    $("#app-find").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); this.findApps(); } });
    $("#app-browse").onclick = async () => {
      const r = await api.appsDo({ action: "pick" }).catch((e) => ({ error: e.message }));
      if (r.error) this.h.toast(r.error, true);
      if (r.path) this.pickRun(r.path);
    };
    // mcp
    $("#mcp-save").onclick = () => this.saveMcp();
    $("#mcp-reconnect").onclick = () => api.mcpDo({ action: "reconnect" }).then(() => this.h.toast("Reconnecting...")).catch((e) => this.h.toast(e.message, true));
    $("#mcp-import").onclick = () => this.importClaude();
    $("#mcp-json").oninput = () => (this.mcpDirty = true);
    // Claude talking to him (the other way round): saved the moment it's switched
    $("#claude-on").onchange = (e) => this.claudeDo(e.target.checked ? "enable" : "disable");
    $("#claude-new-token").onclick = () => this.claudeDo("new-token");
    $("#claude-show").onclick = () => { this.claudeShown = !this.claudeShown; this.renderClaude(this.claude); };
    $("#claude-copy-url").onclick = () => this.copy(this.claude?.url || "");
    $("#claude-copy-token").onclick = () => this.copy(this.claude?.token || "");
    $("#claude-copy-desktop").onclick = () => this.copy(JSON.stringify(this.claude?.desktop || {}, null, 2));
    $("#claude-copy-code").onclick = () => this.copy(this.claude?.claudeCode || "");
    // documents
    this.el.querySelectorAll("[name=docSkill], #docs-on").forEach((c) => (c.onchange = () => this.saveDocs()));
    // messaging
    const pane = this.el.querySelector("[data-pane=msg]");
    pane.addEventListener("input", (e) => { if (!e.target.matches("[type=password]")) this.msgDirty = true; });
    pane.addEventListener("change", (e) => { if (!e.target.matches("[type=password]")) this.msgDirty = true; if (e.target.id === "wa-tunnel" && this.msg) this.renderMessaging(this.msg); });
    $("#msg-save").onclick = () => this.saveMessaging();
    $("#wa-copy").onclick = () => this.copy($("#wa-verify").textContent);
    $("#wa-copy-url").onclick = () => this.copy($("#wa-callback").textContent);
    $("#wa-check").onclick = async () => { await this.saveMessaging(true); const r = await api.remoteDo({ action: "wa-check" }).catch((e) => ({ ok: false, error: e.message })); this.h.toast(r.ok ? "The tunnel reaches D.E.N.N.I.S. - paste the callback URL and verify token into Meta" : r.error, !r.ok); };
    $("#wa-test").onclick = () => this.test("whatsapp");
    $("#teams-test").onclick = () => this.test("teams");
    $("#teams-signin").onclick = () => this.teamsSignIn();
    $("#teams-signout").onclick = () => api.remoteDo({ action: "teams-signout" }).then(() => this.loadMessaging()).catch((e) => this.h.toast(e.message, true));
    $("#teams-inbox-suggest").onclick = async () => {
      const r = await api.remoteDo({ action: "inbox-suggest" }).catch(() => ({}));
      if (!r.folder) return this.h.toast("I can't find OneDrive on this computer", true);
      $("#teams-inbox").value = r.folder;
      this.msgDirty = true;
      this.h.toast(`In OneDrive that's the folder ${r.onedrivePath} - point the Workflow's "Create file" there`);
    };
    setInterval(() => { if (this.running().length) this.renderWidget(); }, 1000);
  }

  // ---------------------------------------------------------------- panel
  async open(tab = "skills") {
    this.el.classList.add("show");
    this.tab(tab);
    await Promise.all([this.loadSkills(), this.loadMinions(), this.loadApps(), this.loadMcp(), this.loadClaude(), this.loadMessaging(), this.loadEmail()]).catch((e) => this.h.toast(e.message, true));
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

  // ---------------------------------------------------------------- email (server/outlook.js)
  async loadEmail() {
    const on = !!this.h.getConfig()?.email?.enabled;
    $("#mail-on").checked = on;
    if (on) return this.checkEmail(false);
    this.emailState("", "off - switch it on to let him read your Outlook email");
  }
  emailState(dot, text) {
    $("#mail-dot").className = `dot ${dot}`;
    $("#mail-status").textContent = text ? ` \u00b7 ${text}` : "";
  }
  async checkEmail(test) {
    this.emailState("warn", "checking Outlook...");
    const r = await api.emailDo({ action: "test" }).catch((e) => ({ ok: false, error: e.message }));
    if (!r.ok) { this.emailState("err", r.error); if (test) this.h.toast(r.error, true); return; }
    const s = r.status;
    this.emailState(r.enabled ? "ok" : "", `${r.enabled ? "connected" : "reachable, but switched off"}: ${s.total.toLocaleString()} in the inbox, ${s.unread} unread`);
    if (test) this.h.toast(`Outlook answers: ${s.unread} unread in your inbox`);
  }
  async setEmail(on) {
    await this.h.saveSettings({ email: { enabled: on } });
    if (on) return this.checkEmail(true);
    this.emailState("", "off");
  }

  // ---------------------------------------------------------------- your apps (server/apps.js)
  async loadApps() {
    const { apps, canPick } = await api.apps();
    this.apps = apps;
    this.h.setApps?.(apps);
    $("#app-browse").hidden = !canPick;
    const list = $("#app-list");
    list.innerHTML = apps.length ? "" : `<div class="empty">No apps yet. Add one below - or tell D.E.N.N.I.S. "add Premiere to my apps".</div>`;
    const what = (a) => (a.page && a.run ? `${a.page}  \u00b7  started by ${a.run}` : a.page ? `${a.page}${a.where === "browser" ? "  \u00b7  in your browser" : ""}` : a.run);
    for (const a of apps) {
      const row = document.createElement("div");
      row.className = "item app";
      row.innerHTML = `<span class="dot"></span><div class="txt"><b>${esc(a.name)}</b><small>${esc(what(a))}</small></div><div class="acts"><button type="button" data-a="open">OPEN</button><button type="button" data-a="edit">EDIT</button><button type="button" class="x" data-a="remove" title="Remove">&times;</button></div>`;
      row.onclick = (e) => {
        const act = e.target.closest("[data-a]")?.dataset.a;
        if (act === "open") this.openApp(a.name);
        if (act === "edit") this.editApp(a);
        if (act === "remove") this.saveApps(this.apps.filter((x) => x !== a), `Removed ${a.name}`);
      };
      list.appendChild(row);
      if (a.page) api.appsDo({ action: "check", name: a.name }).then((r) => { const d = $(".dot", row); d.classList.add(r.up ? "up" : "down"); d.title = r.up ? "Running" : "Not running - opening it starts it"; }).catch(() => {});
    }
  }
  async openApp(name) {
    const r = await api.appsDo({ action: "open", name }).catch((e) => ({ ok: false, error: e.message }));
    if (!r.ok) return this.h.toast(r.error, true);
    this.close();
    if (r.show) this.h.showUi?.(r.show);
    this.h.toast(r.starting ? `Starting ${name} - it opens here once it's ready` : `Opening ${name}`);
  }
  editApp(a) {
    this.editing = a ? a.name : null;
    $("#app-name").value = a?.name || "";
    $("#app-run").value = a?.run || "";
    $("#app-page").value = a?.page || "";
    $("#app-ready").value = a?.ready || "";
    $("#app-where").value = a?.where || "dennis";
    $("#app-found").innerHTML = "";
    $("#app-form").open = !!a;
    $("#app-form summary").textContent = a ? `EDIT ${a.name.toUpperCase()}` : "ADD AN APP";
    if (a) $("#app-name").focus();
  }
  pickRun(p) {
    $("#app-run").value = p;
    if (!$("#app-name").value.trim()) $("#app-name").value = p.split(/[\\/]/).pop().replace(/\.(lnk|url|exe|bat|cmd|app|appref-ms)$/i, "").replace(/\s*-\s*Shortcut$/i, "").replace(/^Start\s+/i, "");
  }
  async findApps() {
    const q = $("#app-find").value.trim();
    const box = $("#app-found");
    if (!q) return;
    const r = await api.appsDo({ action: "find", query: q }).catch((e) => ({ ok: false, error: e.message }));
    box.innerHTML = r.found?.length ? "" : `<div class="empty">${esc(r.error || `Nothing called "${q}" in the Start menu or on the desktop - try BROWSE.`)}</div>`;
    for (const f of r.found || []) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "item found";
      row.innerHTML = `<div class="txt"><b>${esc(f.name)}</b><small>${esc(f.path)}</small></div>`;
      row.onclick = () => { this.pickRun(f.path); box.innerHTML = ""; };
      box.appendChild(row);
    }
  }
  async saveApp() {
    const app = { name: $("#app-name").value.trim(), run: $("#app-run").value.trim(), page: $("#app-page").value.trim(), ready: $("#app-ready").value.trim(), where: $("#app-where").value };
    if (!app.name) return this.h.toast("Give it a name", true);
    if (!app.run && !app.page) return this.h.toast("It needs a program to run, a web page, or both", true);
    const others = (this.apps || []).filter((a) => a.name !== this.editing && a.name.toLowerCase() !== app.name.toLowerCase());
    if (await this.saveApps([...others, app], `Saved ${app.name}`, app.name)) this.editApp(null);
  }
  async saveApps(list, done, expect) {
    const r = await api.appsDo({ action: "save", apps: list }).catch((e) => ({ ok: false, error: e.message }));
    if (!r.ok) { this.h.toast(r.error || "Couldn't save", true); return false; }
    if (expect && !r.apps.some((a) => a.name === expect)) { this.h.toast("That web address doesn't look right", true); return false; }
    this.h.toast(done);
    await this.loadApps();
    return true;
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

  // ---------------------------------------------------------------- Claude talking to him (server/mcp-server.js)
  async loadClaude() { this.renderClaude(await api.mcpServer()); }
  async claudeDo(action) {
    const r = await api.mcpServerDo({ action }).catch((e) => ({ ok: false, error: e.message }));
    if (!r.ok) { this.h.toast(r.error, true); return this.loadClaude().catch(() => {}); }
    this.renderClaude(r);
    this.h.toast(action === "enable" ? "Claude can talk to me now - copy the config for the Claude app or Claude Code" : action === "disable" ? "Claude's access is off" : "New token made - the old one no longer works. The Claude app picks it up by itself; Claude Code needs the new command");
  }
  renderClaude(s) {
    if (!s) return;
    this.claude = s;
    $("#claude-on").checked = s.enabled;
    $("#claude-details").hidden = !s.enabled;
    $("#claude-dot").className = `dot ${s.enabled ? "ok" : ""}`;
    $("#claude-status").textContent = s.enabled ? "on" : "off";
    $("#claude-url").textContent = s.url || "";
    $("#claude-token").textContent = s.token ? (this.claudeShown ? s.token : `${s.token.slice(0, 11)}${"•".repeat(12)}`) : "";
    $("#claude-show").textContent = this.claudeShown ? "HIDE" : "SHOW";
  }

  // ---------------------------------------------------------------- documents
  saveDocs() {
    const skills = [...this.el.querySelectorAll("[name=docSkill]:checked")].map((c) => c.value);
    this.h.saveSettings({ docSkills: { enabled: $("#docs-on").checked && skills.length > 0, skills } });
  }

  // ---------------------------------------------------------------- messaging (WhatsApp, Teams)
  async loadMessaging() {
    const st = await api.remote();
    this.renderMessaging(st);
    if (st.teams.signedIn && !this.teamsChats) this.loadChats();
  }
  async loadChats() {
    const r = await api.remoteDo({ action: "teams-chats" }).catch((e) => ({ ok: false, error: e.message }));
    if (!r.ok) { this.h.toast(`Teams: ${r.error}`, true); return; }
    this.teamsChats = r.chats;
    this.renderChats();
  }
  renderChats() {
    const sel = $("#teams-chat"), cur = this.msg?.teams.chatId || "";
    const chats = this.teamsChats || [];
    sel.innerHTML = `<option value="">${this.msg?.teams.signedIn ? "choose a chat..." : "sign in first"}</option>` +
      [...(cur && !chats.some((c) => c.id === cur) ? [{ id: cur, name: this.msg.teams.chatName || "the chat you chose" }] : []), ...chats]
        .map((c) => `<option value="${esc(c.id)}" ${c.id === cur ? "selected" : ""}>${esc(c.name)}</option>`).join("");
  }
  renderMessaging(st) {
    this.msg = st;
    const wa = st.whatsapp, tm = st.teams, f = st.forward;
    if (!this.msgDirty) {
      $("#wa-on").checked = !!wa.enabled;
      $("#wa-phone").value = wa.phoneNumberId || "";
      $("#wa-allow").value = (wa.allow || []).join(", ");
      $("#wa-url").value = wa.publicUrl || "";
      $("#wa-tunnel").value = wa.tunnel === "cloudflared" ? "cloudflared" : "own";
      $("#wa-appid").value = wa.appId || "";
      $("#wa-port").value = wa.port || 47820;
      $("#wa-template").value = wa.template || "";
      $("#teams-on").checked = !!tm.enabled;
      $("#teams-client").value = tm.clientId || "";
      $("#teams-tenant").value = tm.tenant || "organizations";
      $("#teams-inbox").value = tm.inboxFolder || "";
      $("#teams-inbox-prefix").checked = tm.inboxPrefix !== false;
      this.el.querySelectorAll("[data-fwd]").forEach((c) => (c.checked = !!f[c.dataset.fwd]));
      $("#fwd-mins").value = f.awayMinutes || 10;
      $("#fwd-via").value = f.via || "whatsapp";
      this.renderChats();
    }
    const saved = (el, on, key) => { el.innerHTML = on ? `· SAVED <button type="button" class="forget" title="Forget it">&times;</button>` : ""; const b = el.querySelector(".forget"); if (b) b.onclick = (e) => { e.preventDefault(); this.forget(key); }; };
    saved($("#wa-token-state"), wa.hasToken, "waToken");
    saved($("#wa-secret-state"), wa.hasSecret, "waAppSecret");
    saved($("#teams-hook-state"), tm.hasWebhook, "teamsWebhook");
    $("#wa-callback").textContent = `${wa.publicUrl || "https://<your tunnel's address>"}/whatsapp`;
    const quick = $("#wa-tunnel").value === "cloudflared";
    $("#wa-url-row").hidden = quick; // the quick tunnel finds its own address
    $("#wa-tunnel-state").textContent = !quick ? `yours - point it at http://localhost:${wa.port}`
      : wa.cloudflared === false ? "cloudflared isn't installed yet (see the README, under Messaging)"
      : wa.tunnelState || (wa.enabled ? "starting..." : "starts when WhatsApp is switched on");
    $("#wa-verify").textContent = wa.verifyToken || "";
    const dot = (el, cls) => { el.className = `dot ${cls}`; };
    // WhatsApp: what's missing, or how it's going
    let w;
    if (!wa.enabled) w = ["", "off"];
    else if (wa.error) w = ["err", wa.error];
    else if (!wa.hasToken || !wa.phoneNumberId || !wa.allow?.length) w = ["warn", "fill in the phone number ID, your number and the access token"];
    else if (!wa.hasSecret) w = ["warn", "add the App secret"];
    else if (!wa.listening) w = ["err", "the listener isn't running"];
    else if (!wa.lastInbound) w = ["warn", `listening on port ${wa.port} - message your D.E.N.N.I.S. number to start`];
    else w = ["ok", `connected · last message ${new Date(wa.lastInbound).toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" })}${wa.windowOpen ? "" : " · 24 h window closed: updates wait for your next message"}${wa.held ? ` · ${wa.held} waiting` : ""}`];
    dot($("#wa-dot"), w[0]);
    $("#wa-status").textContent = w[1];
    // Teams
    let t;
    if (!tm.enabled) t = ["", "off"];
    else if (tm.signin) t = ["warn", "waiting for you to sign in..."];
    else if (tm.error) t = ["err", tm.error];
    else if (tm.chatReady && tm.polling) t = ["ok", `watching "${tm.chatName || "your chat"}"${tm.account ? ` as ${tm.account}` : ""}`];
    else if (tm.signedIn && !tm.chatId) t = ["warn", `signed in${tm.account ? ` as ${tm.account}` : ""} - pick the chat below, then save`];
    else if (tm.hasWebhook && tm.inboxReady) t = tm.inbox?.error ? ["err", tm.inbox.error] : ["ok", `two-way: messages through your OneDrive inbox${tm.inbox?.lastAt ? ` (last ${new Date(tm.inbox.lastAt).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })})` : ""}, replies through your Workflow`];
    else if (tm.hasWebhook) t = ["ok", "updates only, through your Workflow"];
    else if (!tm.clientId) t = ["warn", "add your app registration's client ID, then sign in"];
    else t = ["warn", "sign in to Teams"];
    dot($("#teams-dot"), t[0]);
    $("#teams-status").textContent = t[1];
    $("#teams-signout").hidden = !tm.signedIn;
    $("#teams-inbox-row").hidden = !tm.inboxFolder;
    $("#teams-inbox-state").textContent = !tm.inboxFolder ? "" : tm.inbox?.error ? tm.inbox.error : tm.inbox?.running ? `watching - ${tm.inbox.handled} message${tm.inbox.handled === 1 ? "" : "s"} handled${tm.inbox.ignored ? `, ${tm.inbox.ignored} notes skipped (no "Dennis")` : ""}` : !tm.hasWebhook ? "needs the Workflow URL above for his replies" : "starts when Teams is switched on";
    $("#teams-signin").textContent = tm.signedIn ? "SIGN IN AGAIN" : "SIGN IN TO TEAMS";
    $("#teams-code").innerHTML = tm.signin ? `Open <a href="${esc(tm.signin.url)}" target="_blank" rel="noopener">${esc(tm.signin.url)}</a> and enter the code <b>${esc(tm.signin.userCode)}</b>` : "";
  }
  messagingPatch() {
    const chat = $("#teams-chat");
    const patch = { remote: {
      whatsapp: { enabled: $("#wa-on").checked, phoneNumberId: $("#wa-phone").value.trim(), allow: $("#wa-allow").value, port: +$("#wa-port").value || 47820, template: $("#wa-template").value.trim(),
        tunnel: $("#wa-tunnel").value, appId: $("#wa-appid").value.trim(), ...($("#wa-tunnel").value === "own" ? { publicUrl: $("#wa-url").value.trim() } : {}) },
      teams: { enabled: $("#teams-on").checked, clientId: $("#teams-client").value.trim(), tenant: $("#teams-tenant").value.trim() || "organizations", chatId: chat.value, chatName: chat.value ? chat.selectedOptions[0]?.textContent || "" : "",
        inboxFolder: $("#teams-inbox").value.trim(), inboxPrefix: $("#teams-inbox-prefix").checked },
      forward: { ...Object.fromEntries([...this.el.querySelectorAll("[data-fwd]")].map((c) => [c.dataset.fwd, c.checked])), awayMinutes: Math.max(1, +$("#fwd-mins").value || 10), via: $("#fwd-via").value },
    } };
    for (const [id, key] of [["#wa-token", "waToken"], ["#wa-secret", "waAppSecret"], ["#teams-hook", "teamsWebhook"]]) { const v = $(id).value.trim(); if (v) patch[key] = v; }
    return patch;
  }
  async saveMessaging(quiet = false) {
    await this.h.saveSettings(this.messagingPatch());
    for (const id of ["#wa-token", "#wa-secret", "#teams-hook"]) $(id).value = "";
    this.msgDirty = false;
    await this.loadMessaging().catch(() => {});
    if (!quiet) this.h.toast("Messaging saved");
  }
  async forget(key) { await this.h.saveSettings({ [key]: "" }); await this.loadMessaging().catch(() => {}); this.h.toast("Forgotten"); }
  async test(channel) {
    await this.saveMessaging(true);
    const r = await api.remoteDo({ action: "test", channel }).catch((e) => ({ ok: false, error: e.message }));
    this.h.toast(r.ok ? r.text : r.error, !r.ok);
  }
  async teamsSignIn() {
    await this.saveMessaging(true); // the client ID has to be saved first
    const r = await api.remoteDo({ action: "teams-signin" }).catch((e) => ({ ok: false, error: e.message }));
    if (!r.ok) return this.h.toast(r.error, true);
    this.teamsChats = null;
    await this.loadMessaging().catch(() => {});
  }
  async copy(text) {
    try { await navigator.clipboard.writeText(text); this.h.toast("Copied"); } catch { this.h.toast("Couldn't reach the clipboard - select it and copy", true); }
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
    else if (ev.type === "remote_status" && this.isOpen) {
      const wasSignedIn = this.msg?.teams.signedIn;
      this.renderMessaging(ev.status);
      if (ev.status.teams.signedIn && !wasSignedIn) { this.teamsChats = null; this.loadChats(); this.h.toast("Signed in to Teams - now pick the chat"); }
    }
    return null;
  }
}
