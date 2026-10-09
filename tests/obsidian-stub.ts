// Minimal stand-in for the Obsidian API module so engine code can be exercised
// in Node; requestUrl is mapped onto global fetch.
export function getLanguage(): string { return "en"; }

export function sanitizeHTMLToDom(html: string): DocumentFragment {
  const parsed = new window.DOMParser().parseFromString(html, "text/html");
  const fragment = document.createDocumentFragment();
  for (const node of Array.from(parsed.body.childNodes)) fragment.append(document.importNode(node, true));
  return fragment;
}

export class Component {
  private disposers: (() => void)[] = [];
  load(): void {}
  register(disposer: () => void): void { this.disposers.push(disposer); }
  unload(): void {
    for (const dispose of this.disposers.splice(0)) dispose();
  }
}
export interface RequestUrlParam {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string | ArrayBuffer;
  throw?: boolean;
}

export async function requestUrl(request: RequestUrlParam | string): Promise<{ status: number; text: string; json: unknown }> {
  const param = typeof request === "string" ? { url: request } : request;
  const response = await fetch(param.url, {
    method: param.method ?? "GET",
    headers: param.headers,
    body: param.body as string | undefined,
  });
  const text = await response.text();
  let json: unknown = undefined;
  try {
    json = JSON.parse(text);
  } catch {
    /* leave undefined */
  }
  if (!response.ok && param.throw !== false) {
    throw new Error(`HTTP ${response.status}`);
  }
  return { status: response.status, text, json };
}
