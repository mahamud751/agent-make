import type { OrderStatus, PaymentStatus, IntegrationType } from "@prisma/client";

/** Normalised order shape every connector returns — the agent only ever sees this. */
export interface OrderDTO {
  id: string;
  externalId?: string | null;
  number: string;
  source: IntegrationType;
  status: OrderStatus;
  paymentStatus: PaymentStatus;
  currency: string;
  subtotal: number;
  shippingTotal: number;
  total: number;
  refundedTotal: number;
  customerEmail?: string | null;
  customerName?: string | null;
  customerExternalId?: string | null;
  shippingAddress?: Address | null;
  trackingNumber?: string | null;
  carrier?: string | null;
  items: { sku: string; name: string; quantity: number; unitPrice: number }[];
  placedAt: string;
}

export interface Address {
  name?: string;
  line1: string;
  line2?: string;
  city: string;
  state?: string;
  postalCode: string;
  country: string;
  phone?: string;
}

export interface ProductDTO {
  id: string;
  sku: string;
  name: string;
  description?: string;
  price: number;
  currency: string;
  stock: number;
  url?: string;
}

export interface NewOrderInput {
  customer: { email: string; name?: string; phone?: string };
  items: { sku: string; quantity: number }[];
  shippingAddress?: Address;
  notes?: string;
}

/**
 * Every e-commerce backend a tenant connects implements this.
 * `actor` is recorded in order history ("agent:<id>", "user:<id>", ...).
 */
export interface CommerceConnector {
  readonly type: IntegrationType;
  getOrderByNumber(number: string): Promise<OrderDTO | null>;
  listOrdersByEmail(email: string, limit?: number): Promise<OrderDTO[]>;
  cancelOrder(order: OrderDTO, reason: string, actor: string): Promise<OrderDTO>;
  refundOrder(order: OrderDTO, amount: number, reason: string, actor: string): Promise<OrderDTO>;
  updateShippingAddress(order: OrderDTO, address: Address, actor: string): Promise<OrderDTO>;
  searchProducts(query: string, limit?: number): Promise<ProductDTO[]>;
  getProductBySku(sku: string): Promise<ProductDTO | null>;
  createOrder?(input: NewOrderInput, actor: string): Promise<OrderDTO>;
}

export class ConnectorError extends Error {
  constructor(message: string, public retryable = false) {
    super(message);
  }
}
