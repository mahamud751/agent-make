import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, NavLink, Outlet, Route, Routes } from "react-router-dom";
import { AuthProvider, useAuth } from "./auth";
import { api } from "./api";
import "./styles.css";
import { LoginPage, SignupPage, AcceptInvitePage } from "./pages/Auth";
import { OverviewPage } from "./pages/Overview";
import { InboxPage } from "./pages/Inbox";
import { OrdersPage, OrderDetailPage } from "./pages/Orders";
import { ApprovalsPage } from "./pages/Approvals";
import { AgentsPage } from "./pages/Agents";
import { KnowledgePage } from "./pages/Knowledge";
import { IntegrationsPage } from "./pages/Integrations";
import { AutomationsPage } from "./pages/Automations";
import { DevelopersPage } from "./pages/Developers";
import { TeamPage } from "./pages/Team";
import { BillingPage } from "./pages/Billing";
import { ProductsPage } from "./pages/Products";

const NAV = [
  ["/", "Overview"],
  ["/inbox", "Inbox"],
  ["/approvals", "Approvals"],
  ["/orders", "Orders"],
  ["/products", "Products"],
  ["/agents", "AI Agents"],
  ["/knowledge", "Knowledge"],
  ["/automations", "Automations"],
  ["/integrations", "Integrations"],
  ["/developers", "Developers"],
  ["/team", "Team"],
  ["/settings/billing", "Billing"],
] as const;

function Shell() {
  const { me, ready, setToken } = useAuth();
  if (!ready) return <div className="center">Loading…</div>;
  if (!me) return <Navigate to="/login" replace />;
  const switchTo = async (tenantId: string) => {
    const r = await api<{ token: string }>("/auth/switch", { body: { tenantId } });
    await setToken(r.token);
  };
  return (
    <div className="shell">
      <aside>
        <div className="logo">◆ AgentDesk</div>
        {me.workspaces.length > 1 ? (
          <select value={me.tenant.id} onChange={(e) => switchTo(e.target.value)}>
            {me.workspaces.map((w) => (
              <option key={w.id} value={w.id}>{w.name}</option>
            ))}
          </select>
        ) : (
          <div className="ws">{me.tenant.name}</div>
        )}
        <nav>
          {NAV.map(([to, label]) => (
            <NavLink key={to} to={to} end={to === "/"}>{label}</NavLink>
          ))}
        </nav>
        <div className="me">
          <div>{me.user.name}</div>
          <small>{me.role.toLowerCase()} · {me.tenant.plan.toLowerCase()} plan</small>
          <button className="link" onClick={() => setToken(null)}>Sign out</button>
        </div>
      </aside>
      <main>
        <Outlet />
      </main>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/signup" element={<SignupPage />} />
          <Route path="/accept-invite" element={<AcceptInvitePage />} />
          <Route element={<Shell />}>
            <Route index element={<OverviewPage />} />
            <Route path="inbox" element={<InboxPage />} />
            <Route path="inbox/:id" element={<InboxPage />} />
            <Route path="approvals" element={<ApprovalsPage />} />
            <Route path="orders" element={<OrdersPage />} />
            <Route path="orders/:id" element={<OrderDetailPage />} />
            <Route path="products" element={<ProductsPage />} />
            <Route path="agents" element={<AgentsPage />} />
            <Route path="knowledge" element={<KnowledgePage />} />
            <Route path="automations" element={<AutomationsPage />} />
            <Route path="integrations" element={<IntegrationsPage />} />
            <Route path="developers" element={<DevelopersPage />} />
            <Route path="team" element={<TeamPage />} />
            <Route path="settings/billing" element={<BillingPage />} />
          </Route>
          <Route path="*" element={<Navigate to="/" />} />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  </StrictMode>,
);
