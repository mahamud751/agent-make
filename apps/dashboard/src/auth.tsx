import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { api, tokenStore } from "./api";

export interface Me {
  user: { id: string; email: string; name: string };
  role: "OWNER" | "ADMIN" | "SUPPORT" | "VIEWER";
  tenant: { id: string; name: string; slug: string; plan: string };
  workspaces: { id: string; name: string; role: string }[];
}

const Ctx = createContext<{ me: Me | null; ready: boolean; setToken: (t: string | null) => Promise<void> }>({ me: null, ready: false, setToken: async () => {} });

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [ready, setReady] = useState(false);
  const load = async () => {
    if (!tokenStore.get()) {
      setMe(null);
      setReady(true);
      return;
    }
    try {
      setMe(await api<Me>("/auth/me"));
    } catch {
      setMe(null);
    }
    setReady(true);
  };
  useEffect(() => {
    load();
  }, []);
  const setToken = async (t: string | null) => {
    tokenStore.set(t);
    await load();
  };
  return <Ctx.Provider value={{ me, ready, setToken }}>{children}</Ctx.Provider>;
}

export const useAuth = () => useContext(Ctx);
export const canEdit = (me: Me | null) => me?.role === "OWNER" || me?.role === "ADMIN";
