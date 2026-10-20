// Run D.E.N.N.I.S. without Electron: `npm run serve` (or `npm run mock` for the
// no-API-key demo brain). Prints a private link; open it in Chrome.
//   --mock        use the mock brain instead of Claude
//   --open        open the link in the default browser
//   --port N      preferred port (default 47800)
//   --home DIR    data folder (default ~/.dennis, or $DENNIS_HOME)
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
if (opt("--home")) process.env.DENNIS_HOME = opt("--home");

// imported after --home is applied: config.js reads DENNIS_HOME when it loads
const { Config } = await import("./config.js");
const { startServer } = await import("./index.js");
const { nodePlatform } = await import("./platform-node.js");

const config = new Config();
const port = opt("--port") ? +opt("--port") : undefined;
const srv = await startServer({ config, platform: nodePlatform, mock: flag("--mock"), port });

console.log(`
  D.E.N.N.I.S. is online${flag("--mock") ? " (MOCK brain - no Claude calls)" : ""}
  Open this private link in Chrome:  ${srv.openUrl}
  Data folder: ${config.publicView().dataDir}
  Ctrl-C to stop.
`);
if (!config.hasCredentials() && !flag("--mock")) console.log("  No Claude API key yet - add one in Settings (gear icon) or set ANTHROPIC_API_KEY.\n");
if (flag("--open")) nodePlatform.openUrl(srv.openUrl);

const stop = async () => { await srv.close(); process.exit(0); };
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
