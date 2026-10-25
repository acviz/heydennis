// D.E.N.N.I.S.'s line to classic Outlook. Runs under Windows Script Host (cscript, JScript),
// started and fed by server/outlook.js - it is not a Node module. Classic Outlook's object
// model is reached through COM, which Windows Script Host can use where PowerShell can't.
//
// One JSON command per line on stdin, one JSON reply per line on stdout. Replies are ASCII
// only (everything else is \u-escaped), so the console's code page can't garble Arabic or
// emoji. Commands: status, list, read, search, draft, send. Everything is read-only except
// draft (saves a draft in Drafts) and send (sends a draft) - and outlook.js / tools.js only
// ask for those after the user's yes.
//
// Holding the Outlook object keeps classic Outlook running (hidden, if it wasn't open), so
// the user doesn't have to keep its window open. If they close Outlook, the next command
// starts it again.

var app = null, ns = null;
var OL_MAIL = 43, OL_INBOX = 6, OL_SENT = 5, OL_DRAFTS = 16;

function outlook() {
  if (!ns) {
    app = new ActiveXObject("Outlook.Application");
    ns = app.GetNamespace("MAPI");
  }
  return ns;
}
// Outlook closed under us (RPC server unavailable / object disconnected): reconnect once
function gone(e) {
  var n = (e.number >>> 0).toString(16);
  return n === "800706ba" || n === "80010108" || n === "800706be" || n === "80010012";
}

// ---------------------------------------------------------------- JSON (WSH's JScript has none)
function q(s) {
  s = String(s);
  var o = '"';
  for (var i = 0; i < s.length; i++) {
    var c = s.charCodeAt(i);
    if (c === 34) o += '\\"';
    else if (c === 92) o += "\\\\";
    else if (c < 32 || c > 126) { var h = c.toString(16); o += "\\u" + "0000".substr(h.length) + h; }
    else o += s.charAt(i);
  }
  return o + '"';
}
function enc(v) {
  if (v === null || v === undefined) return "null";
  var t = typeof v;
  if (t === "number") return isFinite(v) ? String(v) : "null";
  if (t === "boolean") return v ? "true" : "false";
  if (t === "string") return q(v);
  if (v instanceof Array) { var a = []; for (var i = 0; i < v.length; i++) a.push(enc(v[i])); return "[" + a.join(",") + "]"; }
  var p = [];
  for (var k in v) if (v.hasOwnProperty(k)) p.push(q(k) + ":" + enc(v[k]));
  return "{" + p.join(",") + "}";
}

// ---------------------------------------------------------------- emails
function str(f) { try { var v = f(); return v === null || v === undefined ? "" : String(v); } catch (e) { return ""; } }
function when(f) { try { var d = new Date(f()).getTime(); return isFinite(d) ? d : 0; } catch (e) { return 0; } }
function squeeze(s, n) { s = String(s || "").replace(/\s+/g, " ").replace(/^\s+|\s+$/g, ""); return s.length > n ? s.substr(0, n) + "..." : s; }

/** The sender's real address (Exchange gives an internal path for colleagues). */
function senderAddress(it) {
  var a = str(function () { return it.SenderEmailAddress; });
  if (a.charAt(0) === "/") {
    var smtp = str(function () { return it.Sender.GetExchangeUser().PrimarySmtpAddress; });
    if (smtp) return smtp;
  }
  return a;
}
function summary(it) {
  var mail = it.Class === OL_MAIL;
  return {
    id: str(function () { return it.EntryID; }),
    kind: mail ? "email" : "item " + it.Class,
    from: str(function () { return it.SenderName; }),
    fromAddress: mail ? senderAddress(it) : "",
    to: str(function () { return it.To; }),
    cc: str(function () { return it.CC; }),
    subject: str(function () { return it.Subject; }),
    received: when(function () { return it.ReceivedTime; }),
    unread: str(function () { return it.UnRead; }) === "true",
    importance: Number(str(function () { return it.Importance; })) || 1, // 0 low, 1 normal, 2 high
    flagged: str(function () { return it.FlagStatus; }) === "2",
    attachments: Number(str(function () { return it.Attachments.Count; })) || 0,
    preview: squeeze(str(function () { return it.Body; }), 220)
  }; // (no trailing commas: Windows Script Host's JScript predates them)
}
function folderOf(name) {
  var n = outlook();
  return n.GetDefaultFolder(name === "sent" ? OL_SENT : name === "drafts" ? OL_DRAFTS : OL_INBOX);
}
function newest(items, limit, sinceMs) {
  items.Sort("[ReceivedTime]", true); // newest first
  var out = [];
  for (var i = 1; i <= items.Count && out.length < limit; i++) {
    var it = items.Item(i);
    var s = summary(it);
    if (sinceMs && s.received && s.received <= sinceMs) break;
    out.push(s);
  }
  return out;
}

function handle(r) {
  var limit = Math.max(1, Math.min(50, Number(r.limit) || 10));
  if (r.cmd === "status") {
    var inbox = folderOf("inbox");
    return { version: str(function () { return app.Version; }), mailbox: str(function () { return outlook().DefaultStore.DisplayName; }), total: inbox.Items.Count, unread: inbox.UnReadItemCount };
  }
  if (r.cmd === "list") {
    var f = folderOf(r.folder), items = r.unread ? f.Items.Restrict("[UnRead] = True") : f.Items;
    return { folder: r.folder || "inbox", unread: f.UnReadItemCount, total: f.Items.Count, emails: newest(items, limit, Number(r.since) || 0) };
  }
  if (r.cmd === "read") {
    var it = outlook().GetItemFromID(String(r.id));
    var s = summary(it), body = str(function () { return it.Body; });
    var max = Math.max(1000, Math.min(60000, Number(r.max) || 30000));
    s.body = body.length > max ? body.substr(0, max) : body;
    s.truncated = body.length > max;
    s.attachmentNames = [];
    for (var i = 1; i <= s.attachments; i++) s.attachmentNames.push(str(function () { return it.Attachments.Item(i).FileName; }));
    return { email: s };
  }
  if (r.cmd === "search") {
    var words = String(r.query || "").replace(/'/g, "''").replace(/^\s+|\s+$/g, "");
    if (!words) throw new Error("Nothing to search for.");
    var fields = ["urn:schemas:httpmail:subject", "urn:schemas:httpmail:fromname", "urn:schemas:httpmail:fromemail", "urn:schemas:httpmail:displayto", "urn:schemas:httpmail:textdescription"];
    var cond = [];
    for (var j = 0; j < fields.length; j++) cond.push('"' + fields[j] + "\" LIKE '%" + words + "%'");
    var folders = r.folder === "sent" ? ["sent"] : r.folder === "inbox" ? ["inbox"] : ["inbox", "sent"];
    var found = [];
    for (var k = 0; k < folders.length; k++) {
      var hits = folderOf(folders[k]).Items.Restrict("@SQL=" + cond.join(" OR "));
      var got = newest(hits, limit, 0);
      for (var m = 0; m < got.length; m++) { got[m].folder = folders[k]; found.push(got[m]); }
    }
    found.sort(function (a, b) { return b.received - a.received; });
    return { emails: found.slice(0, limit) };
  }
  if (r.cmd === "draft") {
    var d;
    if (r.replyTo) {
      var orig = outlook().GetItemFromID(String(r.replyTo));
      d = r.replyAll ? orig.ReplyAll() : orig.Reply();
      var html = "<div>" + String(r.body || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\r?\n/g, "<br>") + "</div><br>";
      var h = String(d.HTMLBody || "");
      d.HTMLBody = /<body[^>]*>/i.test(h) ? h.replace(/(<body[^>]*>)/i, "$1" + html) : html + h;
      if (r.cc) d.CC = String(r.cc);
    } else {
      outlook();
      d = app.CreateItem(0);
      d.To = String(r.to || "");
      if (r.cc) d.CC = String(r.cc);
      d.Subject = String(r.subject || "");
      d.Body = String(r.body || "");
    }
    d.Save();
    if (r.show) { try { d.Display(false); } catch (e) { /* no window: it's still in Drafts */ } }
    return { id: str(function () { return d.EntryID; }), to: str(function () { return d.To; }), cc: str(function () { return d.CC; }), subject: str(function () { return d.Subject; }) };
  }
  if (r.cmd === "peek") { // a draft's details, for the approval before sending
    var dr = outlook().GetItemFromID(String(r.id));
    return { to: str(function () { return dr.To; }), cc: str(function () { return dr.CC; }), subject: str(function () { return dr.Subject; }), body: squeeze(str(function () { return dr.Body; }), 1200), sent: !!dr.Sent };
  }
  if (r.cmd === "send") {
    var sd = outlook().GetItemFromID(String(r.id));
    if (sd.Sent) throw new Error("That one has already been sent.");
    sd.Send();
    return { sent: true };
  }
  throw new Error("unknown command " + r.cmd);
}

while (!WScript.StdIn.AtEndOfStream) {
  var line = WScript.StdIn.ReadLine(), req = null, res;
  try {
    req = eval("(" + line + ")"); // our own JSON, from outlook.js
    try { res = handle(req); }
    catch (e) {
      if (!gone(e)) throw e;
      app = null; ns = null; // Outlook was closed: start it again and retry once
      res = handle(req);
    }
    res.ok = true;
  } catch (e) {
    res = { ok: false, error: String(e.message || e.description || e), code: (e.number >>> 0).toString(16) };
  }
  res.seq = req ? req.seq : null;
  WScript.StdOut.WriteLine(enc(res));
}
