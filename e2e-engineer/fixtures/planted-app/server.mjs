// A small order-approval app with planted defects, used to test the e2e-engineer. It is a fixture,
// not a product. Its passwords and seed data are fake and exist only for tests.
//
// Defects are switched on with the PLANTED environment variable: "all" (the default), "none" (the
// clean control), or a comma-separated list of flag names. The clean control is this same code with
// PLANTED=none, so the two cannot drift apart.

import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const HERE = dirname(fileURLToPath(import.meta.url));

export const FLAGS = [
  'dead-export-button',
  'missing-amount-validation',
  'ui-only-approve-permission',
  'object-level-access',
  'approval-skips-director',
  'approval-race',
  'contract-total-string',
  'hidden-failure-recovery',
  'responsive-table-overflow',
  'unlabelled-amount-input',
  'small-touch-target',
];

export function parsePlanted(value = process.env.PLANTED ?? 'all') {
  if (value === 'all') return new Set(FLAGS);
  if (value === 'none') return new Set();
  const names = value.split(',').map((name) => name.trim()).filter(Boolean);
  const unknown = names.filter((name) => !FLAGS.includes(name));
  if (unknown.length > 0) throw new Error(`unknown planted flag: ${unknown.join(', ')}`);
  return new Set(names);
}

// Fixture accounts. These passwords are fake and exist only for this test app.
const USERS = [
  { id: 'u-admin', username: 'admin', password: 'admin-pass', role: 'admin', tenant: 't1' },
  { id: 'u-mgr', username: 'manager', password: 'manager-pass', role: 'manager', tenant: 't1' },
  { id: 'u-staff', username: 'staff', password: 'staff-pass', role: 'staff', tenant: 't1' },
  { id: 'u-out', username: 'outsider', password: 'outsider-pass', role: 'manager', tenant: 't2' },
];

function seedOrders() {
  return [
    { id: 'o-1', tenant: 't1', owner: 'u-staff', item: 'Desk', total: 500, status: 'pending', approvals: 0 },
    { id: 'o-2', tenant: 't1', owner: 'u-staff', item: 'Server rack', total: 5000, status: 'pending', approvals: 0 },
    { id: 'o-3', tenant: 't2', owner: 'u-out', item: 'Chair', total: 100, status: 'pending', approvals: 0 },
    { id: 'o-4', tenant: 't1', owner: 'u-mgr', item: 'Monitor', total: 300, status: 'pending', approvals: 0 },
  ];
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function sendText(res, status, type, text) {
  res.writeHead(status, { 'content-type': type });
  res.end(text);
}

function fail(res, status, code, message, extra = {}) {
  send(res, status, { error: { code, message, ...extra } });
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString('utf8');
  if (text.trim() === '') return {};
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function view(order, { stringTotal = false } = {}) {
  const { tenant, ...rest } = order;
  return stringTotal ? { ...rest, total: String(order.total) } : rest;
}

// Creates a server with the given planted flags. Each server has its own seed data and sessions.
export function createFixtureServer({ planted = parsePlanted() } = {}) {
  const on = (flag) => planted.has(flag);
  const orders = seedOrders();
  const tokens = new Map();
  const index = readFileSync(join(HERE, 'public', 'index.html'), 'utf8');

  function currentUser(req) {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    const userId = token && tokens.get(token);
    return userId ? USERS.find((user) => user.id === userId) : null;
  }

  // Visibility is the tenant boundary. The object-level-access defect removes it for reads and writes.
  const visible = (user, order) => order.tenant === user.tenant;

  async function approve(user, id, res) {
    const order = orders.find((candidate) => candidate.id === id);
    if (!order) return fail(res, 404, 'not_found', 'no such order');
    if (!on('object-level-access') && !visible(user, order)) return fail(res, 404, 'not_found', 'no such order');
    if (!on('ui-only-approve-permission') && !['manager', 'admin'].includes(user.role)) {
      return fail(res, 403, 'forbidden', 'your role cannot approve orders');
    }
    if (order.owner === user.id) return fail(res, 403, 'forbidden', 'you cannot approve your own request');
    if (!on('approval-skips-director') && order.total > 1000 && user.role !== 'admin') {
      return fail(res, 403, 'forbidden', 'orders over 1000 need director approval');
    }
    if (order.status !== 'pending') return fail(res, 409, 'conflict', `order is ${order.status}`);
    if (on('approval-race')) {
      // The check above and the write below are separated by an await, so two requests can both pass.
      await delay(50);
    }
    order.approvals += 1;
    order.status = 'approved';
    return send(res, 200, view(order));
  }

  function createOrder(user, body, res) {
    const item = typeof body.item === 'string' ? body.item.trim() : '';
    const total = body.total;
    if (!on('missing-amount-validation')) {
      if (item === '') return fail(res, 422, 'validation', 'item is required', { field: 'item' });
      if (typeof total !== 'number' || !(total > 0)) {
        return fail(res, 422, 'validation', 'total must be a number greater than zero', { field: 'total' });
      }
    }
    const order = { id: `o-${orders.length + 1}`, tenant: user.tenant, owner: user.id, item, total, status: 'pending', approvals: 0 };
    orders.push(order);
    return send(res, 201, view(order));
  }

  async function api(req, res, url) {
    if (req.method === 'POST' && url.pathname === '/api/login') {
      const body = await readJson(req);
      const user = USERS.find((candidate) => candidate.username === body?.username && candidate.password === body?.password);
      if (!user) return fail(res, 401, 'unauthenticated', 'wrong username or password');
      const token = randomUUID();
      tokens.set(token, user.id);
      return send(res, 200, { token, user: { id: user.id, username: user.username, role: user.role } });
    }

    const user = currentUser(req);
    if (!user) return fail(res, 401, 'unauthenticated', 'sign in required');

    if (req.method === 'GET' && url.pathname === '/api/orders') {
      return send(res, 200, { orders: orders.filter((order) => visible(user, order)).map((order) => view(order)) });
    }
    if (req.method === 'POST' && url.pathname === '/api/orders') {
      const body = await readJson(req);
      if (body === null) return fail(res, 400, 'malformed', 'request body is not valid JSON');
      return createOrder(user, body, res);
    }

    const detail = url.pathname.match(/^\/api\/orders\/([^/]+)$/);
    if (req.method === 'GET' && detail) {
      const order = orders.find((candidate) => candidate.id === detail[1]);
      if (!order || (!on('object-level-access') && !visible(user, order))) return fail(res, 404, 'not_found', 'no such order');
      return send(res, 200, { order: view(order, { stringTotal: on('contract-total-string') }) });
    }

    const action = url.pathname.match(/^\/api\/orders\/([^/]+)\/approve$/);
    if (req.method === 'POST' && action) return approve(user, action[1], res);

    return fail(res, 404, 'not_found', 'no such route');
  }

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://fixture.local');
      if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, { status: 'ok' });
      if (req.method === 'GET' && url.pathname === '/config.js') {
        return sendText(res, 200, 'application/javascript', `window.PLANTED = ${JSON.stringify([...planted])};`);
      }
      if (url.pathname.startsWith('/api/')) return await api(req, res, url);
      if (req.method === 'GET') return sendText(res, 200, 'text/html; charset=utf-8', index);
      return fail(res, 405, 'method_not_allowed', 'method not allowed');
    } catch {
      return fail(res, 500, 'internal', 'server error');
    }
  });
  return { server, orders, planted };
}

// Starts the server when this file is run directly. PORT defaults to 4173.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const port = Number(process.env.PORT || 4173);
  const { server, planted } = createFixtureServer();
  server.listen(port, () => {
    console.log(`planted-app listening on ${port} with flags: ${[...planted].join(', ') || 'none'}`);
  });
}
