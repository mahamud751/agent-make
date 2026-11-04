import { useState } from "react";
import { api } from "../api";
import { useApi } from "../hooks";
import { Card, ErrorText, Page } from "../components/ui";

const EVENTS = ["order.created", "order.status_changed", "order.refunded", "order.updated", "conversation.escalated", "conversation.resolved", "action.pending"];

const PRESETS = [
  { name: "Notify customer when order ships", event: "order.status_changed", conditions: { to: "SHIPPED" }, actions: [{ type: "notify_customer", template: "Great news! Order #{{order.number}} is on its way with {{order.carrier}} — tracking {{order.trackingNumber}}." }] },
  { name: "Order confirmation message", event: "order.created", conditions: {}, actions: [{ type: "notify_customer", template: "Thanks for your order #{{order.number}}! We'll let you know when it ships." }] },
  { name: "Email the team on escalation", event: "conversation.escalated", conditions: {}, actions: [{ type: "email", to: "support@yourstore.com", subject: "Customer needs a human", template: "Reason: {{reason}}\n\n{{summary}}" }] },
];

export function AutomationsPage() {
  const list = useApi<any[]>("/automations");
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    setError(null);
    try {
      await api("/automations", { body: JSON.parse(draft!) });
      setDraft(null);
      list.reload();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <Page title="Automations" actions={<button onClick={() => setDraft(JSON.stringify({ name: "", event: EVENTS[0], conditions: {}, actions: [{ type: "notify_customer", template: "" }] }, null, 2))}>+ Rule</button>}>
      <p className="muted">When an event happens, run actions. Templates use <code>{"{{order.number}}"}</code>-style placeholders.</p>
      <div className="cards3">
        {PRESETS.map((p) => (
          <Card key={p.name} title={p.name}><button onClick={() => setDraft(JSON.stringify(p, null, 2))}>Use template</button></Card>
        ))}
      </div>
      {draft !== null && (
        <Card title="Rule (JSON)">
          <textarea rows={14} className="mono" value={draft} onChange={(e) => setDraft(e.target.value)} />
          <p className="muted small">Events: {EVENTS.join(", ")}. Actions: notify_customer, email, tag_conversation.</p>
          <ErrorText error={error} />
          <div className="row"><button className="primary" onClick={save}>Create</button><button onClick={() => setDraft(null)}>Cancel</button></div>
        </Card>
      )}
      <Card title="Rules">
        {list.data?.map((r) => (
          <div key={r.id} className="approval">
            <div><b>{r.name}</b><div className="muted small">on <code>{r.event}</code> {Object.keys(r.conditions).length > 0 && <>when <code>{JSON.stringify(r.conditions)}</code></>} → {r.actions.map((a: any) => a.type).join(", ")}</div></div>
            <div className="row">
              <button onClick={async () => { await api(`/automations/${r.id}`, { method: "PATCH", body: { active: !r.active } }); list.reload(); }}>{r.active ? "Disable" : "Enable"}</button>
              <button onClick={async () => { await api(`/automations/${r.id}`, { method: "DELETE" }); list.reload(); }}>Delete</button>
            </div>
          </div>
        ))}
      </Card>
    </Page>
  );
}
