import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";

import { TTLCache } from "@src/lib/cache/ttlCache";
import { formatSummary } from "@src/lib/news/summarize";
import type { NewsItem } from "@src/lib/news/types";
import type { TeamId } from "@src/teams";

import { fetchGiantsOfficialNews } from "./giantsOfficial";

type OfficialSource = {
  source: string;
  listUrls: (now: Date) => string[];
  /** list page html から「記事ページURL（同一ホスト）」を抽出 */
  extractArticleUrls: (html: string, baseUrl: string) => string[];
};

const cache = new TTLCache<NewsItem[]>(3 * 60 * 1000);

function stableIdFromUrl(url: string): string {
  let hash = 0;
  for (let i = 0; i < url.length; i++) {
    hash = (hash * 31 + url.charCodeAt(i)) >>> 0;
  }
  return `u${hash.toString(16)}`;
}

function clamp(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max).trimEnd() + "…";
}

function normalizeText(raw: string): string {
  const t = raw.replace(/\r\n/g, "\n").replace(/[ \t]+\n/g, "\n").trim();
  return t.replace(/\n{3,}/g, "\n\n");
}

function pickMeta(doc: Document, selector: string): string {
  return doc.querySelector(selector)?.getAttribute("content")?.trim() ?? "";
}

function pickTitle(doc: Document, teamNameHint?: string): string {
  const og = pickMeta(doc, 'meta[property="og:title"]') || pickMeta(doc, 'meta[name="og:title"]');
  const raw = (og || doc.querySelector("title")?.textContent || "").trim();
  if (!raw) return "";

  // 末尾のサイト名などを軽く落とす（やりすぎない）
  for (const sep of ["｜", "|"]) {
    const idx = raw.indexOf(sep);
    if (idx > 0) return raw.slice(0, idx).trim();
  }
  const m = raw.match(/\s*-\s*(.+)$/u);
  if (m && teamNameHint && m[1]?.includes(teamNameHint)) {
    return raw.replace(/\s*-\s*.+$/u, "").trim();
  }
  if (m && m[1] && /公式|オフィシャル|Official|オフィシャルサイト/i.test(m[1])) {
    return raw.replace(/\s*-\s*.+$/u, "").trim();
  }
  return raw;
}

function pickDescription(doc: Document): string {
  return (
    pickMeta(doc, 'meta[property="og:description"]') ||
    pickMeta(doc, 'meta[name="description"]') ||
    pickMeta(doc, 'meta[name="twitter:description"]') ||
    ""
  ).trim();
}

function parseYmd(y: number, m: number, d: number): string | null {
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return null;
  const dt = new Date(Date.UTC(y, m - 1, d, 0, 0, 0));
  return Number.isNaN(dt.getTime()) ? null : dt.toISOString();
}

function pickPublishedAt(doc: Document): string | null {
  const meta =
    pickMeta(doc, 'meta[property="article:published_time"]') ||
    pickMeta(doc, 'meta[name="article:published_time"]') ||
    pickMeta(doc, 'meta[property="og:article:published_time"]') ||
    pickMeta(doc, 'meta[property="og:updated_time"]') ||
    "";
  if (meta) {
    const d = new Date(meta);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }

  for (const el of Array.from(doc.querySelectorAll("time"))) {
    const dt = el.getAttribute("datetime")?.trim() ?? "";
    if (dt) {
      const d = new Date(dt);
      if (!Number.isNaN(d.getTime())) return d.toISOString();
    }
  }

  // ページ本文からざっくり拾う（最後の保険）
  const text = doc.body?.textContent ?? "";
  const m1 = text.match(/(\d{4})[./年](\d{1,2})[./月](\d{1,2})/u);
  if (m1) return parseYmd(Number(m1[1]), Number(m1[2]), Number(m1[3]));
  const m2 = text.match(/\[(\d{2})\/(\d{1,2})\/(\d{1,2})\]/u);
  if (m2) return parseYmd(2000 + Number(m2[1]), Number(m2[2]), Number(m2[3]));
  return null;
}

async function fetchHtml(url: string, timeoutMs: number): Promise<{ finalUrl: string; html: string } | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
        accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.7"
      },
      redirect: "follow",
      signal: controller.signal,
      cache: "no-store"
    });
    if (!res.ok) return null;
    const ct = (res.headers.get("content-type") ?? "").toLowerCase();
    if (ct && !ct.includes("text/html") && !ct.includes("application/xhtml+xml")) return null;
    const html = await res.text();
    if (!html.trim()) return null;
    return { finalUrl: res.url || url, html };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function extractByRegex(html: string, baseUrl: string, re: RegExp, allowedHost: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const href = (m[0] || "").trim();
    if (!href) continue;
    try {
      const abs = new URL(href, baseUrl);
      if (abs.hostname !== allowedHost) continue;
      const s = abs.toString();
      if (seen.has(s)) continue;
      seen.add(s);
      out.push(s);
      if (out.length >= 60) break; // 念のため上限
    } catch {
      // ignore
    }
  }
  return out;
}

async function fetchOneArticle(url: string, timeoutMs: number, source: string, teamNameHint?: string): Promise<NewsItem | null> {
  const got = await fetchHtml(url, timeoutMs);
  if (!got) return null;

  const dom = new JSDOM(got.html, { url: got.finalUrl });
  const doc = dom.window.document;

  const title = pickTitle(doc, teamNameHint);
  if (!title) return null;

  const publishedAt = pickPublishedAt(doc);
  const desc = pickDescription(doc);

  const reader = new Readability(doc);
  const article = reader.parse();
  const text = article?.textContent ? normalizeText(article.textContent) : "";
  const content = text ? clamp(text, 2200) : undefined;
  const summary = formatSummary(desc || (text ? clamp(text, 600) : null), { maxChars: 240 });

  return {
    id: stableIdFromUrl(url),
    title,
    url,
    publishedAt,
    source,
    summary,
    ...(content ? { content } : {})
  };
}

function makeMonthlyYmdListUrls(base: { yyyy: number; mm: number }): string[] {
  const m = String(base.mm).padStart(2, "0");
  // ベイスターズは月別ページが安定（index_topnavi.php もあるが月別を優先）
  return [
    `https://www.baystars.co.jp/news/${base.yyyy}/${m}.php`,
    `https://www.baystars.co.jp/news/${base.yyyy}/${m}.php?topnavi=news`,
    "https://www.baystars.co.jp/news/index_topnavi.php"
  ];
}

function buildSources(): Record<TeamId, OfficialSource | null> {
  const now = new Date();
  const yyyy = now.getUTCFullYear();
  const mm = now.getUTCMonth() + 1;
  const yy = yyyy % 100;

  const sources: Record<TeamId, OfficialSource | null> = {
    giants: null, // 既存の専用実装を利用
    tigers: {
      source: "hanshintigers.jp",
      listUrls: () => ["https://hanshintigers.jp/news/"],
      extractArticleUrls: (html, baseUrl) => {
        const host = "hanshintigers.jp";
        return extractByRegex(html, baseUrl, /\/news\/topics\/info_\d+\.html/gi, host);
      }
    },
    baystars: {
      source: "baystars.co.jp",
      listUrls: () => makeMonthlyYmdListUrls({ yyyy, mm }),
      extractArticleUrls: (html, baseUrl) => {
        const host = "www.baystars.co.jp";
        return extractByRegex(html, baseUrl, /\/news\/\d{4}\/\d{2}\/\d{4}_\d{2}\.php/gi, host);
      }
    },
    carp: {
      source: "carp.co.jp",
      listUrls: () => [
        `https://www.carp.co.jp/news${String(yy).padStart(2, "0")}/index.html`,
        `https://www.carp.co.jp/news${String((yy + 99) % 100).padStart(2, "0")}/index.html`,
        `https://www.carp.co.jp/news${String((yy + 98) % 100).padStart(2, "0")}/index.html`
      ],
      extractArticleUrls: (html, baseUrl) => {
        const host = "www.carp.co.jp";
        return extractByRegex(html, baseUrl, /\/news\d{2}\/n-\d+\.html/gi, host);
      }
    },
    swallows: {
      source: "yakult-swallows.co.jp",
      listUrls: () => ["https://www.yakult-swallows.co.jp/news"],
      extractArticleUrls: (html, baseUrl) => {
        const host = "www.yakult-swallows.co.jp";
        return extractByRegex(html, baseUrl, /\/news\/detail\/\d+/gi, host);
      }
    },
    dragons: {
      source: "dragons.jp",
      listUrls: () => [`https://dragons.jp/news/${yyyy}/newslist.php`, `https://dragons.jp/news/${yyyy - 1}/newslist.php`],
      extractArticleUrls: (html, baseUrl) => {
        const host = "dragons.jp";
        // newslist.php 自体やアンカーは除外しつつ、記事ページっぽい /news/YYYY/*.php を拾う
        return extractByRegex(html, baseUrl, /\/news\/\d{4}\/(?!newslist\.php)[0-9a-z_-]+\.php/gi, host);
      }
    },
    hawks: {
      source: "softbankhawks.co.jp",
      listUrls: () => ["https://www.softbankhawks.co.jp/news/list/"],
      extractArticleUrls: (html, baseUrl) => {
        const host = "www.softbankhawks.co.jp";
        return extractByRegex(html, baseUrl, /\/news\/detail\/\d+\.html/gi, host);
      }
    },
    fighters: {
      source: "fighters.co.jp",
      listUrls: () => ["https://www.fighters.co.jp/news/list/"],
      extractArticleUrls: (html, baseUrl) => {
        const host = "www.fighters.co.jp";
        return extractByRegex(html, baseUrl, /\/news\/detail\/\d+\.html/gi, host);
      }
    },
    marines: {
      source: "marines.co.jp",
      listUrls: () => ["https://www.marines.co.jp/news/list/"],
      extractArticleUrls: (html, baseUrl) => {
        const host = "www.marines.co.jp";
        return extractByRegex(html, baseUrl, /\/news\/detail\/\d+\.html/gi, host);
      }
    },
    lions: {
      source: "seibulions.jp",
      listUrls: () => ["https://www.seibulions.jp/news/list/"],
      extractArticleUrls: (html, baseUrl) => {
        const host = "www.seibulions.jp";
        return extractByRegex(html, baseUrl, /\/news\/detail\/\d+\.html/gi, host);
      }
    },
    eagles: {
      source: "rakuteneagles.jp",
      listUrls: () => ["https://www.rakuteneagles.jp/news/list/"],
      extractArticleUrls: (html, baseUrl) => {
        const host = "www.rakuteneagles.jp";
        return extractByRegex(html, baseUrl, /\/news\/detail\/\d+\.html/gi, host);
      }
    },
    buffaloes: {
      source: "buffaloes.co.jp",
      listUrls: () => ["https://www.buffaloes.co.jp/news/list/"],
      extractArticleUrls: (html, baseUrl) => {
        const host = "www.buffaloes.co.jp";
        return extractByRegex(html, baseUrl, /\/news\/detail\/\d+\.html/gi, host);
      }
    }
  };

  return sources;
}

export async function fetchOfficialTeamNews(args: {
  teamId: TeamId;
  limit: number;
  timeoutMs?: number;
  teamNameHint?: string;
}): Promise<NewsItem[]> {
  const limit = Math.min(Math.max(args.limit, 1), 10);
  const timeoutMs = args.timeoutMs ?? 6500;
  const cacheKey = `official:${args.teamId}:limit=${limit}`;

  const cached = cache.get(cacheKey);
  if (cached) return cached;

  // 既存の巨人専用実装（安定動作確認済み）
  if (args.teamId === "giants") {
    const items = await fetchGiantsOfficialNews({ limit, timeoutMs });
    cache.set(cacheKey, items);
    return items;
  }

  const sources = buildSources();
  const src = sources[args.teamId];
  if (!src) return [];

  const now = new Date();
  const listUrls = src.listUrls(now);
  const articleUrls: string[] = [];
  const seen = new Set<string>();

  for (const listUrl of listUrls) {
    const got = await fetchHtml(listUrl, timeoutMs);
    if (!got) continue;
    const urls = src.extractArticleUrls(got.html, listUrl);
    for (const u of urls) {
      if (seen.has(u)) continue;
      seen.add(u);
      articleUrls.push(u);
      if (articleUrls.length >= 40) break;
    }
    if (articleUrls.length > 0) break;
  }

  const items: NewsItem[] = [];
  for (const u of articleUrls.slice(0, limit * 3)) {
    const it = await fetchOneArticle(u, timeoutMs, src.source, args.teamNameHint);
    if (it) items.push(it);
    if (items.length >= limit) break;
  }

  cache.set(cacheKey, items);
  return items;
}

