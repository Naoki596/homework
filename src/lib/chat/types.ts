import type { NewsItem } from "@src/lib/news/types";

export type ChatContext = {
  teamId: string | null;
  teamName: string | null;
  items: Array<Pick<NewsItem, "title" | "url" | "summary" | "publishedAt" | "source">>;
};

export type ChatRequestBody = {
  message: string;
  context?: ChatContext;
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
    provider: "rule" | "gemini";
    fallback: boolean;
  };
};

