import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { NextResponse } from "next/server";

import { getTeam } from "@src/teams";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const EXTENSIONS = [".png", ".webp", ".jpg", ".jpeg", ".svg"] as const;

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
    return NextResponse.json({ error: "teamId or name is required" }, { status: 400 });
  }

  const hit = await findLogoFile(baseName);
  if (!hit) {
    return NextResponse.json({ error: "logo not found" }, { status: 404 });
  }

  const buf = await fs.readFile(hit.filePath);
  return new NextResponse(buf, {
    status: 200,
    headers: {
      "Content-Type": contentTypeForExt(hit.ext),
      // ローカルファイル前提なので強キャッシュは避ける（ただし同一セッション内は軽く効かせる）
      "Cache-Control": "public, max-age=0, s-maxage=3600"
    }
  });
}

