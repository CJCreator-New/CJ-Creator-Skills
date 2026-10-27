// Checks that the planted-app behaves as its manifest says: the defects happen when their flags are on
// and do not happen in the clean control. These are the API-level defects, which need no browser.

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { createFixtureServer, FLAGS, parsePlanted } from '../fixtures/planted-app/server.mjs';
import { seededDatabase } from './helpers.mjs';

// Each server gets its own seeded database, so one test's writes never reach another.
async function start(planted) {
  const db = seededDatabase();
  const { server } = createFixtureServer({ planted, dbFile: db.file });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const stop = () =>
    new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections();
      db.cleanup();
    });
  return { base, stop };
}

async function call(base, method, path, { token, body } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const json = await res.json().catch(() => null);
  return { status: res.status, body: json };
}

async function signIn(base, username, password) {
  const res = await call(base, 'POST', '/api/login', { body: { username, password } });
  assert.equal(res.status, 200, `sign-in failed for ${username}`);
  return res.body.token;
}

test('parsePlanted reads all, none, a list, and refuses an unknown flag', () => {
  assert.deepEqual([...parsePlanted('all')].sort(), [...FLAGS].sort());
  assert.equal(parsePlanted('none').size, 0);
  assert.deepEqual([...parsePlanted('dead-export-button, small-touch-target')].sort(), ['dead-export-button', 'small-touch-target']);
  assert.throws(() => parsePlanted('made-up-flag'), /unknown planted flag: made-up-flag/);
});

describe('clean control (PLANTED=none)', () => {
  let app;
  let staff;
  let manager;
  let outsider;
  before(async () => {
    app = await start(new Set());
    staff = await signIn(app.base, 'staff', 'staff-pass');
    manager = await signIn(app.base, 'manager', 'manager-pass');
    outsider = await signIn(app.base, 'outsider', 'outsider-pass');
  });
  after(() => app.stop());

  test('publishes no planted flags to the page', async () => {
    const res = await fetch(`${app.base}/config.js`);
    assert.equal(await res.text(), 'window.PLANTED = [];');
  });

  test('a staff member cannot approve, even when the order is not theirs', async () => {
    const res = await call(app.base, 'POST', '/api/orders/o-4/approve', { token: staff });
    assert.equal(res.status, 403);
  });

  test('a manager cannot approve an order over 1000, which needs an admin', async () => {
    const res = await call(app.base, 'POST', '/api/orders/o-2/approve', { token: manager });
    assert.equal(res.status, 403);
    assert.match(res.body.error.message, /director approval/);
  });

  test('a manager cannot read or approve an order in another tenant', async () => {
    assert.equal((await call(app.base, 'GET', '/api/orders/o-3', { token: manager })).status, 404);
    assert.equal((await call(app.base, 'POST', '/api/orders/o-3/approve', { token: manager })).status, 404);
  });

  test('rejects an order with a negative total or a missing item, with the field named', async () => {
    const negative = await call(app.base, 'POST', '/api/orders', { token: staff, body: { item: 'Pen', total: -5 } });
    assert.equal(negative.status, 422);
    assert.equal(negative.body.error.field, 'total');
    const blank = await call(app.base, 'POST', '/api/orders', { token: staff, body: { item: '  ', total: 5 } });
    assert.equal(blank.body.error.field, 'item');
  });

  test('returns total as a number, as the contract says', async () => {
    const res = await call(app.base, 'GET', '/api/orders/o-1', { token: staff });
    assert.equal(typeof res.body.order.total, 'number');
  });

  test('two concurrent approvals of one order: one succeeds and the other is a conflict', async () => {
    const results = await Promise.all([
      call(app.base, 'POST', '/api/orders/o-1/approve', { token: manager }),
      call(app.base, 'POST', '/api/orders/o-1/approve', { token: manager }),
    ]);
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
    const current = await call(app.base, 'GET', '/api/orders/o-1', { token: manager });
    assert.equal(current.body.order.approvals, 1);
  });

  test('a request without a token is refused', async () => {
    assert.equal((await call(app.base, 'GET', '/api/orders')).status, 401);
  });
});

describe('planted defects (PLANTED=all)', () => {
  let app;
  let staff;
  let manager;
  before(async () => {
    app = await start(new Set(FLAGS));
    staff = await signIn(app.base, 'staff', 'staff-pass');
    manager = await signIn(app.base, 'manager', 'manager-pass');
  });
  after(() => app.stop());

  test('publishes every flag to the page', async () => {
    const res = await fetch(`${app.base}/config.js`);
    assert.match(await res.text(), /dead-export-button/);
  });

  test('defect 3: a staff member can approve an order by calling the API directly', async () => {
    const res = await call(app.base, 'POST', '/api/orders/o-4/approve', { token: staff });
    assert.equal(res.status, 200);
  });

  test('defect 5: a manager can approve an order over 1000', async () => {
    const res = await call(app.base, 'POST', '/api/orders/o-2/approve', { token: manager });
    assert.equal(res.status, 200);
  });

  test('defect 4: a manager reads an order in another tenant', async () => {
    const res = await call(app.base, 'GET', '/api/orders/o-3', { token: manager });
    assert.equal(res.status, 200);
    assert.equal(res.body.order.tenant, undefined);
  });

  test('defect 2: an order with a negative total is accepted', async () => {
    const res = await call(app.base, 'POST', '/api/orders', { token: staff, body: { item: 'Pen', total: -5 } });
    assert.equal(res.status, 201);
  });

  test('defect 7: total is returned as a string, against the contract', async () => {
    const res = await call(app.base, 'GET', '/api/orders/o-1', { token: staff });
    assert.equal(res.body.order.total, '500');
  });

  test('defect 6: two concurrent approvals of one order both succeed', async () => {
    const results = await Promise.all([
      call(app.base, 'POST', '/api/orders/o-1/approve', { token: manager }),
      call(app.base, 'POST', '/api/orders/o-1/approve', { token: manager }),
    ]);
    assert.deepEqual(results.map((r) => r.status), [200, 200]);
    const current = await call(app.base, 'GET', '/api/orders/o-1', { token: manager });
    assert.equal(current.body.order.approvals, 2);
  });
});

test('the approval of an order is one-time in the clean control, and that is what the contract says', async () => {
  const app = await start(new Set());
  try {
    const manager = await signIn(app.base, 'manager', 'manager-pass');
    assert.equal((await call(app.base, 'POST', '/api/orders/o-1/approve', { token: manager })).status, 200);
    assert.equal((await call(app.base, 'POST', '/api/orders/o-1/approve', { token: manager })).status, 409);
  } finally {
    await app.stop();
  }
});
