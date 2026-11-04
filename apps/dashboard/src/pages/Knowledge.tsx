import { useState } from "react";
import { api } from "../api";
import { canEdit, useAuth } from "../auth";
import { useApi } from "../hooks";
import { Card, Empty, Page } from "../components/ui";

export function KnowledgePage() {
  const { me } = useAuth();
  const list = useApi<any[]>("/knowledge");
  const [edit, setEdit] = useState<any | null>(null);
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<any[] | null>(null);
  const save = async () => {
    const body = { title: edit.title, content: edit.content, tags: String(edit.tags ?? "").split(",").map((s: string) => s.trim()).filter(Boolean), published: edit.published ?? true };
    if (edit.id) await api(`/knowledge/${edit.id}`, { method: "PATCH", body });
    else await api("/knowledge", { body });
    setEdit(null);
    list.reload();
  };
  return (
    <Page title="Knowledge base" actions={canEdit(me) && <button onClick={() => setEdit({ title: "", content: "" })}>+ Article</button>}>
      <p className="muted">Policies and FAQs your agent searches before answering. Write them the way you'd brief a new teammate.</p>
      <Card title="Test what the agent finds">
        <div className="row">
          <input placeholder="e.g. can I return a used item?" value={q} onChange={(e) => setQ(e.target.value)} />
          <button onClick={async () => setHits(await api(`/knowledge/search?q=${encodeURIComponent(q)}`))}>Search</button>
        </div>
        {hits && (hits.length ? hits.map((h) => <div key={h.id} className="event"><b>{h.title}</b> <span className="muted">score {h.score.toFixed(2)}</span></div>) : <Empty>No match — the agent would escalate.</Empty>)}
      </Card>
      {edit && (
        <Card title={edit.id ? "Edit article" : "New article"}>
          <label>Title<input value={edit.title} onChange={(e) => setEdit({ ...edit, title: e.target.value })} /></label>
          <label>Content<textarea rows={10} value={edit.content} onChange={(e) => setEdit({ ...edit, content: e.target.value })} /></label>
          <label>Tags<input value={Array.isArray(edit.tags) ? edit.tags.join(", ") : edit.tags ?? ""} onChange={(e) => setEdit({ ...edit, tags: e.target.value })} /></label>
          <div className="row"><button className="primary" onClick={save}>Save</button><button onClick={() => setEdit(null)}>Cancel</button></div>
        </Card>
      )}
      <Card>
        {list.data?.map((a) => (
          <div key={a.id} className="approval">
            <div><b>{a.title}</b> {!a.published && <span className="muted">(draft)</span>}<div className="muted small">{a.content.slice(0, 160)}…</div></div>
            {canEdit(me) && (
              <div className="row">
                <button onClick={() => setEdit(a)}>Edit</button>
                <button onClick={async () => { if (confirm("Delete article?")) { await api(`/knowledge/${a.id}`, { method: "DELETE" }); list.reload(); } }}>Delete</button>
              </div>
            )}
          </div>
        ))}
      </Card>
    </Page>
  );
}
