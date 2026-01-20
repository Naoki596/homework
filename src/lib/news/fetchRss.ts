export async function fetchRssXml(
  url: string,
  options?: { timeoutMs?: number }
): Promise<string> {
  const timeoutMs = options?.timeoutMs ?? 6000;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        "user-agent":
          "Mozilla/5.0 (compatible; NPBNewsSnippetApp/0.1; +https://localhost)",
        accept: "application/rss+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.1"
      },
      signal: controller.signal,
      cache: "no-store"
    });
    if (!res.ok) {
      throw new Error(`RSS fetch failed: ${res.status} ${res.statusText}`);
    }
    return await res.text();
  } finally {
    clearTimeout(timeout);
  }
}

