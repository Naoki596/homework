/**
 * 壊れがちな「AIが返すJSON」をできるだけ安全にパースするためのユーティリティ。
 *
 * 典型的な壊れ方:
 * - ```json ... ``` のコードフェンスが付く
 * - 前後に説明文が混ざる（JSON以外のテキスト）
 * - JSON文字列内に生改行が混ざって JSON.parse できない
 * - 末尾カンマ（trailing comma）
 */

export type SafeJsonResult =
  | { ok: true; value: unknown }
  | { ok: false; reason: string; candidate?: string };

function stripMarkdownCodeFences(text: string): string {
  return text.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
}

function extractBracedObject(text: string): string | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < 0 || end <= start) return null;
  return text.slice(start, end + 1);
}

/**
 * JSON文字列内の生改行を \\n に変換する（JSONとしての妥当性を回復させるため）。
 * - ダブルクォートで囲まれた文字列のみ対象
 * - エスケープ \" は考慮
 */
function escapeNewlinesInsideStrings(candidate: string): string {
  let out = "";
  let inString = false;
  let escaped = false;

  for (let i = 0; i < candidate.length; i++) {
    const ch = candidate[i] ?? "";

    if (escaped) {
      out += ch;
      escaped = false;
      continue;
    }

    if (ch === "\\") {
      out += ch;
      escaped = true;
      continue;
    }

    if (ch === '"') {
      out += ch;
      inString = !inString;
      continue;
    }

    if (inString) {
      if (ch === "\r") continue;
      if (ch === "\n") {
        out += "\\n";
        continue;
      }
    }

    out += ch;
  }

  return out;
}

function removeTrailingCommas(candidate: string): string {
  // 文字列内の ,} を誤置換する可能性は低いがゼロではない。
  // 先に改行問題を直してから、軽めに適用する。
  return candidate.replace(/,\s*([}\]])/g, "$1");
}

export function safeParseAiJson(rawText: string): SafeJsonResult {
  const stripped = stripMarkdownCodeFences(rawText);
  const candidate = extractBracedObject(stripped) ?? stripped;
  if (!candidate.trim()) return { ok: false, reason: "empty" };

  // 1) そのまま
  try {
    return { ok: true, value: JSON.parse(candidate) as unknown };
  } catch {
    // continue
  }

  // 2) 改行修復 + 末尾カンマ削除
  const repaired = removeTrailingCommas(escapeNewlinesInsideStrings(candidate));
  try {
    return { ok: true, value: JSON.parse(repaired) as unknown };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "parse failed";
    return { ok: false, reason: msg, candidate: repaired };
  }
}

