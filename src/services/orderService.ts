import { v4 as uuidv4 } from 'uuid';
import { Pool } from 'pg';
import { CreateOrderInput, Order, OrderStatus, PaginatedResult } from '../types';

interface Cursor {
  createdAt: string;
  id: string;
}

function encodeCursor(order: Pick<Order, 'created_at' | 'id'>): string {
  const cursor: Cursor = { createdAt: order.created_at, id: order.id };
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}

function decodeCursor(raw: string): Cursor {
  try {
    const decoded = JSON.parse(Buffer.from(raw, 'base64url').toString('utf-8'));
    if (typeof decoded.createdAt !== 'string' || typeof decoded.id !== 'string') {
      throw new Error('malformed cursor');
    }
    return decoded;
  } catch {
    throw new InvalidCursorError();
  }
}

export class InvalidCursorError extends Error {
  constructor() {
    super('Invalid or corrupted pagination cursor');
    this.name = 'InvalidCursorError';
  }
}

export class OrderService {
  constructor(private readonly db: Pool) {}

  async createOrder(input: CreateOrderInput, idempotencyKey: string | null): Promise<Order> {
    const id = uuidv4();
    const result = await this.db.query<Order>(
      `INSERT INTO orders (id, customer_email, item, quantity, amount_cents, status, idempotency_key)
       VALUES ($1, $2, $3, $4, $5, 'pending', $6)
       RETURNING *`,
      [id, input.customer_email, input.item, input.quantity, input.amount_cents, idempotencyKey]
    );
    return result.rows[0];
  }

  async getOrderById(id: string): Promise<Order | null> {
    const result = await this.db.query<Order>(`SELECT * FROM orders WHERE id = $1`, [id]);
    return result.rows[0] ?? null;
  }

  async updateStatus(id: string, status: OrderStatus): Promise<Order | null> {
    const result = await this.db.query<Order>(
      `UPDATE orders SET status = $2, updated_at = now() WHERE id = $1 RETURNING *`,
      [id, status]
    );
    return result.rows[0] ?? null;
  }

  /**
   * Keyset ("cursor") pagination, not OFFSET/LIMIT.
   *
   * OFFSET pagination degrades badly at scale: fetching page 10,000 still
   * requires the database to scan and discard everything before it, and
   * results can shift under you if rows are inserted between page loads.
   * Keyset pagination instead seeks directly to "everything strictly after
   * the last row the client saw", using an index on (created_at, id) - O(log n)
   * regardless of how deep you paginate, and stable under concurrent inserts.
   */
  async listOrders(limit: number, cursorRaw: string | null): Promise<PaginatedResult<Order>> {
    const safeLimit = Math.min(Math.max(limit, 1), 100);

    let rows: Order[];
    if (cursorRaw) {
      const cursor = decodeCursor(cursorRaw);
      const result = await this.db.query<Order>(
        `SELECT * FROM orders
         WHERE (created_at, id) < ($1, $2)
         ORDER BY created_at DESC, id DESC
         LIMIT $3`,
        [cursor.createdAt, cursor.id, safeLimit + 1]
      );
      rows = result.rows;
    } else {
      const result = await this.db.query<Order>(
        `SELECT * FROM orders ORDER BY created_at DESC, id DESC LIMIT $1`,
        [safeLimit + 1]
      );
      rows = result.rows;
    }

    const hasMore = rows.length > safeLimit;
    const page = rows.slice(0, safeLimit);
    const nextCursor = hasMore ? encodeCursor(page[page.length - 1]) : null;

    return { items: page, nextCursor, limit: safeLimit };
  }
}
