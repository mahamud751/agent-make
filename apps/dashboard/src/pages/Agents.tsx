import { useEffect, useState } from "react";
import { api } from "../api";
import { canEdit, useAuth } from "../auth";
import { useApi } from "../hooks";
import { Badge, Card, ErrorText, Page } from "../components/ui";

export function AgentsPage() {
  const { me } = useAuth();
  const agents = useApi<any[]>("/agents");
  const tools = useApi<any[]>("/agents/tools");
  const [selId, setSelId] = useState<string | null>(null);
  const sel = agents.data?.find((a) => a.id === selId) ?? agents.data?.[0];
  const create = async () => {
    const name = prompt("Agent name?");
    if (!name) return;
    const a = await api("/agents", { body: { name } });
    await agents.reload();
    setSelId(a.id);
  };
  return (
    <Page title="AI Agents" actions={canEdit(me) && <button onClick={create}>+ New agent</button>}>
      <div className="tabs">
        {agents.data?.map((a) => (
          <button key={a.id} className={sel?.id === a.id ? "active" : ""} onClick={() => setSelId(a.id)}>{a.name}{a.isDefault ? " ★" : ""}</button>
        ))}
      </div>
      {sel && tools.data && <AgentEditor key={sel.id} agent={sel} tools={tools.data} onSaved={agents.reload} readOnly={!canEdit(me)} />}
    </Page>
  );
}

function AgentEditor({ agent, tools, onSaved, readOnly }: { agent: any; tools: any[]; onSaved: () => void; readOnly: boolean }) {
  const [a, setA] = useState(agent);
  const [kw, setKw] = useState((agent.guardrails?.handoffKeywords ?? []).join(", "));
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    setSaved(false);
  }, [a, kw]);
  const set = (k: string, v: unknown) => setA({ ...a, [k]: v });
  const save = async () => {
    setError(null);
    try {
      await api(`/agents/${a.id}`, {
        method: "PATCH",
        body: {
          name: a.name, persona: a.persona, instructions: a.instructions, language: a.language, effort: a.effort, autoReply: a.autoReply, greeting: a.greeting, isDefault: a.isDefault,
          toolPolicies: a.toolPolicies, widgetTheme: a.widgetTheme,
          guardrails: { ...a.guardrails, maxRefundAmount: a.guardrails?.maxRefundAmount === "" ? undefined : Number(a.guardrails?.maxRefundAmount ?? 0), handoffKeywords: kw.split(",").map((s: string) => s.trim()).filter(Boolean) },
        },
      });
      setSaved(true);
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <fieldset disabled={readOnly} className="plain-fieldset">
      <div className="grid2">
        <Card title="Identity & behaviour">
          <label>Name<input value={a.name} onChange={(e) => set("name", e.target.value)} /></label>
          <label>Persona<textarea rows={3} value={a.persona} onChange={(e) => set("persona", e.target.value)} /></label>
          <label>Store-specific instructions<textarea rows={8} value={a.instructions} placeholder="e.g. We ship from Berlin. Offer 10% code SORRY10 when an order is late. Never promise delivery dates." onChange={(e) => set("instructions", e.target.value)} /></label>
          <label>Greeting<input value={a.greeting} onChange={(e) => set("greeting", e.target.value)} /></label>
          <div className="row wrap">
            <label>Language<input value={a.language} onChange={(e) => set("language", e.target.value)} placeholder="auto" /></label>
            <label>Reasoning effort
              <select value={a.effort} onChange={(e) => set("effort", e.target.value)}>
                <option value="low">low (fastest)</option><option value="medium">medium</option><option value="high">high (most careful)</option>
              </select>
            </label>
          </div>
          <label className="check"><input type="checkbox" checked={a.autoReply} onChange={(e) => set("autoReply", e.target.checked)} /> Auto-reply to customers</label>
          <label className="check"><input type="checkbox" checked={a.isDefault} onChange={(e) => set("isDefault", e.target.checked)} /> Default agent for new conversations</label>
        </Card>
        <Card title="What the agent may do">
          <table>
            <tbody>
              {tools.map((t) => {
                const p = a.toolPolicies?.[t.name] ?? t.defaultPolicy;
                return (
                  <tr key={t.name}>
                    <td><b>{t.name.replace(/_/g, " ")}</b><div className="muted small">{t.description.match(/^.*?[.!?](\s|$)/)?.[0] ?? t.description}</div></td>
                    <td>
                      <select value={p} onChange={(e) => set("toolPolicies", { ...a.toolPolicies, [t.name]: e.target.value })}>
                        <option value="AUTO">Allowed</option><option value="APPROVAL">Needs approval</option><option value="DISABLED">Off</option>
                      </select>
                    </td>
                    <td><Badge value={p} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <h4>Guardrails</h4>
          <label>Refunds above this amount always need approval
            <input type="number" min={0} value={a.guardrails?.maxRefundAmount ?? ""} onChange={(e) => set("guardrails", { ...a.guardrails, maxRefundAmount: e.target.value })} />
          </label>
          <label>Hand off to a human when the customer says (comma separated)<input value={kw} onChange={(e) => setKw(e.target.value)} /></label>
          <h4>Widget</h4>
          <div className="row wrap">
            <label>Colour<input type="color" value={a.widgetTheme?.primaryColor ?? "#4f46e5"} onChange={(e) => set("widgetTheme", { ...a.widgetTheme, primaryColor: e.target.value })} /></label>
            <label>Position
              <select value={a.widgetTheme?.position ?? "right"} onChange={(e) => set("widgetTheme", { ...a.widgetTheme, position: e.target.value })}><option>right</option><option>left</option></select>
            </label>
          </div>
        </Card>
      </div>
      <ErrorText error={error} />
      {!readOnly && <div className="row"><button className="primary" onClick={save}>Save agent</button>{saved && <span className="muted">Saved ✓</span>}</div>}
    </fieldset>
  );
}
