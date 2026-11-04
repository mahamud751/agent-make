import { useCallback, useEffect, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";
import { api, realtimeUrl, tokenStore } from "./api";

export function useApi<T = any>(path: string | null, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const reload = useCallback(async () => {
    if (!path) return;
    setLoading(true);
    try {
      setData(await api<T>(path));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, ...deps]);
  useEffect(() => {
    reload();
  }, [reload]);
  return { data, error, loading, reload, setData };
}

let socket: Socket | null = null;
function getSocket() {
  if (!socket) socket = io(realtimeUrl, { path: "/realtime", auth: { token: tokenStore.get() }, transports: ["websocket", "polling"] });
  return socket;
}

/** Subscribe to tenant realtime events (message.created, conversation.escalated, action.pending...). */
export function useRealtime(events: string[], handler: (event: string, payload: any) => void) {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    const s = getSocket();
    const fns = events.map((e) => {
      const fn = (p: unknown) => ref.current(e, p);
      s.on(e, fn);
      return [e, fn] as const;
    });
    return () => fns.forEach(([e, fn]) => s.off(e, fn));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events.join(",")]);
}
