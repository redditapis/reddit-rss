#!/usr/bin/env node
import { configFromEnv, createServer } from "./server.js";

let cfg;
try {
  // Refuses a missing key, and an instance others can reach with no FEED_TOKEN (unless ALLOW_PUBLIC=1).
  cfg = configFromEnv();
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
const server = createServer(cfg);
server.listen(cfg.port, cfg.host, () => {
  const { port } = server.address();
  console.log(`reddit-rss listening on ${cfg.host}:${port} (cache ${cfg.cacheTtlSeconds}s, at most ${cfg.callsPerMinute} API calls a minute and ${cfg.callsPerDay} a day${cfg.feedToken ? ", token required" : ""})`);
  if (cfg.allowPublic && !cfg.feedToken) {
    console.log("No FEED_TOKEN is set: keep this instance private (publish the port on 127.0.0.1 only), or set FEED_TOKEN before exposing it.");
  }
});
