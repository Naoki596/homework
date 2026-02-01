import { findGlossaryEntry } from "./glossary";
import type { ChatKeyword } from "./types";

const STOP_WORDS = new Set(
  [
    "プロ野球",
    "npb",
    "ニュース",
    "公式",
    "発表",
    "続報",
    "最新",
    "投稿",
    "動画",
    "速報",
    "結果",
    "予定",
    "きょう",
    "今日",
    "明日",
    "昨日",
    "今季",
    "今シーズン",
    "試合",
    "球団",
    "選手",
    "監督",
    "など",
    "について",
    "など"
  ].map((s) => s.toLowerCase())
);

function normalizeToken(s: string): string {
  return s.replace(/\s+/g, "").trim();
}

function isMostlyNumber(s: string): boolean {
  return /^[0-9]+$/.test(s);
}

function isStopWord(s: string): boolean {
  const t = s.toLowerCase();
  return STOP_WORDS.has(t);
}

function extractTokensJa(text: string): string[] {
  // 形態素解析なしの簡易版：日本語/英数の「塊」を拾う
  // - 漢字/ひらがな/カタカナ/英数/中点/長音などを含める
  const re = /[\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}A-Za-z0-9・ー]+/gu;
  return text.match(re) ?? [];
}

function scoreToken(token: string, opts: { inTitle: boolean }): number {
  // 基本は「タイトルに出る語」を重くする
  // 用語集ヒットも加点して、説明できる語を上位に出しやすくする
  const base = opts.inTitle ? 6 : 3;
  const lenBonus = Math.min(token.length, 10) * 0.2;
  const glossaryBonus = findGlossaryEntry(token) ? 2 : 0;
  return base + lenBonus + glossaryBonus;
}

export function extractKeywordsFromTexts(input: { title: string; summary: string }[], options?: { max?: number }): ChatKeyword[] {
  const max = options?.max ?? 6;
  const counts = new Map<string, { score: number; titleHits: number; totalHits: number }>();

  for (const it of input) {
    const titleTokens = extractTokensJa(it.title);
    const summaryTokens = extractTokensJa(it.summary);

    for (const raw of titleTokens) {
      const t = normalizeToken(raw);
      if (t.length < 2) continue;
      if (isMostlyNumber(t)) continue;
      if (isStopWord(t)) continue;
      const cur = counts.get(t) ?? { score: 0, titleHits: 0, totalHits: 0 };
      cur.score += scoreToken(t, { inTitle: true });
      cur.titleHits += 1;
      cur.totalHits += 1;
      counts.set(t, cur);
    }

    for (const raw of summaryTokens) {
      const t = normalizeToken(raw);
      if (t.length < 2) continue;
      if (isMostlyNumber(t)) continue;
      if (isStopWord(t)) continue;
      const cur = counts.get(t) ?? { score: 0, titleHits: 0, totalHits: 0 };
      cur.score += scoreToken(t, { inTitle: false });
      cur.totalHits += 1;
      counts.set(t, cur);
    }
  }

  const sorted = [...counts.entries()].sort((a, b) => b[1].score - a[1].score);
  const picked = sorted.slice(0, max);

  return picked.map(([term, meta]) => {
    const entry = findGlossaryEntry(term);
    const reason =
      meta.titleHits > 0
        ? `タイトルに${meta.titleHits}回、本文要点に合計${meta.totalHits}回登場`
        : `要点に合計${meta.totalHits}回登場`;
    return {
      term,
      reason,
      explain: entry?.explain
    };
  });
}

