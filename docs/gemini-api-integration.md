# Gemini API 導入: チャットボットの自由対話化

## 概要

チャットボットの AI プロバイダとして Google Gemini API（無料枠）を導入し、自然な日本語で自由に対話できるようにした。
従来の OpenRouter（JSON形式応答）はそのまま残し、Gemini をデフォルトプロバイダに変更。

### 変更前

- OpenRouter 経由で無料LLMを使用
- 応答は **JSON形式のみ**（要約・キーワード・注意点）
- 決まった質問パターンにしか対応できない

### 変更後

- **Gemini がデフォルト** — 自然な日本語で自由に対話可能
- OpenRouter は選択肢として残存（切替可能）
- ユーザーが「このニュースについて詳しく教えて」「ドラフトの仕組みは？」など自由に質問できる

---

## 変更ファイル一覧

| ファイル | 操作 | 変更内容 |
|---|---|---|
| `src/lib/chat/types.ts` | 修正 | `provider` 型に `"gemini"` を追加 |
| `src/lib/chat/geminiModels.ts` | 新規作成 | Gemini モデル選択肢の定義 |
| `src/lib/chat/gemini.ts` | 新規作成 | Gemini API 呼び出し・システムプロンプト・レート制限・キャッシュ |
| `app/api/chat/route.ts` | 修正 | Gemini ルーティング追加・エラーハンドリング追加 |
| `app/components/ChatDock.tsx` | 修正 | Gemini プロバイダ選択UI・モデル切替・メッセージ更新 |
| `app/page.tsx` | 修正 | ニュース取得時に記事本文も取得するよう変更 |

**変更していないファイル**: `openrouter.ts`, `openrouterModels.ts`, `reply.ts`, `safeJson.ts`, `glossary.ts`, `keywords.ts`, `ttlCache.ts`

---

## 各ファイルの詳細

### 1. `src/lib/chat/types.ts`

- `ChatRequestBody.provider` に `"gemini"` を追加: `"auto" | "openrouter" | "gemini"`
- `ChatResponseBody.meta.provider` に `"gemini"` を追加: `"rule" | "openrouter" | "gemini"`

### 2. `src/lib/chat/geminiModels.ts`（新規）

Gemini のモデル選択肢とサーバ側 allowlist を定義。

- `gemini-2.5-flash` — 推奨・無料
- `gemini-2.0-flash` — 無料

### 3. `src/lib/chat/gemini.ts`（新規・コア）

既存の `openrouter.ts` と同じパターンで実装。

| 項目 | 内容 |
|---|---|
| API エンドポイント | `https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent` |
| 認証 | `x-goog-api-key` ヘッダーに `GEMINI_API_KEY` 環境変数を使用 |
| レート制限 | IP単位 3リクエスト/分（無料枠に配慮、OpenRouter の 5/分より保守的） |
| キャッシュ | TTLCache 120秒（OpenRouter の 60秒より長め、無料枠節約） |
| タイムアウト | AbortController 25秒 |
| エラークラス | `GeminiRateLimitError`, `GeminiBlockedError` |

#### システムプロンプト

NPB ニュース解説アシスタントとして、以下のルールで自然な日本語で応答する:

- 提供されたニュース記事の情報をもとに回答
- 本文抜粋が無い場合はタイトル・要約から分かる範囲で回答（推測は明示）
- 野球の一般的な質問にも対応
- 200〜400文字目安の簡潔な回答
- 出典URLを案内
- **JSON形式ではなく自然な文章で返す**
- 野球用語集（glossary.ts から15件）をコンテキストとして付与

#### レスポンス処理

Gemini は自然文テキストを返すため、JSON パースは不要。`ChatResponseBody.reply` に直接セット。

### 4. `app/api/chat/route.ts`

- `generateGeminiReply` と Gemini エラークラスを import
- ルーティング変更:
  - `provider === "openrouter"` → 既存の OpenRouter 処理（変更なし）
  - `provider === "gemini"` または `provider === "auto"` → **Gemini を呼ぶ**
- catch ブロックに Gemini 固有エラーメッセージを追加:
  - `GeminiRateLimitError` → 「利用制限に達しました」
  - `GeminiBlockedError` → 「安全フィルタによりブロック」
  - `GEMINI_API_KEY is not set` → 「APIキー未設定」

### 5. `app/components/ChatDock.tsx`

- `GEMINI_MODEL_OPTIONS` を import
- `provider` state の型に `"gemini"` を追加
- プロバイダ選択ドロップダウン: `自動（Gemini・推奨）` / `Gemini` / `OpenRouter`
- モデル選択: プロバイダに応じて Gemini / OpenRouter のモデル一覧を切替表示
- `send()`: 全プロバイダでモデルIDを送信
- localStorage: `"gemini"` を正しく復元
- ウェルカムメッセージ・placeholder を自由対話向けに更新

### 6. `app/page.tsx`

ニュース取得時に記事本文も取得するよう変更。

- **変更箇所**: `fetchNews` 内の `fetch` URLに `&withContent=1` を追加
- **変更前**: `/api/news?teamId=...` — タイトルと要約のみ取得
- **変更後**: `/api/news?teamId=...&withContent=1` — 記事本文（最大2200文字）も取得

#### 背景

Gemini に渡されるニュース情報は `gemini.ts` の `buildUserContent()` で組み立てられ、記事本文は最大900文字まで含められる。
しかし、フロントエンドが `withContent=1` を付けずにニュース取得していたため、`content` フィールドが常に未取得（`undefined`）であり、Gemini には `（本文未取得）` として渡されていた。

この変更により、記事本文が取得・送信されるようになり、Gemini が記事の中身を読んだ上で回答できるようになった。

#### トレードオフ

- ニュース読み込みが **2〜4秒ほど遅くなる**（各記事のHTMLを取得・パースするため）
- 回答の質は大幅に向上する（タイトル・要約だけでなく本文の情報も使える）

---

## 環境変数

`.env.local` に以下を追加する必要がある:

```
GEMINI_API_KEY=your-gemini-api-key-here
```

Google AI Studio（https://aistudio.google.com/apikey）から無料で取得可能。

---

## 検証手順

1. `.env.local` に `GEMINI_API_KEY` を設定
2. `npm run dev` でローカル起動
3. チームを選択してニュースを取得
4. チャットで自由な質問を送信（例: 「このニュースについて詳しく教えて」「ドラフトの仕組みは？」）
5. 自然な日本語で応答が返ることを確認
6. プロバイダを「OpenRouter」に切り替え → 従来のJSON形式応答が返ることを確認
7. 連続送信 → レート制限メッセージ + ルールベースフォールバックを確認
