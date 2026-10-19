// Turns an API response into feed items, and items into RSS 2.0, Atom 1.0 or JSON Feed 1.1.

const SITE = "https://www.reddit.com";

function absolute(permalink) {
  if (!permalink) return SITE;
  return /^https?:\/\//.test(permalink) ? permalink : `${SITE}${permalink.startsWith("/") ? "" : "/"}${permalink}`;
}

function isoOf(x) {
  if (typeof x.created === "string" && !Number.isNaN(Date.parse(x.created))) return new Date(x.created).toISOString();
  if (Number.isFinite(x.created_utc)) return new Date(x.created_utc * 1000).toISOString();
  if (Number.isFinite(x.created)) return new Date(x.created * 1000).toISOString();
  return null;
}

function clip(text, n) {
  const s = String(text || "").replace(/\s+/g, " ").trim();
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/** One feed item per post or comment: { id, title, link, author, date, text, externalUrl }. */
export function itemsOf(kind, body, fetchedAt = new Date().toISOString()) {
  if (kind === "posts") {
    return (Array.isArray(body && body.posts) ? body.posts : []).map((p) => ({
      id: p.name || `t3_${p.id}`,
      title: p.title || "(untitled)",
      link: absolute(p.permalink),
      author: p.author || "[deleted]",
      date: isoOf(p) || fetchedAt,
      text: p.text || "",
      externalUrl: p.link_url || null,
      meta: `r/${p.subreddit} · ${Number(p.upvotes) || 0} points · ${Number(p.comments) || 0} comments`,
    }));
  }
  // A thread carries Reddit's own nodes, {kind: "t1", data: {...}} with replies nested under
  // data.replies, plus "more" placeholders; flatten them. The other comment feeds are flat already.
  const flat = [];
  const walk = (nodes) => {
    for (const n of Array.isArray(nodes) ? nodes : []) {
      if (!n || n.kind === "more") continue;
      const c = n.kind === "t1" && n.data ? n.data : n;
      flat.push(c);
      const kids = c.replies && c.replies.data && c.replies.data.children;
      if (kids) walk(kids);
    }
  };
  walk(body && body.comments);
  const post = body && body.post ? (body.post.data || body.post) : {};
  return flat
    .filter((c) => c && (c.body || c.text))
    .map((c) => ({
      id: c.name || `t1_${c.id}`,
      title: `${c.author || "[deleted]"} on ${clip(c.link_title || post.title || `r/${c.subreddit || ""}`, 80)}`,
      link: absolute(c.permalink),
      author: c.author || "[deleted]",
      date: isoOf(c) || fetchedAt,
      text: c.body || c.text || "",
      externalUrl: null,
      meta: `r/${c.subreddit || post.subreddit || ""} · ${Number(c.upvotes ?? c.score) || 0} points`,
    }));
}

const XML_ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" };
export function xml(s) {
  // Characters XML 1.0 forbids are dropped, so one odd byte in a comment cannot break the feed.
  return String(s ?? "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, "")
    .replace(/[&<>"']/g, (c) => XML_ESCAPES[c]);
}

function htmlBody(it) {
  const paras = String(it.text || "")
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${xml(p).replace(/\n/g, "<br/>")}</p>`)
    .join("");
  const link = it.externalUrl ? `<p><a href="${xml(it.externalUrl)}">${xml(it.externalUrl)}</a></p>` : "";
  return `${paras}${link}<p>${xml(it.meta)} · <a href="${xml(it.link)}">open on Reddit</a></p>`;
}

/**
 * @param {"rss"|"atom"|"json"} format
 * @param {{ title: string, link: string, self: string, items: object[], promo: string }} feed
 * @returns {{ body: string, type: string }}
 */
export function render(format, { title, link, self, items, promo }) {
  const updated = items.length ? items.map((i) => i.date).sort().slice(-1)[0] : new Date().toISOString();
  const description = `${title}. Feed served by reddit-rss (${promo}).`;

  if (format === "json") {
    return {
      type: "application/feed+json; charset=utf-8",
      body: JSON.stringify({
        version: "https://jsonfeed.org/version/1.1",
        title,
        home_page_url: link,
        feed_url: self,
        description,
        items: items.map((it) => ({
          id: it.id,
          url: it.link,
          external_url: it.externalUrl || undefined,
          title: it.title,
          content_html: htmlBody(it),
          date_published: it.date,
          authors: [it.author === "[deleted]" ? { name: "[deleted]" } : { name: `u/${it.author}`, url: `${SITE}/user/${encodeURIComponent(it.author)}` }],
        })),
      }, null, 2),
    };
  }

  if (format === "atom") {
    const entries = items.map((it) => `  <entry>
    <id>${xml(it.link)}</id>
    <title>${xml(it.title)}</title>
    <link href="${xml(it.link)}"/>
    <author><name>u/${xml(it.author)}</name></author>
    <updated>${it.date}</updated>
    <published>${it.date}</published>
    <content type="html">${xml(htmlBody(it))}</content>
  </entry>`).join("\n");
    return {
      type: "application/atom+xml; charset=utf-8",
      body: `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <id>${xml(self)}</id>
  <title>${xml(title)}</title>
  <subtitle>${xml(description)}</subtitle>
  <link href="${xml(link)}"/>
  <link rel="self" href="${xml(self)}"/>
  <updated>${updated}</updated>
${entries}
</feed>
`,
    };
  }

  const rfc822 = (iso) => new Date(iso).toUTCString();
  const rssItems = items.map((it) => `    <item>
      <guid isPermaLink="false">${xml(it.id)}</guid>
      <title>${xml(it.title)}</title>
      <link>${xml(it.link)}</link>
      <dc:creator>u/${xml(it.author)}</dc:creator>
      <pubDate>${rfc822(it.date)}</pubDate>
      <description>${xml(htmlBody(it))}</description>
    </item>`).join("\n");
  return {
    type: "application/rss+xml; charset=utf-8",
    body: `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel>
    <title>${xml(title)}</title>
    <link>${xml(link)}</link>
    <atom:link href="${xml(self)}" rel="self" type="application/rss+xml"/>
    <description>${xml(description)}</description>
    <lastBuildDate>${rfc822(updated)}</lastBuildDate>
${rssItems}
  </channel>
</rss>
`,
  };
}
