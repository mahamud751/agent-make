import { ConnectorError } from "./types";

/** fetch with timeout + normalised errors (5xx/429/network are retryable). */
export async function httpJson<T>(url: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), init.timeoutMs ?? 10_000);
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: ctrl.signal, headers: { "content-type": "application/json", accept: "application/json", ...(init.headers ?? {}) } });
  } catch (e) {
    throw new ConnectorError(`Network error calling store: ${(e as Error).message}`, true);
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  if (!res.ok) {
    throw new ConnectorError(`Store responded ${res.status}: ${text.slice(0, 300)}`, res.status >= 500 || res.status === 429);
  }
  return (text ? JSON.parse(text) : {}) as T;
}
