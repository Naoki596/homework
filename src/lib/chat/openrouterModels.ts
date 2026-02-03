export type OpenRouterModelOption = { id: string; label: string };

/**
 * サーバ側 allowlist の正本として使う前提のモデル一覧。
 * クライアント（モデル選択UI）でもこの配列を使えば、表示とサーバ検証がズレにくい。
 *
 * 注意: モデルの提供状況/価格/無料枠は変動します。ここは「運用したい候補」に絞るのが安全です。
 */
export const OPENROUTER_MODEL_OPTIONS: OpenRouterModelOption[] = [
  // 「無料だけ」にしたい場合は、OpenRouterの Free Variant（`:free`）のみを列挙する。
  // 参考: https://openrouter.ai/collections/free-models / https://openrouter.ai/docs/features/variants/free
  // できるだけ「system role」を受け付けやすいモデルを優先（モデル/提供元によってはsystemが弾かれる）
  { id: "openai/gpt-oss-20b:free", label: "gpt-oss 20B（free / そこそこ軽量）" },
  { id: "meta-llama/llama-3.3-70b-instruct:free", label: "Llama 3.3 70B Instruct（free / 高品質）" }
];

export const OPENROUTER_ALLOWED_MODELS = OPENROUTER_MODEL_OPTIONS.map((m) => m.id);

