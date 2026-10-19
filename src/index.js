#!/usr/bin/env node
import { configFromEnv, createServer } from "./server.js";

let cfg;
try {
  cfg = configFromEnv();
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
const port = Number(process.env.PORT) || 8080;
// This machine only unless HOST says otherwise: an instance reachable by others spends your balance.
const host = process.env.HOST || "127.0.0.1";
createServer(cfg).listen(port, host, () => {
  console.log(`reddit-rss listening on ${host}:${port} (cache ${cfg.cacheTtlSeconds}s${cfg.feedToken ? ", token required" : ""})`);
  if (host !== "127.0.0.1" && host !== "localhost" && !cfg.feedToken) console.log("warning: reachable beyond this machine with no FEED_TOKEN; anyone who can reach it spends your API balance");
});
