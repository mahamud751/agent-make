import { Link } from "react-router-dom";
import { api } from "../api";
import { useApi, useRealtime } from "../hooks";
import { Badge, Card, Empty, Page, when } from "../components/ui";

export function ApprovalsPage() {
  const pending = useApi<any[]>("/approvals?status=PENDING");
  const recent = useApi<any[]>("/approvals");
  useRealtime(["action.pending", "action.decided"], () => { pending.reload(); recent.reload(); });
  const decide = async (id: string, verb: "approve" | "reject") => {
    const note = verb === "reject" ? prompt("Message to the customer (optional)") ?? undefined : undefined;
    await api(`/approvals/${id}/${verb}`, { body: { note } });
    pending.reload();
    recent.reload();
  };
  return (
    <Page title="Approvals">
      <p className="muted">Sensitive actions the AI proposed (refunds, cancellations…). Set which actions need approval per agent on the AI Agents page.</p>
      <Card title={`Waiting (${pending.data?.length ?? 0})`}>
        {pending.data?.length === 0 && <Empty>Nothing to review 🎉</Empty>}
        {pending.data?.map((a) => (
          <div key={a.id} className="approval">
            <div>
              <b>{a.tool.replace(/_/g, " ")}</b> <span className="muted">· {when(a.createdAt)}</span>
              <div><code>{JSON.stringify(Object.fromEntries(Object.entries(a.input).filter(([k]) => !k.startsWith("_"))))}</code></div>
              {a.input._verifiedEmail && <div className="muted small">verified customer: {a.input._verifiedEmail}</div>}
              {a.conversationId && <Link to={`/inbox/${a.conversationId}`} className="small">open conversation →</Link>}
            </div>
            <div className="row">
              <button className="primary" onClick={() => decide(a.id, "approve")}>Approve & run</button>
              <button onClick={() => decide(a.id, "reject")}>Reject</button>
            </div>
          </div>
        ))}
      </Card>
      <Card title="Recent decisions">
        <table>
          <tbody>
            {recent.data?.filter((a) => a.status !== "PENDING").slice(0, 30).map((a) => (
              <tr key={a.id}><td>{a.tool}</td><td><Badge value={a.status} /></td><td className="muted">{a.result?.message ?? a.result?.note ?? ""}</td><td className="muted">{a.decidedAt && when(a.decidedAt)}</td></tr>
            ))}
          </tbody>
        </table>
      </Card>
    </Page>
  );
}
