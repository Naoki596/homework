import { TTLCache } from "@src/lib/cache/ttlCache";

import type { ChatContext, ChatResponseBody } from "./types";
import { OPENROUTER_ALLOWED_MODELS } from "./openrouterModels";
import { safeParseAiJson } from "@src/lib/chat/safeJson";

type OpenRouterJson = unknown;

type RateState = { windowStartMs: number; count: number };

const advancedCache = new TTLCache<ChatResponseBody>(60 * 1000);
const rateByIp = new Map<string, RateState>();

export class OpenRouterRateLimitError extends Error {
  constructor(
    message: string,
    public readonly retryAfterSeconds: number | null
  ) {
    super(message);
    this.name = "OpenRouterRateLimitError";
  }
}

export class OpenRouterPaymentRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpenRouterPaymentRequiredError";
  }
}

function sanitizeEnvValue(raw: string): string {
  // Windowsやエディタの保存形式で混ざりやすい不可視文字を除去
  // - \u0000: UTF-16扱いで混ざることがあるNULL
  // - \uFEFF: BOM
  return raw.replace(/\u0000/g, "").replace(/\uFEFF/g, "").trim().replace(/^["']|["']$/g, "");
}

function sanitizeApiKey(raw: string): string {
  // APIキーに使われない文字が紛れた場合に備えて除去（ログ/ヘッダで壊れにくくする）
  return sanitizeEnvValue(raw).replace(/[^\x21-\x7E]/g, "");
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

function clampForPrompt(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (!t) return "";
  return t.length <= max ? t : t.slice(0, max).trimEnd() + "…";
}

function cacheKey(args: { model: string; message: string; context: ChatContext }): string {
  const titles = args.context.items.map((i) => i.title).join("|");
  return `openrouter:${args.model}:${args.context.teamId ?? ""}:${normalizeWs(args.message)}:${titles}`;
}

function pickIp(headers: Headers): string {
  const xfwd = headers.get("x-forwarded-for");
  if (xfwd) return xfwd.split(",")[0]?.trim() || "unknown";
  const xreal = headers.get("x-real-ip");
  if (xreal) return xreal.trim();
  return "unknown";
}

function allowAdvanced(ip: string): boolean {
  // 超簡易のガード：IP単位で 1分あたり5回まで
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

function stripMarkdownCodeFences(text: string): string {
  return text.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
}

function unescapeMaybe(s: string): string {
  // モデルがエスケープ済みで返す場合に最低限だけ戻す
  return s.replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/\\"/g, '"');
}

function parseStructuredJson(text: string): OpenRouterJson | null {
  const res = safeParseAiJson(text);
  return res.ok ? (res.value as OpenRouterJson) : null;
}

function formatReplyFromParsed(
  parsed: OpenRouterJson
): Pick<ChatResponseBody, "reply" | "keywords" | "meta"> | null {
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
    meta: { mode: "advanced", provider: "openrouter", fallback: false }
  };
}

function formatReplyFromLooseJsonLikeText(rawText: string): Pick<ChatResponseBody, "reply" | "keywords" | "meta"> | null {
  const raw = stripMarkdownCodeFences(rawText);
  if (!raw) return null;

  // 1) まずは通常パースを試す（ノイズ混入ケースを拾う）
  const parsed = parseStructuredJson(raw);
  const byParsed = parsed ? formatReplyFromParsed(parsed) : null;
  if (byParsed) return byParsed;

  // 2) それでもダメなら、壊れたJSONから「それっぽい」部分を抜く
  const shortMatch =
    raw.match(/"shortSummary"\s*:\s*"([\s\S]*?)"(?=\s*(,|\}))/i) ??
    raw.match(/shortSummary\s*:\s*"([\s\S]*?)$/i);
  const shortSummary = shortMatch?.[1]
    ? unescapeMaybe(shortMatch[1]).replace(/\r?\n/g, " ").replace(/\s+/g, " ").trim()
    : "";

  const keywordMatches = Array.from(
    raw.matchAll(/"term"\s*:\s*"([^"]+)"[\s\S]*?"explain"\s*:\s*"([^"]*)"(?:[\s\S]*?"importance"\s*:\s*"([^"]+)")?/gi)
  );
  const keywords = keywordMatches
    .map((m) => {
      const term = (m[1] ?? "").trim();
      const explain = (m[2] ?? "").trim();
      const importance = (m[3] ?? "mid").trim();
      if (!term) return null;
      return { term, reason: `AI抽出（重要度:${importance || "mid"}）`, explain: explain || undefined };
    })
    .filter(Boolean)
    .slice(0, 6) as NonNullable<ChatResponseBody["keywords"]>;

  if (!shortSummary && keywords.length === 0) return null;

  const lines: string[] = [];
  if (shortSummary) lines.push(`要点（AI・短縮）: ${shortSummary}`);
  if (keywords.length > 0) {
    lines.push("");
    lines.push("重要キーワード:");
    for (const k of keywords) lines.push(`- ${k.term}${k.explain ? `：${k.explain}` : ""}`);
  }

  return { reply: lines.join("\n"), keywords, meta: { mode: "advanced", provider: "openrouter", fallback: false } };
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
                `content: ${it.content ? clampForPrompt(it.content, 900) : "（本文未取得）"}`,
                `url: ${it.url}`
              ].join("\n")
          )
          .join("\n\n");

  const system =
    "あなたは日本のプロ野球（NPB）ニュースの解説者です。\n" +
    "制約: あなたが参照できるのはRSS由来の title/summary/url と、取得できた場合の本文抜粋（content）のみです。本文抜粋が無い記事は推測で補わず、断定しないでください。\n" +
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

function pickModel(requested: string | undefined): string {
  const req = typeof requested === "string" ? requested.trim() : "";
  if (req && OPENROUTER_ALLOWED_MODELS.includes(req)) return req;

  const envDefault = sanitizeEnvValue(process.env.OPENROUTER_DEFAULT_MODEL ?? "");
  if (envDefault && OPENROUTER_ALLOWED_MODELS.includes(envDefault)) return envDefault;

  // `??` と `||` を混在させる場合は括弧が必要（ビルド時パーサエラー回避）
  return (OPENROUTER_ALLOWED_MODELS[0] ?? req) || "openai/gpt-oss-20b:free";
}

function joinMessageContent(content: unknown): string {
  // OpenAI互換: content が string の場合が多いが、配列（マルチモーダル）もあり得る
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => {
        if (!p) return "";
        if (typeof p === "string") return p;
        if (typeof p !== "object") return "";
        // いろいろな互換実装で `type` が無かったり、`text` だけが入っていることがある
        const text = typeof (p as any).text === "string" ? (p as any).text : "";
        if (text) return text;
        const type = (p as any).type;
        if (type === "text") return typeof (p as any).text === "string" ? (p as any).text : "";
        return "";
      })
      .join("");
  }
  return "";
}

function isDeveloperInstructionNotEnabled(raw: string): boolean {
  // プロバイダ/モデルによって表現が揺れるので、system/developer ロール拒否の代表パターンを広めに拾う
  return (
    /Developer instruction is not enabled/i.test(raw) ||
    /system (role|message)/i.test(raw) ||
    /unsupported.*system/i.test(raw) ||
    /role.*system.*(not supported|invalid|unsupported)/i.test(raw) ||
    /cannot use.*system/i.test(raw)
  );
}

function joinSystemIntoUser(system: string, user: string): string {
  // system roleが使えないモデル向けの互換：system指示を user の先頭に埋め込む
  return `【指示】\n${system}\n\n【入力】\n${user}`;
}

export async function generateOpenRouterAdvancedReply(args: {
  message: string;
  context: ChatContext;
  headers: Headers;
  model?: string;
}): Promise<ChatResponseBody> {
  const apiKey = sanitizeApiKey(process.env.OPENROUTER_API_KEY ?? "");
  if (!apiKey) {
    throw new Error("OPENROUTER_API_KEY is not set");
  }

  const ip = pickIp(args.headers);
  if (!allowAdvanced(ip)) {
    throw new Error("OpenRouter rate limited");
  }

  const model = pickModel(args.model);
  const key = cacheKey({ model, message: args.message, context: args.context });
  const cached = advancedCache.get(key);
  if (cached) return cached;

  const { system, user } = buildPrompt({ message: args.message, context: args.context });

  const siteUrl = sanitizeEnvValue(process.env.OPENROUTER_SITE_URL ?? "");
  const appName = sanitizeEnvValue(process.env.OPENROUTER_APP_NAME ?? "");

  const url = "https://openrouter.ai/api/v1/chat/completions";

  const runOnce = async (retry: boolean, mode: "system+user" | "userOnly") => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20_000);
    try {
      const messages =
        mode === "system+user"
          ? [
              { role: "system", content: system },
              { role: "user", content: user }
            ]
          : [{ role: "user", content: joinSystemIntoUser(system, user) }];

      const res = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          authorization: `Bearer ${apiKey}`,
          ...(siteUrl ? { "HTTP-Referer": siteUrl } : {}),
          ...(appName ? { "X-Title": appName } : {})
        },
        body: JSON.stringify({
          model,
          messages,
          temperature: retry ? 0.2 : 0.4,
          max_tokens: retry ? 900 : 700
        }),
        signal: controller.signal
      });

      if (!res.ok) {
        if (res.status === 402) {
          const t = await res.text().catch(() => "");
          throw new OpenRouterPaymentRequiredError(
            `OpenRouterの支払い/上限により拒否されました（402）。` + (t ? ` ${clamp(t, 220)}` : "")
          );
        }
        if (res.status === 429) {
          const ra = res.headers.get("retry-after");
          const retryAfterSeconds = ra ? Number.parseInt(ra, 10) : Number.NaN;
          const seconds = Number.isFinite(retryAfterSeconds) ? retryAfterSeconds : null;
          throw new OpenRouterRateLimitError("OpenRouter API failed: 429 Too Many Requests", seconds);
        }
        const t = await res.text().catch(() => "");
        throw new Error(`OpenRouter API failed: ${res.status} ${res.statusText} ${clamp(t, 220)}`);
      }

      const json = (await res.json()) as {
        choices?: Array<{
          message?: { content?: unknown };
        }>;
      };
      const content = json.choices?.[0]?.message?.content;
      const text = joinMessageContent(content);
      // たまに provider が「成功(200)だけど本文が空」を返すことがある。
      // その場合はAI成功扱いにするとユーザーには意味不明なので、エラーにして上位（Gemini等）へフォールバックさせる。
      if (!text.trim()) {
        throw new Error("OpenRouter returned empty completion");
      }
      const parsed = parseStructuredJson(text);
      const formatted = parsed ? formatReplyFromParsed(parsed) : null;
      return { formatted, rawText: text };
    } finally {
      clearTimeout(timeout);
    }
  };

  // 1) 通常モード（system+user）
  try {
    const first = await runOnce(false, "system+user");
    if (first.formatted) {
      const out: ChatResponseBody = {
        ...first.formatted,
        sources: args.context.items.slice(0, 1).map((i) => ({ title: i.title, url: i.url }))
      };
      out.meta = { ...(out.meta ?? { mode: "advanced", provider: "openrouter", fallback: false }), model };
      advancedCache.set(key, out);
      return out;
    }

    const second = await runOnce(true, "system+user");
    if (second.formatted) {
      const out: ChatResponseBody = {
        ...second.formatted,
        sources: args.context.items.slice(0, 1).map((i) => ({ title: i.title, url: i.url }))
      };
      out.meta = { ...(out.meta ?? { mode: "advanced", provider: "openrouter", fallback: false }), model };
      advancedCache.set(key, out);
      return out;
    }

    // JSONが崩れた場合の救済：まずは壊れたJSONから要素を抽出して整形、ダメなら生テキスト。
    const raw = first.rawText || second.rawText || "";
    const loose = formatReplyFromLooseJsonLikeText(raw);
    if (loose) {
      const out: ChatResponseBody = {
        ...loose,
        sources: args.context.items.slice(0, 1).map((i) => ({ title: i.title, url: i.url }))
      };
      out.meta = { ...(out.meta ?? { mode: "advanced", provider: "openrouter", fallback: false }), model };
      advancedCache.set(key, out);
      return out;
    }
    // 壊れたJSONをそのまま返すとUIが崩れるので、上位でフォールバックさせる
    throw new Error("AIの応答形式（JSON）が崩れました。");
  } catch (e) {
    // 2) system roleが弾かれるモデル向け：userOnly で再試行
    const msg = e instanceof Error ? e.message : "";
    if (isDeveloperInstructionNotEnabled(msg)) {
      const first = await runOnce(false, "userOnly");
      const parsed = parseStructuredJson(first.rawText);
      const formatted = parsed ? formatReplyFromParsed(parsed) : null;
      const loose = formatted ? null : formatReplyFromLooseJsonLikeText(first.rawText);
      const out: ChatResponseBody = formatted
        ? {
            ...formatted,
            sources: args.context.items.slice(0, 1).map((i) => ({ title: i.title, url: i.url }))
          }
        : loose
          ? {
              ...loose,
              sources: args.context.items.slice(0, 1).map((i) => ({ title: i.title, url: i.url }))
            }
        : (() => {
            // 壊れたJSONをそのまま返さない（上位でフォールバックさせる）
            throw new Error("AIの応答形式（JSON）が崩れました。");
          })();
      out.meta = { ...(out.meta ?? { mode: "advanced", provider: "openrouter", fallback: false }), model };
      advancedCache.set(key, out);
      return out;
    }
    throw e;
  }
}

