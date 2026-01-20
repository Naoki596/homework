import { formatSummary } from "./summarize";
import type { NewsItem } from "./types";

function splitTitleAndSource(rawTitle: string): { title: string; source: string | null } {
  // GoogleニュースRSSのtitleは「記事タイトル - 配信元」になっていることが多い
  const idx = rawTitle.lastIndexOf(" - ");
  if (idx <= 0) return { title: rawTitle.trim(), source: null };

  const title = rawTitle.slice(0, idx).trim();
  const source = rawTitle.slice(idx + 3).trim();
  if (!title) return { title: rawTitle.trim(), source: null };
  if (!source || source.length > 60) return { title, source: null };
  return { title, source };
}

function toIsoDate(item: { isoDate?: string; pubDate?: string }): string | null {
  if (item.isoDate) return item.isoDate;
  if (!item.pubDate) return null;
  const d = new Date(item.pubDate);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function stableIdFromUrl(url: string): string {
  // 低コストにID化（URLが長いので、簡易ハッシュ）
  let hash = 0;
  for (let i = 0; i < url.length; i++) {
    hash = (hash * 31 + url.charCodeAt(i)) >>> 0;
  }
  return `u${hash.toString(16)}`;
}

function normalizeTitleForDedupe(title: string): string {
  return title.replace(/\s+/g, " ").trim().toLowerCase();
}

export function normalizeNewsItems(
  items: Array<{
    title?: string;
    link?: string;
    isoDate?: string;
    pubDate?: string;
    creator?: string;
    contentSnippet?: string;
    content?: string;
  }>,
  options?: { maxItems?: number }
): NewsItem[] {
  const maxItems = options?.maxItems ?? 3;
  const out: NewsItem[] = [];

  const seenUrl = new Set<string>();
  const seenTitle = new Set<string>();

  for (const it of items) {
    const url = (it.link ?? "").trim();
    if (!url) continue;

    const rawTitle = (it.title ?? "").trim();
    if (!rawTitle) continue;

    const { title, source } = splitTitleAndSource(rawTitle);
    const publishedAt = toIsoDate(it);
    const summary = formatSummary(it.contentSnippet ?? it.content ?? null, { maxChars: 240 });

    const urlKey = url;
    const titleKey = normalizeTitleForDedupe(title);
    if (seenUrl.has(urlKey)) continue;
    if (seenTitle.has(titleKey)) continue;

    seenUrl.add(urlKey);
    seenTitle.add(titleKey);

    out.push({
      id: stableIdFromUrl(url),
      title,
      url,
      publishedAt,
      source: source ?? (it.creator ? String(it.creator).trim() : null),
      summary
    });

    if (out.length >= maxItems) break;
  }

  return out;
}

