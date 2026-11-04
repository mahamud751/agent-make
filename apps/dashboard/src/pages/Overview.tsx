import { Link } from "react-router-dom";
import { useApi } from "../hooks";
import { Card, ErrorText, Page, money } from "../components/ui";

export function OverviewPage() {
  const { data, error } = useApi("/analytics/overview?days=30");
  const billing = useApi("/billing");
  const pending = useApi<any[]>("/approvals?status=PENDING");
  if (!data) return <Page title="Overview"><ErrorText error={error} />Loading…</Page>;
  const used = billing.data?.usage?.ai_replies ?? 0;
  const limit = billing.data?.limits?.aiRepliesPerMonth ?? 1;
  const revenue = data.orders.reduce((s: number, o: any) => s + o.revenue, 0);
  const max = Math.max(1, ...data.daily.map((d: any) => d.conversations));
  return (
    <Page title="Overview">
      <div className="stats">
        <Stat label="Conversations (30d)" value={data.conversations.total} />
        <Stat label="Handled fully by AI" value={`${data.automationRate}%`} />
        <Stat label="Waiting for a human" value={data.conversations.byStatus.PENDING_HUMAN ?? 0} link="/inbox?status=PENDING_HUMAN" />
        <Stat label="Pending approvals" value={pending.data?.length ?? 0} link="/approvals" />
        <Stat label="Order revenue (30d)" value={money(revenue)} />
        <Stat label="Avg AI reply time" value={`${(data.ai.avgLatencyMs / 1000).toFixed(1)}s`} />
      </div>
      <div className="grid2">
        <Card title="Conversations per day">
          <div className="bars">
            {data.daily.length === 0 && <div className="muted">No conversations yet — install the widget from Developers.</div>}
            {data.daily.map((d: any) => (
              <div key={d.day} className="bar" title={`${d.day}: ${d.conversations}`} style={{ height: `${(d.conversations / max) * 100}%` }} />
            ))}
          </div>
        </Card>
        <Card title="AI usage this month">
          <div className="meter"><div style={{ width: `${Math.min(100, (used / limit) * 100)}%` }} /></div>
          <p>{used.toLocaleString()} / {limit.toLocaleString()} AI replies</p>
          <p className="muted">{data.ai.runs} agent runs · {(data.ai.inputTokens + data.ai.outputTokens).toLocaleString()} tokens · {data.ai.cacheReadTokens.toLocaleString()} served from prompt cache</p>
          <Link to="/settings/billing">Manage plan →</Link>
        </Card>
      </div>
    </Page>
  );
}

const Stat = ({ label, value, link }: { label: string; value: React.ReactNode; link?: string }) => {
  const body = (
    <div className="stat">
      <div className="stat-v">{value}</div>
      <div className="stat-l">{label}</div>
    </div>
  );
  return link ? <Link to={link} className="plain">{body}</Link> : body;
};
