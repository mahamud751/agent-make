import { api } from "../api";
import { useApi } from "../hooks";
import { Card, Page } from "../components/ui";

export function BillingPage() {
  const { data } = useApi("/billing");
  if (!data) return <Page title="Billing">Loading…</Page>;
  const go = async (path: string, body: unknown = {}) => {
    try {
      const r = await api(path, { body });
      location.href = r.url;
    } catch (e) {
      alert((e as Error).message);
    }
  };
  return (
    <Page title="Billing" actions={<button onClick={() => go("/billing/portal")}>Manage subscription</button>}>
      <Card title={`Current plan: ${data.plan} (${data.status.toLowerCase()})`}>
        <p>{(data.usage.ai_replies ?? 0).toLocaleString()} / {data.limits.aiRepliesPerMonth.toLocaleString()} AI replies used in {data.period}</p>
        <div className="meter"><div style={{ width: `${Math.min(100, ((data.usage.ai_replies ?? 0) / data.limits.aiRepliesPerMonth) * 100)}%` }} /></div>
      </Card>
      <div className="cards3">
        {(["FREE", "STARTER", "GROWTH"] as const).map((p) => {
          const l = data.plans[p];
          return (
            <Card key={p} title={`${p} — ${l.priceUsd ? `$${l.priceUsd}/mo` : "free"}`}>
              <ul>
                <li>{l.aiRepliesPerMonth.toLocaleString()} AI replies / month</li>
                <li>{l.agents} agents · {l.seats} seats · {l.integrations} integrations</li>
                <li>Channels: {l.channels.join(", ").toLowerCase().replace(/_/g, " ")}</li>
                <li>{l.automations ? "Automations included" : "No automations"}</li>
              </ul>
              {p !== "FREE" && p !== data.plan && <button className="primary" onClick={() => go("/billing/checkout", { plan: p })}>Upgrade</button>}
              {p === data.plan && <b>Current plan</b>}
            </Card>
          );
        })}
      </div>
    </Page>
  );
}
