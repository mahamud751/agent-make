import { useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { api } from "../api";
import { useApi, useRealtime } from "../hooks";
import { Badge, Card, Empty, ErrorText, Page, money, when } from "../components/ui";

const STATUSES = ["PENDING", "CONFIRMED", "PROCESSING", "SHIPPED", "DELIVERED", "CANCELLED", "REFUNDED", "ON_HOLD"];

export function OrdersPage() {
  const [params, setParams] = useSearchParams();
  const status = params.get("status") ?? "";
  const [search, setSearch] = useState("");
  const q = new URLSearchParams({ limit: "50", ...(status ? { status } : {}), ...(search ? { search } : {}) });
  const { data, reload } = useApi<{ data: any[] }>(`/orders?${q}`, [status, search]);
  useRealtime(["order.created", "order.status_changed", "order.refunded", "order.updated"], () => reload());
  return (
    <Page title="Orders" actions={<input placeholder="Search # / email / name" value={search} onChange={(e) => setSearch(e.target.value)} />}>
      <div className="tabs">
        {["", ...STATUSES].map((s) => (
          <button key={s} className={status === s ? "active" : ""} onClick={() => setParams(s ? { status: s } : {})}>{s ? s.toLowerCase().replace("_", " ") : "all"}</button>
        ))}
      </div>
      <Card>
        {data?.data.length === 0 ? (
          <Empty>No orders yet. Orders arrive from your store integration or the Orders API.</Empty>
        ) : (
          <table>
            <thead><tr><th>#</th><th>Customer</th><th>Status</th><th>Payment</th><th>Total</th><th>Source</th><th>Placed</th></tr></thead>
            <tbody>
              {data?.data.map((o) => (
                <tr key={o.id}>
                  <td><Link to={`/orders/${o.id}`}>#{o.number}</Link></td>
                  <td>{o.customerName ?? o.customerEmail ?? "—"}</td>
                  <td><Badge value={o.status} /></td>
                  <td><Badge value={o.paymentStatus} /></td>
                  <td>{money(o.total, o.currency)}</td>
                  <td className="muted">{o.source.toLowerCase()}</td>
                  <td className="muted">{when(o.placedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </Page>
  );
}

export function OrderDetailPage() {
  const { id } = useParams();
  const { data, reload } = useApi(`/orders/${id}`, [id]);
  const [error, setError] = useState<string | null>(null);
  const [next, setNext] = useState("");
  const [tracking, setTracking] = useState({ trackingNumber: "", carrier: "" });
  if (!data) return <Page title="Order">Loading…</Page>;
  const run = async (path: string, body: unknown) => {
    setError(null);
    try {
      await api(`/orders/${id}/${path}`, { body });
      reload();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <Page title={`Order #${data.number}`} actions={<><Badge value={data.status} /><Badge value={data.paymentStatus} /></>}>
      <ErrorText error={error} />
      <div className="grid2">
        <Card title="Items">
          <table>
            <tbody>
              {data.items.map((i: any) => (
                <tr key={i.sku}><td>{i.quantity} ×</td><td>{i.name}<div className="muted small">{i.sku}</div></td><td>{money(i.unitPrice * i.quantity, data.currency)}</td></tr>
              ))}
              <tr><td /><td>Shipping</td><td>{money(data.shippingTotal, data.currency)}</td></tr>
              <tr><td /><td><b>Total</b></td><td><b>{money(data.total, data.currency)}</b>{data.refundedTotal > 0 && <div className="muted small">refunded {money(data.refundedTotal, data.currency)}</div>}</td></tr>
            </tbody>
          </table>
        </Card>
        <Card title="Customer & shipping">
          <p>{data.customerName}<br /><span className="muted">{data.customerEmail}</span></p>
          {data.shippingAddress && <p className="muted">{[data.shippingAddress.line1, data.shippingAddress.line2, data.shippingAddress.city, data.shippingAddress.state, data.shippingAddress.postalCode, data.shippingAddress.country].filter(Boolean).join(", ")}</p>}
          {data.trackingNumber && <p>Tracking: {data.carrier} {data.trackingNumber}</p>}
        </Card>
      </div>
      {data.source === "NATIVE" && (
        <Card title="Manage">
          <div className="row wrap">
            <select value={next} onChange={(e) => setNext(e.target.value)}>
              <option value="">Change status…</option>
              {STATUSES.map((s) => <option key={s}>{s}</option>)}
            </select>
            {next === "SHIPPED" && (
              <>
                <input placeholder="Carrier" value={tracking.carrier} onChange={(e) => setTracking({ ...tracking, carrier: e.target.value })} />
                <input placeholder="Tracking #" value={tracking.trackingNumber} onChange={(e) => setTracking({ ...tracking, trackingNumber: e.target.value })} />
              </>
            )}
            <button className="primary" disabled={!next} onClick={() => run("status", { status: next, ...(next === "SHIPPED" ? tracking : {}) })}>Update</button>
            <button onClick={() => { const r = prompt("Cancellation reason?"); if (r) run("cancel", { reason: r }); }}>Cancel order</button>
            <button onClick={() => { const a = Number(prompt("Refund amount?")); if (a > 0) run("refund", { amount: a, reason: "Manual refund" }); }}>Refund</button>
            {data.paymentStatus === "UNPAID" && <button onClick={() => run("payment", { paymentStatus: "PAID" })}>Mark paid</button>}
          </div>
        </Card>
      )}
      <Card title="History">
        {data.events.map((e: any) => (
          <div key={e.id} className="event"><b>{e.type.replace("_", " ")}</b> <span className="muted">by {e.actor} · {when(e.createdAt)}</span> {Object.keys(e.data ?? {}).length > 0 && <code>{JSON.stringify(e.data)}</code>}</div>
        ))}
      </Card>
    </Page>
  );
}
