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
const DAY_MS = 24 * 60 * 60 * 1000;

function intEnv(value, fallback, min = 0) {
  if (value === undefined || value === null || String(value).trim() === "") return fallback;
  const n = Number(value);
  return Number.isInteger(n) && n >= min ? n : fallback;
}

/** True for an address only this machine can reach. */
export function isLoopback(host) {
  const h = String(host || "").trim().toLowerCase().replace(/^\[|\]$/g, "");
  return h === "localhost" || h === "::1" || /^(::ffff:)?127(\.\d{1,3}){3}$/.test(h);
}

/** Settings from the environment. Throws when the API key is missing or the instance would be open to anyone. */
export function configFromEnv(env = process.env) {
  const apiKey = (env.REDDITAPIS_API_KEY || "").trim();
  if (!apiKey) throw new Error(`REDDITAPIS_API_KEY is not set. Get a key at ${SIGNUP_URL}`);
  const host = (env.HOST || "").trim() || "127.0.0.1";
  const feedToken = (env.FEED_TOKEN || "").trim() || null;
  const allowPublic = (env.ALLOW_PUBLIC || "").trim() === "1";
  if (!isLoopback(host) && !feedToken && !allowPublic) {
    throw new Error(
      `HOST is ${host}, so other machines can reach this instance, and FEED_TOKEN is not set: anyone who finds it would spend your API balance. ` +
      "Set FEED_TOKEN, or set ALLOW_PUBLIC=1 if something else keeps it private (a port published on 127.0.0.1 only, a firewall, or a proxy that asks for a login).",
    );
  }
  return {
    apiKey,
    apiBase: (env.REDDITAPIS_API_BASE || "https://api.redditapis.com").replace(/\/+$/, ""),
    host,
    port: intEnv(env.PORT, 8080, 0),
    cacheTtlSeconds: intEnv(env.CACHE_TTL_SECONDS, 300),
    callsPerMinute: intEnv(env.MAX_API_CALLS_PER_MINUTE, 60, 1),
    callsPerDay: intEnv(env.MAX_API_CALLS_PER_DAY, 2000, 1),
    cacheBytes: intEnv(env.CACHE_MAX_MB, 64, 1) * 1024 * 1024,
    feedToken,
    publicUrl: (env.PUBLIC_URL || "").replace(/\/+$/, "") || null,
  };
}

const sha256 = (s) => createHash("sha256").update(String(s)).digest();

/** Compares digests, so neither the token nor its length can be learned from response times. */
export function tokenOk(expected, given) {
  if (!expected) return true;
  return timingSafeEqual(sha256(given || ""), sha256(expected));
}

/**
 * If-None-Match per RFC 9110 13.1.2: `*`, or a comma-separated list of entity tags, compared weakly
 * (a W/ prefix is ignored on either side).
 */
export function noneMatch(header, etag) {
  if (!header) return false;
  const h = String(header).trim();
  if (h === "*") return true;
  const bare = (t) => t.replace(/^W\//, "");
  return (h.match(/(?:W\/)?"[^"]*"/g) || []).some((t) => bare(t) === bare(etag));
}

function send(res, status, headers, body = "") {
  res.writeHead(status, { "X-Content-Type-Options": "nosniff", ...headers });
  res.end(body);
}

// What a reader sees for each kind of failure. Fixed text only: the API's own error text can name
// things a reader should not see, so it goes to the server log instead.
const FAILURES = {
  not_found: { status: 404, text: "Feed unavailable: Reddit has no such subreddit, user or post." },
  balance: { status: 502, text: `Feed unavailable: the API balance is empty: top up at ${SIGNUP_URL}` },
  auth: { status: 502, text: "Feed unavailable: the API key was refused. Check REDDITAPIS_API_KEY." },
  rate_limited: { status: 429, text: "Feed unavailable: the API is rate limiting this instance. Try again in a minute." },
  minute_budget: { status: 429, text: "Feed unavailable: this instance reached its API call budget for the minute." },
  day_budget: { status: 429, text: "Feed unavailable: this instance reached its API call budget for the day." },
  too_large: { status: 502, text: "Feed unavailable: the API response was too large." },
  timeout: { status: 502, text: "Feed unavailable: the API did not answer in time." },
  unreachable: { status: 502, text: "Feed unavailable: the API could not be reached." },
  upstream: { status: 502, text: "Feed unavailable: the API returned an error." },
};

function reasonOf(status) {
  if (status === 404) return "not_found";
  if (status === 402) return "balance";
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return "rate_limited";
  return "upstream";
}

/**
 * @param {ReturnType<typeof configFromEnv>} cfg
 * @param {{ fetchImpl?: typeof fetch, now?: () => number, log?: (line: string) => void }} [deps]
 */
export function createServer(cfg, { fetchImpl = globalThis.fetch, now = Date.now, log = (line) => console.error(line) } = {}) {
  const cfgFull = { callsPerMinute: 60, callsPerDay: 2000, cacheBytes: 64 * 1024 * 1024, ...cfg };
  // upstream url -> { at, text, bytes }. The raw response text is what is kept, so the cache budget
  // counts the bytes actually held; it is parsed again when a feed is rendered.
  // Insertion order = least recently refreshed first.
  const cache = new Map();
  const failures = new Map(); // upstream url -> { at, status, reason }
  const inflight = new Map(); // upstream url -> Promise, so concurrent readers share one call
  let cacheBytes = 0;
  let windowStart = 0;
  let callsThisWindow = 0;
  // The times of the last callsPerDay calls, as a ring: a new call is allowed only when the oldest
  // of them is more than 24 hours old, so no 24-hour span ever holds more than callsPerDay calls.
  const dayCalls = new Float64Array(cfgFull.callsPerDay).fill(-Infinity);
  let dayNext = 0;

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

  // Every API call costs the instance owner, so they are budgeted per minute and per 24 hours whatever
  // the readers ask for: past either budget a request gets the last good copy or a 429, never a new call.
  function takeBudget() {
    const t = now();
    if (t - windowStart >= 60_000) { windowStart = t; callsThisWindow = 0; }
    if (callsThisWindow >= cfgFull.callsPerMinute) return "minute_budget";
    if (t - dayCalls[dayNext] < DAY_MS) return "day_budget";
    callsThisWindow += 1;
    dayCalls[dayNext] = t;
    dayNext = (dayNext + 1) % dayCalls.length;
    return null;
  }

  function fail(key, status, reason, detail) {
    log(`reddit-rss: ${key} failed (${status}): ${String(detail).replace(/\s+/g, " ").slice(0, 500)}`);
    return { error: true, status, reason };
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
      const bytes = Buffer.byteLength(text);
      if (bytes > MAX_BODY_BYTES) return fail(key, 502, "too_large", `response of ${bytes} bytes`);
      if (!r.ok) return fail(key, r.status, reasonOf(r.status), text);
      try { JSON.parse(text); } catch { return fail(key, 502, "upstream", `not JSON: ${text}`); }
      const entry = { at: now(), text, bytes };
      remember(key, entry);
      failures.delete(key);
      return entry;
    } catch (e) {
      return e.name === "AbortError" ? fail(key, 504, "timeout", "no answer in 30s") : fail(key, 504, "unreachable", e.message);
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
    const over = takeBudget();
    if (over) return hit || { error: true, status: 429, reason: over };
    const p = fetchOnce(key).then((r) => {
      if (r.error) {
        failures.set(key, { ...r, at: now() });
        // Bounded: drop the oldest remembered failure once there are too many to be useful.
        if (failures.size > 1000) failures.delete(failures.keys().next().value);
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
        const f = FAILURES[up.reason] || FAILURES.upstream;
        return send(res, f.status, { "Content-Type": "text/plain; charset=utf-8", "Retry-After": f.status === 429 ? "60" : "300" }, `${f.text}\n`);
      }

      const format = formatOf(url.pathname);
      // The token never goes into a feed body: readers export self links and Atom ids.
      const shown = new URLSearchParams(url.search);
      shown.delete("token");
      const qs = shown.toString();
      const self = `${baseUrl(req)}${url.pathname}${qs ? `?${qs}` : ""}`;
      const fetchedAt = new Date(up.at).toISOString();
      const items = itemsOf(route.kind, JSON.parse(up.text), fetchedAt);
      const { body, type } = render(format, { title: route.title, link: route.link, self, items, promo: SIGNUP_URL, fetchedAt });
      const etag = `"${createHash("sha1").update(body).digest("base64url")}"`;
      // A token-protected feed is one reader's copy: shared caches must not keep it.
      const cacheControl = `${cfgFull.feedToken ? "private" : "public"}, max-age=${cfgFull.cacheTtlSeconds}`;
      const headers = { "Content-Type": type, ETag: etag, "Last-Modified": new Date(up.at).toUTCString(), "Cache-Control": cacheControl };
      if (noneMatch(req.headers["if-none-match"], etag)) return send(res, 304, headers);
      return send(res, 200, headers, req.method === "HEAD" ? "" : body);
    } catch {
      return send(res, 500, { "Content-Type": "text/plain; charset=utf-8" }, "Internal error\n");
    }
  });
}
