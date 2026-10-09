// Minimal stand-in for the Obsidian API module so engine code can be exercised
// in Node; requestUrl is mapped onto global fetch.
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
