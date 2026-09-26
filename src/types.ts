export type OrderStatus = 'pending' | 'processing' | 'completed' | 'failed' | 'dead_letter';

export interface Order {
  id: string;
  customer_email: string;
  item: string;
  quantity: number;
  amount_cents: number;
  status: OrderStatus;
  idempotency_key: string | null;
  created_at: string; // ISO timestamp
  updated_at: string;
}

export interface CreateOrderInput {
  customer_email: string;
  item: string;
  quantity: number;
  amount_cents: number;
}

export interface PaginatedResult<T> {
  items: T[];
  nextCursor: string | null;
  limit: number;
}

export interface ProcessOrderJobData {
  orderId: string;
}

export interface SendConfirmationJobData {
  orderId: string;
  customerEmail: string;
}
