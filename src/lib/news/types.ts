export type NewsItem = {
  id: string;
  title: string;
  url: string;
  publishedAt: string | null;
  source: string | null;
  summary: string;
  /**
   * 記事本文から抽出した抜粋（取得できた場合のみ）。
   * - 取得できない/ブロックされる/有料記事等の場合は undefined
   */
  content?: string;
};

export type NewsResponse =
  | {
      teamId: string;
      teamName: string;
      items: NewsItem[];
    }
  | {
      errorCode: "INVALID_TEAM" | "FETCH_FAILED" | "PARSE_FAILED";
      message: string;
    };

