/** Protect syntax before translation and verify every placeholder round-trips. */
export class TranslationValidationError extends Error {
  constructor(message: string) { super(message); this.name = "TranslationValidationError"; }
}

export function protectText(source: string): { text: string; restore: (result: string) => string; prose: string } {
  let prefix = "ZXQNAIYI";
  while (source.includes(prefix)) prefix += "X";
  const values: string[] = [];
  const save = (value: string) => `${prefix}${values.push(value) - 1}QXZ`;
  // Match the outer syntax first, so code/math containing URLs is one protected unit.
  let text = source.replace(/(`+)[\s\S]*?\1|\$\$[\s\S]*?\$\$|\$[^$\n]+\$|\[\[[^\]\n]+\]\]|https?:\/\/[^\s<>\])]+|\n|^[ \t]*[-=_.─━]{3,}[ \t]*$/gm, save);
  // Relative Markdown destinations must survive as well as absolute URLs.
  text = text.replace(/(\]\()([^\n)]*)(\))/g, (_all, before: string, destination: string, after: string) =>
    destination.includes(prefix) ? before + destination + after : before + save(destination) + after);
  const tokenPattern = new RegExp(`${prefix}\\d+QXZ`, "g");
  const prose = text.replace(tokenPattern, " ");
  return {
    text, prose,
    restore(result) {
      const seen = result.match(tokenPattern) ?? [];
      if (seen.length !== values.length || values.some((_v, i) => seen.filter((token) => token === `${prefix}${i}QXZ`).length !== 1)) {
        throw new TranslationValidationError("Translation damaged protected formatting; retrying may help.");
      }
      return result.replace(tokenPattern, (token) => values[Number(token.slice(prefix.length, -3))]);
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
