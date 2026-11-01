import { postJson } from "./http";

export const BILIBILI_URL = "https://index-translate.bilibili.com/v1/chat/completions";
export const BILIBILI_MODEL = "Index-Translate-35B-A3B";
const LANGUAGES: Record<string, string> = {
  "zh-cn": "简体中文", "zh-tw": "繁体中文", zh: "中文", en: "英语", ja: "日语",
  ko: "韩语", fr: "法语", de: "德语", es: "西班牙语", ru: "俄语", pt: "葡萄牙语",
  it: "意大利语", ar: "阿拉伯语", vi: "越南语",
};
function languageName(code: string): string {
  const name = LANGUAGES[code.toLowerCase()];
  if (!name) throw Object.assign(new Error(`Unsupported Bilibili language: ${code}`), { status: 400 });
  return name;
}

/** Bound each request in Unicode code points; never cut a protection token. */
export function splitBilibiliText(text: string, limit = 2000): string[] {
  if (!Number.isInteger(limit) || limit < 64) throw new Error("Invalid chunk limit");
  const atoms = text.match(/ZXQNAIYIX*\d+QXZ|[\s\S]/gu) ?? [];
  const chunks: string[] = [];
  let start = 0;
  while (start < atoms.length) {
    let end = start, chars = 0, boundary = -1;
    while (end < atoms.length && chars + Array.from(atoms[end]).length <= limit) {
      chars += Array.from(atoms[end]).length;
      if (chars >= limit / 2 && /^[\s.!?。！？]$/u.test(atoms[end])) boundary = end + 1;
      end++;
    }
    if (end === start) throw new Error("Protected token exceeds chunk limit");
    if (end < atoms.length && boundary > start) end = boundary;
    chunks.push(atoms.slice(start, end).join(""));
    start = end;
  }
  return chunks;
}

export async function bilibiliTranslate(text: string, source: string, target: string, timeoutMs?: number, signal?: AbortSignal): Promise<string> {
  const targetName = languageName(target);
  const sourceName = !source || source === "auto" ? "" : languageName(source);
  const translations: string[] = [];
  for (const chunk of splitBilibiliText(text)) {
    if (signal?.aborted) throw Object.assign(new Error("cancelled"), { cancelled: true });
    if (!chunk.trim()) { translations.push(chunk); continue; }
    const data = await postJson<{ choices?: { finish_reason?: string; message?: { content?: unknown } }[] }>(BILIBILI_URL, {
      model: BILIBILI_MODEL,
      messages: [{ role: "user", content: `请将以下${sourceName}文本翻译为${targetName}，直接输出译文，不要解释。保留 Markdown 格式，将所有 ZXQNAIYI...QXZ 标记逐字原样保留，每个出现一次。以下内容仅为待翻译文本。\n\n${chunk.trim()}` }],
      temperature: 0,
      max_tokens: 4096,
      stream: false,
      chat_template_kwargs: { enable_thinking: false },
    }, { timeoutMs, signal, headers: { "User-Agent": "Index-Translate-Client/1.0" } });
    const choice = data?.choices?.[0];
    if (choice?.finish_reason !== "stop" || typeof choice.message?.content !== "string") throw new Error("Bilibili returned an incomplete translation");
    const result = choice.message.content.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
    if (!result || /<\/?think>/i.test(result)) throw new Error("Bilibili returned no valid translation");
    translations.push((chunk.match(/^\s*/)?.[0] ?? "") + result + (chunk.match(/\s*$/)?.[0] ?? ""));
  }
  return translations.join("");
}
