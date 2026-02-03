import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";

import { TTLCache } from "@src/lib/cache/ttlCache";

const cache = new TTLCache<string | null>(6 * 60 * 60 * 1000);

function isGoogleHost(host: string): boolean {
  const h = host.toLowerCase();
  return h === "news.google.com" || h === "www.google.com" || h.endsWith(".google.com");
}

function isGoogleNewsArticleUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    if (!isGoogleHost(u.hostname)) return false;
    return u.pathname.startsWith("/rss/articles/") || u.pathname.startsWith("/articles/") || u.pathname.includes("/articles/");
  } catch {
    return false;
  }
}

function clamp(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max).trimEnd() + "…";
}

function normalizeText(raw: string): string {
  // 余計な空白・改行を整形（読みやすさ重視）
  const t = raw.replace(/\r\n/g, "\n").replace(/[ \t]+\n/g, "\n").trim();
  // 空行が連続しすぎるケースを抑制
  return t.replace(/\n{3,}/g, "\n\n");
}

function pickMetaDescription(doc: Document): string {
  const og =
    doc.querySelector('meta[property="og:description"]')?.getAttribute("content") ??
    doc.querySelector('meta[name="description"]')?.getAttribute("content") ??
    "";
  return og.trim();
}

function tryExtractOutboundUrlFromGoogleNews(doc: Document, baseUrl: string): string | null {
  const candidates: string[] = [];
  for (const a of Array.from(doc.querySelectorAll("a"))) {
    const href = a.getAttribute("href") ?? "";
    if (!href) continue;
    try {
      const abs = new URL(href, baseUrl).toString();
      candidates.push(abs);
    } catch {
      // ignore
    }
  }

  // 1) まずは google.com/url? の `url` / `q` を優先
  for (const href of candidates) {
    try {
      const u = new URL(href);
      if (!isGoogleHost(u.hostname)) continue;
      if (u.pathname !== "/url") continue;
      const out = u.searchParams.get("url") ?? u.searchParams.get("q") ?? "";
      if (!out) continue;
      const decoded = decodeURIComponent(out);
      const outUrl = new URL(decoded);
      if (isGoogleHost(outUrl.hostname)) continue;
      return outUrl.toString();
    } catch {
      // ignore
    }
  }

  // 2) それ以外の「外部 https://…」リンク（google以外）を拾う
  for (const href of candidates) {
    try {
      const u = new URL(href);
      if (u.protocol !== "https:" && u.protocol !== "http:") continue;
      if (isGoogleHost(u.hostname)) continue;
      return u.toString();
    } catch {
      // ignore
    }
  }

  return null;
}

export async function fetchArticleContent(
  url: string,
  options?: { timeoutMs?: number; maxChars?: number }
): Promise<string | null> {
  const timeoutMs = options?.timeoutMs ?? 6500;
  const maxChars = options?.maxChars ?? 2600;

  const cached = cache.get(url);
  if (cached !== undefined) return cached;

  const fetchOnce = async (targetUrl: string, remainingRedirectAttempt: number): Promise<string | null> => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(targetUrl, {
        method: "GET",
        headers: {
          // 一部サイトがUA無しを弾くため、ブラウザ相当に寄せる
          "user-agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
          accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.7"
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

      // Readability は base URL があると相対リンク解決等が安定する
      const finalUrl = (res as any).url ? String((res as any).url) : targetUrl;
      const dom = new JSDOM(html, { url: finalUrl });
      const doc = dom.window.document;

      const reader = new Readability(doc);
      const article = reader.parse();
      const fromReadability = article?.textContent ? normalizeText(article.textContent) : "";
      const fromMeta = pickMetaDescription(doc);
      const picked = fromReadability || fromMeta;
      const out = picked ? clamp(picked, maxChars) : null;

      // GoogleニュースURLは「記事本文そのもの」ではないことが多いので、
      // 抽出結果が弱い場合は、ページ内の“元記事URL”を探して再取得する。
      if (
        remainingRedirectAttempt > 0 &&
        isGoogleNewsArticleUrl(finalUrl) &&
        (!out || out.length < 200)
      ) {
        const outbound = tryExtractOutboundUrlFromGoogleNews(doc, finalUrl);
        if (outbound) {
          // outbound の結果は url としてもキャッシュしておく（同じRSSリンクからの再取得を減らす）
          const second = await fetchOnce(outbound, remainingRedirectAttempt - 1);
          return second ?? out;
        }
      }

      return out;
    } catch {
      return null;
    } finally {
      clearTimeout(timeout);
    }
  };

  const out = await fetchOnce(url, 1);
  if (out) {
    cache.set(url, out);
    return out;
  }
  // 失敗は短めにキャッシュ
  cache.set(url, null, 20 * 60 * 1000);
  return null;
}

