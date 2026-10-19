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

test("thread feeds unwrap Reddit's comment nodes, include replies and skip 'more'", async () => {
  const thread = {
    post: { title: "A post", subreddit: "rss" },
    comments: [
      { kind: "t1", data: { id: "c1", name: "t1_c1", author: "ann", body: "top level", permalink: "/r/rss/comments/a1/x/c1/", created_utc: 1792353314, score: 3,
        replies: { kind: "Listing", data: { children: [{ kind: "t1", data: { id: "c2", name: "t1_c2", author: "bob", body: "a reply", permalink: "/r/rss/comments/a1/x/c2/", created_utc: 1792353400, score: 1, replies: "" } }] } } } },
      { kind: "more", data: { count: 12, children: ["c9"] } },
    ],
  };
  const s = await serve({}, { fetchImpl: fakeFetch([], { body: thread }) });
  try {
    const j = await (await fetch(`${s.base}/r/rss/comments/a1/x/.json`)).json();
    assert.deepEqual(j.items.map((i) => i.id), ["t1_c1", "t1_c2"]);
    assert.equal(j.items[1].title, "bob on A post");
    assert.ok(j.items[0].date_published.startsWith("2026-10-18"));
  } finally {
    await s.close();
  }
});

test("concurrent readers of one feed share a single API call", async () => {
  const calls = [];
  let release;
  const gate = new Promise((r) => { release = r; });
  const fetchImpl = async (url, init) => { calls.push(url); await gate; return { ok: true, status: 200, text: async () => JSON.stringify(POSTS) }; };
  const s = await serve({}, { fetchImpl });
  try {
    const all = Promise.all(Array.from({ length: 20 }, () => fetch(`${s.base}/r/rss/.rss`)));
    await new Promise((r) => setTimeout(r, 50));
    release();
    const rs = await all;
    assert.ok(rs.every((r) => r.status === 200));
    assert.equal(calls.length, 1);
  } finally {
    await s.close();
  }
});

test("the per-minute call budget caps spend on an open instance", async () => {
  const calls = [];
  const s = await serve({ callsPerMinute: 3 }, { fetchImpl: fakeFetch(calls) });
  try {
    const statuses = [];
    for (let i = 0; i < 6; i++) statuses.push((await fetch(`${s.base}/search.rss?q=term${i}`)).status);
    assert.equal(calls.length, 3);
    assert.deepEqual(statuses, [200, 200, 200, 429, 429, 429]);
  } finally {
    await s.close();
  }
});

test("the token never appears in a feed body, and a hostile Host header is not trusted", async () => {
  const s = await serve({ feedToken: "s3cret" }, { fetchImpl: fakeFetch([]) });
  try {
    const body = await (await fetch(`${s.base}/r/rss/.atom?token=s3cret&limit=5`)).text();
    assert.ok(!body.includes("s3cret"));
    assert.ok(body.includes("/r/rss/.atom?limit=5"));
  } finally {
    await s.close();
  }
  const http = await import("node:http");
  const s2 = await serve({}, { fetchImpl: fakeFetch([]) });
  try {
    const port = new URL(s2.base).port;
    const body = await new Promise((resolve, reject) => {
      http.get({ host: "127.0.0.1", port, path: "/r/rss/.atom", headers: { Host: 'evil.example"><x' } }, (r) => { let b = ""; r.on("data", (c) => (b += c)); r.on("end", () => resolve(b)); }).on("error", reject);
    });
    assert.ok(!body.includes("evil.example"));
    assert.ok(body.includes("<id>http://localhost/r/rss/.atom</id>"));
  } finally {
    await s2.close();
  }
});

test("an empty CACHE_TTL_SECONDS means the default, not zero", () => {
  assert.equal(configFromEnv({ REDDITAPIS_API_KEY: "k", CACHE_TTL_SECONDS: "" }).cacheTtlSeconds, 300);
  assert.equal(configFromEnv({ REDDITAPIS_API_KEY: "k", CACHE_TTL_SECONDS: "0" }).cacheTtlSeconds, 0);
});
