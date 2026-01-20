const BASIC_ENTITY_MAP: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&nbsp;": " "
};

function decodeHtmlEntities(input: string): string {
  let out = input.replace(/&(amp|lt|gt|quot|nbsp);|&#39;/g, (m) => BASIC_ENTITY_MAP[m] ?? m);

  // &#NNN; / &#xHHH;
  out = out.replace(/&#(\d+);/g, (_, dec: string) => {
    const code = Number(dec);
    if (!Number.isFinite(code)) return _;
    try {
      return String.fromCodePoint(code);
    } catch {
      return _;
    }
  });
  out = out.replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => {
    const code = Number.parseInt(hex, 16);
    if (!Number.isFinite(code)) return _;
    try {
      return String.fromCodePoint(code);
    } catch {
      return _;
    }
  });
  return out;
}

export function stripHtml(input: string): string {
  // Preserve <br> as spaces, then drop tags.
  const brNormalized = input.replace(/<\s*br\s*\/?\s*>/gi, " ");
  const noTags = brNormalized.replace(/<[^>]*>/g, " ");
  return decodeHtmlEntities(noTags);
}

export function normalizeWhitespace(input: string): string {
  return input.replace(/\s+/g, " ").trim();
}

export function formatSummary(
  raw: string | null | undefined,
  options?: { maxChars?: number }
): string {
  if (!raw) return "要点を取得できませんでした";
  const maxChars = options?.maxChars ?? 240;
  const cleaned = normalizeWhitespace(stripHtml(raw));
  if (!cleaned) return "要点を取得できませんでした";
  if (cleaned.length <= maxChars) return cleaned;
  return cleaned.slice(0, maxChars).trimEnd() + "…";
}

