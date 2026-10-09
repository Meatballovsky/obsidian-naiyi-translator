import { postJson } from "./http";
import { escapeEntities, unescapeEntities } from "../utils/entities";

const MICROSOFT_URL = "https://edge.microsoft.com/translate/translatetext";

interface MicrosoftTranslation {
  text?: string;
}

interface MicrosoftItem {
  translations?: MicrosoftTranslation[];
}

/**
 * Successor to the api-edge.cognitive flow: the old `edge.microsoft.com/translate/auth`
 * token endpoint was removed upstream, and this one takes a bare JSON string array
 * with no Authorization header at all. It accepts arrays and returns one entry per
 * input item, so batching maps back 1:1.
 */
export async function microsoftTranslateBatch(
  texts: string[],
  fromLang: string,
  toLang: string,
  timeoutMs?: number
): Promise<string[]> {
  if (texts.length === 0) return [];

  const params = new URLSearchParams({
    from: fromLang === "auto" ? "" : fromLang,
    to: toLang,
    isEnterpriseClient: "false",
  });

  // The endpoint runs an HTML tag aligner over every request, so a bare "<" fuses
  // into a pseudo-tag. Escaped entities round-trip verbatim and are decoded once.
  const payload = texts.map((text) => escapeEntities(text));

  const data = await postJson<MicrosoftItem[]>(
    `${MICROSOFT_URL}?${params.toString()}`,
    payload,
    { timeoutMs }
  );

  if (!Array.isArray(data)) {
    throw new Error("Unexpected Microsoft response shape");
  }
  if (data.length !== texts.length) {
    throw new Error(
      `Microsoft returned ${data.length} items for ${texts.length} inputs`
    );
  }

  return data.map(
    (item) => unescapeEntities(item?.translations?.[0]?.text ?? "") || ""
  );
}

export function microsoftTranslate(
  text: string,
  fromLang: string,
  toLang: string,
  timeoutMs?: number
): Promise<string> {
  return microsoftTranslateBatch([text], fromLang, toLang, timeoutMs).then(
    (results) => results[0] ?? ""
  );
}
