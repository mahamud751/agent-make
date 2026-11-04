import { useState } from "react";
import { api } from "../api";
import { useAuth } from "../auth";
import { useApi } from "../hooks";
import { Card, Page } from "../components/ui";

export function TeamPage() {
  const { me } = useAuth();
  const members = useApi<any[]>("/members");
  const [invite, setInvite] = useState<string | null>(null);
  const add = async () => {
    const email = prompt("Teammate email");
    if (!email) return;
    const role = prompt("Role: ADMIN, SUPPORT or VIEWER", "SUPPORT")?.toUpperCase();
    try {
      const r = await api("/members/invite", { body: { email, role } });
      setInvite(r.inviteUrl);
    } catch (e) {
      alert((e as Error).message);
    }
  };
  return (
    <Page title="Team" actions={<button onClick={add}>+ Invite</button>}>
      {invite && <Card title="Invite link (valid 7 days)"><code className="secret">{invite}</code></Card>}
      <Card>
        <table>
          <tbody>
            {members.data?.map((m) => (
              <tr key={m.id}>
                <td><b>{m.user.name}</b><div className="muted small">{m.user.email}</div></td>
                <td>
                  {me?.role === "OWNER" && m.user.id !== me.user.id ? (
                    <select value={m.role} onChange={async (e) => { await api(`/members/${m.id}`, { method: "PATCH", body: { role: e.target.value } }); members.reload(); }}>
                      {["OWNER", "ADMIN", "SUPPORT", "VIEWER"].map((r) => <option key={r}>{r}</option>)}
                    </select>
                  ) : m.role.toLowerCase()}
                </td>
                <td>{m.user.id !== me?.user.id && <button onClick={async () => { if (confirm("Remove member?")) { await api(`/members/${m.id}`, { method: "DELETE" }); members.reload(); } }}>Remove</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </Page>
  );
}
