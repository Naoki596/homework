import { NextResponse } from "next/server";

import { TTLCache } from "@src/lib/cache/ttlCache";
import { fetchRssXml } from "@src/lib/news/fetchRss";
import { normalizeNewsItems } from "@src/lib/news/normalize";
import { parseRssXml } from "@src/lib/news/parseRss";
import type { NewsResponse } from "@src/lib/news/types";
import { getTeam } from "@src/teams";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const cache = new TTLCache<NewsResponse>(5 * 60 * 1000);

function clampLimit(raw: string | null): number {
  const n = raw ? Number.parseInt(raw, 10) : Number.NaN;
  if (!Number.isFinite(n)) return 3;
  return Math.min(Math.max(n, 1), 10);
}

function buildGoogleNewsRssUrl(query: string): string {
  const q = encodeURIComponent(query);
  return `https://news.google.com/rss/search?q=${q}&hl=ja&gl=JP&ceid=JP:ja`;
}

function buildQueryVariants(team: { name: string; queries: string[] }): string[] {
  const baseTerms = [team.name, ...team.queries];
  const uniq: string[] = [];
  const seen = new Set<string>();
  for (const t of baseTerms) {
    const s = t.trim();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    uniq.push(s);
  }

  const variants: string[] = [];
  for (const term of uniq) variants.push(`${term} (プロ野球 OR NPB)`);
  for (const term of uniq) variants.push(`${term} プロ野球`);
  for (const term of uniq) variants.push(`${term}`);

  return variants;
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const teamId = url.searchParams.get("teamId");
  const limit = clampLimit(url.searchParams.get("limit"));
  const debug = url.searchParams.get("debug") === "1";
  const noCache = url.searchParams.get("noCache") === "1";

  const team = getTeam(teamId);
  if (!team) {
    const body: NewsResponse = {
      errorCode: "INVALID_TEAM",
      message: "球団の指定が不正です。球団を選択して再試行してください。"
    };
    return NextResponse.json(body, { status: 400 });
  }

  const queryVariants = buildQueryVariants(team);
  const debugLog: Array<{ query: string; step: string; detail?: string }> = [];
  let hadAnyError = false;
  let lastErrorMessage: string | null = null;

  for (const q of queryVariants) {
    const cacheKey = `news:${team.teamId}:limit=${limit}:q=${q}`;
    if (!noCache) {
      const cached = cache.get(cacheKey);
      if (cached) {
        // 0件のキャッシュは次の候補へ（ヒット率を優先）
        if ("items" in cached && cached.items.length === 0) continue;
        return NextResponse.json(cached, {
          status: "items" in cached ? 200 : 502,
          headers: {
            "Cache-Control": "public, max-age=0, s-maxage=300"
          }
        });
      }
    }

    try {
      const rssUrl = buildGoogleNewsRssUrl(q);
      if (debug) debugLog.push({ query: q, step: "fetch", detail: rssUrl });
      const xml = await fetchRssXml(rssUrl, { timeoutMs: 6500 });
      if (debug) debugLog.push({ query: q, step: "xmlLen", detail: String(xml.length) });
      const feed = await parseRssXml(xml);
      if (debug) debugLog.push({ query: q, step: "parsedItems", detail: String(feed.items?.length ?? 0) });
      const items = normalizeNewsItems(feed.items ?? [], { maxItems: limit });
      if (debug) debugLog.push({ query: q, step: "normalizedItems", detail: String(items.length) });

      const body: NewsResponse = {
        teamId: team.teamId,
        teamName: team.name,
        items
      };
      cache.set(cacheKey, body);

      if (items.length > 0) {
        return NextResponse.json(body, {
          status: 200,
          headers: {
            "Cache-Control": "public, max-age=0, s-maxage=300"
          }
        });
      }
      // 0件ならフォールバック続行（最後まで0件なら最終的に返す）
      continue;
    } catch (e) {
      const message = e instanceof Error ? e.message : "unknown error";
      hadAnyError = true;
      lastErrorMessage = message;
      if (debug) debugLog.push({ query: q, step: "error", detail: message });
      const body: NewsResponse = {
        errorCode: "FETCH_FAILED",
        message: `ニュースを取得できませんでした。時間をおいて再試行してください。（${message}）`
      };
      cache.set(cacheKey, body, 60 * 1000); // エラーは短めにキャッシュ
      // 取得失敗は次候補で回復する場合もあるので続行
      continue;
    }
  }

  if (debug) {
    return NextResponse.json(
      {
        teamId: team.teamId,
        teamName: team.name,
        items: [],
        debug: debugLog
      },
      { status: hadAnyError ? 502 : 200 }
    );
  }

  if (hadAnyError) {
    const body: NewsResponse = {
      errorCode: "FETCH_FAILED",
      message: `ニュースを取得できませんでした。時間をおいて再試行してください。（${lastErrorMessage ?? "unknown error"}）`
    };
    return NextResponse.json(body, { status: 502 });
  }

  const body: NewsResponse = {
    teamId: team.teamId,
    teamName: team.name,
    items: []
  };
  return NextResponse.json(body, {
    status: 200,
    headers: {
      "Cache-Control": "public, max-age=0, s-maxage=300"
    }
  });
}

