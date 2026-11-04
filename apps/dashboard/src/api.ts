const BASE = import.meta.env.VITE_API_URL ?? "";

export class ApiError extends Error {
  constructor(public status: number, message: string, public details?: unknown) {
    super(message);
  }
}

export const tokenStore = {
  get: () => localStorage.getItem("agentdesk_token"),
  set: (t: string | null) => (t ? localStorage.setItem("agentdesk_token", t) : localStorage.removeItem("agentdesk_token")),
};

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const token = tokenStore.get();
  const res = await fetch(`${BASE}/v1${path}`, {
    method: opts.method ?? (opts.body ? "POST" : "GET"),
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401 && token) {
    tokenStore.set(null);
    location.href = "/login";
  }
  if (res.status === 204) return undefined as T;
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, json?.error?.message ?? res.statusText, json?.error?.details);
  return json as T;
}

export const realtimeUrl = BASE || window.location.origin;
