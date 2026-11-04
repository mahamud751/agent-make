import { useState } from "react";
import { api } from "../api";
import { useApi } from "../hooks";
import { Card, Empty, Page, money } from "../components/ui";

export function ProductsPage() {
  const [search, setSearch] = useState("");
  const { data, reload } = useApi<any[]>(`/products${search ? `?search=${encodeURIComponent(search)}` : ""}`, [search]);
  const add = async () => {
    const sku = prompt("SKU?");
    const name = sku && prompt("Name?");
    const price = name && Number(prompt("Price?"));
    if (!sku || !name || !price) return;
    await api("/products", { body: { sku, name, price, stock: Number(prompt("Stock?") ?? 0) } });
    reload();
  };
  return (
    <Page title="Products" actions={<><input placeholder="Search" value={search} onChange={(e) => setSearch(e.target.value)} /><button onClick={add}>+ Product</button></>}>
      <p className="muted">Native catalogue. Sync it from your site with <code>PUT /v1/products</code>, or connect Shopify/WooCommerce to use theirs live.</p>
      <Card>
        {data?.length === 0 ? <Empty>No products.</Empty> : (
          <table>
            <thead><tr><th>SKU</th><th>Name</th><th>Price</th><th>Stock</th><th /></tr></thead>
            <tbody>
              {data?.map((p) => (
                <tr key={p.id} className={p.active ? "" : "muted"}>
                  <td><code>{p.sku}</code></td><td>{p.name}</td><td>{money(Number(p.price), p.currency)}</td>
                  <td>{p.stock}</td>
                  <td><button className="link" onClick={async () => { const s = prompt("New stock level", String(p.stock)); if (s !== null) { await api(`/products/${p.id}`, { method: "PATCH", body: { stock: Number(s) } }); reload(); } }}>edit stock</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </Page>
  );
}
