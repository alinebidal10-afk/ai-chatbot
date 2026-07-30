import { XMLParser } from "fast-xml-parser";
import type { ToolResult } from "./index";

const FETCH_TIMEOUT_MS = 8000;
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

/** Hardcoded feeds for well-known outlets. Keys are normalized names. */
const FEED_MAP: Record<string, { source: string; feeds: string[] }> = {
  bbc: { source: "BBC News", feeds: ["https://feeds.bbci.co.uk/news/rss.xml"] },
  reuters: {
    source: "Reuters",
    feeds: ["https://www.reutersagency.com/feed/?best-topics=top-news"],
  },
  guardian: {
    source: "The Guardian",
    feeds: ["https://www.theguardian.com/international/rss"],
  },
  theguardian: {
    source: "The Guardian",
    feeds: ["https://www.theguardian.com/international/rss"],
  },
  nyt: {
    source: "The New York Times",
    feeds: ["https://rss.nytimes.com/services/xml/rss/nyt/HomePage.xml"],
  },
  newyorktimes: {
    source: "The New York Times",
    feeds: ["https://rss.nytimes.com/services/xml/rss/nyt/HomePage.xml"],
  },
  nytimes: {
    source: "The New York Times",
    feeds: ["https://rss.nytimes.com/services/xml/rss/nyt/HomePage.xml"],
  },
  hurriyet: {
    source: "Hürriyet",
    feeds: ["https://www.hurriyet.com.tr/rss/anasayfa"],
  },
  anadolu: {
    source: "Anadolu Ajansı",
    feeds: ["https://www.aa.com.tr/tr/rss/default?cat=guncel"],
  },
  anadoluajansi: {
    source: "Anadolu Ajansı",
    feeds: ["https://www.aa.com.tr/tr/rss/default?cat=guncel"],
  },
  aa: {
    source: "Anadolu Ajansı",
    feeds: ["https://www.aa.com.tr/tr/rss/default?cat=guncel"],
  },
  ntv: { source: "NTV", feeds: ["https://www.ntv.com.tr/gundem.rss"] },
};

function normalize(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]/g, "");
}

async function get(url: string): Promise<Response> {
  return fetch(url, {
    headers: { "user-agent": UA, accept: "*/*" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    redirect: "follow",
  });
}

function stripHtml(s: string): string {
  return s
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function clampSentences(s: string, max = 2): string {
  const parts = s.match(/[^.!?]+[.!?]+/g);
  if (!parts) return s.slice(0, 220);
  return parts.slice(0, max).join(" ").trim();
}

interface NewsItem {
  headline: string;
  summary: string;
  publishedAt: string | null;
  link: string;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function parseFeed(xml: string, limit: number): NewsItem[] | null {
  const parser = new XMLParser({ ignoreAttributes: false });
  let doc: any;
  try {
    doc = parser.parse(xml);
  } catch {
    return null;
  }
  // RSS 2.0
  let items: any[] | undefined = doc?.rss?.channel?.item;
  if (items && !Array.isArray(items)) items = [items];
  if (items?.length) {
    return items.slice(0, limit).map((it) => ({
      headline: stripHtml(String(it.title ?? "Untitled")),
      summary: clampSentences(stripHtml(String(it.description ?? ""))),
      publishedAt: it.pubDate ? String(it.pubDate) : null,
      link: String(it.link ?? ""),
    }));
  }
  // Atom
  let entries: any[] | undefined = doc?.feed?.entry;
  if (entries && !Array.isArray(entries)) entries = [entries];
  if (entries?.length) {
    return entries.slice(0, limit).map((e) => {
      let link = "";
      const l = Array.isArray(e.link) ? e.link[0] : e.link;
      if (typeof l === "string") link = l;
      else if (l?.["@_href"]) link = String(l["@_href"]);
      const title =
        typeof e.title === "object" ? e.title["#text"] : e.title;
      const summary =
        typeof e.summary === "object" ? e.summary["#text"] : e.summary;
      return {
        headline: stripHtml(String(title ?? "Untitled")),
        summary: clampSentences(stripHtml(String(summary ?? ""))),
        publishedAt: e.updated ? String(e.updated) : null,
        link,
      };
    });
  }
  return null;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/** Find <link rel="alternate" type="application/rss+xml"> in a page. */
function discoverFeedUrls(html: string, baseUrl: string): string[] {
  const urls: string[] = [];
  const linkTags = html.match(/<link\b[^>]*>/gi) ?? [];
  for (const tag of linkTags) {
    if (!/rel=["']?alternate["']?/i.test(tag)) continue;
    if (!/application\/(rss|atom)\+xml/i.test(tag)) continue;
    const href = tag.match(/href=["']([^"']+)["']/i)?.[1];
    if (href) {
      try {
        urls.push(new URL(href, baseUrl).toString());
      } catch {
        /* skip malformed */
      }
    }
  }
  return urls;
}

/** Last resort: pull likely article links straight from the homepage. */
function extractArticleLinks(html: string, baseUrl: string, limit: number): NewsItem[] {
  const seen = new Set<string>();
  const items: NewsItem[] = [];
  const anchors = html.match(/<a\b[^>]*href=["'][^"']+["'][^>]*>[\s\S]*?<\/a>/gi) ?? [];
  for (const a of anchors) {
    const href = a.match(/href=["']([^"']+)["']/i)?.[1];
    if (!href) continue;
    let url: URL;
    try {
      url = new URL(href, baseUrl);
    } catch {
      continue;
    }
    if (url.origin !== new URL(baseUrl).origin) continue;
    // Article-ish paths: reasonably deep or slug-like
    const path = url.pathname;
    if (!/[a-z0-9-]{8,}/i.test(path) || path.split("/").filter(Boolean).length < 2) continue;
    const text = stripHtml(a);
    if (text.length < 25) continue;
    const key = url.toString().split("#")[0];
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({ headline: text.slice(0, 200), summary: "", publishedAt: null, link: key });
    if (items.length >= limit) break;
  }
  return items;
}

export async function fetchNews(
  publisher: string,
  limit = 5,
): Promise<ToolResult> {
  try {
    const key = normalize(publisher);
    const known = FEED_MAP[key];
    const feedUrls: string[] = known ? [...known.feeds] : [];
    let sourceName = known?.source ?? publisher;
    const looksLikeDomain = /\./.test(publisher.trim());
    const siteCandidates = looksLikeDomain
      ? [
          publisher.trim().startsWith("http")
            ? publisher.trim()
            : `https://${publisher.trim()}`,
        ]
      : [`https://www.${key}.com`, `https://${key}.com`];

    // Strategy 1: known feeds, then discovered feeds
    if (feedUrls.length === 0) {
      for (const site of siteCandidates) {
        try {
          const res = await get(site);
          if (!res.ok) continue;
          const html = await res.text();
          feedUrls.push(...discoverFeedUrls(html, site));
          if (feedUrls.length > 0) {
            sourceName = publisher;
            break;
          }
        } catch {
          /* try next candidate */
        }
      }
    }

    for (const feedUrl of feedUrls.slice(0, 3)) {
      try {
        const res = await get(feedUrl);
        if (!res.ok) continue;
        const items = parseFeed(await res.text(), limit);
        if (items && items.length > 0) {
          return {
            ok: true,
            data: {
              source: sourceName,
              method: "rss",
              fetchedAt: new Date().toISOString(),
              items,
            },
          };
        }
      } catch {
        /* try next feed */
      }
    }

    // Strategy 2: extract article links from the homepage
    for (const site of siteCandidates) {
      try {
        const res = await get(site);
        if (!res.ok) continue;
        const items = extractArticleLinks(await res.text(), site, limit);
        if (items.length > 0) {
          return {
            ok: true,
            data: {
              source: sourceName,
              method: "homepage extraction (no summaries available)",
              fetchedAt: new Date().toISOString(),
              items,
            },
          };
        }
      } catch {
        /* try next candidate */
      }
    }

    return {
      ok: false,
      reason: `Could not find an RSS feed or readable article list for "${publisher}". The site may block automated access or use a different domain.`,
    };
  } catch (err) {
    return {
      ok: false,
      reason: `News fetch failed: ${err instanceof Error ? err.message : "unknown error"}`,
    };
  }
}
