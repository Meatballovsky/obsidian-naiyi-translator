export type LangCode = "zh" | "zh-tw" | "en";

export function getLanguage(): LangCode {
  try {
    const raw = (
      (typeof window !== "undefined" && window.localStorage?.getItem("language")) ||
      // @ts-ignore
      (typeof moment !== "undefined" && typeof moment.locale === "function" ? moment.locale() : "") ||
      (typeof navigator !== "undefined" && navigator.language) ||
      "en"
    ).toLowerCase();

    if (raw.includes("tw") || raw.includes("hk") || raw.includes("hant")) {
      return "zh-tw";
    }
    if (raw.startsWith("zh")) {
      return "zh";
    }
  } catch {
    // fallback
  }
  return "en";
}

const STRINGS = {
  zh: {
    // Header
    pluginTitle: "奈译屋 · Naiyi Translate",
    pluginSubtitle: "看似 Simple，实则深厚 —— 助你谈笑阅览外文文献的极简翻译助手",

    // Engine
    engineHeading: "翻译引擎",
    engineSelect: "当前引擎",
    engineDesc: "选择当前阅读视图使用的翻译服务",
    probeEngine: "连通性测试",
    probeEngineDesc: "向当前配置的引擎发送一个测试句子以校验网络连通性",
    probing: "正在测试连通性…",
    probeSuccess: "引擎测试成功",
    probeFailed: "引擎测试失败",

    // Style
    styleHeading: "排版与译文样式",
    translationStyle: "译文渲染样式",
    translationStyleDesc: "选择就地插入段落下方时的视觉排版风格",
    styleCard: "文字底纹 (灰/奶白底纹，沿用原文排版)",
    styleQuote: "引用边线 (经典段落左侧边线)",
    styleMinimal: "极简弱化 (无底纹虚线分割)",

    // Languages
    langHeading: "语言配置",
    sourceLang: "源语言",
    targetLang: "目标语言",
    autoDetect: "自动检测 (Auto)",

    // AI Endpoint
    aiHeading: "自定义 AI 端点",
    aiBaseUrl: "服务地址 (Base URL)",
    aiBaseUrlDesc: "兼容 OpenAI 格式接口。支持本地 127.0.0.1 直连（Ollama、OMLX、LM Studio 等），无 CORS 限制",
    aiModel: "模型名称 (Model)",
    aiFetchModels: "拉取模型列表",
    aiFetchModelsDesc: "从上方服务地址读取 /v1/models 可选模型",
    aiPickModel: "快速选取模型",
    aiApiKey: "API 密钥 (API Key)",
    aiApiKeyDesc: "本地模型无需填写；云端中转需填。仅加密保存在本地笔记库 data.json",
    aiTemperature: "采样温度 (Temperature)",
    aiDisableThinking: "关闭思考链 (Disable CoT)",
    aiDisableThinkingDesc: "传递 reasoning_effort=none。翻译任务无需思考链，关闭可降低一半延迟",
    aiTimeout: "AI 请求超时 (毫秒)",
    aiTimeoutDesc: "本地模型初次请求存在加载开销，此超时与免费网络引擎隔离计算",
    systemPrompt: "系统提示词 (System prompt)",
    systemPromptDesc: "可用占位符：{{targetLang}} {{sourceLang}}",
    userPrompt: "用户提示词 (User prompt)",
    userPromptDesc: "可用占位符：{{input}} {{targetLang}}",

    // Requests
    requestsHeading: "流量调度与防限流",
    preloadBand: "视口预取边界 (像素)",
    preloadBandDesc: "超出当前可是可视窗口多远时触发静默预加载",
    requestCapacity: "最大并发请求数",
    requestCapacityDesc: "令牌桶容量。免费公共端点建议保持较小值以避免 429 限流",
    requestRate: "每秒请求补充率",
    requestRateDesc: "令牌桶恢复速率",
    batchItems: "单批聚合段落数",
    batchItemsDesc: "Microsoft Edge 与 AI 引擎生效；Google 不支持批量聚合",
    batchChars: "单批字符上限",
    requestTimeout: "单段请求超时 (毫秒)",
    maxRetries: "常规故障重试次数",

    // Filtering
    filterHeading: "段落过滤",
    minChars: "段落最小字符数",
    minWords: "段落最小词数",

    // Cache
    cacheHeading: "本地持久化缓存",
    enableCache: "启用翻译缓存",
    enableCacheDesc: "基于内容哈希的 LRU + 7天 TTL 磁盘缓存，重复阅读 0 流量消耗",
    cacheTtl: "缓存过期天数 (TTL)",
    cacheMax: "最大缓存条数",
    clearCache: "清空本地缓存",
    clearCacheDesc: "清空当前笔记库保存在 data.json 中的所有翻译条目",
    cacheCleared: "本地翻译缓存已清空",

    // Orb
    orbHeading: "交互悬浮球",
    showOrb: "显示阅读视图悬浮球",
    showOrbDesc: "在阅读视图边缘常驻快速操作青蛙徽章",
    orbOpacity: "静止透明度",
    orbPosition: "停靠位置",
    posRightMiddle: "右侧居中",
    posLeftMiddle: "左侧居中",
    posCustom: "自定义拖拽位置",
    autoTranslateSelect: "划选自动翻译",
    autoTranslateSelectDesc: "在阅读视图中选中段落即自动触发翻译",

    // Markdown
    mdHeading: "Markdown 语法",
    renderMd: "以 Markdown 格式渲染译文",
    renderMdDesc: "保留译文中的加粗、行内代码、链接等排版格式",

    // Orb Menu Actions
    orbToggle: "全文双语翻译",
    orbSelection: "仅译选中段落",
    orbStop: "停止翻译",
    orbClear: "清除所有译文",

    // Commands
    cmdToggle: "全文双语对照翻译",
    cmdSelection: "仅翻译选中段落",
    cmdClear: "清除所有注入译文",
    cmdCycle: "快速轮换翻译引擎",
    engineSwitched: "当前翻译引擎已切换为：",
  },

  "zh-tw": {
    // Header
    pluginTitle: "奈譯屋 · Naiyi Translate",
    pluginSubtitle: "看似 Simple，實則深厚 —— 助你談笑閱覽外文文獻的極簡翻譯助手",

    // Engine
    engineHeading: "翻譯引擎",
    engineSelect: "當前引擎",
    engineDesc: "選擇當前閱讀視圖使用的翻譯服務",
    probeEngine: "連通性測試",
    probeEngineDesc: "向當前配置的引擎發送一個測試句子以校驗網絡連通性",
    probing: "正在測試連通性…",
    probeSuccess: "引擎測試成功",
    probeFailed: "引擎測試失敗",

    // Style
    styleHeading: "排版與譯文樣式",
    translationStyle: "譯文渲染樣式",
    translationStyleDesc: "選擇就地插入段落下方時的視覺排版風格",
    styleCard: "文字底紋 (灰/奶白底紋，沿用原文排版)",
    styleQuote: "引用邊線 (經典段落左側邊線)",
    styleMinimal: "極簡弱化 (無底紋虛線分割)",

    // Languages
    langHeading: "語言配置",
    sourceLang: "源語言",
    targetLang: "目標語言",
    autoDetect: "自動檢測 (Auto)",

    // AI Endpoint
    aiHeading: "自定義 AI 端點",
    aiBaseUrl: "服務地址 (Base URL)",
    aiBaseUrlDesc: "兼容 OpenAI 格式接口。支持本地 127.0.0.1 直連（Ollama、OMLX、LM Studio 等），無 CORS 限制",
    aiModel: "模型名稱 (Model)",
    aiFetchModels: "獲取模型列表",
    aiFetchModelsDesc: "從上方服務地址讀取 /v1/models 可選模型",
    aiPickModel: "快速選取模型",
    aiApiKey: "API 金鑰 (API Key)",
    aiApiKeyDesc: "本地模型無需填寫；雲端中轉需填。僅加密保存在當前庫 data.json",
    aiTemperature: "採樣溫度 (Temperature)",
    aiDisableThinking: "關閉思考鏈 (Disable CoT)",
    aiDisableThinkingDesc: "傳遞 reasoning_effort=none。翻譯任務無需思考鏈，關閉可降低一半延遲",
    aiTimeout: "AI 請求超時 (毫秒)",
    aiTimeoutDesc: "本地模型初次請求存在加載開銷，此超時與免費網絡引擎隔離計算",
    systemPrompt: "系統提示詞 (System prompt)",
    systemPromptDesc: "可用佔位符：{{targetLang}} {{sourceLang}}",
    userPrompt: "用戶提示詞 (User prompt)",
    userPromptDesc: "可用佔位符：{{input}} {{targetLang}}",

    // Requests
    requestsHeading: "流量調度與防限流",
    preloadBand: "視口預取邊界 (像素)",
    preloadBandDesc: "超出當前可視窗口多遠時觸發靜默預加載",
    requestCapacity: "最大併發請求數",
    requestCapacityDesc: "令牌桶容量。免費公共端點建議保持較小值以避免 429 限流",
    requestRate: "每秒請求補充率",
    requestRateDesc: "令牌桶恢復速率",
    batchItems: "單批聚合段落數",
    batchItemsDesc: "Microsoft Edge 與 AI 引擎生效；Google 不支持批量聚合",
    batchChars: "單批字符上限",
    requestTimeout: "單段請求超時 (毫秒)",
    maxRetries: "常規故障重試次數",

    // Filtering
    filterHeading: "段落過濾",
    minChars: "段落最小字符數",
    minWords: "段落最小詞數",

    // Cache
    cacheHeading: "本地持久化緩存",
    enableCache: "啟用翻譯緩存",
    enableCacheDesc: "基於內容哈希的 LRU + 7天 TTL 磁盤緩存，重複閱讀 0 流量消耗",
    cacheTtl: "緩存過期天數 (TTL)",
    cacheMax: "最大緩存條數",
    clearCache: "清空本地緩存",
    clearCacheDesc: "清空當前筆記庫保存在 data.json 中的所有翻譯條目",
    cacheCleared: "本地翻譯緩存已清空",

    // Orb
    orbHeading: "交互懸浮球",
    showOrb: "顯示閱讀視圖懸浮球",
    showOrbDesc: "在閱讀視圖邊緣常駐快速操作青蛙徽章",
    orbOpacity: "靜止透明度",
    orbPosition: "停靠位置",
    posRightMiddle: "右側居中",
    posLeftMiddle: "左側居中",
    posCustom: "自定義拖拽位置",
    autoTranslateSelect: "劃選自動翻譯",
    autoTranslateSelectDesc: "在閱讀視圖中選中段落即自動觸發翻譯",

    // Markdown
    mdHeading: "Markdown 語法",
    renderMd: "以 Markdown 格式渲染譯文",
    renderMdDesc: "保留譯文中的加粗、行內代碼、鏈接等排版格式",

    // Orb Menu Actions
    orbToggle: "全文雙語翻譯",
    orbSelection: "僅譯選中段落",
    orbStop: "停止翻譯",
    orbClear: "清除所有譯文",

    // Commands
    cmdToggle: "全文雙語對照翻譯",
    cmdSelection: "僅翻譯選中段落",
    cmdClear: "清除所有注入譯文",
    cmdCycle: "快速輪換翻譯引擎",
    engineSwitched: "當前翻譯引擎已切換為：",
  },

  en: {
    // Header
    pluginTitle: "Naiyi Translate (奈译屋)",
    pluginSubtitle: "A minimal and rapid translation assistant for seamless reading in Obsidian.",

    // Engine
    engineHeading: "Translation Engine",
    engineSelect: "Translation engine",
    engineDesc: "Choose the active translation provider",
    probeEngine: "Probe engine",
    probeEngineDesc: "Sends one short sentence to the active engine and verifies connectivity",
    probing: "Probing engine…",
    probeSuccess: "Probe succeeded",
    probeFailed: "Probe failed",

    // Style
    styleHeading: "Appearance & Style",
    translationStyle: "Translation style",
    translationStyleDesc: "How translated text is rendered beneath original paragraphs",
    styleCard: "Text shading (ReadFrog background, original typography)",
    styleQuote: "Blockquote border (Classic left accent border)",
    styleMinimal: "Minimal unbordered (Dashed divider)",

    // Languages
    langHeading: "Languages",
    sourceLang: "Source language",
    targetLang: "Target language",
    autoDetect: "Auto detect",

    // AI Endpoint
    aiHeading: "Custom AI Endpoint",
    aiBaseUrl: "Base URL",
    aiBaseUrlDesc: "Any OpenAI-compatible server. Local endpoints work on 127.0.0.1 directly without CORS preflight",
    aiModel: "Model",
    aiFetchModels: "Fetch model list",
    aiFetchModelsDesc: "Reads /v1/models from the endpoint above",
    aiPickModel: "Pick model",
    aiApiKey: "API key",
    aiApiKeyDesc: "Only needed for hosted endpoints. Stored locally in this vault's plugin data.json",
    aiTemperature: "Temperature",
    aiDisableThinking: "Disable model thinking",
    aiDisableThinkingDesc: "Sends reasoning_effort=none. Chain of thought doubles latency without improving translation",
    aiTimeout: "AI request timeout (ms)",
    aiTimeoutDesc: "Local models pay loading cost on the first request, isolated from the free-API timeout",
    systemPrompt: "System prompt",
    systemPromptDesc: "Placeholders: {{targetLang}} {{sourceLang}}",
    userPrompt: "User prompt",
    userPromptDesc: "Placeholders: {{input}} {{targetLang}}",

    // Requests
    requestsHeading: "Requests & Rate Limiting",
    preloadBand: "Preload band (px)",
    preloadBandDesc: "How far ahead of the viewport paragraphs get translated",
    requestCapacity: "Max concurrent requests",
    requestCapacityDesc: "Token bucket capacity. Free endpoints rate-limit aggressively, keep this small",
    requestRate: "Requests per second",
    requestRateDesc: "Token refill rate",
    batchItems: "Batch size (paragraphs)",
    batchItemsDesc: "Active for Microsoft Edge and AI; ignored for Google",
    batchChars: "Batch size (characters)",
    requestTimeout: "Request timeout (ms)",
    maxRetries: "Max retries",

    // Filtering
    filterHeading: "Filtering",
    minChars: "Min characters per paragraph",
    minWords: "Min words per paragraph",

    // Cache
    cacheHeading: "Cache",
    enableCache: "Enable translation cache",
    enableCacheDesc: "Cached hits bypass the network entirely with hash-based LRU + 7-day TTL",
    cacheTtl: "Cache TTL (days)",
    cacheMax: "Max cache entries",
    clearCache: "Clear cache",
    clearCacheDesc: "Empties the disk cache stored in data.json",
    cacheCleared: "Translation cache cleared.",

    // Orb
    orbHeading: "Floating Orb",
    showOrb: "Show floating orb",
    showOrbDesc: "Docked semi-hidden button at the reading view margin",
    orbOpacity: "Orb resting opacity",
    orbPosition: "Orb dock position",
    posRightMiddle: "Right middle",
    posLeftMiddle: "Left middle",
    posCustom: "Custom (draggable)",
    autoTranslateSelect: "Auto-translate on selection",
    autoTranslateSelectDesc: "Translates selections without opening the orb menu",

    // Markdown
    mdHeading: "Markdown",
    renderMd: "Render translation as Markdown",
    renderMdDesc: "Preserves bold, code, links, etc. in translated text",

    // Orb Menu Actions
    orbToggle: "Translate full note",
    orbSelection: "Translate selection",
    orbStop: "Stop",
    orbClear: "Clear translations",

    // Commands
    cmdToggle: "Toggle full-note translation",
    cmdSelection: "Translate selection",
    cmdClear: "Clear injected translations",
    cmdCycle: "Cycle translation engine",
    engineSwitched: "Switched translation engine to: ",
  },
} as const;

export type TranslationKey = keyof typeof STRINGS["zh"];

export function t(key: TranslationKey): string {
  const lang = getLanguage();
  const dict = STRINGS[lang] || STRINGS.en;
  return (dict as Record<string, string>)[key] || STRINGS.en[key] || key;
}
