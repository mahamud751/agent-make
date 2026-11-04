import { useState } from "react";
import { api } from "../api";
import { useApi } from "../hooks";
import { Card, ErrorText, Page, when } from "../components/ui";

const TYPES = {
  SHOPIFY: { label: "Shopify", fields: [["shopDomain", "your-store.myshopify.com"], ["accessToken", "Admin API access token"], ["webhookSecret", "Webhook signing secret"]] },
  WOOCOMMERCE: { label: "WooCommerce", fields: [["siteUrl", "https://shop.example.com"], ["consumerKey", "ck_…"], ["consumerSecret", "cs_…"], ["webhookSecret", "Webhook secret"]] },
  CUSTOM_WEBHOOK: { label: "Custom website / backend", fields: [["endpointUrl", "https://api.yoursite.com/agentdesk"]] },
} as const;

export function IntegrationsPage() {
  const list = useApi<any[]>("/integrations");
  const [type, setType] = useState<keyof typeof TYPES | null>(null);
  const [cfg, setCfg] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const connect = async () => {
    setError(null);
    try {
      const r = await api("/integrations", { body: { type, config: Object.fromEntries(Object.entries(cfg).filter(([, v]) => v)) } });
      if (r.signingSecret) setSecret(r.signingSecret);
      setType(null);
      setCfg({});
      list.reload();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <Page title="Integrations">
      <p className="muted">Connect where your orders live. Without an integration the agent uses AgentDesk's built-in order system (push orders via the API).</p>
      {secret && <Card title="Signing secret — copy it now"><code className="secret">{secret}</code><p className="muted">Verify the <code>X-AgentDesk-Signature</code> header on your endpoint with this secret. See docs/INTEGRATION.md.</p></Card>}
      <div className="cards3">
        {(Object.keys(TYPES) as (keyof typeof TYPES)[]).map((t) => (
          <Card key={t} title={TYPES[t].label}>
            <button onClick={() => setType(t)}>Connect</button>
          </Card>
        ))}
      </div>
      {type && (
        <Card title={`Connect ${TYPES[type].label}`}>
          {TYPES[type].fields.map(([k, ph]) => (
            <label key={k}>{k}<input placeholder={ph} value={cfg[k] ?? ""} onChange={(e) => setCfg({ ...cfg, [k]: e.target.value })} /></label>
          ))}
          <ErrorText error={error} />
          <div className="row"><button className="primary" onClick={connect}>Save</button><button onClick={() => setType(null)}>Cancel</button></div>
        </Card>
      )}
      <Card title="Connected">
        <table>
          <tbody>
            {list.data?.map((i) => (
              <tr key={i.id}>
                <td><b>{i.name}</b><div className="muted small">{i.type}</div></td>
                <td>{i.active ? "active" : "paused"}</td>
                <td className="muted small">{i.lastSyncAt ? `synced ${when(i.lastSyncAt)}` : "never synced"}{i.lastError && <div className="error">{i.lastError}</div>}</td>
                <td className="small">{i.inboundWebhookUrl && <>Webhook URL: <code>{i.inboundWebhookUrl}</code></>}</td>
                <td className="row">
                  <button onClick={async () => { try { const r = await api(`/integrations/${i.id}/test`, { body: {} }); alert(`Connection OK (${r.sampleProducts} products found)`); } catch (e) { alert((e as Error).message); } list.reload(); }}>Test</button>
                  <button onClick={async () => { await api(`/integrations/${i.id}`, { method: "PATCH", body: { active: !i.active } }); list.reload(); }}>{i.active ? "Pause" : "Resume"}</button>
                  <button onClick={async () => { if (confirm("Disconnect?")) { await api(`/integrations/${i.id}`, { method: "DELETE" }); list.reload(); } }}>Remove</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </Page>
  );
}
