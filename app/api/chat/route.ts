import { NextResponse } from "next/server";

import { buildChatReply } from "@src/lib/chat/reply";
import type { ChatRequestBody, ChatResponseBody } from "@src/lib/chat/types";
import {
  OpenRouterPaymentRequiredError,
  OpenRouterRateLimitError,
  generateOpenRouterAdvancedReply
} from "@src/lib/chat/openrouter";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  let body: ChatRequestBody | null = null;
  try {
    body = (await req.json()) as ChatRequestBody;
  } catch {
    const res: ChatResponseBody = { reply: "リクエスト形式が不正です（JSONを解析できませんでした）。" };
    return NextResponse.json(res, { status: 400 });
  }

  // AI解説を試み、失敗時はルールベースへフォールバックする
  try {
    const message = body?.message ?? "";
    const context = body?.context ?? { teamId: null, teamName: null, items: [] };
    const provider = body?.provider ?? "auto";

    if (provider === "openrouter") {
      // OpenRouter指定時は、他プロバイダへはフォールバックしない（ユーザーの指定を尊重）
      const advanced = await generateOpenRouterAdvancedReply({
        message,
        context,
        headers: req.headers,
        model: body?.model
      });
      if (!advanced.meta) advanced.meta = { mode: "advanced", provider: "openrouter", fallback: false };
      return NextResponse.json(advanced, { status: 200 });
    }

    // auto: いずれかへ自動切替は行わない（プロバイダ間フォールバック禁止）
    const advanced = await generateOpenRouterAdvancedReply({ message, context, headers: req.headers, model: body?.model });
    if (!advanced.meta) advanced.meta = { mode: "advanced", provider: "openrouter", fallback: false };
    return NextResponse.json(advanced, { status: 200 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown error";
    const fallback = buildChatReply({ message: body?.message, context: body?.context });
    const pretty = (() => {
      if (e instanceof OpenRouterPaymentRequiredError) {
        return "OpenRouterの支払い/上限設定によりAIが利用できませんでした（402）。OpenRouter側のキー上限（spend limit）や残高を確認してください。";
      }
      if (e instanceof OpenRouterRateLimitError) {
        const sec = e.retryAfterSeconds;
        if (typeof sec === "number" && sec > 0) {
          return `OpenRouterの利用制限（429）に達しました。約${sec}秒待ってから再試行してください。`;
        }
        return "OpenRouterの利用制限（429）に達しました。1〜2分ほど待ってから再試行してください。";
      }
      if (msg === "This operation was aborted") {
        return "AIの通信がタイムアウトしました（回線/混雑の可能性）。";
      }
      return msg;
    })();
    return NextResponse.json(
      {
        ...fallback,
        reply:
          `${fallback.reply}\n\n` +
          `※AI解説は現在利用できないため通常解説で返しました。\n` +
          `（原因: ${pretty}）`,
        meta: { mode: "basic", provider: "rule", fallback: true }
      } satisfies ChatResponseBody,
      { status: 200 }
    );
  }
}

