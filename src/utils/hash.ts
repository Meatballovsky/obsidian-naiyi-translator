/**
 * Cache keys must be stable across sessions but the renderer may not always
 * expose crypto.subtle, so fall back to a 64-bit FNV-1a hash.
 */
export async function hashKey(input: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle && typeof globalThis.crypto?.subtle?.digest === "function") {
    try {
      const bytes = new TextEncoder().encode(input);
      const digest = await subtle.digest("SHA-256", bytes);
      return Array.from(new Uint8Array(digest))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
    } catch {
      // fall through
    }
  }
  return fnv1a64(input);
}

function fnv1a64(text: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0xcbf29ce4;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ (c & 0xff), 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ ((c >> 8) & 0xff), 0x01000193) >>> 0;
  }
  return `fnv${h2.toString(16).padStart(8, "0")}${h1.toString(16).padStart(8, "0")}`;
}
