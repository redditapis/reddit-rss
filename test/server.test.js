import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, configFromEnv, SIGNUP_URL } from "../src/server.js";

const POSTS = {
  posts: [{
    id: "abc123", name: "t3_abc123", title: "Feeds & <readers>", author: "someone", permalink: "/r/rss/comments/abc123/feeds/",
    text: "First paragraph.\n\nSecond one.", subreddit: "rss", upvotes: 12, comments: 3, link_url: null, created: "2026-10-18T19:55:14.000Z",
  }],
  after: "x",
};

function fakeFetch(calls, { status = 200, body = POSTS, fail = false } = {}) {
  return async (url, init) => {
    calls.push({ url, auth: init.headers.Authorization });
    if (fail) throw new Error("network down");
    return { ok: status < 400, status, text: async () => JSON.stringify(body) };
  };
}

async function serve(cfg, deps) {
  const server = createServer({ apiKey: "k_test", apiBase: "https://api.example.test", cacheTtlSeconds: 300, feedToken: null, publicUrl: null, ...cfg }, deps);
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, close: () => new Promise((r) => server.close(r)) };
}

test("configFromEnv refuses to start without a key and points at signup", () => {
  assert.throws(() => configFromEnv({}), (e) => e.message.includes(SIGNUP_URL));
  assert.equal(configFromEnv({ REDDITAPIS_API_KEY: "k" }).cacheTtlSeconds, 300);
});

test("RSS: escaped, valid-looking XML from one authenticated call, then served from cache", async () => {
  const calls = [];
  const s = await serve({}, { fetchImpl: fakeFetch(calls) });
  try {
    const r = await fetch(`${s.base}/r/rss/.rss`);
    const body = await r.text();
    assert.equal(r.status, 200);
    assert.match(r.headers.get("content-type"), /application\/rss\+xml/);
    assert.ok(body.includes("<title>Feeds &amp; &lt;readers&gt;</title>"));
    assert.ok(body.includes("<link>https://www.reddit.com/r/rss/comments/abc123/feeds/</link>"));
    assert.ok(body.includes(SIGNUP_URL));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].auth, "Bearer k_test");
    assert.ok(calls[0].url.startsWith("https://api.example.test/api/reddit/posts?"));
    await fetch(`${s.base}/r/rss/.rss`);
    assert.equal(calls.length, 1, "the second read within the TTL is served from cache");
    const again = await fetch(`${s.base}/r/rss/.rss`, { headers: { "If-None-Match": r.headers.get("etag") } });
    assert.equal(again.status, 304);
  } finally {
    await s.close();
  }
});

test("Atom and JSON Feed", async () => {
  const s = await serve({}, { fetchImpl: fakeFetch([]) });
  try {
    const a = await fetch(`${s.base}/r/rss/.atom`);
    assert.match(a.headers.get("content-type"), /application\/atom\+xml/);
    assert.ok((await a.text()).includes('<feed xmlns="http://www.w3.org/2005/Atom">'));
    const j = await (await fetch(`${s.base}/r/rss/.json`)).json();
    assert.equal(j.version, "https://jsonfeed.org/version/1.1");
    assert.equal(j.items[0].title, "Feeds & <readers>");
  } finally {
    await s.close();
  }
});

test("a token-protected instance refuses without the token", async () => {
  const s = await serve({ feedToken: "s3cret" }, { fetchImpl: fakeFetch([]) });
  try {
    assert.equal((await fetch(`${s.base}/r/rss/.rss`)).status, 401);
    assert.equal((await fetch(`${s.base}/r/rss/.rss?token=wrong`)).status, 401);
    assert.equal((await fetch(`${s.base}/r/rss/.rss?token=s3cret`)).status, 200);
  } finally {
    await s.close();
  }
});

test("upstream failures: 404 passes through, others are 502, a stale copy beats an error", async () => {
  let mode = { status: 404, body: { error: "subreddit not found" } };
  let t = 0;
  const calls = [];
  const fetchImpl = async (url, init) => fakeFetch(calls, mode)(url, init);
  const s = await serve({ cacheTtlSeconds: 1 }, { fetchImpl, now: () => t });
  try {
    assert.equal((await fetch(`${s.base}/r/nope/.rss`)).status, 404);
    mode = { status: 402, body: { error: "insufficient balance" } };
    const r = await fetch(`${s.base}/r/broke/.rss`);
    assert.equal(r.status, 502);
    assert.match(await r.text(), /top up/);
    mode = {};
    assert.equal((await fetch(`${s.base}/r/rss/.rss`)).status, 200);
    t += 5000;
    mode = { fail: true };
    assert.equal((await fetch(`${s.base}/r/rss/.rss`)).status, 200, "an expired copy is served when the refresh fails");
  } finally {
    await s.close();
  }
});

test("unknown paths and methods", async () => {
  const s = await serve({}, { fetchImpl: fakeFetch([]) });
  try {
    assert.equal((await fetch(`${s.base}/nothing/here`)).status, 404);
    assert.equal((await fetch(`${s.base}/r/rss/.rss`, { method: "POST" })).status, 405);
    assert.equal((await fetch(`${s.base}/healthz`)).status, 200);
  } finally {
    await s.close();
  }
});
