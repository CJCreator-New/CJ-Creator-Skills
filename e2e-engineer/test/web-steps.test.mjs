import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { ACTS, validateSteps, validateStep } from '../scripts/web-steps.mjs';

describe('the step vocabulary', () => {
  test('every act is accepted with the fields it needs', () => {
    const good = [
      { act: 'signIn', as: 'manager' },
      { act: 'goto', path: '#/orders' },
      { act: 'fill', label: 'Total', value: '5' },
      { act: 'click', role: 'button', name: 'Create' },
      { act: 'expectVisible', role: 'button', name: 'Approve' },
      { act: 'expectText', text: 'Could not approve' },
      { act: 'expectUrl', contains: '#/orders' },
      { act: 'expectTestId', testId: 'status', text: 'approved' },
      { act: 'expectDownload', role: 'button', name: 'Export', filename: 'orders.json' },
      { act: 'interceptNext', method: 'POST', path: '/api/orders/o-1/approve', status: 500 },
      { act: 'expectNotClipped', role: 'table' },
      { act: 'expectMinTarget', role: 'button', name: 'Approve', min: 44 },
      { act: 'scanA11y', rules: ['input-label', 'button-name'] },
      { act: 'expectResponse', role: 'button', name: 'Approve', method: 'POST', path: '/api/orders/o-1/approve', status: 200 },
    ];
    assert.deepEqual(good.map((s) => validateStep(s, 'x')), good.map(() => []));
    assert.deepEqual(ACTS.length, 15);
  });

  test('a backend check step is allowed in an e2e test case only, and is checked like any check', () => {
    const step = { act: 'check', check: { kind: 'db', query: "SELECT status FROM orders WHERE id = 'o-2'", expectRows: [{ status: 'pending' }] } };
    assert.deepEqual(validateStep(step, 'x', 'e2e'), []);
    assert.match(validateStep(step, 'x', 'web')[0], /allowed only in an e2e test case/);
    assert.match(validateStep({ act: 'check', check: { kind: 'probe' } }, 'x', 'e2e')[0], /needs an http or db check/);
    assert.match(validateStep({ act: 'check', check: { kind: 'db', query: 'DELETE FROM orders', expectRows: [] } }, 'x', 'e2e')[0], /^x: query must be one SELECT statement/);
  });

  test('an unknown act is refused, with the list of acts', () => {
    const [problem] = validateStep({ act: 'hover' }, 'TC-1 step 1');
    assert.match(problem, /TC-1 step 1: act must be one of signIn/);
  });

  test('a step with a missing field names the field', () => {
    assert.deepEqual(validateStep({ act: 'fill', label: 'Total' }, 'TC-1 step 2'), ['TC-1 step 2: fill needs value']);
    assert.deepEqual(validateStep({ act: 'expectMinTarget', role: 'button', name: 'Approve' }, 'TC-1 step 3'), ['TC-1 step 3: expectMinTarget needs min']);
  });

  test('a role outside the list is refused', () => {
    assert.match(validateStep({ act: 'click', role: 'div', name: 'x' }, 'TC-1 step 1')[0], /role must be one of/);
  });

  test('a goto path that is not a hash or an absolute path is refused', () => {
    assert.match(validateStep({ act: 'goto', path: 'orders' }, 'TC-1 step 1')[0], /must start with # or \//);
  });

  test('an unknown accessibility rule is refused', () => {
    assert.match(validateStep({ act: 'scanA11y', rules: ['color-contrast'] }, 'TC-1 step 1')[0], /unknown rule color-contrast/);
  });

  test('an interception method outside the list is refused', () => {
    assert.match(validateStep({ act: 'interceptNext', method: 'FETCH', path: '/x', status: 500 }, 'TC-1 step 1')[0], /method must be one of/);
  });
});

describe('a test case', () => {
  test('with no steps is refused', () => {
    assert.deepEqual(validateSteps({ id: 'TC-1' }), ['test case TC-1 has no steps']);
  });

  test('with valid steps has no problems', () => {
    assert.deepEqual(validateSteps({ id: 'TC-1', steps: [{ act: 'goto', path: '#/orders' }] }), []);
  });
});
