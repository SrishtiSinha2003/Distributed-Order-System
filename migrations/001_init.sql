CREATE TABLE IF NOT EXISTS orders (
  id UUID PRIMARY KEY,
  customer_email TEXT NOT NULL,
  item TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'dead_letter')),
  idempotency_key TEXT UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Supports the keyset pagination query: WHERE (created_at, id) < ($1, $2)
-- ORDER BY created_at DESC, id DESC. Without this composite index, every
-- "next page" fetch on a large table degrades into a sequential scan.
CREATE INDEX IF NOT EXISTS idx_orders_created_at_id ON orders (created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_orders_status ON orders (status);
