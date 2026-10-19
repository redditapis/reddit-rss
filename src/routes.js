// Maps a Reddit-style feed path to one API request and the feed's own title and link.
// Paths mirror the ones Reddit served before it switched .rss off, so an existing
// subscription only needs its host changed:
//
//   /r/<sub>/.rss                 newest posts (also /r/<sub>.rss)
//   /r/<sub>/<sort>/.rss          hot, new, top, rising, controversial, best (?t=week for top)
//   /r/<sub>/comments/.rss        newest comments across the subreddit
//   /r/<sub>/comments/<id>/.rss   one post's comment thread
//   /r/<sub>/search.rss?q=...     search inside one subreddit
//   /search.rss?q=...             search all of Reddit
//   /user/<name>/.rss             a user's posts (also /u/<name>, /user/<name>/submitted)
//   /user/<name>/comments/.rss    a user's comments
//
// The extension picks the format: .rss (RSS 2.0), .atom (Atom 1.0) or .json (JSON Feed 1.1).
// A path ending in "/" or with no extension is served as RSS. Returns null for anything else.

const SUB_SORTS = new Set(["hot", "new", "top", "rising", "controversial", "best"]);
const USER_SORTS = new Set(["new", "hot", "top", "controversial"]);
const SEARCH_SORTS = new Set(["relevance", "hot", "top", "new", "comments"]);
const TIMES = new Set(["hour", "day", "week", "month", "year", "all"]);
const NAME = /^[A-Za-z0-9_-]{1,64}$/;
const POST_ID = /^[a-z0-9]{1,16}$/i;

export function formatOf(pathname) {
  if (/\.atom$/i.test(pathname)) return "atom";
  if (/\.json$/i.test(pathname)) return "json";
  return "rss";
}

function stripFeedSuffix(pathname) {
  return pathname
    .replace(/\/?\.(rss|atom|json)$/i, "")
    .replace(/\.(rss|atom|json)$/i, "")
    .replace(/\/+$/, "");
}

function pick(set, value) {
  return value && set.has(value) ? value : undefined;
}

function common(params, query) {
  const limit = Number(query.get("limit"));
  if (Number.isInteger(limit) && limit >= 1 && limit <= 100) params.limit = limit;
  else params.limit = 25;
  return params;
}

/**
 * @param {string} pathname  the request path, e.g. "/r/rss/top/.rss"
 * @param {URLSearchParams} query
 * @returns {{ path: string, params: object, kind: "posts"|"comments"|"thread", title: string, link: string } | null}
 */
export function routeFor(pathname, query) {
  const p = stripFeedSuffix(pathname).split("/").filter(Boolean);
  const t = pick(TIMES, query.get("t"));

  if (p[0] === "search" && p.length === 1) {
    const q = (query.get("q") || "").trim();
    if (!q) return null;
    return {
      path: "/api/reddit/search",
      params: common({ q, sort: pick(SEARCH_SORTS, query.get("sort")) || "new", t }, query),
      kind: "posts",
      title: `Reddit search: ${q}`,
      link: `https://www.reddit.com/search/?q=${encodeURIComponent(q)}`,
    };
  }

  if (p[0] === "r" && NAME.test(p[1] || "")) {
    const sub = p[1];
    const rest = p.slice(2);
    if (rest.length === 0) {
      return { path: "/api/reddit/posts", params: common({ subreddit: sub, sort: "new" }, query), kind: "posts", title: `r/${sub}: new`, link: `https://www.reddit.com/r/${sub}/new/` };
    }
    if (rest.length === 1 && SUB_SORTS.has(rest[0])) {
      const sort = rest[0];
      return { path: "/api/reddit/posts", params: common({ subreddit: sub, sort, t: sort === "top" || sort === "controversial" ? t : undefined }, query), kind: "posts", title: `r/${sub}: ${sort}`, link: `https://www.reddit.com/r/${sub}/${sort}/` };
    }
    if (rest.length === 1 && rest[0] === "comments") {
      return { path: `/api/reddit/sub/${sub}/comments`, params: common({}, query), kind: "comments", title: `r/${sub}: newest comments`, link: `https://www.reddit.com/r/${sub}/comments/` };
    }
    if (rest[0] === "comments" && POST_ID.test(rest[1] || "")) {
      const permalink = `/r/${sub}/comments/${rest[1]}/${rest[2] && NAME.test(rest[2]) ? `${rest[2]}/` : ""}`;
      const params = { permalink, depth: 1, sort: "new" };
      const limit = Number(query.get("limit"));
      params.limit = Number.isInteger(limit) && limit >= 1 && limit <= 500 ? limit : 50;
      return { path: "/api/reddit/comments", params, kind: "thread", title: `r/${sub}: comments on ${rest[1]}`, link: `https://www.reddit.com${permalink}` };
    }
    if (rest.length === 1 && rest[0] === "search") {
      const q = (query.get("q") || "").trim();
      if (!q) return null;
      return {
        path: "/api/reddit/search",
        params: common({ q, subreddit: sub, sort: pick(SEARCH_SORTS, query.get("sort")) || "new", t }, query),
        kind: "posts",
        title: `r/${sub} search: ${q}`,
        link: `https://www.reddit.com/r/${sub}/search/?q=${encodeURIComponent(q)}&restrict_sr=1`,
      };
    }
    return null;
  }

  if ((p[0] === "user" || p[0] === "u") && NAME.test(p[1] || "")) {
    const name = p[1];
    const what = p[2] || "submitted";
    const sort = pick(USER_SORTS, query.get("sort")) || "new";
    if (p.length <= 3 && (what === "submitted" || what === "overview")) {
      return { path: `/api/reddit/user/${name}/submitted`, params: common({ sort, t: sort === "top" || sort === "controversial" ? t : undefined }, query), kind: "posts", title: `u/${name}: posts`, link: `https://www.reddit.com/user/${name}/submitted/` };
    }
    if (p.length === 3 && what === "comments") {
      return { path: `/api/reddit/user/${name}/comments`, params: common({ sort }, query), kind: "comments", title: `u/${name}: comments`, link: `https://www.reddit.com/user/${name}/comments/` };
    }
    return null;
  }

  return null;
}
