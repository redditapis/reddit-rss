# reddit-rss

Reddit RSS feeds, back after November 13, self-hosted in one Docker command.

Reddit is switching off its `.rss` feeds on November 13, 2026, and [says there is no replacement](https://www.reddit.com/r/modnews/comments/1wubgvt/continuing_our_infrastructure_updates_whats/) for feeds outside the communities you moderate. reddit-rss gives you the same feed URLs on your own server: change the host in your reader and your subreddit, search, user and comment-thread subscriptions keep working. It serves RSS 2.0, Atom 1.0 and JSON Feed 1.1 for subreddits, searches, users and comment threads, caches each feed so your reader can poll as often as it likes, and answers `If-None-Match` with a 304 so nothing is fetched twice. It runs on the [RedditAPIs](https://www.redditapis.com/?ref=gh-reddit-rss) API with your own key, has no dependencies beyond Node 20, and works with Miniflux, FreshRSS, NetNewsWire, Thunderbird and any other reader (hosted readers such as Feedly or Inoreader need the instance on a public URL).

## Quick start

1. Get an API key at [redditapis.com](https://www.redditapis.com/?ref=gh-reddit-rss). New accounts start with free credit, and each feed refresh is one API call.
2. Run it:

```sh
docker run -d -p 127.0.0.1:8080:8080 -e REDDITAPIS_API_KEY=your_key --name reddit-rss \
  $(docker build -q https://github.com/redditapis/reddit-rss.git)
```

Or with Node 20+:

```sh
git clone https://github.com/redditapis/reddit-rss.git && cd reddit-rss
REDDITAPIS_API_KEY=your_key npm start
```

3. In your reader, replace `https://www.reddit.com` (or `https://old.reddit.com`) with `http://localhost:8080` in any feed URL.

Both quick starts listen on this machine only. Inside the container the server listens on `0.0.0.0`, so the image sets `ALLOW_PUBLIC=1`; publishing the port on `127.0.0.1` (as above, and in Docker Compose) is what keeps it private. To serve readers elsewhere, publish the port more widely and set `FEED_TOKEN` (see [Configuration](#configuration)). Outside Docker, the server refuses to start on an address other machines can reach unless `FEED_TOKEN` is set.

## Feeds

| Feed | Path |
|---|---|
| Newest posts in a subreddit | `/r/selfhosted/.rss` |
| Hot, top, rising, controversial, best | `/r/selfhosted/top/.rss?t=week` |
| Newest comments across a subreddit | `/r/selfhosted/comments/.rss` |
| Comments on one post | `/r/selfhosted/comments/<post_id>/.rss` |
| Search inside a subreddit | `/r/selfhosted/search.rss?q=backup` |
| Search all of Reddit | `/search.rss?q=homelab&sort=new` |
| A user's posts | `/user/<name>/.rss` |
| A user's comments | `/user/<name>/comments/.rss` |

Swap `.rss` for `.atom` or `.json` to get Atom or JSON Feed. `?limit=` sets the number of items (1 to 100, default 25; on a comment thread, top-level comments from 1 to 500, default 50, each with up to three levels of replies). `?t=` takes `hour`, `day`, `week`, `month`, `year` or `all` on top and controversial feeds (user feeds take every window except `hour`), and `?sort=` takes `relevance`, `hot`, `top`, `new` or `comments` on searches.

## Configuration

| Variable | Default | |
|---|---|---|
| `REDDITAPIS_API_KEY` | (required) | Your API key. |
| `PORT` | `8080` | Port to listen on. |
| `HOST` | `127.0.0.1` (`0.0.0.0` in the Docker image) | Address to listen on. Anything other than loopback makes the instance reachable by others, so the server will not start without `FEED_TOKEN` (or `ALLOW_PUBLIC=1`). |
| `ALLOW_PUBLIC` | (none) (`1` in the Docker image) | Set to `1` to start on a non-loopback `HOST` with no `FEED_TOKEN`. Use it only when something else keeps the instance private: a port published on 127.0.0.1, a firewall, or a proxy that asks for a login. |
| `HOST_PORT` | `8080` | Docker Compose only: the port on this machine the container is published on. |
| `CACHE_TTL_SECONDS` | `300` | How long a feed is reused before it is fetched again. |
| `MAX_API_CALLS_PER_MINUTE` | `60` | Hard cap on API calls this instance makes in a minute, whatever readers request. Past it, readers get the last good copy or a 429. |
| `MAX_API_CALLS_PER_DAY` | `2000` | Hard cap on API calls in any 24 hours since the instance started (at most 1000000). Past it, readers get the last good copy or a 429 until the oldest of those calls is a day old. |
| `CACHE_MAX_MB` | `64` | Memory the feed cache may use, counted in bytes of the API responses it keeps. |
| `FEED_TOKEN` | (none) | When set, every feed URL needs `?token=<value>`, so a public instance cannot spend your balance. Feeds are then sent as `Cache-Control: private`, so shared caches do not keep them. |
| `PUBLIC_URL` | request host | The address readers use, for the feed's self link (e.g. `https://rss.example.com`). Set it on any public instance. |
| `REDDITAPIS_API_BASE` | `https://api.redditapis.com` | Only needed for testing against another endpoint. |

Copy `.env.example` to `.env` and `docker compose up -d` does the same as the one-liner above.

## How it handles failures

- A subreddit or user that does not exist is a 404, so your reader shows it as a broken feed rather than an empty one.
- If a refresh fails, the last good copy is served until the next refresh works. A failing feed is retried once a minute, however often readers poll it.
- An empty balance returns a 502 with a link to top up, and readers retry on their own.
- Readers get a short, fixed message for each kind of failure. The API's own error text goes to the server log only.
- Past the per-minute or per-day call budget, readers get the last good copy or a 429.
- Readers polling the same feed at the same moment share one API call.

## FAQ

**Why do I need an API key?** Reddit's feeds are going away; the key is what keeps your feeds working after November 13. You pay only for the refreshes your reader makes; with the default five-minute cache, a busy feed costs at most one API call per five minutes no matter how many readers follow it. A feed whose refresh fails is retried once a minute. The whole instance makes at most `MAX_API_CALLS_PER_DAY` calls (2000 by default) in any 24 hours since it started.

**Why does it refuse to start?** `HOST` is an address other machines can reach and `FEED_TOKEN` is not set, so anyone who found the instance could spend your balance. Set `FEED_TOKEN`, or set `ALLOW_PUBLIC=1` if a firewall or a proxy already keeps it private.

**Can I share one instance with friends?** Yes. Set `FEED_TOKEN` and give them URLs with `?token=`.

**Does it store anything?** No. Feeds are kept in memory (up to `CACHE_MAX_MB`) and nothing is written to disk.

**What is not covered?** The front page, multireddits (`/r/a+b`), `/domain/` feeds and private feeds that need your Reddit login.

## Development

```sh
npm test
```

The tests run against a fake API, so they need no key and make no network calls.

## License

MIT
