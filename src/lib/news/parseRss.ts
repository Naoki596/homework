import Parser from "rss-parser";

export type ParsedFeedItem = {
  title?: string;
  link?: string;
  isoDate?: string;
  pubDate?: string;
  creator?: string;
  contentSnippet?: string;
  content?: string;
};

export type ParsedFeed = {
  items: ParsedFeedItem[];
};

// 余計なxml2jsオプションで形が崩れると、itemsが読めず0件扱いになりうるためデフォルトで扱う
const parser = new Parser();

export async function parseRssXml(xml: string): Promise<ParsedFeed> {
  const feed = (await parser.parseString(xml)) as unknown as {
    items?: unknown;
  };

  const items = Array.isArray(feed.items) ? (feed.items as ParsedFeedItem[]) : [];
  return { items };
}

