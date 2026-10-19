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
createServer(cfg).listen(port, () => {
  console.log(`reddit-rss listening on :${port} (cache ${cfg.cacheTtlSeconds}s${cfg.feedToken ? ", token required" : ""})`);
});
