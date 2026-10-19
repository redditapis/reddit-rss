import { test } from "node:test";
import assert from "node:assert/strict";
import { routeFor, formatOf } from "../src/routes.js";

const q = (s = "") => new URLSearchParams(s);

test("subreddit paths match Reddit's old .rss paths", () => {
  for (const p of ["/r/rss/.rss", "/r/rss.rss", "/r/rss/", "/r/rss"]) {
    const r = routeFor(p, q());
    assert.equal(r.path, "/api/reddit/posts", p);
    assert.deepEqual([r.params.subreddit, r.params.sort, r.kind], ["rss", "new", "posts"], p);
  }
});

test("sorts, and the time window only where Reddit uses it", () => {
  assert.equal(routeFor("/r/rss/top/.rss", q("t=week")).params.t, "week");
  assert.equal(routeFor("/r/rss/hot/.rss", q("t=week")).params.t, undefined);
  assert.equal(routeFor("/r/rss/top/.rss", q("t=forever")).params.t, undefined);
  assert.equal(routeFor("/r/rss/sideways/.rss", q()), null);
});

test("comments: a subreddit's newest, and one thread", () => {
  const c = routeFor("/r/rss/comments/.rss", q());
  assert.deepEqual([c.path, c.kind], ["/api/reddit/sub/rss/comments", "comments"]);
  const t = routeFor("/r/rss/comments/1x9cnzk/some_title/.rss", q());
  assert.deepEqual([t.path, t.kind, t.params.permalink], ["/api/reddit/comments", "thread", "/r/rss/comments/1x9cnzk/some_title/"]);
});

test("search, site-wide and inside one subreddit; an empty query is no feed", () => {
  const s = routeFor("/search.rss", q("q=self-hosted"));
  assert.deepEqual([s.params.q, s.params.subreddit, s.params.sort], ["self-hosted", undefined, "new"]);
  const r = routeFor("/r/selfhosted/search.rss", q("q=rss&sort=top"));
  assert.deepEqual([r.params.subreddit, r.params.sort], ["selfhosted", "top"]);
  assert.equal(routeFor("/search.rss", q("q=")), null);
});

test("users: posts by default, comments on request", () => {
  for (const p of ["/user/spez/.rss", "/u/spez/.rss", "/user/spez/submitted/.rss"]) assert.equal(routeFor(p, q()).path, "/api/reddit/user/spez/submitted", p);
  assert.equal(routeFor("/user/spez/comments/.rss", q()).kind, "comments");
});

test("limit is clamped to the API's range, and names cannot reach other paths", () => {
  assert.equal(routeFor("/r/rss/.rss", q("limit=500")).params.limit, 25);
  assert.equal(routeFor("/r/rss/.rss", q("limit=50")).params.limit, 50);
  assert.equal(routeFor("/r/..%2f/.rss", q()), null);
  assert.equal(routeFor("/r/a.b/.rss", q()), null);
  assert.equal(routeFor("/etc/passwd", q()), null);
});

test("the extension picks the format", () => {
  assert.equal(formatOf("/r/rss/.rss"), "rss");
  assert.equal(formatOf("/r/rss/.atom"), "atom");
  assert.equal(formatOf("/r/rss/.json"), "json");
  assert.equal(formatOf("/r/rss/"), "rss");
});
