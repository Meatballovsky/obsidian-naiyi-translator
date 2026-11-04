import { markdownLinkPattern } from "../utils/links";

/** Protect syntax before translation and verify every placeholder round-trips. */
export class TranslationValidationError extends Error {
  constructor(message: string) { super(message); this.name = "TranslationValidationError"; }
}

export function protectText(source: string): { text: string; restore: (result: string, labels?: string[]) => string; prose: string; labels: string[] } {
  let prefix = "ZXQNAIYI";
  while (source.includes(prefix)) prefix += "X";
  const values: string[] = [];
  const linksToRestore: { index: number; label: string }[] = [];
  const save = (value: string) => `${prefix}${values.push(value) - 1}QXZ`;
  // Match outer code/math first. A whole link uses ONE token: some services
  // drop opening tokens around translated labels, even when separated by spaces.
  // Labels are translated separately and reinserted into the protected syntax.
  const links = markdownLinkPattern().source;
  const syntax = new RegExp('(`+)[\\s\\S]*?\\1|\\$\\$[\\s\\S]*?\\$\\$|\\$[^$\\n]+\\$|\\[\\[[^\\]\\n]+\\]\\]|' + links + '|https?:\\/\\/[^\\s<>\\])]+|\\n|^[ \\t]*[-=_.─━]{3,}[ \\t]*$', 'gm');
  let text = source.replace(syntax, (value) => {
    const link = markdownLinkPattern().exec(value);
    if (link?.[0] === value) linksToRestore.push({ index: values.length, label: link[1] });
    return save(value);
  });
  // Relative Markdown destinations must survive as well as absolute URLs.
  text = text.replace(/(\]\()([^\n)]*)(\))/g, (_all, before: string, destination: string, after: string) =>
    destination.includes(prefix) ? before + destination + after : before + save(destination) + after);
  const tokenPattern = new RegExp(`${prefix}\\d+QXZ`, "g");
  const prose = text.replace(tokenPattern, " ");
  return {
    text, prose, labels: linksToRestore.map((link) => link.label),
    restore(result, labels) {
      const seen = result.match(tokenPattern) ?? [];
      if (seen.length !== values.length || values.some((_v, i) => seen.filter((token) => token === `${prefix}${i}QXZ`).length !== 1)) {
        throw new TranslationValidationError("Translation damaged protected formatting; retrying may help.");
      }
      const restoredValues = [...values];
      if (labels) {
        if (labels.length !== linksToRestore.length) throw new TranslationValidationError("Translation link label count mismatch.");
        linksToRestore.forEach((link, index) => {
          // Escape delimiters introduced by translated prose, keeping the label
          // inside its original link rather than allowing new Markdown syntax.
          const label = labels[index].replace(/[\\[\]]/g, "\\$&").replace(/\n/g, " ");
          restoredValues[link.index] = "[" + label + values[link.index].slice(link.label.length + 1);
        });
      }
      return result.replace(tokenPattern, (token) => restoredValues[Number(token.slice(prefix.length, -3))]);
    },
  };
}

export function validateTranslation(sourceProse: string, translatedProse: string, targetLang: string): void {
  if (!translatedProse.trim() && sourceProse.trim()) throw new TranslationValidationError("Translation returned empty text.");
  // Only reject clear long Latin-prose failures for a Chinese target. Short labels,
  // acronyms and mixed-language passages deliberately remain permissive.
  if (!targetLang.toLowerCase().startsWith("zh")) return;
  const words = sourceProse.match(/\b[A-Za-z]{2,}\b/g) ?? [];
  if (words.length < 12 || /\p{Script=Han}/u.test(sourceProse)) return;
  if (!/\p{Script=Han}/u.test(translatedProse) && (translatedProse.match(/\b[A-Za-z]{2,}\b/g) ?? []).length >= 8) {
    throw new TranslationValidationError("Translation is still non-Chinese prose instead of the requested Chinese.");
  }
}
