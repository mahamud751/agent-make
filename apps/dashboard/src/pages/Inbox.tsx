import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { api } from "../api";
import { useApi, useRealtime } from "../hooks";
import { Badge, Empty, ago, when } from "../components/ui";

const FILTERS = [
  ["", "All"],
  ["OPEN", "AI handling"],
  ["PENDING_HUMAN", "Needs human"],
  ["RESOLVED", "Resolved"],
] as const;

export function InboxPage() {
  const { id } = useParams();
  const [params, setParams] = useSearchParams();
  const status = params.get("status") ?? "";
  const list = useApi<{ data: any[] }>(`/conversations?limit=50${status ? `&status=${status}` : ""}`, [status]);
  useRealtime(["message.created", "conversation.created", "conversation.escalated", "conversation.resolved"], () => list.reload());

  return (
    <div className="inbox">
      <div className="inbox-list">
        <div className="tabs">
          {FILTERS.map(([v, l]) => (
            <button key={v} className={status === v ? "active" : ""} onClick={() => setParams(v ? { status: v } : {})}>{l}</button>
          ))}
        </div>
        {list.data?.data.length === 0 && <Empty>No conversations.</Empty>}
        {list.data?.data.map((c) => (
          <Link key={c.id} to={`/inbox/${c.id}${status ? `?status=${status}` : ""}`} className={`conv ${c.id === id ? "sel" : ""}`}>
            <div className="row between">
              <b>{c.customer?.name ?? c.customer?.email ?? c.verifiedEmail ?? "Visitor"}</b>
              <small className="muted">{ago(c.lastMessageAt)}</small>
            </div>
            <div className="row between">
              <span className="snippet">{c.lastMessage?.content ?? "—"}</span>
              <Badge value={c.status} />
            </div>
            <small className="muted">{c.channel.replace("_", " ").toLowerCase()}{c.tags?.length ? ` · ${c.tags.join(", ")}` : ""}</small>
          </Link>
        ))}
      </div>
      <div className="inbox-thread">{id ? <Thread id={id} onChange={list.reload} /> : <Empty>Select a conversation</Empty>}</div>
    </div>
  );
}

function Thread({ id, onChange }: { id: string; onChange: () => void }) {
  const { data, reload } = useApi(`/conversations/${id}`, [id]);
  const [text, setText] = useState("");
  const [internal, setInternal] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  const nav = useNavigate();
  useRealtime(["message.created", "action.decided", "conversation.escalated"], (_e, p) => {
    if (!p?.conversationId || p.conversationId === id || p.conversation?.id === id || p.action?.conversationId === id) reload();
  });
  useEffect(() => {
    end.current?.scrollIntoView({ behavior: "smooth" });
  }, [data?.messages?.length]);
  if (!data) return <div className="center">Loading…</div>;

  const act = async (path: string, body: unknown = {}) => {
    await api(`/conversations/${id}/${path}`, { body });
    await reload();
    onChange();
  };
  const send = async () => {
    if (!text.trim()) return;
    await act("messages", { content: text, internal });
    setText("");
  };

  return (
    <>
      <div className="thread-head">
        <div>
          <b>{data.customer?.name ?? data.customer?.email ?? "Visitor"}</b> <Badge value={data.status} />
          <div className="muted small">{data.verifiedEmail ? `✔ verified ${data.verifiedEmail}` : "identity not verified"} · {data.channel.toLowerCase()} · agent {data.agent?.name ?? "—"}</div>
        </div>
        <div className="row">
          {data.status !== "OPEN" && <button onClick={() => act("resume-ai")}>Hand back to AI</button>}
          {data.status !== "RESOLVED" && <button className="primary" onClick={() => act("resolve")}>Resolve</button>}
          <button className="link" onClick={() => nav("/inbox")}>✕</button>
        </div>
      </div>
      <div className="thread">
        {data.messages.map((m: any) => (
          <div key={m.id} className={`bubble ${m.role.toLowerCase()} ${m.metadata?.internalNote ? "note" : ""}`}>
            <div className="who">{label(m)} · {when(m.createdAt)}</div>
            <div className="text">{m.content}</div>
            {m.metadata?.toolCalls?.length > 0 && <div className="tools">tools: {m.metadata.toolCalls.join(", ")}</div>}
          </div>
        ))}
        {data.actions?.filter((a: any) => a.status === "PENDING").map((a: any) => (
          <div key={a.id} className="bubble system">
            <div className="who">Approval needed</div>
            <div className="text">{a.tool.replace(/_/g, " ")} — {JSON.stringify(stripMeta(a.input))}</div>
            <div className="row">
              <button className="primary" onClick={async () => { await api(`/approvals/${a.id}/approve`, { body: {} }); reload(); }}>Approve</button>
              <button onClick={async () => { await api(`/approvals/${a.id}/reject`, { body: {} }); reload(); }}>Reject</button>
            </div>
          </div>
        ))}
        <div ref={end} />
      </div>
      <div className="composer">
        <textarea value={text} onChange={(e) => setText(e.target.value)} placeholder={internal ? "Internal note (customer won't see this)" : "Reply as a human — this pauses the AI for this conversation"} onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) send(); }} />
        <div className="row between">
          <label className="small"><input type="checkbox" checked={internal} onChange={(e) => setInternal(e.target.checked)} /> internal note</label>
          <button className="primary" onClick={send}>Send ⌘↵</button>
        </div>
      </div>
    </>
  );
}

const label = (m: any) => ({ CUSTOMER: "Customer", AGENT: "AI agent", HUMAN: "Team", SYSTEM: m.metadata?.internalNote ? "Internal note" : "System" })[m.role as string];
const stripMeta = (i: Record<string, unknown>) => Object.fromEntries(Object.entries(i).filter(([k]) => !k.startsWith("_")));
