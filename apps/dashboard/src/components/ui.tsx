import type { ReactNode } from "react";

export const Page = ({ title, actions, children }: { title: string; actions?: ReactNode; children: ReactNode }) => (
  <div className="page">
    <div className="page-head">
      <h1>{title}</h1>
      <div className="row">{actions}</div>
    </div>
    {children}
  </div>
);

export const Card = ({ title, children, actions }: { title?: string; children: ReactNode; actions?: ReactNode }) => (
  <section className="card">
    {(title || actions) && (
      <div className="card-head">
        <h3>{title}</h3>
        {actions}
      </div>
    )}
    {children}
  </section>
);

const tone: Record<string, string> = {
  OPEN: "blue", PENDING_HUMAN: "amber", RESOLVED: "green", PENDING: "amber", CONFIRMED: "blue", PROCESSING: "blue", SHIPPED: "violet",
  DELIVERED: "green", CANCELLED: "gray", REFUNDED: "gray", ON_HOLD: "amber", PAID: "green", UNPAID: "amber", PARTIALLY_REFUNDED: "violet",
  FAILED: "red", APPROVED: "green", REJECTED: "red", EXECUTED: "green", AUTO: "green", APPROVAL: "amber", DISABLED: "gray",
};
export const Badge = ({ value }: { value: string }) => <span className={`badge ${tone[value] ?? "gray"}`}>{value.replace(/_/g, " ").toLowerCase()}</span>;

export const Empty = ({ children }: { children: ReactNode }) => <div className="empty">{children}</div>;
export const ErrorText = ({ error }: { error: string | null }) => (error ? <div className="error">{error}</div> : null);

export const money = (n: number, c = "USD") => new Intl.NumberFormat(undefined, { style: "currency", currency: c }).format(n);
export const when = (d: string | Date) => new Date(d).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
export const ago = (d: string | Date) => {
  const s = (Date.now() - new Date(d).getTime()) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};
