const MAX_RUNTIME_RESPONSE_BYTES = 8 * 1024 * 1024;

async function readResponseText(response: Response): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RUNTIME_RESPONSE_BYTES) {
    if (response.body) await response.body.cancel().catch(() => {});
    throw new Error("Plugin services returned an oversized response.");
  }
  if (!response.body) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > MAX_RUNTIME_RESPONSE_BYTES) throw new Error("Plugin services returned an oversized response.");
    return text;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let bytes = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      bytes += result.value.byteLength;
      if (bytes > MAX_RUNTIME_RESPONSE_BYTES) {
        await reader.cancel().catch(() => {});
        throw new Error("Plugin services returned an oversized response.");
      }
      chunks.push(decoder.decode(result.value, { stream: true }));
    }
    chunks.push(decoder.decode());
    return chunks.join("");
  } finally {
    reader.releaseLock();
  }
}

export async function readJsonResponse<T>(response: Response, invalidResponseMessage: string): Promise<T> {
  const text = await readResponseText(response);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(response.ok ? "Plugin services returned invalid JSON." : invalidResponseMessage);
  }
}

export async function runtimeRequest<T>(runtime: RuntimeInfo, route: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (!headers.has("content-type")) headers.set("content-type", "application/json");
  if (runtime.runtimeToken) headers.set("authorization", `Bearer ${runtime.runtimeToken}`);
  const response = await fetch(`${runtime.origin}${route}`, {
    ...init,
    headers,
    credentials: "include",
  });
  const body = await readJsonResponse<{ error?: string; code?: string } & T>(response, "Plugin services are unavailable.");
  if (!response.ok) throw Object.assign(new Error(body.error ?? "Operation failed"), { code: body.code, body });
  return body;
}
