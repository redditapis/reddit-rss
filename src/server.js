// The HTTP server: one GET per feed, cached, with ETag and Last-Modified for polite readers.

import http from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { routeFor, formatOf } from "./routes.js";
import { itemsOf, render } from "./feed.js";

export const SIGNUP_URL = "https://www.redditapis.com/?ref=gh-reddit-rss";
export const MAX_CACHE_ENTRIES = 1000;

/** Settings from the environment. Throws when the API key is missing. */
export function configFromEnv(env = process.env) {
  const apiKey = (env.REDDITAPIS_API_KEY || "").trim();
  if (!apiKey) throw new Error(`REDDITAPIS_API_KEY is not set. Get a key at ${SIGNUP_URL}`);
  const ttl = Number(env.CACHE_TTL_SECONDS);
  return {
    apiKey,
    apiBase: (env.REDDITAPIS_API_BASE || "https://api.redditapis.com").replace(/\/+$/, ""),
    cacheTtlSeconds: Number.isFinite(ttl) && ttl >= 0 ? ttl : 300,
    feedToken: (env.FEED_TOKEN || "").trim() || null,
    publicUrl: (env.PUBLIC_URL || "").replace(/\/+$/, "") || null,
  };
}

function tokenOk(expected, given) {
  if (!expected) return true;
  const a = Buffer.from(String(given || ""));
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function send(res, status, headers, body = "") {
  res.writeHead(status, { "X-Content-Type-Options": "nosniff", ...headers });
  res.end(body);
}

/**
 * @param {ReturnType<typeof configFromEnv>} cfg
 * @param {{ fetchImpl?: typeof fetch, now?: () => number }} [deps]
 */
export function createServer(cfg, { fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  const cache = new Map(); // upstream url -> { at, status, body, etag, lastModified, type }

  async function upstream(route) {
    const u = new URL(cfg.apiBase + route.path);
    for (const [k, v] of Object.entries(route.params)) if (v !== undefined && v !== null) u.searchParams.set(k, String(v));
    const key = u.toString();
    const hit = cache.get(key);
    if (hit && now() - hit.at < cfg.cacheTtlSeconds * 1000) return { ...hit, cached: true };
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 30_000);
    try {
      const r = await fetchImpl(key, {
        headers: { Authorization: `Bearer ${cfg.apiKey}`, Accept: "application/json", "User-Agent": "reddit-rss/1.0 (+https://github.com/redditapis/reddit-rss)" },
        signal: ctrl.signal,
      });
      const text = await r.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* reported below */ }
      if (!r.ok || !json) {
        // A failed refresh keeps serving the last good copy rather than breaking every reader.
        if (hit) return { ...hit, cached: true, stale: true };
        return { error: true, status: r.status, message: (json && (json.error || json.message)) || `upstream answered ${r.status}` };
      }
      const entry = { at: now(), json };
      cache.delete(key);
      cache.set(key, entry);
      // Map keeps insertion order, so the first key is the least recently refreshed.
      if (cache.size > MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value);
      return entry;
    } catch (e) {
      if (hit) return { ...hit, cached: true, stale: true };
      return { error: true, status: 504, message: e.name === "AbortError" ? "upstream timed out" : "upstream unreachable" };
    } finally {
      clearTimeout(timer);
    }
  }

  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost");
      if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, { Allow: "GET, HEAD" });
      if (url.pathname === "/" || url.pathname === "/healthz") {
        return send(res, 200, { "Content-Type": "text/plain; charset=utf-8" }, url.pathname === "/healthz" ? "ok\n" : `reddit-rss is running. Try /r/rss/.rss\nDocs: https://github.com/redditapis/reddit-rss\n`);
      }
      if (!tokenOk(cfg.feedToken, url.searchParams.get("token") || req.headers["x-feed-token"])) {
        return send(res, 401, { "Content-Type": "text/plain; charset=utf-8" }, "This instance needs ?token=<FEED_TOKEN>\n");
      }
      const route = routeFor(url.pathname, url.searchParams);
      if (!route) return send(res, 404, { "Content-Type": "text/plain; charset=utf-8" }, "No feed at this path. See https://github.com/redditapis/reddit-rss#feeds\n");

      const up = await upstream(route);
      if (up.error) {
        // A missing subreddit or user is the reader's 404; every other upstream failure is ours (502).
        const status = up.status === 404 ? 404 : 502;
        const hint = up.status === 402 ? ` Your API balance is empty: top up at ${SIGNUP_URL}` : up.status === 401 ? " Check REDDITAPIS_API_KEY." : "";
        return send(res, status, { "Content-Type": "text/plain; charset=utf-8", "Retry-After": "300" }, `Feed unavailable: ${up.message}.${hint}\n`);
      }

      const format = formatOf(url.pathname);
      const base = cfg.publicUrl || `http://${req.headers.host || "localhost"}`;
      const self = `${base}${url.pathname}${url.search}`;
      const { body, type } = render(format, { title: route.title, link: route.link, self, items: itemsOf(route.kind, up.json), promo: SIGNUP_URL });
      const etag = `"${createHash("sha1").update(body).digest("base64url")}"`;
      const lastModified = new Date(up.at).toUTCString();
      const headers = { "Content-Type": type, ETag: etag, "Last-Modified": lastModified, "Cache-Control": `public, max-age=${cfg.cacheTtlSeconds}` };
      if (req.headers["if-none-match"] === etag) return send(res, 304, headers);
      return send(res, 200, headers, req.method === "HEAD" ? "" : body);
    } catch (e) {
      return send(res, 500, { "Content-Type": "text/plain; charset=utf-8" }, "Internal error\n");
    }
  });
}
