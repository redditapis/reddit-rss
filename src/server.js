// The HTTP server: one GET per feed, cached, with ETag and Last-Modified for polite readers.

import http from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { routeFor, formatOf } from "./routes.js";
import { itemsOf, render } from "./feed.js";

export const SIGNUP_URL = "https://www.redditapis.com/?ref=gh-reddit-rss";
// A single API response larger than this is refused rather than held in memory.
export const MAX_BODY_BYTES = 4 * 1024 * 1024;
// A failed refresh is remembered this long, so a broken feed is not re-fetched on every poll.
export const FAILURE_TTL_MS = 60_000;

function intEnv(value, fallback, min = 0) {
  if (value === undefined || value === null || String(value).trim() === "") return fallback;
  const n = Number(value);
  return Number.isInteger(n) && n >= min ? n : fallback;
}

/** Settings from the environment. Throws when the API key is missing. */
export function configFromEnv(env = process.env) {
  const apiKey = (env.REDDITAPIS_API_KEY || "").trim();
  if (!apiKey) throw new Error(`REDDITAPIS_API_KEY is not set. Get a key at ${SIGNUP_URL}`);
  return {
    apiKey,
    apiBase: (env.REDDITAPIS_API_BASE || "https://api.redditapis.com").replace(/\/+$/, ""),
    cacheTtlSeconds: intEnv(env.CACHE_TTL_SECONDS, 300),
    callsPerMinute: intEnv(env.MAX_API_CALLS_PER_MINUTE, 60, 1),
    cacheBytes: intEnv(env.CACHE_MAX_MB, 64, 1) * 1024 * 1024,
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

function messageOf(json, status) {
  const e = json && (json.error ?? json.message);
  if (typeof e === "string" && e) return e.slice(0, 200);
  if (e && typeof e === "object" && typeof e.message === "string") return e.message.slice(0, 200);
  return `upstream answered ${status}`;
}

/**
 * @param {ReturnType<typeof configFromEnv>} cfg
 * @param {{ fetchImpl?: typeof fetch, now?: () => number }} [deps]
 */
export function createServer(cfg, { fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  const cfgFull = { callsPerMinute: 60, cacheBytes: 64 * 1024 * 1024, ...cfg };
  const cache = new Map(); // upstream url -> { at, json, bytes }  (insertion order = least recently refreshed first)
  const failures = new Map(); // upstream url -> { at, status, message }
  const inflight = new Map(); // upstream url -> Promise, so concurrent readers share one call
  let cacheBytes = 0;
  let windowStart = 0;
  let callsThisWindow = 0;

  function remember(key, entry) {
    const old = cache.get(key);
    if (old) { cacheBytes -= old.bytes; cache.delete(key); }
    cache.set(key, entry);
    cacheBytes += entry.bytes;
    while (cacheBytes > cfgFull.cacheBytes && cache.size > 1) {
      const [k, v] = cache.entries().next().value;
      cache.delete(k);
      cacheBytes -= v.bytes;
    }
  }

  // Every API call costs the instance owner, so they are budgeted per minute whatever the
  // readers ask for: past the budget a request gets the last good copy or a 429, never a new call.
  function takeBudget() {
    const t = now();
    if (t - windowStart >= 60_000) { windowStart = t; callsThisWindow = 0; }
    if (callsThisWindow >= cfgFull.callsPerMinute) return false;
    callsThisWindow += 1;
    return true;
  }

  async function fetchOnce(key) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 30_000);
    try {
      const r = await fetchImpl(key, {
        headers: { Authorization: `Bearer ${cfgFull.apiKey}`, Accept: "application/json", "User-Agent": "reddit-rss/1.0 (+https://github.com/redditapis/reddit-rss)" },
        signal: ctrl.signal,
      });
      const text = await r.text();
      if (text.length > MAX_BODY_BYTES) return { error: true, status: 502, message: "upstream response too large" };
      let json = null;
      try { json = JSON.parse(text); } catch { /* reported below */ }
      if (!r.ok || !json) return { error: true, status: r.status, message: messageOf(json, r.status) };
      const entry = { at: now(), json, bytes: text.length };
      remember(key, entry);
      failures.delete(key);
      return entry;
    } catch (e) {
      return { error: true, status: 504, message: e.name === "AbortError" ? "upstream timed out" : "upstream unreachable" };
    } finally {
      clearTimeout(timer);
    }
  }

  async function upstream(route) {
    const u = new URL(cfgFull.apiBase + route.path);
    for (const [k, v] of Object.entries(route.params)) if (v !== undefined && v !== null) u.searchParams.set(k, String(v));
    const key = u.toString();
    const hit = cache.get(key);
    if (hit && now() - hit.at < cfgFull.cacheTtlSeconds * 1000) return hit;
    const failed = failures.get(key);
    if (failed && now() - failed.at < FAILURE_TTL_MS) return hit || failed;
    if (inflight.has(key)) return inflight.get(key);
    if (!takeBudget()) return hit || { error: true, status: 429, message: "this instance reached its API call budget for the minute" };
    const p = fetchOnce(key).then((r) => {
      if (r.error) {
        failures.set(key, { ...r, at: now() });
        // A failed refresh keeps serving the last good copy rather than breaking every reader.
        return hit || r;
      }
      return r;
    }).finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
  }

  function baseUrl(req) {
    if (cfgFull.publicUrl) return cfgFull.publicUrl;
    // Only a plain host[:port] is trusted from the request; anything else falls back to localhost.
    const host = String(req.headers.host || "");
    return /^[A-Za-z0-9.-]{1,253}(:\d{1,5})?$/.test(host) ? `http://${host}` : "http://localhost";
  }

  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost");
      if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, { Allow: "GET, HEAD" });
      if (url.pathname === "/" || url.pathname === "/healthz") {
        return send(res, 200, { "Content-Type": "text/plain; charset=utf-8" }, url.pathname === "/healthz" ? "ok\n" : `reddit-rss is running. Try /r/rss/.rss\nDocs: https://github.com/redditapis/reddit-rss\n`);
      }
      if (!tokenOk(cfgFull.feedToken, url.searchParams.get("token") || req.headers["x-feed-token"])) {
        return send(res, 401, { "Content-Type": "text/plain; charset=utf-8" }, "This instance needs ?token=<FEED_TOKEN>\n");
      }
      const route = routeFor(url.pathname, url.searchParams);
      if (!route) return send(res, 404, { "Content-Type": "text/plain; charset=utf-8" }, "No feed at this path. See https://github.com/redditapis/reddit-rss#feeds\n");

      const up = await upstream(route);
      if (up.error) {
        // A missing subreddit or user is the reader's 404; a spent budget is a 429; anything else is ours (502).
        const status = up.status === 404 ? 404 : up.status === 429 ? 429 : 502;
        const hint = up.status === 402 ? ` Your API balance is empty: top up at ${SIGNUP_URL}` : up.status === 401 || up.status === 403 ? " Check REDDITAPIS_API_KEY." : "";
        return send(res, status, { "Content-Type": "text/plain; charset=utf-8", "Retry-After": status === 429 ? "60" : "300" }, `Feed unavailable: ${up.message}.${hint}\n`);
      }

      const format = formatOf(url.pathname);
      // The token never goes into a feed body: readers export self links and Atom ids.
      const shown = new URLSearchParams(url.search);
      shown.delete("token");
      const qs = shown.toString();
      const self = `${baseUrl(req)}${url.pathname}${qs ? `?${qs}` : ""}`;
      const fetchedAt = new Date(up.at).toISOString();
      const { body, type } = render(format, { title: route.title, link: route.link, self, items: itemsOf(route.kind, up.json, fetchedAt), promo: SIGNUP_URL });
      const etag = `"${createHash("sha1").update(body).digest("base64url")}"`;
      const headers = { "Content-Type": type, ETag: etag, "Last-Modified": new Date(up.at).toUTCString(), "Cache-Control": `public, max-age=${cfgFull.cacheTtlSeconds}` };
      if (req.headers["if-none-match"] === etag) return send(res, 304, headers);
      return send(res, 200, headers, req.method === "HEAD" ? "" : body);
    } catch {
      return send(res, 500, { "Content-Type": "text/plain; charset=utf-8" }, "Internal error\n");
    }
  });
}
