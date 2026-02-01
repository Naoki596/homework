import { TTLCache } from "@src/lib/cache/ttlCache";

import type { ChatContext, ChatResponseBody } from "./types";

type GeminiJson = unknown;

type RateState = { windowStartMs: number; count: number };

const advancedCache = new TTLCache<ChatResponseBody>(60 * 1000);
const rateByIp = new Map<string, RateState>();

export class GeminiRateLimitError extends Error {
  constructor(
    message: string,
    public readonly retryAfterSeconds: number | null
  ) {
    super(message);
    this.name = "GeminiRateLimitError";
  }
}

function sanitizeEnvValue(raw: string): string {
  // Windowsやエディタの保存形式で混ざりやすい不可視文字を除去
  // - \u0000: UTF-16扱いで混ざることがあるNULL
  // - \uFEFF: BOM
  return raw.replace(/\u0000/g, "").replace(/\uFEFF/g, "").trim().replace(/^["']|["']$/g, "");
}

function sanitizeGeminiApiKey(raw: string): string {
  const cleaned = sanitizeEnvValue(raw);
  // APIキーに使われない文字が紛れた場合に備えて、許可文字以外を除去
  // （AI StudioのAPIキーは通常これで十分。）
  return cleaned.replace(/[^0-9A-Za-z\-_]/g, "");
}

function nowMs(): number {
  return Date.now();
}

function clamp(str: string, max: number): string {
  if (str.length <= max) return str;
  return str.slice(0, max);
}

function normalizeWs(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function cacheKey(args: { message: string; context: ChatContext }): string {
  const titles = args.context.items.map((i) => i.title).join("|");
  return `gemini:${args.context.teamId ?? ""}:${normalizeWs(args.message)}:${titles}`;
}

function extractJsonFromText(text: string): GeminiJson | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < 0 || end <= start) return null;
  const candidate = text.slice(start, end + 1);
  try {
    return JSON.parse(candidate) as GeminiJson;
  } catch {
    return null;
  }
}

function joinCandidateText(json: {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
  }>;
}): string {
  const parts = json.candidates?.[0]?.content?.parts ?? [];
  return parts.map((p) => p.text ?? "").join("");
}

function stripMarkdownCodeFences(text: string): string {
  // ```json ... ``` のような囲いを除去して、JSON抽出しやすくする
  return text.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
}

function parseStructuredJson(text: string): GeminiJson | null {
  const stripped = stripMarkdownCodeFences(text);
  try {
    return JSON.parse(stripped) as GeminiJson;
  } catch {
    return extractJsonFromText(stripped);
  }
}

function formatReplyFromParsed(parsed: GeminiJson): Pick<ChatResponseBody, "reply" | "keywords" | "meta"> | null {
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as {
    shortSummary?: unknown;
    keywords?: unknown;
    notes?: unknown;
  };

  const shortSummary = typeof obj.shortSummary === "string" ? obj.shortSummary.trim() : "";
  const notes = Array.isArray(obj.notes) ? obj.notes.filter((n) => typeof n === "string").slice(0, 3) : [];
  const kws = Array.isArray(obj.keywords) ? obj.keywords : [];
  const keywords = kws
    .map((k) => {
      if (!k || typeof k !== "object") return null;
      const term = typeof (k as any).term === "string" ? String((k as any).term).trim() : "";
      const explain = typeof (k as any).explain === "string" ? String((k as any).explain).trim() : "";
      const importance = typeof (k as any).importance === "string" ? String((k as any).importance) : "mid";
      if (!term) return null;
      return {
        term,
        reason: `AI抽出（重要度:${importance}）`,
        explain: explain || undefined
      };
    })
    .filter(Boolean)
    .slice(0, 6) as NonNullable<ChatResponseBody["keywords"]>;

  const lines: string[] = [];
  if (shortSummary) lines.push(`要点（AI・短縮）: ${shortSummary}`);
  if (keywords.length > 0) {
    lines.push("");
    lines.push("重要キーワード:");
    for (const k of keywords) lines.push(`- ${k.term}${k.explain ? `：${k.explain}` : ""}`);
  }
  if (notes.length > 0) {
    lines.push("");
    lines.push("注意:");
    for (const n of notes) lines.push(`- ${String(n).trim()}`);
  }

  return {
    reply: lines.join("\n") || "（AI解説）応答を作れませんでした。",
    keywords,
    meta: { mode: "advanced", provider: "gemini", fallback: false }
  };
}

const GEMINI_RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    shortSummary: {
      type: "string",
      description: "100〜140文字程度で要点を短縮した文章"
    },
    keywords: {
      type: "array",
      description: "重要キーワード（3〜6個）",
      items: {
        type: "object",
        properties: {
          term: { type: "string", description: "キーワード" },
          explain: { type: "string", description: "短い解説" },
          importance: {
            type: "string",
            description: "重要度",
            enum: ["high", "mid", "low"]
          }
        },
        required: ["term", "explain", "importance"]
      }
    },
    notes: {
      type: "array",
      description: "注意事項（断定できない点など）",
      items: { type: "string" }
    }
  },
  required: ["shortSummary", "keywords", "notes"]
} as const;

function pickIp(headers: Headers): string {
  const xfwd = headers.get("x-forwarded-for");
  if (xfwd) return xfwd.split(",")[0]?.trim() || "unknown";
  const xreal = headers.get("x-real-ip");
  if (xreal) return xreal.trim();
  return "unknown";
}

function allowAdvanced(ip: string): boolean {
  // 超簡易の無料枠ガード：IP単位で 1分あたり5回まで
  const windowMs = 60_000;
  const limit = 5;

  const now = nowMs();
  const cur = rateByIp.get(ip);
  if (!cur || now - cur.windowStartMs >= windowMs) {
    rateByIp.set(ip, { windowStartMs: now, count: 1 });
    return true;
  }
  if (cur.count >= limit) return false;
  cur.count += 1;
  rateByIp.set(ip, cur);
  return true;
}

function buildPrompt(args: { message: string; context: ChatContext }): { system: string; user: string } {
  const items = args.context.items.slice(0, 3);
  const itemsText =
    items.length === 0
      ? "（ニュースはまだ取得されていません）"
      : items
          .map(
            (it, i) =>
              [
                `#${i + 1}`,
                `title: ${it.title}`,
                `summary: ${it.summary}`,
                `url: ${it.url}`
              ].join("\n")
          )
          .join("\n\n");

  const system =
    "あなたは日本のプロ野球（NPB）ニュースの解説者です。\n" +
    "制約: あなたが参照できるのはRSS由来の title/summary/url のみです。記事本文はありません。推測で事実を作らず、断定しないでください。\n" +
    "出力: 必ずJSONだけを返してください（前後に文章を付けない）。\n" +
    "JSONスキーマ:\n" +
    '{\n  "shortSummary": string, // 100〜140文字程度\n  "keywords": [{ "term": string, "explain": string, "importance": "high"|"mid"|"low" }],\n  "notes": string[]\n}\n' +
    "keywordsは3〜6個。explainは短く。\n";

  const user =
    `球団: ${args.context.teamName ?? args.context.teamId ?? "未選択"}\n` +
    `ユーザーの質問: ${args.message}\n\n` +
    `ニュース（最大3件）:\n${itemsText}\n\n` +
    "ユーザーの質問が特定の記事(#1/#2/#3)を指している場合はそれを優先し、そうでなければ#1を対象にしてください。";

  return { system, user };
}

export async function generateGeminiAdvancedReply(args: {
  message: string;
  context: ChatContext;
  headers: Headers;
}): Promise<ChatResponseBody> {
  // .env の書き方ゆれ（引用符/空白/不可視文字混入）でエラーになりやすいので正規化する
  const rawApiKey = process.env.GEMINI_API_KEY ?? "";
  const apiKey = sanitizeGeminiApiKey(rawApiKey);
  // 2026時点のGemini APIでは、1.5系が利用不可/非推奨になっていることがあるため、
  // 安定版として 2.5 flash をデフォルトにする。
  const model = sanitizeEnvValue(process.env.GEMINI_MODEL ?? "gemini-2.5-flash");
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is not set");
  }
  // AI StudioのAPIキーは通常 "AIza..." で始まり、半角英数/記号（- _）で構成される。
  // それ以外は「APIキーを貼れていない」か「不可視文字混入」が疑わしい。
  if (!/^AIza[0-9A-Za-z\-_]{10,}$/.test(apiKey)) {
    const rawLen = rawApiKey.length;
    const sanitizedLen = apiKey.length;
    const rawHasNonAscii = /[^\x00-\x7F]/.test(rawApiKey);
    const rawHasNull = rawApiKey.includes("\u0000");
    const rawHasBom = rawApiKey.includes("\uFEFF");
    const safePrefix = apiKey.slice(0, 4) || "(empty)";
    throw new Error(
      "GEMINI_API_KEY の値が不正です。AI Studioで発行したAPIキー（だいたい 'AIza...' で始まる半角文字列）を、余計な文字なしで設定してください。" +
        `（診断: prefix=${safePrefix}, rawLen=${rawLen}, sanitizedLen=${sanitizedLen}, nonAscii=${rawHasNonAscii}, null=${rawHasNull}, bom=${rawHasBom}）`
    );
  }

  const ip = pickIp(args.headers);
  if (!allowAdvanced(ip)) {
    throw new Error("Gemini rate limited");
  }

  const key = cacheKey({ message: args.message, context: args.context });
  const cached = advancedCache.get(key);
  if (cached) return cached;

  const { system, user } = buildPrompt({ message: args.message, context: args.context });

  // APIキーはURLクエリに載せずヘッダで送る（ログ等への露出を減らす）
  // Structured Outputs（JSON Schema）を使うため v1beta を利用する
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;

  try {
    const runOnce = async (retry: boolean) => {
      // 1回ごとにタイムアウトを持つ（1回目が遅くても2回目のチャンスを残す）
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 20_000);
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          "x-goog-api-key": apiKey
        },
        body: JSON.stringify({
          contents: [{ parts: [{ text: `${system}\n\n${user}` }] }],
          generationConfig: {
            // JSONを壊さないため、Structured Outputsを使う
            responseMimeType: "application/json",
            responseJsonSchema: GEMINI_RESPONSE_SCHEMA,
            temperature: retry ? 0.2 : 0.4,
            maxOutputTokens: retry ? 1200 : 900
          }
        }),
        signal: controller.signal
      });
      clearTimeout(timeout);
      if (!res.ok) {
        if (res.status === 429) {
          // 可能なら待ち時間（秒）を取得
          const ra = res.headers.get("retry-after");
          const retryAfterSeconds = ra ? Number.parseInt(ra, 10) : Number.NaN;
          const seconds = Number.isFinite(retryAfterSeconds) ? retryAfterSeconds : null;
          throw new GeminiRateLimitError("Gemini API failed: 429 Too Many Requests", seconds);
        }
        const t = await res.text().catch(() => "");
        if (res.status === 404) {
          throw new Error(
            `Gemini API failed: 404 Not Found（モデル名 '${model}' がこのAPIで見つかりません）` +
              `。まず .env.local の GEMINI_MODEL を 'gemini-2.5-flash' にして再起動してください。` +
              ` ${clamp(t, 200)}`
          );
        }
        throw new Error(`Gemini API failed: ${res.status} ${res.statusText} ${clamp(t, 200)}`);
      }

      const json = (await res.json()) as {
        candidates?: Array<{
          content?: { parts?: Array<{ text?: string }> };
        }>;
      };
      const text = joinCandidateText(json);
      const parsed = parseStructuredJson(text);
      const formatted = parsed ? formatReplyFromParsed(parsed) : null;
      return { formatted };
    };

    const first = await runOnce(false);
    if (first.formatted) {
      const out: ChatResponseBody = {
        ...first.formatted,
        sources: args.context.items.slice(0, 1).map((i) => ({ title: i.title, url: i.url }))
      };
      advancedCache.set(key, out);
      return out;
    }

    const second = await runOnce(true);
    if (second.formatted) {
      const out: ChatResponseBody = {
        ...second.formatted,
        sources: args.context.items.slice(0, 1).map((i) => ({ title: i.title, url: i.url }))
      };
      advancedCache.set(key, out);
      return out;
    }

    // JSONとして壊れている（途中で切れる/```json付き等）。生のJSONを返すと見づらいのでフォールバックさせる。
    throw new Error("AIの応答形式（JSON）が崩れました。");
  } finally {
    // no-op
  }
}

