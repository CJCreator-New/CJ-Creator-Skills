import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runStep, PRESENCE_TIMEOUT_MS, STEP_TIMEOUT_MS } from '../scripts/run-web.mjs';

// A fake page that records the options each wait is given, and fails every wait the way a missing element does.
function missingElementPage() {
  const waits = [];
  const locator = {
    first: () => locator,
    waitFor: async (options) => {
      waits.push(options);
      throw new Error('element not found');
    },
  };
  return {
    waits,
    page: {
      getByRole: () => locator,
      getByText: () => locator,
    },
  };
}

test('the presence budget is shorter than the action budget', () => {
  assert.ok(PRESENCE_TIMEOUT_MS < STEP_TIMEOUT_MS);
  assert.ok(PRESENCE_TIMEOUT_MS >= 1000, 'a presence budget under a second fails slow but correct pages');
});

test('expectVisible waits with the presence budget and fails when the element is missing', async () => {
  const { page, waits } = missingElementPage();
  await assert.rejects(
    runStep({ act: 'expectVisible', role: 'button', name: 'Export' }, { page, base: 'http://x/', ctx: { env: {} } }),
    /element not found/,
  );
  assert.equal(waits.length, 1);
  assert.equal(waits[0].timeout, PRESENCE_TIMEOUT_MS);
  assert.equal(waits[0].state, 'visible');
});

test('expectText waits with the presence budget and fails when the text is missing', async () => {
  const { page, waits } = missingElementPage();
  await assert.rejects(
    runStep({ act: 'expectText', text: 'Saved' }, { page, base: 'http://x/', ctx: { env: {} } }),
    /element not found/,
  );
  assert.equal(waits[0].timeout, PRESENCE_TIMEOUT_MS);
});
