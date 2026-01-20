# NPBニュース（球団別・直近3件）

NPB 12球団から1球団を選ぶと、GoogleニュースRSSから **直近ニュースを最大3件** 取得し、RSSの **snippet（抜粋）を整形して要点表示**するWebアプリです。  
（APIキー不要・無料運用想定）

## できること

- 12球団の選択（クリック/キーボード操作）
- 選択球団のニュースを新しい順に最大3件表示
- snippetの整形（HTML除去・空白正規化・文字数上限）
- 重複ニュースの除外（URL優先、なければタイトル）
- 取得失敗時のエラー表示 + 再試行導線
- 簡易キャッシュ（TTL 5分）

## 技術

- Next.js（App Router）+ TypeScript
- Route Handler（`GET /api/news`）でRSS取得→JSON化
- RSSパース: `rss-parser`

## セットアップ

### 前提

- Node.js（推奨: 18以上）

### 手順

```bash
npm install
npm run dev
```

起動後、ブラウザで `http://localhost:3000` を開いてください。

## API

- `GET /api/news?teamId={teamId}`
  - 任意: `limit`（既定3、上限10）

### 例

`/api/news?teamId=tigers`

## 主要ファイル

- `app/page.tsx`: 単一ページUI（球団選択 + 結果表示）
- `app/api/news/route.ts`: RSS取得→整形→重複排除→最大3件
- `src/teams.ts`: 12球団マスタ（クエリ候補含む）
- `src/lib/news/*`: RSS取得/パース/整形
- `src/lib/cache/ttlCache.ts`: TTLキャッシュ

