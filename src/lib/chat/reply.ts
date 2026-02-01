import { extractKeywordsFromTexts } from "./keywords";
import type { ChatContext, ChatResponseBody } from "./types";

function clampMessage(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw.trim().slice(0, 800);
}

function normalizeWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function shorten(s: string, maxChars: number): string {
  const t = normalizeWhitespace(s);
  if (t.length <= maxChars) return t;
  return t.slice(0, maxChars).trimEnd() + "…";
}

function pickItemIndex(message: string, items: ChatContext["items"]): number | null {
  // 「1」「2」などの番号指定（1始まり）
  const m = message.match(/(?:^|\D)([1-9]|10)(?:\D|$)/);
  if (m) {
    const n = Number.parseInt(m[1] ?? "", 10);
    if (Number.isFinite(n) && n >= 1 && n <= items.length) return n - 1;
  }
  return null;
}

function wantsKeywords(message: string): boolean {
  return /キーワード|単語|用語|重要|ポイント/.test(message);
}

function wantsShortSummary(message: string): boolean {
  return /要約|短く|まとめ|噛み砕/.test(message);
}

function renderItemsList(items: ChatContext["items"]): string {
  if (items.length === 0) return "（ニュースがまだ取得されていません）";
  return items
    .slice(0, 10)
    .map((it, i) => `${i + 1}. ${it.title}`)
    .join("\n");
}

export function buildChatReply(args: { message: unknown; context?: ChatContext }): ChatResponseBody {
  const message = clampMessage(args.message);
  const ctx = args.context;

  if (!message) {
    return { reply: "メッセージが空でした。聞きたいことを入力してください。" };
  }

  // 文脈がないとき
  if (!ctx || !ctx.teamId) {
    return {
      reply:
        "今は球団/ニュースの文脈がありません。まず画面で球団を選んでニュースを取得してから、\n「この記事のキーワード」「1の要点を短く」などと聞いてください。"
    };
  }

  const items = ctx.items ?? [];
  const idx = pickItemIndex(message, items) ?? (items.length > 0 ? 0 : null);
  const picked = idx !== null ? items[idx] : null;

  // キーワード
  if (wantsKeywords(message)) {
    if (!picked) {
      return {
        reply: `どの記事のキーワードにしますか？番号で指定してください。\n\n${renderItemsList(items)}`
      };
    }

    const keywords = extractKeywordsFromTexts(
      [{ title: picked.title, summary: picked.summary }],
      { max: 6 }
    );

    const lines: string[] = [];
    lines.push(`対象: ${idx! + 1}. ${picked.title}`);
    lines.push("");
    lines.push("重要キーワード（候補）:");
    for (const k of keywords) {
      if (k.explain) {
        lines.push(`- ${k.term}：${k.explain}`);
      } else {
        lines.push(`- ${k.term}：固有名詞/一般語の可能性があります（記事本文で文脈確認がおすすめ）`);
      }
    }

    return {
      reply: lines.join("\n"),
      keywords,
      sources: [{ title: picked.title, url: picked.url }]
    };
  }

  // 要点を短く
  if (wantsShortSummary(message)) {
    if (!picked) {
      return {
        reply: `どの記事を短く要約しますか？番号で指定してください。\n\n${renderItemsList(items)}`
      };
    }
    const short = shorten(picked.summary, 120);
    return {
      reply: `対象: ${idx! + 1}. ${picked.title}\n\n要点（短縮）: ${short}\n\n元記事: ${picked.url}`,
      sources: [{ title: picked.title, url: picked.url }]
    };
  }

  // ヘルプ/デフォルト
  return {
    reply:
      `了解です。できることの例です：\n` +
      `- 「1のキーワードを教えて」\n` +
      `- 「2を100文字くらいで要約して」\n\n` +
      `今表示中のニュース:\n${renderItemsList(items)}`
  };
}

