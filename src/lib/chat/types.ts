import type { NewsItem } from "@src/lib/news/types";

export type ChatContext = {
  teamId: string | null;
  teamName: string | null;
  items: Array<Pick<NewsItem, "title" | "url" | "summary" | "publishedAt" | "source" | "content">>;
};

export type ChatRequestBody = {
  message: string;
  context?: ChatContext;
  /**
   * 利用するAIプロバイダ（任意）。
   * - "auto": サーバ側のデフォルト（現在はOpenRouter）を使う
   * - "openrouter": OpenRouter を使う
   */
  provider?: "auto" | "openrouter";
  /**
   * クライアント側のモデル選択（任意）。
   * サーバ側で allowlist により検証・丸め込みを行うこと。
   */
  model?: string;
};

export type ChatKeyword = {
  term: string;
  reason: string;
  explain?: string;
};

export type ChatSource = { title: string; url: string };

export type ChatResponseBody = {
  reply: string;
  keywords?: ChatKeyword[];
  sources?: ChatSource[];
  meta?: {
    mode: "basic" | "advanced";
    provider: "rule" | "openrouter";
    fallback: boolean;
    /**
     * 利用したモデルID（分かる範囲で）。
     * - OpenRouter: "vendor/model(:variant)" 形式
     */
    model?: string;
  };
};

