export async function readJsonResponse<T>(response: Response, invalidResponseMessage: string): Promise<T> {
  const text = await response.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(response.ok ? "Plugin services returned invalid JSON." : invalidResponseMessage);
  }
}

export async function runtimeRequest<T>(runtime: RuntimeInfo, route: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${runtime.origin}${route}`, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
  const body = await readJsonResponse<{ error?: string; code?: string } & T>(response, "Plugin services are unavailable.");
  if (!response.ok) throw Object.assign(new Error(body.error ?? "Operation failed"), { code: body.code, body });
  return body;
}
