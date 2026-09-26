import { OrderService, InvalidCursorError } from '../../src/services/orderService';
import { Order } from '../../src/types';

function makeOrder(overrides: Partial<Order>): Order {
  return {
    id: 'id-0',
    customer_email: 'a@example.com',
    item: 'widget',
    quantity: 1,
    amount_cents: 100,
    status: 'pending',
    idempotency_key: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides
  };
}

function mockPool(rows: Order[]) {
  return { query: jest.fn().mockResolvedValue({ rows }) } as never;
}

describe('OrderService.listOrders (keyset pagination)', () => {
  it('returns nextCursor=null when there are fewer rows than the limit', async () => {
    const rows = [makeOrder({ id: '1' }), makeOrder({ id: '2' })];
    const pool = mockPool(rows);
    const service = new OrderService(pool);

    const result = await service.listOrders(20, null);

    expect(result.items).toHaveLength(2);
    expect(result.nextCursor).toBeNull();
  });

  it('fetches limit+1 rows to detect if another page exists, and trims the extra row', async () => {
    const limit = 2;
    // 3 rows returned for a limit of 2 -> a next page exists.
    const rows = [makeOrder({ id: '3' }), makeOrder({ id: '2' }), makeOrder({ id: '1' })];
    const pool = mockPool(rows);
    const service = new OrderService(pool);

    const result = await service.listOrders(limit, null);

    expect(result.items).toHaveLength(2);
    expect(result.items.map((o) => o.id)).toEqual(['3', '2']);
    expect(result.nextCursor).not.toBeNull();

    const [sql, params] = (pool as { query: jest.Mock }).query.mock.calls[0];
    expect(sql).toContain('LIMIT $1');
    expect(params).toEqual([3]); // limit + 1
  });

  it('encodes a cursor from the last row and uses it to seek the next page', async () => {
    const rows = [makeOrder({ id: '2', created_at: '2026-01-02T00:00:00.000Z' })];
    const pool = mockPool(rows);
    const service = new OrderService(pool);

    const firstPage = await service.listOrders(1, null);
    expect(firstPage.nextCursor).toBeNull(); // only 1 row for limit 1+1=2 requested but mock returns 1

    // Manually decode-safe roundtrip: a well-formed cursor should be accepted
    // without throwing, and should be passed through to the WHERE clause.
    const cursor = Buffer.from(
      JSON.stringify({ createdAt: '2026-01-02T00:00:00.000Z', id: '2' })
    ).toString('base64url');

    await service.listOrders(10, cursor);
    const [sql, params] = (pool as { query: jest.Mock }).query.mock.calls[1];
    expect(sql).toContain('WHERE (created_at, id) < ($1, $2)');
    expect(params).toEqual(['2026-01-02T00:00:00.000Z', '2', 11]);
  });

  it('rejects a malformed cursor with InvalidCursorError instead of hitting the DB with garbage', async () => {
    const pool = mockPool([]);
    const service = new OrderService(pool);

    await expect(service.listOrders(10, 'not-valid-base64url-json')).rejects.toBeInstanceOf(
      InvalidCursorError
    );
  });

  it('clamps limit to a sane maximum to prevent a client from requesting the entire table', async () => {
    const pool = mockPool([]);
    const service = new OrderService(pool);

    await service.listOrders(10_000, null);
    const [, params] = (pool as { query: jest.Mock }).query.mock.calls[0];
    expect(params[0]).toBe(101); // clamped to 100 + 1
  });
});
