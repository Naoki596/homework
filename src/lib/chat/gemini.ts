import { TTLCache } from "@src/lib/cache/ttlCache";
import { GLOSSARY } from "@src/lib/chat/glossary";
import { GEMINI_ALLOWED_MODELS } from "@src/lib/chat/geminiModels";

import type { ChatContext, ChatResponseBody } from "./types";

// ---------------------------------------------------------------------------
// Error classes
// ---------------------------------------------------------------------------

export class GeminiRateLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GeminiRateLimitError";
  }
}

export class GeminiBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GeminiBlockedError";
  }
}

// ---------------------------------------------------------------------------
// Rate limiting (IP-based, 3 req/min for free tier)
// ---------------------------------------------------------------------------

type RateState = { windowStartMs: number; count: number };

const rateByIp = new Map<string, RateState>();

function allowRequest(ip: string): boolean {
  const windowMs = 60_000;
  const limit = 3;
  const now = Date.now();
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

// ---------------------------------------------------------------------------
// Cache (120s TTL — longer than OpenRouter to conserve free quota)
// ---------------------------------------------------------------------------

const geminiCache = new TTLCache<ChatResponseBody>(120 * 1000);

function cacheKey(args: { model: string; message: string; context: ChatContext }): string {
  const titles = args.context.items.map((i) => i.title).join("|");
  return `gemini:${args.model}:${args.context.teamId ?? ""}:${args.message.replace(/\s+/g, " ").trim()}:${titles}`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sanitizeEnvValue(raw: string): string {
  return raw.replace(/\u0000/g, "").replace(/\uFEFF/g, "").trim().replace(/^["']|["']$/g, "");
}

function sanitizeApiKey(raw: string): string {
  return sanitizeEnvValue(raw).replace(/[^\x21-\x7E]/g, "");
}

function pickIp(headers: Headers): string {
  const xfwd = headers.get("x-forwarded-for");
  if (xfwd) return xfwd.split(",")[0]?.trim() || "unknown";
  const xreal = headers.get("x-real-ip");
  if (xreal) return xreal.trim();
  return "unknown";
}

function clampForPrompt(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (!t) return "";
  return t.length <= max ? t : t.slice(0, max).trimEnd() + "…";
}

function pickModel(requested: string | undefined): string {
  const req = typeof requested === "string" ? requested.trim() : "";
  if (req && GEMINI_ALLOWED_MODELS.includes(req)) return req;
  return GEMINI_ALLOWED_MODELS[0] ?? "gemini-2.5-flash";
}

// ---------------------------------------------------------------------------
// System prompt (natural conversation, not JSON)
// ---------------------------------------------------------------------------

function buildSystemInstruction(context: ChatContext): string {
  const glossaryEntries = GLOSSARY.slice(0, 15)
    .map((e) => `- ${e.term}: ${e.explain}`)
    .join("\n");

  return (
    "あなたは日本のプロ野球（NPB）ニュースに詳しい解説アシスタントです。\n" +
    "ユーザーが選んでいる球団の最新ニュースについて、分かりやすく自然な日本語で会話してください。\n\n" +
    "## ルール\n" +
    "- 提供されたニュース記事の情報をもとに回答してください。\n" +
    "- 本文抜粋が無い場合は、タイトルと要約だけで分かる範囲で答え、推測は明示してください。\n" +
    "- ニュースに関係ない一般的な野球の質問にも答えて構いません。\n" +
    "- 回答は簡潔に（200〜400文字目安）。\n" +
    "- 出典URLがある場合は最後に案内してください。\n" +
    "- JSON形式では返さず、自然な文章で返してください。\n\n" +
    `## 現在の球団: ${context.teamName ?? context.teamId ?? "未選択"}\n\n` +
    "## 野球用語集（参考）\n" +
    glossaryEntries
  );
}

function buildUserContent(message: string, context: ChatContext): string {
  const items = context.items.slice(0, 5);
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
                it.content ? `content: ${clampForPrompt(it.content, 900)}` : "content: （本文未取得）",
                `url: ${it.url}`,
              ].join("\n")
          )
          .join("\n\n");

  return `ユーザーの質問: ${message}\n\nニュース（最大5件）:\n${itemsText}`;
}

// ---------------------------------------------------------------------------
// Gemini API call
// ---------------------------------------------------------------------------

export async function generateGeminiReply(args: {
  message: string;
  context: ChatContext;
  headers: Headers;
  model?: string;
}): Promise<ChatResponseBody> {
  const apiKey = sanitizeApiKey(process.env.GEMINI_API_KEY ?? "");
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is not set");
  }

  const ip = pickIp(args.headers);
  if (!allowRequest(ip)) {
    throw new GeminiRateLimitError("Gemini rate limited");
  }

  const model = pickModel(args.model);
  const key = cacheKey({ model, message: args.message, context: args.context });
  const cached = geminiCache.get(key);
  if (cached) return cached;

  const systemInstruction = buildSystemInstruction(args.context);
  const userContent = buildUserContent(args.message, args.context);

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25_000);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify({
        system_instruction: {
          parts: [{ text: systemInstruction }],
        },
        contents: [
          {
            role: "user",
            parts: [{ text: userContent }],
          },
        ],
        generationConfig: {
          temperature: 0.7,
          maxOutputTokens: 1024,
        },
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const errorText = await res.text().catch(() => "");
      if (res.status === 429) {
        throw new GeminiRateLimitError(
          `Gemini API rate limited (429). ${errorText.slice(0, 200)}`
        );
      }
      throw new Error(`Gemini API failed: ${res.status} ${res.statusText} ${errorText.slice(0, 300)}`);
    }

    const json = (await res.json()) as {
      candidates?: Array<{
        content?: { parts?: Array<{ text?: string }> };
        finishReason?: string;
      }>;
      promptFeedback?: { blockReason?: string };
    };

    // Check for safety blocking
    if (json.promptFeedback?.blockReason) {
      throw new GeminiBlockedError(
        `安全フィルタによりブロックされました（${json.promptFeedback.blockReason}）`
      );
    }

    const candidate = json.candidates?.[0];
    if (candidate?.finishReason === "SAFETY") {
      throw new GeminiBlockedError("安全フィルタにより応答がブロックされました");
    }

    const replyText = candidate?.content?.parts
      ?.map((p) => p.text ?? "")
      .join("")
      .trim();

    if (!replyText) {
      throw new Error("Gemini returned empty response");
    }

    const sources = args.context.items
      .slice(0, 5)
      .filter((i) => i.url)
      .map((i) => ({ title: i.title, url: i.url }));

    const result: ChatResponseBody = {
      reply: replyText,
      sources,
      meta: { mode: "advanced", provider: "gemini", fallback: false, model },
    };

    geminiCache.set(key, result);
    return result;
  } finally {
    clearTimeout(timeout);
  }
}
