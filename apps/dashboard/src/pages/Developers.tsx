import { useState } from "react";
import { api } from "../api";
import { useApi } from "../hooks";
import { Card, Page, when } from "../components/ui";

const API_URL = import.meta.env.VITE_API_URL || window.location.origin;
const WIDGET_URL = import.meta.env.VITE_WIDGET_URL || `${API_URL}/agentdesk.js`;

export function DevelopersPage() {
  const keys = useApi<any[]>("/api-keys");
  const hooks = useApi<any[]>("/webhooks");
  const [shown, setShown] = useState<{ label: string; value: string } | null>(null);
  const pk = keys.data?.find((k) => k.kind === "PUBLISHABLE");

  const createKey = async (kind: "SECRET" | "PUBLISHABLE") => {
    const name = prompt("Key name?", kind === "SECRET" ? "Store backend" : "Website widget");
    if (!name) return;
    const origins = kind === "PUBLISHABLE" ? (prompt("Allowed origins (comma separated, blank = any)", "https://yourstore.com") ?? "") : "";
    const r = await api("/api-keys", { body: { name, kind, allowedOrigins: origins.split(",").map((s) => s.trim()).filter(Boolean) } });
    setShown({ label: `${kind.toLowerCase()} key — copy it now, it won't be shown again`, value: r.key });
    keys.reload();
  };
  const createHook = async () => {
    const url = prompt("Endpoint URL (https)");
    if (!url) return;
    const r = await api("/webhooks", { body: { url, events: ["*"] } });
    setShown({ label: "Webhook signing secret", value: r.secret });
    hooks.reload();
  };

  return (
    <Page title="Developers">
      {shown && <Card title={shown.label}><code className="secret">{shown.value}</code></Card>}
      <Card title="1 · Add the chat widget to your website">
        <pre>{`<script src="${WIDGET_URL}"
        data-key="${shown?.value.startsWith("pk_") ? shown.value : "pk_live_…"}"
        data-api="${API_URL}" async></script>`}</pre>
        <p className="muted small">Paste before <code>&lt;/body&gt;</code>. Logged-in shopper? add <code>data-email</code> / <code>data-name</code>. {pk ? `Your widget key starts with ${pk.prefix}…` : "Create a publishable key below."}</p>
      </Card>
      <Card title="2 · Sync orders from your backend (built-in order system)">
        <pre>{`curl -X POST ${API_URL}/v1/orders \\
  -H "Authorization: Bearer sk_live_…" -H "content-type: application/json" \\
  -d '{"number":"1042","customer":{"email":"sam@example.com","name":"Sam"},
       "items":[{"sku":"TENT-2P","quantity":1}],"paymentStatus":"PAID"}'`}</pre>
        <p className="muted small">Or connect Shopify / WooCommerce / your own endpoint under Integrations.</p>
      </Card>
      <Card title="3 · Use the agent from any channel">
        <pre>{`curl -X POST ${API_URL}/v1/messages -H "Authorization: Bearer sk_live_…" -H "content-type: application/json" \\
  -d '{"threadId":"user-42","content":"where is my order?","customer":{"email":"sam@example.com"},"customerVerified":true,"wait":true}'`}</pre>
      </Card>
      <Card title="API keys" actions={<div className="row"><button onClick={() => createKey("PUBLISHABLE")}>+ Publishable</button><button onClick={() => createKey("SECRET")}>+ Secret</button></div>}>
        <table>
          <tbody>
            {keys.data?.map((k) => (
              <tr key={k.id}>
                <td><b>{k.name}</b></td><td><code>{k.prefix}…</code></td><td>{k.kind.toLowerCase()}</td>
                <td className="muted small">{k.allowedOrigins.join(", ") || (k.kind === "PUBLISHABLE" ? "any origin" : "")}</td>
                <td className="muted small">{k.lastUsedAt ? `used ${when(k.lastUsedAt)}` : "never used"}</td>
                <td><button onClick={async () => { if (confirm("Revoke key?")) { await api(`/api-keys/${k.id}`, { method: "DELETE" }); keys.reload(); } }}>Revoke</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      <Card title="Webhooks (events → your server)" actions={<button onClick={createHook}>+ Endpoint</button>}>
        <table>
          <tbody>
            {hooks.data?.map((h) => (
              <tr key={h.id}><td><code>{h.url}</code></td><td>{h.events.join(", ")}</td><td><button onClick={async () => { await api(`/webhooks/${h.id}`, { method: "DELETE" }); hooks.reload(); }}>Delete</button></td></tr>
            ))}
          </tbody>
        </table>
      </Card>
    </Page>
  );
}
