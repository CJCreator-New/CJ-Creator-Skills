import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { addItem, emptyLedger, makeContext, recordReview } from '../scripts/ledger.mjs';
import { build, main as reportMain, parseArgs } from '../scripts/report.mjs';
import { buildView, escapeHtml, renderDashboard, renderReport } from '../scripts/view.mjs';
import { declare, passingRun, withRepo } from './helpers.mjs';

function sample(dir) {
  const ledger = declare(emptyLedger());
  ledger.project = { ...ledger.project, mode: 'standard', stack: { backend: 'Express' }, limitations: ['No browser.'] };
  addItem(ledger, 'requirements', { source: 'confirmed', priority: 'high', text: 'Submit works.', status: 'implemented' });
  addItem(ledger, 'journeys', {
    requirementIds: ['R-01'],
    role: 'employee',
    start: 'draft',
    steps: [{ ui: 'Submit', api: 'POST /x/:id/submit' }],
    outcomeSuccess: 'submitted',
    dependsOn: ['src/feature/'],
    priority: 'high',
  });
  addItem(ledger, 'interactions', { route: '/x', element: 'Submit', classification: 'backend', journeyId: 'J-01' });
  addItem(ledger, 'interactions', { route: '/x', element: 'Tab', classification: 'local', reason: 'client only' });
  addItem(ledger, 'gaps', {
    title: '<img src=x onerror=alert(1)> queue stale',
    severity: 'High',
    category: 'Frontend',
    detectedIn: 'e2e',
    journeyIds: ['J-01'],
  });
  addItem(ledger, 'decisions', { question: 'Can it be recalled?', status: 'open', blocks: [] });
  addItem(ledger, 'tasks', { owner: 'backend-implementer', files: ['src/feature/'], status: 'done' });
  const ctx = makeContext(dir);
  passingRun(ledger, ctx, { journeyIds: ['J-01'], scope: 'e2e' });
  recordReview(ledger, ctx, { verdict: 'passed' });
  return { ledger, ctx };
}

test('escapeHtml neutralises markup in user text', () => {
  assert.equal(escapeHtml(`<a href="x">'&'</a>`), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
});

test('the view counts journeys, interactions, gaps and detected-after-integration gaps', () => {
  withRepo((dir) => {
    const { ledger, ctx } = sample(dir);
    const view = buildView(ledger, [], ctx);
    assert.equal(view.metrics.journeys.total, 1);
    assert.equal(view.metrics.journeys.verified, 1);
    assert.equal(view.metrics.interactions.backend, 1);
    assert.equal(view.metrics.interactions.mappedToJourney, 1);
    assert.equal(view.metrics.interactions.local, 1);
    assert.equal(view.metrics.gaps.openBySeverity.High, 1);
    assert.equal(view.metrics.gaps.detectedAfterIntegration, 1);
    assert.equal(view.metrics.decisions.open, 1);
    assert.equal(view.tasks[0].blockedBy.length, 0);
  });
});

test('the dashboard escapes gap titles, has no external resources, and shows the release status', () => {
  withRepo((dir) => {
    const { ledger, ctx } = sample(dir);
    const html = renderDashboard(buildView(ledger, [], ctx), '2026-10-22T10:00:00.000Z');
    assert.doesNotMatch(html, /<img src=x/);
    assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt; queue stale/);
    assert.doesNotMatch(html, /<script src=|<link /);
    assert.match(html, /Release readiness/);
    assert.match(html, /Not Release Ready|Blocked|Partially Complete|Complete/);
    assert.match(html, /Mode: standard/);
  });
});

test('the report is computed from the ledger and lists what is not run or open', () => {
  withRepo((dir) => {
    const { ledger, ctx } = sample(dir);
    const report = renderReport(buildView(ledger, [], ctx));
    assert.match(report, /^# Backend run report/m);
    assert.match(report, /Overall status: \*\*(Blocked|Not Release Ready|Partially Complete|Complete)\*\*/);
    assert.match(report, /Open by severity: Critical 0, High 1/);
    assert.match(report, /D-01: Can it be recalled\?/);
    assert.match(report, /No browser\./);
  });
});

test('the report lists every journey that is not verified, including blocked and failed ones', () => {
  withRepo((dir) => {
    const { ledger, ctx } = sample(dir);
    ledger.decisions[0].status = 'open';
    ledger.decisions[0].blocks = ['J-01'];
    const report = renderReport(buildView(ledger, [], ctx));
    assert.match(report, /Journeys without a verified result:\n- J-01 \(blocked\)/);
    assert.doesNotMatch(report, /Journeys without a verified result:\n- none/);
  });
});

test('telemetry the run did not record is shown as unavailable, not estimated', () => {
  withRepo((dir) => {
    const { ledger, ctx } = sample(dir);
    const view = buildView(ledger, [{ type: 'dispatch', agent: 'x', model: 'sonnet', ts: '2026-10-22T10:00:00.000Z' }], ctx);
    assert.equal(view.telemetry.tokens, 'unavailable');
    assert.match(renderReport(view), /Tokens: unavailable/);
    assert.match(renderDashboard(view), /Tokens: unavailable/);
  });
});

test('report.mjs writes the dashboard and the report into the run folder', () => {
  withRepo((dir) => {
    const { ledger } = sample(dir);
    mkdirSync(join(dir, '.claude', 'backend-engineer'), { recursive: true });
    writeFileSync(join(dir, '.claude', 'backend-engineer', 'ledger.json'), JSON.stringify(ledger));
    const env = { CLAUDE_PROJECT_DIR: dir };
    assert.match(reportMain(['dashboard'], env), /dashboard written/);
    assert.match(reportMain(['report'], env), /report written/);
    assert.equal(existsSync(join(dir, '.claude', 'backend-engineer', 'dashboard.html')), true);
    assert.match(readFileSync(join(dir, '.claude', 'backend-engineer', 'report.md'), 'utf8'), /Backend run report/);
    assert.equal(build({ kind: 'report', out: null }, dir).path, join(dir, '.claude', 'backend-engineer', 'report.md'));
  });
});

test('report arguments are validated', () => {
  assert.throws(() => parseArgs(['pdf']), /usage/);
  assert.throws(() => parseArgs(['report', '--format', 'pdf']), /unknown option/);
  assert.deepEqual(parseArgs(['dashboard', '--out', '/tmp/x.html']), { kind: 'dashboard', out: '/tmp/x.html' });
});
