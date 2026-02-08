export type GeminiModelOption = { id: string; label: string };

export const GEMINI_MODEL_OPTIONS: GeminiModelOption[] = [
  { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash（推奨・無料）" },
  { id: "gemini-2.0-flash", label: "Gemini 2.0 Flash（無料）" },
];

export const GEMINI_ALLOWED_MODELS = GEMINI_MODEL_OPTIONS.map((m) => m.id);
