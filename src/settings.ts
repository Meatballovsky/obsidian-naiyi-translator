export type EngineId = "google" | "microsoft" | "ai";

export type OrbPosition = "right-middle" | "left-middle" | "custom";

export interface AiEndpointSettings {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Free-form system prompt. Supports {{targetLang}} and {{sourceLang}}. */
  systemPrompt: string;
  /** User prompt template. Supports {{input}} and {{targetLang}}. */
  userPrompt: string;
  temperature: number;
  /** Chain of thought buys nothing for translation and doubles local latency. */
  disableThinking: boolean;
  /** Local models can spend tens of seconds loading before the first token. */
  timeoutMs: number;
}

export interface TranslatorSettings {
  engine: EngineId;
  sourceLang: string;
  targetLang: string;

  /** IntersectionObserver rootMargin preload band in px. */
  preloadMarginPx: number;
  /** Max simultaneous in-flight requests (token bucket capacity). */
  requestCapacity: number;
  /** Token refill per second. */
  requestRate: number;
  /** Max paragraphs joined into one AI/microsoft batch request. */
  maxItemsPerBatch: number;
  /** Max characters joined into one batch request. */
  maxCharsPerBatch: number;
  requestTimeoutMs: number;
  maxRetries: number;

  minCharactersPerNode: number;
  minWordsPerNode: number;

  enableCache: boolean;
  cacheTtlDays: number;
  cacheMaxEntries: number;

  showOrb: boolean;
  orbOpacity: number;
  orbPosition: OrbPosition;
  orbCustomX: number | null;
  orbCustomY: number | null;
  autoTranslateOnSelect: boolean;

  /** Render translation as Markdown (AI engines return formatted output). */
  renderMarkdown: boolean;
  ai: AiEndpointSettings;
}

export const DEFAULT_AI_SYSTEM_PROMPT = `You are a professional {{targetLang}} native translator who needs to fluently translate text into {{targetLang}}.

## Translation Rules
1. Output only the translated content, without explanations or additional content.
2. The returned translation must maintain exactly the same number of paragraphs and the same Markdown formatting as the original text.
3. For content that should not be translated (proper nouns, code, identifiers, file paths), keep the original text.
4. Keep Markdown link syntax [text](url) intact; translate only the link text.
5. Keep inline math $...$ and $$...$$ blocks unchanged.`;

export const DEFAULT_AI_USER_PROMPT = `Translate the following into {{targetLang}}:

{{input}}`;

export const DEFAULT_SETTINGS: TranslatorSettings = {
  engine: "google",
  sourceLang: "auto",
  targetLang: "zh-CN",

  preloadMarginPx: 600,
  requestCapacity: 4,
  requestRate: 2,
  maxItemsPerBatch: 4,
  maxCharsPerBatch: 1000,
  requestTimeoutMs: 20000,
  maxRetries: 2,

  minCharactersPerNode: 0,
  minWordsPerNode: 0,

  enableCache: true,
  cacheTtlDays: 7,
  cacheMaxEntries: 1000,

  showOrb: true,
  orbOpacity: 0.35,
  orbPosition: "right-middle",
  orbCustomX: null,
  orbCustomY: null,
  autoTranslateOnSelect: false,

  renderMarkdown: true,
  ai: {
    baseUrl: "http://127.0.0.1:11434/v1",
    apiKey: "",
    model: "qwen2.5:7b",
    systemPrompt: DEFAULT_AI_SYSTEM_PROMPT,
    userPrompt: DEFAULT_AI_USER_PROMPT,
    temperature: 0.2,
    disableThinking: true,
    timeoutMs: 90000,
  },
};

/** Separator line used to join multiple paragraphs into one AI request. */
export const BATCH_SEPARATOR = "%%";
