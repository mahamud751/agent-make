/**
 * AgentDesk chat widget — drop-in for any website:
 *
 *   <script src="https://cdn.agentdesk.app/agentdesk.js"
 *           data-key="pk_live_..." data-api="https://api.agentdesk.app" async></script>
 *
 * Optional: data-agent="<agentId>", data-email / data-name (prefill a logged-in shopper),
 * window.AgentDesk.open() / .close() / .identify({email,name}).
 */
interface Msg {
  id: string;
  role: "CUSTOMER" | "AGENT" | "HUMAN" | "SYSTEM";
  content: string;
  createdAt: string;
}
interface Session {
  conversationId: string;
  visitorToken: string;
  store: string;
  agent: { name: string; theme: { primaryColor?: string; position?: "left" | "right"; title?: string } };
  messages: Msg[];
}

(function () {
  const script = document.currentScript as HTMLScriptElement | null;
  const cfg = {
    key: script?.dataset.key ?? "",
    api: (script?.dataset.api ?? "").replace(/\/$/, ""),
    agentId: script?.dataset.agent,
    email: script?.dataset.email,
    name: script?.dataset.name,
  };
  if (!cfg.key || !cfg.api) {
    console.warn("[AgentDesk] data-key and data-api are required");
    return;
  }
  const STORAGE = `agentdesk:${cfg.key.slice(0, 16)}`;
  const store = {
    get: () => {
      try {
        return localStorage.getItem(STORAGE) ?? undefined;
      } catch {
        return undefined;
      }
    },
    set: (v: string) => {
      try {
        localStorage.setItem(STORAGE, v);
      } catch {
        /* private mode */
      }
    },
  };

  let session: Session | null = null;
  const seen = new Set<string>();
  let lastAt: string | undefined;
  let open = false;
  let pollTimer: number | undefined;
  let typing = false;

  const call = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const res = await fetch(`${cfg.api}/v1/widget${path}`, {
      method,
      headers: { "content-type": "application/json", authorization: `Bearer ${cfg.key}` },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`AgentDesk ${res.status}`);
    return res.json() as Promise<T>;
  };

  // ── UI (Shadow DOM so the host site's CSS can't break us, and vice versa) ──
  const host = document.createElement("div");
  host.id = "agentdesk-widget";
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = `
  <style>
    :host { all: initial; }
    * { box-sizing: border-box; font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; }
    .launcher { position: fixed; bottom: 20px; right: 20px; width: 56px; height: 56px; border-radius: 50%; border: 0; cursor: pointer;
      background: var(--c); color: #fff; box-shadow: 0 6px 24px rgba(0,0,0,.2); display: grid; place-items: center; z-index: 2147483000; }
    .launcher svg { width: 26px; height: 26px; }
    .panel { position: fixed; bottom: 88px; right: 20px; width: 370px; max-width: calc(100vw - 32px); height: 560px; max-height: calc(100vh - 110px);
      background: #fff; border-radius: 16px; box-shadow: 0 12px 48px rgba(0,0,0,.22); display: none; flex-direction: column; overflow: hidden; z-index: 2147483000; }
    .left .launcher, .left .panel { right: auto; left: 20px; }
    .panel.open { display: flex; }
    header { background: var(--c); color: #fff; padding: 14px 16px; }
    header b { display: block; font-size: 15px; }
    header small { opacity: .85; font-size: 12px; }
    .log { flex: 1; overflow-y: auto; padding: 14px; background: #f7f7f9; display: flex; flex-direction: column; gap: 8px; }
    .m { max-width: 82%; padding: 9px 12px; border-radius: 14px; font-size: 14px; line-height: 1.4; white-space: pre-wrap; word-wrap: break-word; }
    .m.in { background: #fff; color: #111; border: 1px solid #e6e6ea; align-self: flex-start; border-bottom-left-radius: 4px; }
    .m.out { background: var(--c); color: #fff; align-self: flex-end; border-bottom-right-radius: 4px; }
    .m.human { border-color: var(--c); }
    .who { font-size: 11px; color: #777; margin: 2px 4px -4px; }
    .typing { font-size: 12px; color: #888; padding: 0 16px 6px; height: 18px; background: #f7f7f9; }
    form { display: flex; border-top: 1px solid #eee; }
    textarea { flex: 1; border: 0; resize: none; padding: 12px; font-size: 14px; outline: none; height: 48px; }
    button.send { border: 0; background: none; color: var(--c); font-weight: 600; padding: 0 16px; cursor: pointer; }
    .brand { text-align: center; font-size: 10px; color: #aaa; padding: 4px; }
    @media (max-width: 480px) { .panel { inset: 0; width: 100%; max-width: 100%; height: 100%; max-height: 100%; border-radius: 0; bottom: 0; right: 0; } }
  </style>
  <div class="wrap">
    <div class="panel" role="dialog" aria-label="Chat with support">
      <header><b class="title">Support</b><small class="sub">We usually reply instantly</small></header>
      <div class="log" aria-live="polite"></div>
      <div class="typing"></div>
      <form><textarea placeholder="Type your message…" aria-label="Message"></textarea><button class="send" type="submit">Send</button></form>
      <div class="brand">Powered by AgentDesk</div>
    </div>
    <button class="launcher" aria-label="Open chat">
      <svg viewBox="0 0 24 24" fill="currentColor"><path d="M4 4h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H8l-4 4V6a2 2 0 0 1 2-2z"/></svg>
    </button>
  </div>`;
  const $ = <T extends Element>(s: string) => root.querySelector(s) as T;
  const wrap = $<HTMLDivElement>(".wrap");
  const panel = $<HTMLDivElement>(".panel");
  const log = $<HTMLDivElement>(".log");
  const input = $<HTMLTextAreaElement>("textarea");
  const typingEl = $<HTMLDivElement>(".typing");

  function render(m: Msg) {
    if (seen.has(m.id) || m.role === "SYSTEM") return;
    seen.add(m.id);
    if (!lastAt || m.createdAt > lastAt) lastAt = m.createdAt;
    if (m.role === "HUMAN") {
      const who = document.createElement("div");
      who.className = "who";
      who.textContent = "Support team";
      log.appendChild(who);
    }
    const el = document.createElement("div");
    el.className = `m ${m.role === "CUSTOMER" ? "out" : "in"}${m.role === "HUMAN" ? " human" : ""}`;
    el.textContent = m.content; // textContent: never inject HTML from messages
    log.appendChild(el);
    log.scrollTop = log.scrollHeight;
    if (m.role !== "CUSTOMER") setTyping(false);
  }

  function setTyping(v: boolean) {
    typing = v;
    typingEl.textContent = v ? `${session?.agent.name ?? "Agent"} is typing…` : "";
  }

  async function ensureSession() {
    if (session) return session;
    session = await call<Session>("POST", "/session", {
      visitorToken: store.get(),
      agentId: cfg.agentId,
      customer: cfg.email ? { email: cfg.email, name: cfg.name } : undefined,
    });
    store.set(session.visitorToken);
    const t = session.agent.theme ?? {};
    wrap.style.setProperty("--c", t.primaryColor ?? "#4f46e5");
    if (t.position === "left") wrap.classList.add("left");
    $<HTMLElement>(".title").textContent = t.title ?? `${session.store} · ${session.agent.name}`;
    session.messages.forEach(render);
    return session;
  }

  async function poll() {
    if (!session) return;
    try {
      const r = await call<{ messages: Msg[] }>("GET", `/messages?visitorToken=${encodeURIComponent(session.visitorToken)}${lastAt ? `&after=${encodeURIComponent(lastAt)}` : ""}`);
      r.messages.forEach(render);
    } catch {
      /* transient */
    }
    pollTimer = window.setTimeout(poll, open ? (typing ? 1200 : 3000) : 15000);
  }

  async function send(text: string) {
    const s = await ensureSession();
    const m = await call<Msg>("POST", "/messages", { visitorToken: s.visitorToken, content: text });
    render(m);
    setTyping(true);
    window.clearTimeout(pollTimer);
    pollTimer = window.setTimeout(poll, 800);
  }

  async function toggle(v = !open) {
    open = v;
    panel.classList.toggle("open", open);
    if (open) {
      await ensureSession();
      window.clearTimeout(pollTimer);
      poll();
      input.focus();
    }
  }

  wrap.style.setProperty("--c", "#4f46e5");
  $<HTMLButtonElement>(".launcher").addEventListener("click", () => toggle());
  $<HTMLFormElement>("form").addEventListener("submit", (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    input.value = "";
    send(text).catch(() => setTyping(false));
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      $<HTMLFormElement>("form").requestSubmit();
    }
  });

  const mount = () => document.body.appendChild(host);
  if (document.body) mount();
  else document.addEventListener("DOMContentLoaded", mount);

  (window as unknown as { AgentDesk: unknown }).AgentDesk = {
    open: () => toggle(true),
    close: () => toggle(false),
    identify: (c: { email?: string; name?: string }) => {
      cfg.email = c.email;
      cfg.name = c.name;
    },
  };
})();
