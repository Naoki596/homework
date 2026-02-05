import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { NextResponse } from "next/server";

import { getTeam } from "@src/teams";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const EXTENSIONS = [".png", ".webp", ".jpg", ".jpeg", ".svg"] as const;
const NO_STORE_HEADERS = { "Cache-Control": "no-store" } as const;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function contentTypeForExt(ext: string): string {
  switch (ext.toLowerCase()) {
    case ".png":
      return "image/png";
    case ".webp":
      return "image/webp";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".svg":
      return "image/svg+xml";
    default:
      return "application/octet-stream";
  }
}

function sanitizeBaseName(input: string): string {
  // ファイル名として安全な範囲に丸める（ディレクトリトラバーサル対策）
  return input.replace(/[\\/]/g, "").replace(/\.\./g, "").trim().slice(0, 120);
}

function logoDirCandidates(): string[] {
  const envDir = process.env.TEAM_LOGO_DIR?.trim();
  const home = os.homedir();
  return [
    ...(envDir ? [envDir] : []),
    path.join(process.cwd(), "team-logos"),
    // ワークスペースに `12球団ロゴ/` が含まれている場合（homework の隣に置く運用）
    path.resolve(process.cwd(), "..", "12球団ロゴ"),
    // リポジトリ直下に置いた場合
    path.resolve(process.cwd(), "12球団ロゴ"),
    path.join(home, "OneDrive", "画像", "ドキュメント", "12球団ロゴ"),
    path.join(home, "OneDrive", "Documents", "12球団ロゴ")
  ];
}

async function findLogoFile(baseNameRaw: string): Promise<{ filePath: string; ext: string } | null> {
  const baseName = sanitizeBaseName(baseNameRaw);
  if (!baseName) return null;

  for (const dir of logoDirCandidates()) {
    for (const ext of EXTENSIONS) {
      const filePath = path.join(dir, `${baseName}${ext}`);
      try {
        await fs.access(filePath);
        return { filePath, ext };
      } catch {
        // not found
      }
    }
  }
  return null;
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const teamId = url.searchParams.get("teamId");
  const name = url.searchParams.get("name");

  const team = teamId ? getTeam(teamId) : null;
  const baseName = team?.name ?? name;

  if (!baseName) {
    return NextResponse.json({ error: "teamId or name is required" }, { status: 400, headers: NO_STORE_HEADERS });
  }

  const hit = await findLogoFile(baseName);
  if (!hit) {
    return NextResponse.json({ error: "logo not found" }, { status: 404, headers: NO_STORE_HEADERS });
  }

  let buf: Buffer;
  try {
    buf = await fs.readFile(hit.filePath);
  } catch (e) {
    // OneDrive等で一瞬ロックされるケースを軽くリトライ
    const code = (e as { code?: string } | null)?.code;
    if (code === "EBUSY" || code === "EPERM" || code === "EACCES") {
      await sleep(80);
      buf = await fs.readFile(hit.filePath);
    } else {
      throw e;
    }
  }
  // NextResponse の body は Web 標準の BodyInit を期待するため、
  // Node の Buffer を Uint8Array に変換して返す（型エラー回避 + 互換性確保）
  const body = new Uint8Array(buf);
  return new NextResponse(body, {
    status: 200,
    headers: {
      "Content-Type": contentTypeForExt(hit.ext),
      ...NO_STORE_HEADERS
    }
  });
}

