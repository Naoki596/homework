"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import type { NewsItem } from "@src/lib/news/types";
import { OPENROUTER_MODEL_OPTIONS } from "@src/lib/chat/openrouterModels";
import { GEMINI_MODEL_OPTIONS } from "@src/lib/chat/geminiModels";
import type { ChatResponseBody } from "@src/lib/chat/types";

type ChatRole = "user" | "assistant" | "system";

type ChatMessage = {
  id: string;
  role: ChatRole;
  text: string;
  createdAt: string;
};

type ChatContext = {
  teamId: string | null;
  teamName: string | null;
  items: Array<Pick<NewsItem, "title" | "url" | "summary" | "publishedAt" | "source" | "content">>;
};

function uid(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(16).slice(2)}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

function buildContextLabel(ctx: ChatContext): string {
  const team = ctx.teamName ?? ctx.teamId ?? "未選択";
  const count = ctx.items.length;
  return `${team} / ${count}件`;
}

function renderItemsList(items: ChatContext["items"]): string {
  if (items.length === 0) return "（ニュースがまだ取得されていません）";
  return items
    .slice(0, 10)
    .map((it, i) => `${i + 1}. ${it.title}`)
    .join("\n");
}

export function ChatDock(props: { context: ChatContext }) {
  const { context } = props;
  const [isOpen, setIsOpen] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [input, setInput] = useState("");
  const quotaNote = "AI: 自動/指定ともにプロバイダ間フォールバックなし（失敗時は通常解説）";
  const defaultModel = GEMINI_MODEL_OPTIONS[0]?.id ?? "gemini-2.5-flash";
  const [selectedModel, setSelectedModel] = useState<string>(defaultModel);
  const [provider, setProvider] = useState<"auto" | "openrouter" | "gemini">("auto");
  const [messages, setMessages] = useState<ChatMessage[]>(() => [
    {
      id: uid(),
      role: "system",
      createdAt: nowIso(),
      text:
        "チャットへようこそ！\n" +
        "ニュースについて自由に質問できます。\n" +
        "例）「このニュースについて詳しく教えて」「ドラフトの仕組みは？」"
    }
  ]);

  const logRef = useRef<HTMLDivElement | null>(null);
  const ctxKey = useMemo(() => {
    const titles = context.items.map((i) => i.title).join("|");
    return `${context.teamId ?? ""}::${titles}`;
  }, [context.teamId, context.items]);
  const lastCtxKeyRef = useRef<string | null>(null);

  useEffect(() => {
    // 文脈（球団/ニュース）が変わったら、システムメッセージで一覧を出す
    if (lastCtxKeyRef.current === ctxKey) return;
    lastCtxKeyRef.current = ctxKey;
    setMessages((prev) => [
      ...prev,
      {
        id: uid(),
        role: "system",
        createdAt: nowIso(),
        text: `現在の文脈: ${buildContextLabel(context)}\n\nニュース一覧:\n${renderItemsList(context.items)}`
      }
    ]);
  }, [ctxKey, context]);

  useEffect(() => {
    if (!isOpen) return;
    const el = logRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [isOpen, messages]);

  useEffect(() => {
    // 好みのモデルを永続化（UIだけの話で、最終的な検証はサーバ側allowlistで行う）
    try {
      const saved = window.localStorage.getItem("chat:model");
      if (
        saved &&
        (GEMINI_MODEL_OPTIONS.some((m) => m.id === saved) ||
          OPENROUTER_MODEL_OPTIONS.some((m) => m.id === saved))
      ) {
        setSelectedModel(saved);
      }
    } catch {
      // no-op
    }
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem("chat:model", selectedModel);
    } catch {
      // no-op
    }
  }, [selectedModel]);

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem("chat:provider");
      if (saved === "auto" || saved === "openrouter" || saved === "gemini") {
        setProvider(saved);
      }
    } catch {
      // no-op
    }
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem("chat:provider", provider);
    } catch {
      // no-op
    }
  }, [provider]);

  async function send() {
    const text = input.trim();
    if (!text) return;
    setInput("");
    const userMsg: ChatMessage = { id: uid(), role: "user", createdAt: nowIso(), text };
    setMessages((prev) => [...prev, userMsg]);

    setIsSending(true);
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({
          message: text,
          context,
          provider,
          model: provider === "auto" || provider === "gemini" || provider === "openrouter"
            ? selectedModel
            : undefined
        })
      });
      const data = (await res.json()) as ChatResponseBody;
      const replyText = typeof data.reply === "string" ? data.reply : "応答の解析に失敗しました。";
      const metaNote =
        data?.meta?.provider
          ? `\n\n（AI: ${data.meta.provider}${data.meta.model ? ` / ${data.meta.model}` : ""}${
              data.meta.fallback ? " / fallback" : ""
            }）`
          : "";
      setMessages((prev) => [
        ...prev,
        { id: uid(), role: "assistant", createdAt: nowIso(), text: `${replyText}${metaNote}` }
      ]);
    } catch {
      setMessages((prev) => [
        ...prev,
        {
          id: uid(),
          role: "system",
          createdAt: nowIso(),
          text: "通信に失敗しました。時間をおいて再試行してください。"
        }
      ]);
    } finally {
      setIsSending(false);
    }
  }

  return (
    <div className={`chatDock ${isOpen ? "chatDockOpen" : ""}`} aria-label="チャット">
      <div className="chatDockHeader">
        <div className="chatDockTitle">
          <div className="chatDockTitleText">チャット</div>
          <div className="chatDockSubtitle">{buildContextLabel(context)}</div>
          <div className="chatDockQuota">{quotaNote}</div>
          <div style={{ marginTop: 6, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <label htmlFor="chatProviderSelect" style={{ color: "var(--muted)", fontSize: 12 }}>
              AI
            </label>
            <select
              id="chatProviderSelect"
              value={provider}
              onChange={(e) => {
                const v = e.target.value as "auto" | "openrouter" | "gemini";
                setProvider(v);
                // プロバイダ切替時にモデルも合わせる
                if (v === "openrouter") {
                  setSelectedModel(OPENROUTER_MODEL_OPTIONS[0]?.id ?? "openai/gpt-4o-mini");
                } else {
                  setSelectedModel(GEMINI_MODEL_OPTIONS[0]?.id ?? "gemini-2.5-flash");
                }
              }}
              style={{ padding: "6px 8px", borderRadius: 8 }}
              aria-label="利用するAIプロバイダ"
            >
              <option value="auto">自動（Gemini・推奨）</option>
              <option value="gemini">Gemini</option>
              <option value="openrouter">OpenRouter</option>
            </select>

            <label htmlFor="chatModelSelect" style={{ color: "var(--muted)", fontSize: 12 }}>
              モデル
            </label>
            <select
              id="chatModelSelect"
              value={selectedModel}
              onChange={(e) => setSelectedModel(e.target.value)}
              style={{ padding: "6px 8px", borderRadius: 8 }}
              aria-label="利用するAIモデル"
            >
              {(provider === "openrouter" ? OPENROUTER_MODEL_OPTIONS : GEMINI_MODEL_OPTIONS).map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          </div>
        </div>
        <button
          type="button"
          className="chatDockToggle"
          onClick={() => setIsOpen((v) => !v)}
          aria-expanded={isOpen}
        >
          {isOpen ? "閉じる" : "開く"}
        </button>
      </div>

      {isOpen ? (
        <>
          <div className="chatLog" ref={logRef}>
            {messages.map((m) => (
              <div
                key={m.id}
                className={`chatRow ${
                  m.role === "user" ? "chatRowUser" : m.role === "assistant" ? "chatRowAssistant" : "chatRowSystem"
                }`}
              >
                <div className="chatBubble">{m.text}</div>
              </div>
            ))}
          </div>

          <div className="chatInputRow">
            <textarea
              className="chatInput"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="ニュースについて自由に質問してください"
              rows={2}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
              }}
            />
            <button type="button" className="chatSend" onClick={() => void send()} disabled={isSending}>
              {isSending ? "送信中…" : "送信"}
            </button>
          </div>
        </>
      ) : null}
    </div>
  );
}

