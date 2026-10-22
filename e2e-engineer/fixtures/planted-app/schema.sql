-- Schema for the planted-app fixture. Applied by scripts/env.mjs when it seeds a test database.
-- Accounts and seed data are fake and exist only for tests.

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'manager', 'staff')),
  tenant TEXT NOT NULL
);

CREATE TABLE orders (
  id TEXT PRIMARY KEY,
  tenant TEXT NOT NULL,
  owner TEXT NOT NULL REFERENCES users (id),
  item TEXT NOT NULL,
  total REAL NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved')),
  approvals INTEGER NOT NULL DEFAULT 0 CHECK (approvals >= 0)
);
