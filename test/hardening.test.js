import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { createServer, configFromEnv, SIGNUP_URL } from "../src/server.js";
import { render } from "../src/feed.js";

const INDEX = fileURLToPath(new URL("../src/index.js", import.meta.url));
const DOCKERFILE = fileURLToPath(new URL("../Dockerfile", import.meta.url));

const post = (over = {}) => ({
  id: "abc123", name: "t3_abc123", title: "A post", author: "someone", permalink: "/r/rss/comments/abc123/a_post/",
  text: "Body.", subreddit: "rss", upvotes: 1, comments: 0, link_url: null, created: "2026-10-18T19:55:14.000Z", ...over,
});

function fakeFetch(calls, { status = 200, body = { posts: [post()] } } = {}) {
  return async (url) => {
    calls.push(url);
    return { ok: status < 400, status, text: async () => JSON.stringify(body) };
  };
}

async function serve(cfg, deps) {
  const server = createServer({ apiKey: "k_test", apiBase: "https://api.example.test", cacheTtlSeconds: 300, feedToken: null, publicUrl: null, ...cfg }, deps);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, close: () => new Promise((r) => server.close(r)) };
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

// ---- spend safety ----

test("spend: a non-loopback HOST with no FEED_TOKEN is refused unless ALLOW_PUBLIC=1", () => {
  const key = { REDDITAPIS_API_KEY: "k" };
  assert.throws(() => configFromEnv({ ...key, HOST: "0.0.0.0" }), /FEED_TOKEN/);
  assert.throws(() => configFromEnv({ ...key, HOST: "192.168.1.5", FEED_TOKEN: "  " }), /ALLOW_PUBLIC=1/);
  assert.throws(() => configFromEnv({ ...key, HOST: "0.0.0.0", ALLOW_PUBLIC: "yes" }), /FEED_TOKEN/);
  assert.equal(configFromEnv({ ...key, HOST: "0.0.0.0", FEED_TOKEN: "s3cret" }).host, "0.0.0.0");
  assert.equal(configFromEnv({ ...key, HOST: "0.0.0.0", ALLOW_PUBLIC: "1" }).host, "0.0.0.0");
  for (const host of [undefined, "", "127.0.0.1", "127.0.0.2", "localhost", "::1", "[::1]"]) {
    assert.doesNotThrow(() => configFromEnv({ ...key, HOST: host }), String(host));
  }
  assert.equal(configFromEnv(key).host, "127.0.0.1");
});

test("spend: the server refuses to start when reachable by others with no FEED_TOKEN", async () => {
  const port = await freePort();
  const env = { PATH: process.env.PATH, REDDITAPIS_API_KEY: "k_test", REDDITAPIS_API_BASE: "http://127.0.0.1:9", HOST: "0.0.0.0", PORT: String(port) };
  const child = spawn(process.execPath, [INDEX], { env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (c) => (out += c));
  child.stderr.on("data", (c) => (out += c));
  const code = await new Promise((resolve) => {
    const timer = setTimeout(() => { child.kill(); resolve("still running"); }, 3000);
    child.on("exit", (c) => { clearTimeout(timer); resolve(c); });
  });
  assert.notEqual(code, 0, "exit code");
  assert.notEqual(code, "still running");
  assert.match(out, /FEED_TOKEN/);
});

test("spend: the Docker image allows its 0.0.0.0 listen address, since the port is published on 127.0.0.1", () => {
  const env = readFileSync(DOCKERFILE, "utf8").split("\n").find((l) => l.startsWith("ENV "));
  assert.match(env, /HOST=0\.0\.0\.0/);
  assert.match(env, /ALLOW_PUBLIC=1/);
});

test("spend: MAX_API_CALLS_PER_DAY defaults to 2000 and caps calls over any 24 hours", async () => {
  let t = 0;
  const calls = [];
  const s = await serve({ callsPerMinute: 100, callsPerDay: 3, cacheTtlSeconds: 60 }, { fetchImpl: fakeFetch(calls), now: () => t });
  try {
    const get = async (q) => (await fetch(`${s.base}/search.rss?q=${q}`)).status;
    assert.deepEqual([await get("a"), await get("b"), await get("c")], [200, 200, 200]);
    const over = await fetch(`${s.base}/search.rss?q=d`);
    assert.equal(over.status, 429);
    assert.match(await over.text(), /budget for the day/);
    t += 61_000; // a new minute does not reset the day
    assert.equal(await get("d"), 429);
    assert.equal(await get("a"), 200, "past the budget, an expired feed is served from its last good copy");
    assert.equal(calls.length, 3);
    t = 24 * 60 * 60 * 1000; // 24 hours after the first call
    assert.equal(await get("d"), 200);
    assert.equal(calls.length, 4);
  } finally {
    await s.close();
  }
  assert.equal(configFromEnv({ REDDITAPIS_API_KEY: "k" }).callsPerDay, 2000);
  assert.equal(configFromEnv({ REDDITAPIS_API_KEY: "k", MAX_API_CALLS_PER_DAY: "50" }).callsPerDay, 50);
});

// ---- memory ----

test("memory: the cache budget counts bytes held, not characters", async () => {
  // About 1,100 bytes per response but only about 500 characters: two fit a 1,500 character
  // budget but not a 1,500 byte one, so the first feed must be evicted and fetched again.
  const body = { posts: [post({ title: "€".repeat(300) })] };
  const calls = [];
  const s = await serve({ cacheBytes: 1500 }, { fetchImpl: fakeFetch(calls, { body }) });
  try {
    for (const sub of ["aa", "bb", "aa"]) assert.equal((await fetch(`${s.base}/r/${sub}/.rss`)).status, 200);
    assert.equal(calls.length, 3);
  } finally {
    await s.close();
  }
});

// ---- upstream error text ----

test("errors: upstream error text goes to the server log, never to the reader", async () => {
  const lines = [];
  let mode = { status: 500, body: { error: "db-7.internal refused connection for account 42" } };
  const fetchImpl = async (url, init) => fakeFetch([], mode)(url, init);
  const s = await serve({}, { fetchImpl, log: (l) => lines.push(l) });
  try {
    const r = await fetch(`${s.base}/r/broken/.rss`);
    const text = await r.text();
    assert.equal(r.status, 502);
    assert.ok(!text.includes("db-7"), text);
    assert.ok(lines.some((l) => l.includes("db-7.internal")), "logged on the server");
    mode = { status: 402, body: { error: "insufficient balance on account acct_9f" } };
    const b = await fetch(`${s.base}/r/broke/.rss`);
    const bt = await b.text();
    assert.equal(b.status, 502);
    assert.ok(bt.includes(SIGNUP_URL));
    assert.ok(!bt.includes("acct_9f"), bt);
    mode = { status: 404, body: { error: "no subreddit named zz_secret_lookup" } };
    const n = await fetch(`${s.base}/r/missing/.rss`);
    assert.equal(n.status, 404);
    assert.ok(!(await n.text()).includes("zz_secret_lookup"));
  } finally {
    await s.close();
  }
});

// ---- feed output ----

test("feed: an empty feed keeps one ETag between requests", async () => {
  const s = await serve({}, { fetchImpl: fakeFetch([], { body: { posts: [] } }) });
  try {
    const a = await fetch(`${s.base}/r/quiet/.atom`);
    await new Promise((r) => setTimeout(r, 15));
    const b = await fetch(`${s.base}/r/quiet/.atom`);
    assert.equal(a.status, 200);
    assert.equal(a.headers.get("etag"), b.headers.get("etag"));
    const again = await fetch(`${s.base}/r/quiet/.atom`, { headers: { "If-None-Match": a.headers.get("etag") } });
    assert.equal(again.status, 304);
  } finally {
    await s.close();
  }
});

test("feed: Atom entry ids come from the Reddit id, so entries without a permalink do not collide", () => {
  const items = ["t3_one", "t3_two"].map((id) => ({ id, title: id, link: "https://www.reddit.com", author: "a", date: "2026-10-18T00:00:00.000Z", text: "", externalUrl: null, meta: "" }));
  const body = render("atom", { title: "t", link: "https://www.reddit.com/r/rss", self: "http://localhost/r/rss/.atom", items, promo: SIGNUP_URL }).body;
  const ids = [...body.matchAll(/<entry>\s*<id>([^<]*)<\/id>/g)].map((m) => m[1]);
  assert.equal(ids.length, 2);
  assert.notEqual(ids[0], ids[1]);
  assert.ok(ids[0].endsWith("t3_one") && /^[a-z]+:/.test(ids[0]), ids[0]);
});

test("feed: only http and https links reach external_url and href", async () => {
  const body = { posts: [post({ link_url: "javascript:alert(1)" }), post({ name: "t3_b", id: "b", link_url: "https://example.com/x" })] };
  const s = await serve({}, { fetchImpl: fakeFetch([], { body }) });
  try {
    const j = await (await fetch(`${s.base}/r/rss/.json`)).json();
    assert.equal(j.items[0].external_url, undefined);
    assert.ok(!j.items[0].content_html.includes("javascript:"), j.items[0].content_html);
    assert.equal(j.items[1].external_url, "https://example.com/x");
    const rss = await (await fetch(`${s.base}/r/rss/.rss`)).text();
    assert.ok(!rss.includes("javascript:"));
  } finally {
    await s.close();
  }
  const direct = render("json", { title: "t", link: "l", self: "s", promo: SIGNUP_URL, items: [{ id: "x", title: "x", link: "data:text/html,hi", author: "a", date: "2026-10-18T00:00:00.000Z", text: "", externalUrl: "data:text/html,hi", meta: "" }] });
  const item = JSON.parse(direct.body).items[0];
  assert.equal(item.external_url, undefined);
  assert.ok(!item.content_html.includes("data:"), item.content_html);
});

// ---- conditional requests and tokens ----

test("conditional: If-None-Match takes a list, weak tags and *", async () => {
  const s = await serve({}, { fetchImpl: fakeFetch([]) });
  try {
    const etag = (await fetch(`${s.base}/r/rss/.rss`)).headers.get("etag");
    const status = async (h) => (await fetch(`${s.base}/r/rss/.rss`, { headers: { "If-None-Match": h } })).status;
    assert.equal(await status(`"other", ${etag}`), 304);
    assert.equal(await status(`W/${etag}`), 304);
    assert.equal(await status("*"), 304);
    assert.equal(await status(`"other", W/"another"`), 200);
  } finally {
    await s.close();
  }
});

test("tokens: a token-protected feed is Cache-Control private, an open one public", async () => {
  const s = await serve({ feedToken: "s3cret" }, { fetchImpl: fakeFetch([]) });
  try {
    const r = await fetch(`${s.base}/r/rss/.rss?token=s3cret`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get("cache-control"), /^private\b/);
  } finally {
    await s.close();
  }
  const o = await serve({}, { fetchImpl: fakeFetch([]) });
  try {
    assert.match((await fetch(`${o.base}/r/rss/.rss`)).headers.get("cache-control"), /^public\b/);
  } finally {
    await o.close();
  }
});

test("tokens: tokens of any length and in any script are compared correctly", async () => {
  const s = await serve({ feedToken: "s3cret-ünï" }, { fetchImpl: fakeFetch([]) });
  try {
    for (const bad of ["s", "s3cret-ün", "s3cret-ünï-longer", "S3CRET-ÜNÏ"]) {
      assert.equal((await fetch(`${s.base}/r/rss/.rss?token=${encodeURIComponent(bad)}`)).status, 401, bad);
    }
    assert.equal((await fetch(`${s.base}/r/rss/.rss?token=${encodeURIComponent("s3cret-ünï")}`)).status, 200);
    assert.equal((await fetch(`${s.base}/r/rss/.rss`, { headers: { "X-Feed-Token": "s3cret" } })).status, 401);
  } finally {
    await s.close();
  }
});
