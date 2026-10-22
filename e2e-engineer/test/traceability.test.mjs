import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { clone, fixtureLedger } from './helpers.mjs';
import { validatePlan } from '../scripts/traceability.mjs';

function check(mutate) {
  const ledger = clone(fixtureLedger());
  mutate(ledger);
  return validatePlan(ledger);
}

describe('the planted-app plan', () => {
  const result = validatePlan(fixtureLedger());

  test('has no errors, so it can be frozen', () => {
    assert.deepEqual(result.errors, []);
  });

  test('reports the derived, unconfirmed and observed items as warnings', () => {
    assert.ok(result.warnings.includes('requirement REQ-APR-004 is derived and not confirmed, so it cannot drive a FAIL'));
    assert.ok(result.warnings.includes('test case TC-UI-01 has the observed oracle, so it can record behaviour but cannot PASS or FAIL'));
  });

  test('reports the controls with no test as gaps, and does not hide them', () => {
    assert.ok(result.gaps.includes('control SCR-ORDERS.order-link is not mapped to a test case'));
    assert.ok(result.gaps.includes('control SCR-ORDERS.sign-out is not mapped to a test case'));
    assert.ok(result.gaps.includes('control SCR-ORDER-DETAIL.back is not mapped to a test case'));
    assert.equal(result.gaps.length, 3);
  });

  test('reports coverage as separate measures, with P0 journeys counted on their own', () => {
    assert.deepEqual(result.coverage.requirements, { total: 15, withTestCases: 15 });
    assert.deepEqual(result.coverage.journeys, { total: 9, p0Total: 4, p0WithTestCases: 4, withTestCases: 9 });
    assert.deepEqual(result.coverage.testCases, { total: 18, planned: 18, implemented: 0, executed: 0 });
  });
});

describe('a test case', () => {
  test('with no oracle is an error', () => {
    const result = check((l) => delete l.testCases.find((t) => t.id === 'TC-AUTH-02').oracle);
    assert.ok(result.errors.includes('test case TC-AUTH-02 needs an oracle: spec, design, contract, doc, observed'));
  });

  test('whose oracle differs from its requirement is an error', () => {
    const result = check((l) => {
      l.testCases.find((t) => t.id === 'TC-APR-04').oracle = 'contract';
    });
    assert.ok(result.errors.includes('test case TC-APR-04 has the contract oracle, but REQ-APR-004 has the spec oracle'));
  });

  test('with a non-observed oracle and no requirement is an error', () => {
    const result = check((l) => {
      l.testCases.find((t) => t.id === 'TC-AUTH-02').requirements = [];
    });
    assert.ok(result.errors.includes('test case TC-AUTH-02 has the contract oracle but no requirement it checks'));
  });

  test('that is not linked to any journey is an error', () => {
    const result = check((l) => {
      l.testCases.find((t) => t.id === 'TC-AUTH-02').journeys = [];
    });
    assert.ok(result.errors.includes('test case TC-AUTH-02 is linked to no journey'));
  });

  test('that does not say whether it mutates data is an error', () => {
    const result = check((l) => delete l.testCases.find((t) => t.id === 'TC-AUTH-02').mutates);
    assert.ok(result.errors.includes('test case TC-AUTH-02 must say whether it mutates data (mutates: true or false)'));
  });

  test('that refers to a control no screen has is an error', () => {
    const result = check((l) => {
      l.testCases.find((t) => t.id === 'TC-UI-06').controls = ['SCR-LOGIN.nope'];
    });
    assert.ok(result.errors.includes('test case TC-UI-06 refers to control SCR-LOGIN.nope, which is not on any screen'));
  });

  test('with no expected result is an error', () => {
    const result = check((l) => {
      l.testCases.find((t) => t.id === 'TC-AUTH-02').expected = [];
    });
    assert.ok(result.errors.includes('test case TC-AUTH-02 has no expected results'));
  });
});

describe('a journey', () => {
  test('P0 with no test case is an error, because the plan must cover every P0 journey', () => {
    const result = check((l) => {
      l.testCases = l.testCases.filter((t) => t.id !== 'TC-ORD-03');
    });
    assert.ok(result.errors.includes('P0 journey J-04 has no test case'));
  });

  test('P1 with no test case is a gap, not an error', () => {
    const result = check((l) => {
      l.testCases = l.testCases.filter((t) => !t.journeys.includes('J-08'));
    });
    assert.ok(result.gaps.includes('journey J-08 has no test case'));
    assert.ok(!result.errors.some((e) => e.includes('J-08')));
  });

  test('P0 with no failure branch is an error', () => {
    const result = check((l) => {
      l.journeys.find((j) => j.id === 'J-01').branches = l.journeys.find((j) => j.id === 'J-01').branches.filter((b) => b.kind !== 'failure');
    });
    assert.ok(result.errors.includes('P0 journey J-01 has no failure branch'));
  });

  test('that uses a permission with no permission branch is an error', () => {
    const result = check((l) => {
      const journey = l.journeys.find((j) => j.id === 'J-02');
      journey.branches = journey.branches.filter((b) => b.kind !== 'permission');
    });
    assert.ok(result.errors.includes('journey J-02 uses permissions but has no permission branch'));
  });

  test('that names an unknown requirement is an error', () => {
    const result = check((l) => {
      l.journeys.find((j) => j.id === 'J-05').requirements = ['REQ-NOPE-999'];
    });
    assert.ok(result.errors.includes('journey J-05 refers to requirement REQ-NOPE-999, which is not in the plan'));
  });
});

describe('a permission', () => {
  test('with no allowing rule is an error', () => {
    const result = check((l) => {
      l.permissions.find((p) => p.id === 'PERM-CREATE').rules = [{ role: 'admin', outcome: 'denied' }];
    });
    assert.ok(result.errors.includes('permission PERM-CREATE has no rule that allows anyone'));
  });

  test('with no denied role and no stated reason is a gap', () => {
    const result = check((l) => {
      delete l.permissions.find((p) => p.id === 'PERM-CREATE').noDeniedReason;
    });
    assert.ok(result.gaps.includes('permission PERM-CREATE has no denied role; add one, or state why in noDeniedReason'));
  });
});

describe('the design map', () => {
  test('missing a screen is an error', () => {
    const result = check((l) => {
      delete l.designMap.screens['SCR-LOGIN'];
    });
    assert.ok(result.errors.includes('the design map has no entry for screen SCR-LOGIN'));
  });

  test('mapped with no frame is an error', () => {
    const result = check((l) => {
      l.designMap.screens['SCR-LOGIN'] = { status: 'mapped' };
    });
    assert.ok(result.errors.includes('design map entry SCR-LOGIN is mapped but names no frame'));
  });

  test('missing altogether is an error', () => {
    const result = check((l) => {
      delete l.designMap;
    });
    assert.ok(result.errors.some((e) => e.startsWith('the design map is missing')));
  });
});

describe('the whole plan', () => {
  test('with no journeys is an error', () => {
    const result = check((l) => {
      l.journeys = [];
    });
    assert.ok(result.errors.includes('the plan has no journeys'));
  });

  test('a derived requirement that is confirmed is no longer a warning', () => {
    const result = check((l) => {
      l.requirements.find((r) => r.id === 'REQ-APR-004').confirmed = true;
    });
    assert.ok(!result.warnings.some((w) => w.includes('REQ-APR-004 is derived')));
  });

  test('a requirement with no test case is a gap', () => {
    const result = check((l) => {
      l.testCases = l.testCases.filter((t) => !t.requirements.includes('REQ-SEC-001'));
    });
    assert.ok(result.gaps.includes('requirement REQ-SEC-001 has no test case'));
  });
});
