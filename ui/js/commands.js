// Instant commands: the everyday ones are handled right here, with no round trip to the
// brain, so they happen the moment you finish speaking. Anything that isn't plainly one of
// these goes to D.E.N.N.I.S. as usual - when in doubt, this returns null.
//
// matchCommand(text, { places }) -> { action, arg?, ack } | null
//   places: [{ name, path, isDir }] - mapped folders and what's on screen, for "open X"
const FILLER = new Set("please pls dennis denis hey ok okay alright now just can could would will you for me mate thanks thank".split(" "));

function norm(text) {
  const words = String(text || "").toLowerCase().replace(/[^\p{L}\p{N}' ]+/gu, " ").split(/\s+/).filter(Boolean);
  return words.filter((w) => !FILLER.has(w)).join(" ").replace(/^(go |take |bring |head )/, "").trim(); // "take me home" -> "home" ("me" is filler)
}
const is = (t, ...alts) => alts.some((a) => new RegExp(`^(?:${a})$`).test(t));
const THEME_ACK = { reactor: "Back to the classic.", spiral: "Spiral it is. Mind the light trails.", neural: "Neural. Feeling rather brainy.", grid: "Into the grid." };

export function matchCommand(text, { places = [] } = {}) {
  const t = norm(text);
  if (!t || t.split(" ").length > 7) return null;
  if (is(t, "home", "to the home( screen)?", "back home", "show (me )?(the )?(overview|home|everything|all( my)? folders)", "overview")) return { action: "home", ack: "Overview." };
  if (is(t, "back", "go back", "up", "up a level", "back up", "previous( folder)?", "back to the previous folder")) return { action: "back", ack: "Back we go." };
  if (is(t, "(go )?full ?screen", "(make it|switch to) full ?screen", "maximi[sz]e")) return { action: "fullscreen", ack: "Full screen." };
  if (is(t, "exit full ?screen", "leave full ?screen", "normal size", "restore")) return { action: "exitFullscreen", ack: "Back to normal." };
  if (is(t, "compact( mode)?", "(go|switch to) compact( mode)?", "mini( mode)?", "minimi[sz]e( yourself)?", "shrink")) return { action: "compact", ack: "Going compact." };
  if (is(t, "undo( that| it| the last (change|move|one))?", "put it back", "revert( that)?")) return { action: "undo", ack: "" };
  if (is(t, "close( (it|this|that|the (file|window|preview)))?")) return { action: "close", ack: "" };
  if (is(t, "close (all|everything|all (the )?windows|all files)")) return { action: "closeAll", ack: "All closed." };
  if (is(t, "mute( yourself)?", "voice off", "stop speaking aloud", "go quiet")) return { action: "voiceOff", ack: "" };
  if (is(t, "unmute( yourself)?", "voice on", "speak (again|aloud)", "talk to me")) return { action: "voiceOn", ack: "Voice back on." };
  if (is(t, "(turn )?hands? (tracking )?on", "(start|enable) hand tracking")) return { action: "handsOn", ack: "Hand tracking on." };
  if (is(t, "(turn )?hands? (tracking )?off", "(stop|disable) hand tracking")) return { action: "handsOff", ack: "Hand tracking off." };
  if (is(t, "(turn )?(the )?camera off", "hide (the )?camera")) return { action: "cameraOff", ack: "Camera off." };
  if (is(t, "(turn )?(the )?camera on", "show (the )?camera")) return { action: "cameraOn", ack: "Camera on." };
  if (is(t, "what time is it", "what's the time", "the time", "time", "what is the time")) return { action: "time", ack: "" };
  if (is(t, "what day is it", "what's the date", "what is the date", "(today's )?date", "what's today")) return { action: "date", ack: "" };
  if (is(t, "(open |show )?(the )?settings")) return { action: "settings", ack: "" };
  if (is(t, "(open |show )?(the )?capabilities", "(show )?(my )?(skills|minions)")) return { action: "capabilities", ack: "" };
  if (is(t, "(rescan|re-?index|refresh)( (the )?(files|index))?")) return { action: "rescan", ack: "Rescanning." };
  if (is(t, "(start )?(taking )?(meeting )?notes", "take (meeting )?notes", "meeting mode", "record (the |this )?meeting", "start (the )?notes")) return { action: "notesStart", ack: "" };
  if (is(t, "stop (taking )?(the )?notes", "end (the )?notes", "stop recording( the meeting)?")) return { action: "notesStop", ack: "" };
  if (is(t, "do not disturb", "don't disturb me", "quiet mode", "(no|stop the|mute) notices", "notices off")) return { action: "dndOn", ack: "Understood. I'll keep my notices to myself." };
  if (is(t, "(you can )?disturb me( again)?", "notices on", "(turn )?off do not disturb", "quiet mode off")) return { action: "dndOff", ack: "Notices back on." };
  // continuous conversation: he listens all the time, no wake word, no key
  if (is(t, "continuous( conversation| mode| listening)*( on)?", "(start|turn on|enable|switch on|begin|go)( the)? continuous( conversation| mode| listening)*", "(conversation|convo) mode( on)?",
    "keep listening", "stay listening", "(always|keep) listen(ing)? to me", "listen (continuously|all the time|constantly)", "hands ?free conversation", "stay with me")) return { action: "continuousOn", ack: "" };
  if (is(t, "continuous( conversation| mode| listening)* off", "(stop|end|turn off|disable|switch off|exit|leave)( the)? continuous( conversation| mode| listening)*", "(conversation|convo) mode off",
    "stop listening( continuously| all the time)?")) return { action: "continuousOff", ack: "" };
  // themes: "switch to the neural theme", "spiral theme", "next theme", "change the look"
  const th = /^(?:(?:switch|change|set|go)(?: (?:the )?(?:theme|look))?(?: to)?(?: the)? )?(reactor|spiral|neural|grid|galaxy|neuron|cyber ?space|original|default)(?: (?:theme|look|mode|style))?$/.exec(t);
  if (th && (/theme|look|mode|style|switch|change|set/.test(t))) {
    const name = { galaxy: "spiral", neuron: "neural", cyberspace: "grid", "cyber space": "grid", original: "reactor", default: "reactor" }[th[1]] || th[1];
    return { action: "theme", arg: name, ack: THEME_ACK[name] };
  }
  if (is(t, "(next|another|different|switch|change|cycle)( the)? (theme|look|style)", "(switch|change) (the )?(themes|looks)")) return { action: "theme", arg: "next", ack: "" };
  if (is(t, "(next|switch) (tab|window)")) return { action: "nextWindow", ack: "" };
  if (is(t, "previous (tab|window)")) return { action: "prevWindow", ack: "" };
  // "open Downloads" / "show me the Renders folder": only when it names a folder that's mapped or on screen
  const m = /^(?:open|show|to)\s+(?:my |the )?(.+?)(?: folder)?$/.exec(t); // ("go"/"take" and "me" are already gone)
  if (m) {
    const want = m[1].trim();
    const folders = places.filter((p) => p.isDir);
    const hit = folders.find((p) => p.name.toLowerCase() === want) || (want.length >= 3 ? folders.find((p) => p.name.toLowerCase().startsWith(want)) : null);
    if (hit) return { action: "open", arg: hit.path, ack: `${hit.name}.` };
  }
  return null;
}
