"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import type { NewsItem } from "@src/lib/news/types";

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
  items: Array<Pick<NewsItem, "title" | "url" | "summary" | "publishedAt" | "source">>;
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
  const quotaNote = "Gemini無料枠目安: 1日20回（RPD=20）/ 1分5回（RPM=5）";
  const [messages, setMessages] = useState<ChatMessage[]>(() => [
    {
      id: uid(),
      role: "system",
      createdAt: nowIso(),
      text:
        "チャットへようこそ。\n" +
        "例）「1のキーワードを教えて」「2を短く要約して」\n" +
        "※この記事の本文は取得していないので、RSSの要点（抜粋）をもとに案内します。"
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
        body: JSON.stringify({ message: text, context })
      });
      const data = (await res.json()) as { reply?: string };
      const replyText = typeof data.reply === "string" ? data.reply : "応答の解析に失敗しました。";
      setMessages((prev) => [
        ...prev,
        { id: uid(), role: "assistant", createdAt: nowIso(), text: replyText }
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
              placeholder='例）"1のキーワードを教えて"'
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

