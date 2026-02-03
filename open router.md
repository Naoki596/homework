## OpenRouter 実装設計（現状構成に合わせた差し替え）

このドキュメントは、現在の構成（`app/api/chat/route.ts` + `app/components/ChatDock.tsx` + `src/lib/chat/*`）を前提に、**Gemini連携を OpenRouter に置き換える**ための設計メモです。  
狙いは「最短で動かす」＋「モデル選択UIで複数LLMを切り替えられる」＋「コスト/安全面のガードを入れる」です。

---

### 0. 現状（前提の整理）

- **APIルート**: `POST /api/chat`（`app/api/chat/route.ts`）
  - いまは `generateGeminiAdvancedReply(...)` を最初に試し、失敗時は `buildChatReply(...)`（ルールベース）へフォールバック。
- **フロント**: `app/components/ChatDock.tsx`
  - `fetch("/api/chat", ...)` で `{ message, context }` を送る。
- **型**: `src/lib/chat/types.ts`
  - `ChatRequestBody = { message: string; context?: ChatContext }`
  - `ChatResponseBody.meta.provider = "rule" | "gemini"`

---

### 1. ゴール / 非ゴール

- **ゴール**
  - **`/api/chat` の「高度解説」を OpenRouter 経由に差し替え**る（UI/呼び出し元は極力変えない）。
  - **モデル選択UI**を `ChatDock` に追加し、選択したモデルで応答できるようにする。
  - OpenRouterが失敗した場合は、現状と同様に**ルールベースへフォールバック**してチャットが止まらないようにする。
  - **コスト暴走・任意モデル指定**を防ぐため、**サーバ側で許可モデルを制限**する。

- **非ゴール（まずはやらない）**
  - ストリーミング（SSE）対応（後から追加できる設計にはする）
  - DBに会話履歴保存（現状どおりクライアントのstateでOK）
  - OpenRouterのモデル一覧を動的取得して常に最新に追従（まずは固定のallowlistで運用）

---

### 2. 方式：既存の `/api/chat` を OpenRouter に置き換える

#### 2.1 変更方針（最短で置き換える）

- `app/api/chat/route.ts` の `generateGeminiAdvancedReply(...)` 呼び出しを、
  - 新規の `generateOpenRouterAdvancedReply(...)` に置き換える
- 失敗時のフォールバック（`buildChatReply(...)`）は現状維持
- `ChatResponseBody.meta.provider` は `"openrouter"` を追加する（型を更新）

#### 2.2 新しい責務の分割（おすすめ）

- `src/lib/chat/openrouter.ts`
  - OpenRouter 呼び出し（HTTP）
  - 返答のJSON抽出/整形（Gemini版と同等）
  - レート制限・短時間キャッシュ（Gemini版の作りを踏襲）
- `app/api/chat/route.ts`
  - リクエストバリデーション（JSON parse）
  - OpenRouter呼び出し → 成功なら返す
  - 失敗ならルールベースにフォールバックして返す

---

### 3. API設計（`POST /api/chat`）

#### 3.1 リクエスト（拡張）

現状:

- `ChatRequestBody = { message: string; context?: ChatContext }`

モデル選択を入れるため、**後方互換**に `model?: string` を追加する（指定が無ければサーバ側でデフォルトモデルを使う）。

- **提案**: `ChatRequestBody = { message: string; context?: ChatContext; model?: string }`

リクエスト例:

```json
{
  "message": "1のキーワードを教えて",
  "context": {
    "teamId": "tigers",
    "teamName": "阪神タイガース",
    "items": [{ "title": "...", "url": "...", "summary": "...", "publishedAt": "...", "source": "..." }]
  },
  "model": "anthropic/claude-3.5-sonnet"
}
```

#### 3.2 レスポンス（meta拡張）

現状:

- `meta.provider = "rule" | "gemini"`

OpenRouter差し替え後:

- **提案**: `meta.provider = "rule" | "openrouter"`
  - 将来さらに増やす可能性があるなら `provider: "rule" | "openrouter" | "gemini"` としておき、Geminiは削除しない運用でもOK

成功時の例:

```json
{
  "reply": "要点（AI・短縮）: ...\n\n重要キーワード:\n- ...",
  "keywords": [{ "term": "FA", "reason": "AI抽出（重要度:high）", "explain": "..." }],
  "sources": [{ "title": "...", "url": "..." }],
  "meta": { "mode": "advanced", "provider": "openrouter", "fallback": false }
}
```

失敗→フォールバック時の例（現状踏襲）:

```json
{
  "reply": "（通常解説）...\n\n※AI解説は現在利用できないため通常解説で返しました。\n（原因: ...）",
  "meta": { "mode": "basic", "provider": "rule", "fallback": true }
}
```

---

### 4. OpenRouter 呼び出し仕様（サーバ側）

#### 4.1 環境変数（`.env.local`）

（重要）**APIキーは絶対にGitにコミットしない**。既に `.env.local` に実キーが入っている場合、公開済みの可能性があるので**キーの再発行/無効化**を推奨。

- **必須**
  - `OPENROUTER_API_KEY=...`
- **推奨（デフォルトモデル）**
  - `OPENROUTER_DEFAULT_MODEL=anthropic/claude-3.5-sonnet`（例。好きな既定に）
- **推奨（OpenRouterの推奨ヘッダ）**
  - `OPENROUTER_SITE_URL=http://localhost:3000`（本番は自サイトURL）
  - `OPENROUTER_APP_NAME=npb-news-chat`（任意のアプリ名）

#### 4.2 エンドポイント/互換API

OpenRouterは OpenAI互換の Chat Completions 形式で呼べる前提で設計する。

- **URL**: `https://openrouter.ai/api/v1/chat/completions`
- **Authorization**: `Bearer ${OPENROUTER_API_KEY}`
- **推奨ヘッダ**
  - `HTTP-Referer: ${OPENROUTER_SITE_URL}`
  - `X-Title: ${OPENROUTER_APP_NAME}`

#### 4.3 送信するプロンプト（現状Geminiの思想を踏襲）

`src/lib/chat/gemini.ts` の `buildPrompt(...)` と同等の内容でOK。

- **System**
  - 「NPBニュースの解説者」
  - 「参照できるのはRSSの title/summary/url のみ」
  - 「推測で事実を作らない・断定しない」
  - 「必ずJSONのみで返す（前後に文章を付けない）」
- **User**
  - `球団: ...`
  - `ユーザーの質問: ...`
  - `ニュース（最大3件）: ...`

#### 4.4 JSONで返させる方法（壊れやすいので設計で対策）

OpenRouter経由の各モデルは、**JSON厳守の安定度がモデルごとに異なる**。

- **基本方針**
  - まずは強い指示（「JSONだけ」「前後に文字を付けない」）＋温度低めで実装
  - 受け取り側は「```json の除去」「最初の `{` と最後の `}` を拾う」などの**JSON抽出ロジック**を入れる
  - 1回目が壊れたら「temperatureを下げる」などで**軽いリトライ（最大2回）**
  - それでも壊れたらフォールバック（現状のUXを崩さない）

（実装上は、Gemini版にある `stripMarkdownCodeFences / extractJsonFromText` 相当を共通化すると楽）

---

### 5. サーバ側の安全ガード（モデル選択を許しつつ、暴走を防ぐ）

#### 5.1 許可モデルリスト（Allowlist）

クライアントから `model` を受け取ってそのままOpenRouterに渡すと、**高額モデル指定**などができて危険です。  
なのでサーバ側で `ALLOWED_OPENROUTER_MODELS` を持ち、そこにあるものだけ通す。

- **設計**
  - `src/lib/chat/openrouterModels.ts`（または `src/lib/chat/openrouter.ts` 内）に固定配列で定義
  - `model` 未指定なら `OPENROUTER_DEFAULT_MODEL`
  - `model` が allowlist になければ、デフォルトに丸める or 400（どちらでも良いが、まずは丸めるとUXが滑らか）

#### 5.2 レート制限（IP単位）

Gemini版にある `allowAdvanced(ip)` の仕組みを踏襲してOK。

- 例: **1分あたり5回**（いまの `gemini.ts` と同じ）
- 429はOpenRouter側でも返るので、両方で守るイメージ

#### 5.3 短時間キャッシュ

Gemini版の `TTLCache` を踏襲。

- 例: 同一 `message + context`（＋選択model）なら **60秒キャッシュ**

---

### 6. UI設計：モデル選択UI（`ChatDock` に追加）

#### 6.1 UIの置き場所

`ChatDock` のヘッダ領域（タイトルの近く）に、以下を追加するのが最小変更。

- **モデル選択 `<select>`**
  - 例: `モデル: [おすすめ ▼]`
- **現在のモデル表示**
  - サブタイトル行に `選択モデル: ...` を出す（長いモデルIDは省略表示）

#### 6.2 状態設計（クライアント）

`ChatDock.tsx` に以下の状態を追加する。

- `selectedModel: string`
  - 初期値: `localStorage` に保存があればそれ、なければ `"default"`（UI用の疑似値） or 先頭モデル
  - 送信時: `body: { message, context, model: selectedModel }`

永続化:

- `localStorage.setItem("chat:model", selectedModel)`
- 文脈（球団/ニュース）が変わってもモデルは維持する（ユーザー好みのため）

#### 6.3 モデル一覧の供給方法（2案）

- **案A（最短）: フロントに固定配列**
  - `const MODELS = [...]` を `ChatDock.tsx` に書く
  - ただしサーバ側にも同じ allowlist を持つ（重複するが最短）

- **案B（おすすめ）: サーバが返す**
  - `GET /api/chat/models` を追加し、許可モデル一覧を返す
  - `ChatDock` は起動時に `fetch("/api/chat/models")` して `<select>` を構築
  - **メリット**: allowlistの単一管理（サーバが正）

最短で進めるなら案AでもOK。長期的には案Bが管理しやすいです。

---

### 7. 変更が入る型/ファイル一覧（この順で手を入れると安全）

- `src/lib/chat/types.ts`
  - `ChatRequestBody` に `model?: string` を追加
  - `ChatResponseBody.meta.provider` に `"openrouter"` を追加
- `src/lib/chat/openrouter.ts`（新規）
  - `generateOpenRouterAdvancedReply({ message, context, headers, model })`
- `app/api/chat/route.ts`
  - `generateGeminiAdvancedReply` → `generateOpenRouterAdvancedReply` に置換
  - `meta.provider` を `openrouter` に
  - 失敗時メッセージは現状踏襲（原因文言だけOpenRouter向けに調整）
- `app/components/ChatDock.tsx`
  - `selectedModel` stateの追加
  - `<select>` 追加
  - `fetch("/api/chat")` のbodyに `model` を追加
  - quotaNote を OpenRouter前提の文言に変更（例: 「モデルにより料金/制限が異なります」）

---

### 8. エラーハンドリング方針（ユーザーに見せる文言）

`/api/chat` では「失敗しても200でフォールバック返信」は現状と同じ（UX優先）。

- **OpenRouterの典型**
  - 401/403: APIキー設定ミス → フォールバックしつつ「設定を確認」系のメッセージ
  - 429: 混雑/制限 → フォールバックしつつ「少し待って」系
  - タイムアウト: フォールバックしつつ「回線/混雑」系

返信末尾の注記（現状の形式）:

- `※AI解説は現在利用できないため通常解説で返しました。`
- `（原因: ...）`

---

### 9. （任意）将来の拡張：ストリーミング対応の余地

後で SSE にする場合でも、モデル選択やallowlistの方針はそのまま流用できる。

- `POST /api/chat/stream` を新設
- `ChatDock` は `ReadableStream` を読み取り、逐次表示

---

### 10. 運用メモ（重要）

- **キー漏洩対策**
  - OpenRouterのAPIキーは必ずサーバ側のみで利用（クライアントに渡さない）
  - `.env.local` を gitignore に含める（通常は含まれているが念のため確認）
- **コスト対策**
  - サーバ側allowlist必須
  - デフォルトモデルは「安い/速い」寄りを推奨
  - 1分あたりの回数制限＋短時間キャッシュで無駄打ちを減らす

---

### 11. トラブルシューティング（今回実際に起きたもの）

この章は「症状（画面に出る原因文）→原因→対処」を、今回の実装で実際に遭遇したものに絞ってまとめます。

#### 11.1 `Nullish coalescing operator(??) requires parens when mixing with logical operators`

- **原因**: `??` と `||` を同じ式で混ぜた（例: `a ?? b || c`）。JS/TSの仕様で括弧が必須。
- **対処**: 括弧を入れて意図を明示する。
  - 例: `return (a ?? b) || c;`
- **該当**: `src/lib/chat/openrouter.ts` の `pickModel(...)`

#### 11.2 `OPENROUTER_API_KEY is not set`

- **原因**: `.env.local` に `OPENROUTER_API_KEY` が無い / 反映前（サーバ再起動してない）。
- **対処**:
  - OpenRouterでAPIキーを作成
  - `.env.local` に `OPENROUTER_API_KEY=...` を追加
  - 開発サーバ再起動（環境変数は起動時に読む）

#### 11.3 `... is not a valid model ID`（例: `google/gemini-2.0-flash is not a valid model ID`）

- **原因**: OpenRouter上のモデルIDが間違っている。
- **対処**:
  - OpenRouterのモデルページ/ドキュメントで正しいIDを確認して、allowlistを修正
  - 例: `google/gemini-2.0-flash-001` のように **末尾のバージョンが必要**なことがある
- **該当**: `src/lib/chat/openrouterModels.ts`

#### 11.4 `402 Payment Required` / `API key USD spend limit exceeded`

- **原因**: OpenRouter側で「このAPIキーの利用上限（spend limit）」に達した/0に設定されている等で拒否されている。
  - `:free` モデルでも、OpenRouter側のキー設定や運用状況により 402 が返ることがある。
- **対処**:
  - OpenRouterダッシュボードで「そのAPIキーの spend limit」や Billing/Credits を確認
  - アプリ側は **Geminiへ自動フォールバック**できるようにしてUXを守る（本実装では対応）

#### 11.5 `Developer instruction is not enabled for models/...`

- **原因**: 一部モデル/提供元で `role:"system"`（開発者指示/システム指示）が受け付けられず 400 になる。
- **対処（互換対応）**:
  - `system` を送れないモデルでは、system内容を `user` の先頭に結合して送る（`userOnly` モード）
  - もしくは、そのモデルを候補から外す（free運用ではこちらも有効）
- **該当**: `src/lib/chat/openrouter.ts`

#### 11.6 `AIの応答形式（JSON）が崩れました。`

- **原因**: モデルが「JSONだけ返す」指示を守れず、サーバ側で `JSON.parse` できなかった。
  - freeモデルは特に「JSON厳守」が苦手な場合がある。
- **対処（UX優先）**:
  - JSONにできない場合でも **生テキストをそのまま返す**（AIが返ってきたなら表示する）
  - それでも空なら、別プロバイダへフォールバック（Gemini等）
- **該当**:
  - OpenRouter: `src/lib/chat/openrouter.ts`
  - Gemini: `src/lib/chat/gemini.ts`

#### 11.7 `（AI解説）応答を作れませんでした。`（OpenRouterで空返答）

- **原因**: OpenRouterが 200 を返しても `choices[0].message.content` が空/欠落しているケースがある（提供元側の挙動）。
- **対処**:
  - 空ならエラー扱いにして、上位（Gemini等）へフォールバックする
- **該当**: `src/lib/chat/openrouter.ts`

#### 11.8 「どれを選んでも失敗する」時の切り分け手順（最短）

- **手順**
  - UIで **AI=Gemini** に固定して1回試す（Geminiキーや回数制限の問題か確認）
  - UIで **AI=OpenRouter** に固定して1回試す（OpenRouterキー/上限/モデル互換の問題か確認）
  - **AI=自動** に戻す（最終的に「どちらか生きていれば返る」状態を作る）
- **見るべき場所**
  - `.env.local`: `GEMINI_API_KEY`, `OPENROUTER_API_KEY`
  - `src/lib/chat/openrouterModels.ts`: モデルID/候補（allowlist）
  - `app/api/chat/route.ts`: フォールバック順序（autoの優先）

np,