import type { OrderStatus } from "@prisma/client";
import type { OrderDTO } from "../../connectors/types";

/** Allowed status transitions for natively-managed orders. */
export const TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  PENDING: ["CONFIRMED", "CANCELLED", "ON_HOLD"],
  CONFIRMED: ["PROCESSING", "CANCELLED", "ON_HOLD"],
  PROCESSING: ["SHIPPED", "CANCELLED", "ON_HOLD"],
  ON_HOLD: ["CONFIRMED", "PROCESSING", "CANCELLED"],
  SHIPPED: ["DELIVERED"],
  DELIVERED: ["REFUNDED"],
  CANCELLED: [],
  REFUNDED: [],
};

export const canTransition = (from: OrderStatus, to: OrderStatus) => TRANSITIONS[from].includes(to);

export const CANCELLABLE: OrderStatus[] = ["PENDING", "CONFIRMED", "PROCESSING", "ON_HOLD"];
export const ADDRESS_EDITABLE: OrderStatus[] = ["PENDING", "CONFIRMED", "PROCESSING", "ON_HOLD"];

export function cancelBlocker(o: OrderDTO): string | null {
  if (!CANCELLABLE.includes(o.status)) return `Order ${o.number} is ${o.status} and can no longer be cancelled.`;
  return null;
}

export function refundBlocker(o: OrderDTO, amount: number): string | null {
  if (o.paymentStatus !== "PAID" && o.paymentStatus !== "PARTIALLY_REFUNDED") return `Order ${o.number} has no captured payment to refund.`;
  if (amount <= 0) return "Refund amount must be positive.";
  const refundable = round2(o.total - o.refundedTotal);
  if (amount > refundable) return `Maximum refundable amount is ${refundable.toFixed(2)} ${o.currency}.`;
  return null;
}

export function addressBlocker(o: OrderDTO): string | null {
  if (!ADDRESS_EDITABLE.includes(o.status)) return `Order ${o.number} is already ${o.status}; the address can't be changed.`;
  return null;
}

export const round2 = (n: number) => Math.round(n * 100) / 100;
