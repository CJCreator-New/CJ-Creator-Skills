// Builds one view of the run from the ledger and telemetry, and renders it as the operational
// dashboard (HTML) and the final report (Markdown). Both renderings read the same view, so they
// cannot disagree about a number. Nothing here is simulated: every figure comes from a record,
// a recorded run, or a telemetry entry, and an unrecorded metric is shown as unavailable.

import { AFTER_INTEGRATION, GAP_LIFECYCLE, journeyState, releaseStatus } from './ledger.mjs';
import { summarize } from './telemetry.mjs';

const SEVERITY_ORDER = ['Critical', 'High', 'Medium', 'Low'];

export function buildView(ledger, telemetryEntries, ctx) {
  const journeys = ledger.journeys.map((j) => ({ ...j, state: journeyState(ledger, j, ctx) }));
  const taskStatus = Object.fromEntries(ledger.tasks.map((t) => [t.id, t.status]));
  const tasks = ledger.tasks.map((t) => ({
    ...t,
    blockedBy: (t.dependsOn ?? []).filter((id) => taskStatus[id] !== 'done'),
  }));
  const openGaps = ledger.gaps.filter((g) => g.status !== 'Closed');
  const backend = ledger.interactions.filter((i) => i.classification === 'backend');
  const journeyIds = new Set(ledger.journeys.map((j) => j.id));
  const count = (list, state) => list.filter((item) => item.state === state).length;

  return {
    project: ledger.project ?? {},
    release: releaseStatus(ledger, ctx),
    journeys,
    requirements: ledger.requirements,
    interactions: ledger.interactions,
    gaps: ledger.gaps,
    decisions: ledger.decisions,
    tasks,
    runs: ledger.evidence.filter((e) => e.kind === 'run'),
    reviews: ledger.evidence.filter((e) => e.kind === 'review'),
    metrics: {
      requirements: {
        total: ledger.requirements.length,
        traced: ledger.requirements.filter((r) => ledger.journeys.some((j) => j.requirementIds.includes(r.id))).length,
      },
      interactions: {
        total: ledger.interactions.length,
        backend: backend.length,
        local: ledger.interactions.length - backend.length,
        mappedToJourney: backend.filter((i) => journeyIds.has(i.journeyId)).length,
      },
      journeys: {
        total: journeys.length,
        verified: count(journeys, 'verified'),
        failed: count(journeys, 'failed'),
        stale: count(journeys, 'stale'),
        blocked: count(journeys, 'blocked'),
      },
      gaps: {
        total: ledger.gaps.length,
        closed: ledger.gaps.length - openGaps.length,
        openBySeverity: Object.fromEntries(
          SEVERITY_ORDER.map((s) => [s, openGaps.filter((g) => g.severity === s).length]),
        ),
        detectedAfterIntegration: ledger.gaps.filter((g) => AFTER_INTEGRATION.includes(g.detectedIn)).length,
      },
      decisions: {
        open: ledger.decisions.filter((d) => d.status === 'open').length,
      },
    },
    telemetry: summarize(telemetryEntries),
  };
}

export const escapeHtml = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const text = (value, fallback = '—') => (value === undefined || value === null || value === '' ? fallback : value);

function table(headers, rows, attrs = []) {
  const head = headers.map((h) => `<th>${escapeHtml(h)}</th>`).join('');
  const body = rows
    .map((cells, i) => `<tr${attrs[i] ?? ''}>${cells.map((c) => `<td>${c}</td>`).join('')}</tr>`)
    .join('\n');
  return `<table><thead><tr>${head}</tr></thead><tbody>\n${body}\n</tbody></table>`;
}

const badge = (label, tone) => `<span class="badge ${tone}">${escapeHtml(label)}</span>`;
const STATE_TONE = { verified: 'ok', failed: 'bad', stale: 'warn', blocked: 'bad', implemented: 'info', planned: 'muted' };
const RELEASE_TONE = { Complete: 'ok', 'Partially Complete': 'warn', Blocked: 'bad', 'Not Release Ready': 'bad' };

const STYLE = `
:root { color-scheme: light dark; --bg:#fbfbfa; --fg:#1d1d1b; --muted:#6b6b66; --line:#dcdcd6; --ok:#2f7d4f; --warn:#a86b00; --bad:#b03030; --info:#2c5f9e; }
@media (prefers-color-scheme: dark) { :root { --bg:#161614; --fg:#ecebe6; --muted:#9a9a93; --line:#3a3a36; --ok:#5bbf86; --warn:#e0a84a; --bad:#e46a6a; --info:#7fa8e0; } }
body { background:var(--bg); color:var(--fg); font:14px/1.5 system-ui, sans-serif; margin:0; padding:16px; }
main { max-width:1100px; margin:0 auto; }
h1 { font-size:20px; margin:0 0 4px; } h2 { font-size:16px; margin:24px 0 8px; border-bottom:1px solid var(--line); padding-bottom:4px; }
table { width:100%; border-collapse:collapse; font-size:13px; } th, td { text-align:left; padding:6px 8px; border-bottom:1px solid var(--line); vertical-align:top; }
th { color:var(--muted); font-weight:600; }
.badge { display:inline-block; padding:1px 8px; border-radius:10px; border:1px solid currentColor; font-size:12px; }
.ok { color:var(--ok); } .warn { color:var(--warn); } .bad { color:var(--bad); } .info { color:var(--info); } .muted { color:var(--muted); }
.cards { display:grid; grid-template-columns:repeat(auto-fit, minmax(150px, 1fr)); gap:8px; }
.card { border:1px solid var(--line); border-radius:6px; padding:8px 10px; } .card b { display:block; font-size:18px; }
.note { color:var(--muted); font-size:12px; } ul { margin:4px 0 0 18px; padding:0; }
`;

const STATE_SCRIPT = `
document.querySelectorAll('select[data-filter]').forEach(function (el) {
  el.addEventListener('change', function () {
    var sev = document.getElementById('f-sev').value, cat = document.getElementById('f-cat').value;
    document.querySelectorAll('#gaps tbody tr').forEach(function (tr) {
      tr.hidden = (sev && tr.dataset.severity !== sev) || (cat && tr.dataset.category !== cat);
    });
  });
});`;

export function renderDashboard(view, generatedAt = new Date().toISOString()) {
  const m = view.metrics;
  const release = view.release;
  const project = view.project;
  const stack = Object.entries(project.stack ?? {})
    .map(([k, v]) => `${escapeHtml(k)}: ${escapeHtml(v)}`)
    .join(' · ');
  const capabilities = Object.entries(project.capabilities ?? {})
    .map(([k, v]) => `${escapeHtml(k)}: ${escapeHtml(JSON.stringify(v))}`)
    .join('<br>');

  const journeyRows = view.journeys.map((j) => [
    escapeHtml(j.id),
    escapeHtml(text(j.priority)),
    escapeHtml(text(j.role)),
    escapeHtml(j.start ?? '—'),
    escapeHtml((j.requirementIds ?? []).join(', ')),
    badge(j.state, STATE_TONE[j.state] ?? 'muted'),
    escapeHtml((j.dependsOn ?? []).join(', ')),
  ]);

  const interactionRows = view.interactions.map((i) => [
    escapeHtml(i.id),
    escapeHtml(i.route),
    escapeHtml(i.element),
    escapeHtml(i.classification),
    escapeHtml(i.journeyId ?? i.reason ?? '—'),
  ]);

  const gapRows = view.gaps.map((g) => [
    escapeHtml(g.id),
    escapeHtml(g.severity),
    escapeHtml(g.category),
    escapeHtml(g.title),
    escapeHtml(g.status),
    escapeHtml(text(g.detectedIn)),
    escapeHtml((g.journeyIds ?? []).join(', ')),
    escapeHtml(text(g.owner)),
  ]);
  const gapAttrs = view.gaps.map((g) => ` data-severity="${escapeHtml(g.severity)}" data-category="${escapeHtml(g.category)}"`);

  const taskRows = view.tasks.map((t) => [
    escapeHtml(t.id),
    escapeHtml(t.owner),
    escapeHtml((t.files ?? []).join(', ')),
    escapeHtml(t.status),
    escapeHtml((t.dependsOn ?? []).join(', ') || '—'),
    escapeHtml(t.blockedBy.length ? `blocked by ${t.blockedBy.join(', ')}` : '—'),
  ]);

  const runRows = view.runs.map((r) => [
    escapeHtml(r.id),
    escapeHtml(r.name),
    escapeHtml(r.scope),
    r.exitCode === 0 ? badge('passed', 'ok') : badge(`failed (${r.exitCode})`, 'bad'),
    escapeHtml(r.startedAt),
    escapeHtml((r.journeyIds ?? []).join(', ') || '—'),
  ]);
  const reviewRows = view.reviews.map((r) => [
    escapeHtml(r.id),
    escapeHtml(text(r.reviewer)),
    escapeHtml(r.verdict),
    escapeHtml(r.recordedAt ?? '—'),
    escapeHtml(text(r.notes, '—')),
  ]);
  const decisionRows = view.decisions.map((d) => [
    escapeHtml(d.id),
    escapeHtml(d.question),
    d.status === 'open' ? badge('open', 'warn') : badge('answered', 'ok'),
    escapeHtml((d.blocks ?? []).join(', ') || '—'),
  ]);

  const list = (items) => (items.length ? `<ul>${items.map((i) => `<li>${escapeHtml(i)}</li>`).join('')}</ul>` : '<p class="note">none</p>');
  const severityOptions = SEVERITY_ORDER.map((s) => `<option value="${s}">${s}</option>`).join('');
  const categories = [...new Set(view.gaps.map((g) => g.category))].sort();
  const categoryOptions = categories.map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');
  const tel = view.telemetry;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Backend run dashboard</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<h1>Backend run dashboard</h1>
<p class="note">Generated ${escapeHtml(generatedAt)} from the ledger and telemetry. Nothing on this page is simulated.</p>

<h2>Release readiness</h2>
<p>${badge(release.status, RELEASE_TONE[release.status] ?? 'muted')}</p>
<h3 class="note">Blockers</h3>${list(release.blockers)}
<h3 class="note">Not release ready</h3>${list(release.notReady)}
<h3 class="note">Partial</h3>${list(release.partial)}

<h2>Summary</h2>
<div class="cards">
  <div class="card"><b>${m.journeys.verified} / ${m.journeys.total}</b>journeys verified</div>
  <div class="card"><b>${m.requirements.traced} / ${m.requirements.total}</b>requirements traced</div>
  <div class="card"><b>${m.interactions.mappedToJourney} / ${m.interactions.backend}</b>backend interactions mapped</div>
  <div class="card"><b>${m.interactions.local}</b>local interactions</div>
  <div class="card"><b>${m.gaps.total - m.gaps.closed}</b>open gaps</div>
  <div class="card"><b>${m.gaps.detectedAfterIntegration}</b>gaps found after integration</div>
  <div class="card"><b>${m.decisions.open}</b>open decisions</div>
  <div class="card"><b>${tel.dispatches.total}</b>agent dispatches</div>
</div>

<h2>Setup</h2>
<p>Mode: ${escapeHtml(text(project.mode, 'not set'))}</p>
<p>Stack: ${stack || '<span class="note">not recorded</span>'}</p>
<p>Capabilities: ${capabilities || '<span class="note">not recorded</span>'}</p>

<h2>Plan</h2>
${table(['Task', 'Owner', 'Files', 'Status', 'Depends on', 'Blocked'], taskRows)}

<h2>Journey explorer</h2>
${table(['Journey', 'Priority', 'Role', 'Start', 'Requirements', 'State', 'Depends on'], journeyRows)}

<h2>Interaction map</h2>
${table(['Interaction', 'Route', 'Element', 'Classification', 'Journey or reason'], interactionRows)}

<h2>Gaps</h2>
<p>
  <label>Severity <select id="f-sev" data-filter><option value="">all</option>${severityOptions}</select></label>
  <label>Category <select id="f-cat" data-filter><option value="">all</option>${categoryOptions}</select></label>
</p>
<div id="gaps">${table(['Gap', 'Severity', 'Category', 'Title', 'Status', 'Detected in', 'Journeys', 'Owner'], gapRows, gapAttrs)}</div>
<p class="note">Lifecycle: ${GAP_LIFECYCLE.map(escapeHtml).join(' → ')}</p>

<h2>Decisions and clarifications</h2>
${table(['Decision', 'Question', 'Status', 'Blocks'], decisionRows)}

<h2>Tests and evidence</h2>
${table(['Record', 'Name', 'Scope', 'Result', 'Started', 'Journeys'], runRows)}
<h3 class="note">Reviews</h3>
${table(['Record', 'Reviewer', 'Verdict', 'Recorded', 'Notes'], reviewRows)}

<h2>Telemetry</h2>
<p>Stage time (ms): ${escapeHtml(JSON.stringify(tel.stageMs))}</p>
<p>Dispatches: ${escapeHtml(JSON.stringify(tel.dispatches))}</p>
<p>Tokens: ${escapeHtml(typeof tel.tokens === 'string' ? tel.tokens : JSON.stringify(tel.tokens))}</p>
<p>Failures: ${escapeHtml(JSON.stringify(tel.failures))}</p>
<p>Correction rounds: ${tel.iterations.total}</p>
</main>
<script>${STATE_SCRIPT}</script>
</body>
</html>
`;
}

// The final report. Every section is computed from the ledger, so a missing item shows as missing.
// The orchestrator adds narrative only where the ledger has none, and says so.
export function renderReport(view) {
  const { release, metrics: m, project, tel } = { ...view, tel: view.telemetry };
  const openHigh = view.gaps.filter((g) => g.status !== 'Closed' && ['Critical', 'High'].includes(g.severity));
  const notRun = view.journeys.filter((j) => j.state !== 'verified');
  const lines = [];
  const add = (...items) => lines.push(...items);
  const list = (items, empty = '- none') => (items.length ? items.map((i) => `- ${i}`) : [empty]);

  add('# Backend run report', '', `Mode: ${text(project.mode, 'not set')}`, `Overall status: **${release.status}**`, '');
  add('## A. Execution summary', '');
  add(`- Journeys: ${m.journeys.total} identified, ${m.journeys.verified} verified, ${m.journeys.failed} failed, ${m.journeys.stale} stale, ${m.journeys.blocked} blocked.`);
  add(`- Requirements: ${m.requirements.total} recorded, ${m.requirements.traced} traced to a journey.`);
  add('');
  add('## B. User-flow coverage', '');
  add(`- Interactions: ${m.interactions.total} (backend ${m.interactions.backend}, mapped to a journey ${m.interactions.mappedToJourney}; local ${m.interactions.local}).`);
  add(`- Open decisions: ${m.decisions.open}.`);
  add('');
  add('## C. Implementation', '');
  add('Tasks and the files they own:', ...list(view.tasks.map((t) => `${t.id} (${t.owner}, ${t.status}): ${(t.files ?? []).join(', ')}`)), '');
  add('## D. Gaps', '');
  add(`- Detected ${m.gaps.total}; closed ${m.gaps.closed}; detected after integration ${m.gaps.detectedAfterIntegration}.`);
  add(`- Open by severity: ${SEVERITY_ORDER.map((s) => `${s} ${m.gaps.openBySeverity[s]}`).join(', ')}.`);
  add('Open Critical and High gaps:', ...list(openHigh.map((g) => `${g.id} ${g.severity} at ${g.status}: ${g.title}`)), '');
  add('Decisions the user must make:', ...list(view.decisions.filter((d) => d.status === 'open').map((d) => `${d.id}: ${d.question}`)), '');
  add('## E. Verification evidence', '');
  add('Recorded runs:', ...list(view.runs.map((r) => `${r.id} ${r.name} [${r.scope}] exit ${r.exitCode} at ${r.startedAt}`)));
  add('Recorded reviews:', ...list(view.reviews.map((r) => `${r.id} ${text(r.reviewer)} ${r.verdict}`)));
  add('Journeys without a verified result:', ...list(notRun.map((j) => `${j.id} (${j.state})`)), '');
  add('Limitations recorded in the ledger:', ...list(project.limitations ?? []), '');
  add('## F. Release readiness', '');
  add('Blockers:', ...list(release.blockers));
  add('Not release ready:', ...list(release.notReady));
  add('Partial:', ...list(release.partial));
  add('Deployment and migration notes:', ...list(project.deployNotes ?? []), '');
  add('## G. Next steps', '');
  add(...list([...release.blockers, ...release.notReady].map((item) => `Resolve: ${item}`)), '');
  add('## Telemetry', '');
  add(`- Stage time (ms): ${JSON.stringify(tel.stageMs)}`);
  add(`- Dispatches: ${tel.dispatches.total}; correction rounds: ${tel.iterations.total}; failures: ${tel.failures.total}`);
  add(`- Tokens: ${typeof tel.tokens === 'string' ? tel.tokens : JSON.stringify(tel.tokens)}`);
  return `${lines.join('\n')}\n`;
}
