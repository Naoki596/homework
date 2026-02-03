import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";

import { TTLCache } from "@src/lib/cache/ttlCache";
import { formatSummary } from "@src/lib/news/summarize";
import type { NewsItem } from "@src/lib/news/types";

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

function parseYmdDot(s: string): string | null {
  // giants.jp は "2026.1.20" のような表記が多い
  const m = s.match(/(\d{4})\.(\d{1,2})\.(\d{1,2})/);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (!Number.isFinite(y) || !Number.isFinite(mo) || !Number.isFinite(d)) return null;
  const dt = new Date(Date.UTC(y, mo - 1, d, 0, 0, 0));
  return Number.isNaN(dt.getTime()) ? null : dt.toISOString();
}

function pickTitle(doc: Document): string {
  const og = doc.querySelector('meta[property="og:title"]')?.getAttribute("content")?.trim() ?? "";
  const t = (og || doc.querySelector("title")?.textContent?.trim() || "").trim();
  // " - 読売ジャイアンツ（巨人軍）公式サイト" のような後置を削る
  return t.replace(/\s*-\s*読売ジャイアンツ.*$/u, "").trim();
}

function pickDescription(doc: Document): string {
  return (
    doc.querySelector('meta[property="og:description"]')?.getAttribute("content")?.trim() ??
    doc.querySelector('meta[name="description"]')?.getAttribute("content")?.trim() ??
    ""
  );
}

function pickPublishedAt(doc: Document): string | null {
  const meta =
    doc.querySelector('meta[property="article:published_time"]')?.getAttribute("content") ??
    doc.querySelector('meta[name="article:published_time"]')?.getAttribute("content") ??
    "";
  if (meta) {
    const d = new Date(meta);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }

  // time タグ or ページ内テキストから拾う
  for (const el of Array.from(doc.querySelectorAll("time"))) {
    const dt = el.getAttribute("datetime")?.trim() ?? "";
    if (dt) {
      const d = new Date(dt);
      if (!Number.isNaN(d.getTime())) return d.toISOString();
    }
    const t = el.textContent?.trim() ?? "";
    const iso = parseYmdDot(t);
    if (iso) return iso;
  }

  const text = doc.body?.textContent ?? "";
  return parseYmdDot(text);
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
    const html = await res.text();
    if (!html.trim()) return null;
    return { finalUrl: res.url || url, html };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function extractLatestNewsUrlsFromList(html: string, baseUrl: string): string[] {
  // `/news/28446/` のようなURLを登場順で拾う（先頭ほど新しい想定）
  const re = /\/news\/(\d{3,8})\//g;
  const out: string[] = [];
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const id = m[1];
    if (!id) continue;
    const abs = new URL(`/news/${id}/`, baseUrl).toString();
    if (seen.has(abs)) continue;
    seen.add(abs);
    out.push(abs);
    if (out.length >= 30) break; // 念のため上限
  }
  return out;
}

async function fetchOneNewsItem(url: string, timeoutMs: number): Promise<NewsItem | null> {
  const got = await fetchHtml(url, timeoutMs);
  if (!got) return null;

  const dom = new JSDOM(got.html, { url: got.finalUrl });
  const doc = dom.window.document;

  const title = pickTitle(doc);
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
    source: "giants.jp",
    summary,
    ...(content ? { content } : {})
  };
}

export async function fetchGiantsOfficialNews(options?: { limit?: number; timeoutMs?: number }): Promise<NewsItem[]> {
  const limit = Math.min(Math.max(options?.limit ?? 3, 1), 10);
  const timeoutMs = options?.timeoutMs ?? 6500;

  const cached = cache.get(`limit=${limit}`);
  if (cached) return cached;

  const listUrl = "https://www.giants.jp/news/";
  const list = await fetchHtml(listUrl, timeoutMs);
  if (!list) return [];

  const urls = extractLatestNewsUrlsFromList(list.html, listUrl).slice(0, limit * 2); // 欠損に備えて少し多め
  const items: NewsItem[] = [];
  for (const u of urls) {
    const it = await fetchOneNewsItem(u, timeoutMs);
    if (it) items.push(it);
    if (items.length >= limit) break;
  }

  cache.set(`limit=${limit}`, items);
  return items;
}

