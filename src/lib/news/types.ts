export type NewsItem = {
  id: string;
  title: string;
  url: string;
  publishedAt: string | null;
  source: string | null;
  summary: string;
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

