// The test plan: the items recorded in the ledger, their digest, the freeze, and the approval. These
// are plain functions over the ledger object, so the ledger and the artifact renderer can both use
// them without importing each other.
//
// Approval binds to the frozen digest. A change to any plan item changes the digest, so an approval
// of an earlier plan no longer counts, and the gate says so.

import { createHash } from 'node:crypto';
import { validatePlan } from './traceability.mjs';

// Ledger collections that make up the plan. designMap is a single object, handled separately.
export const PLAN_COLLECTIONS = ['requirements', 'roles', 'permissions', 'operations', 'screens', 'journeys', 'testCases', 'fixtures'];

const KIND_TO_COLLECTION = {
  requirement: 'requirements',
  role: 'roles',
  permission: 'permissions',
  operation: 'operations',
  screen: 'screens',
  journey: 'journeys',
  testcase: 'testCases',
  fixture: 'fixtures',
};

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

// Sorts object keys at every depth, so the digest does not depend on how an object was written.
export function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function byId(a, b) {
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

export function planDigest(ledger) {
  const sections = {};
  for (const key of PLAN_COLLECTIONS) sections[key] = [...(ledger[key] || [])].sort(byId);
  sections.designMap = ledger.designMap ?? null;
  return createHash('sha256').update(JSON.stringify(canonical(sections))).digest('hex');
}

// "not frozen", "frozen", or "changed since frozen".
export function planState(ledger) {
  if (!ledger.planFrozen) return 'not frozen';
  return planDigest(ledger) === ledger.planFrozen.hash ? 'frozen' : 'changed since frozen';
}

function requireAllowedRun(ledger, action) {
  if (!ledger.intake || !ledger.intake.safety.allowed) throw new Error(`${action} is not possible for a refused run`);
}

export function addItem(ledger, kind, item) {
  requireAllowedRun(ledger, 'adding a plan item');
  const collection = KIND_TO_COLLECTION[kind];
  if (!collection) throw new Error(`unknown kind ${kind}; use one of ${Object.keys(KIND_TO_COLLECTION).join(', ')}`);
  if (!item || typeof item.id !== 'string' || !ID_PATTERN.test(item.id)) {
    throw new Error(`a ${kind} needs an id of letters, digits, dots, dashes or underscores`);
  }
  ledger[collection] = ledger[collection] || [];
  if (ledger[collection].some((existing) => existing.id === item.id)) throw new Error(`${kind} ${item.id} already exists`);
  ledger[collection].push(item);
  return item;
}

// Loads a whole plan from one object, with one array per collection and an optional designMap.
export function loadPlan(ledger, data) {
  requireAllowedRun(ledger, 'loading a plan');
  const kindFor = Object.fromEntries(Object.entries(KIND_TO_COLLECTION).map(([kind, collection]) => [collection, kind]));
  const counts = {};
  for (const [key, value] of Object.entries(data)) {
    if (key === 'designMap') {
      ledger.designMap = value;
      continue;
    }
    if (!kindFor[key]) throw new Error(`unknown plan section ${key}`);
    if (!Array.isArray(value)) throw new Error(`plan section ${key} must be a list`);
    for (const item of value) addItem(ledger, kindFor[key], item);
    counts[key] = value.length;
  }
  return counts;
}

// Freezes the plan. A plan with errors cannot be frozen, and the errors are returned in the message.
export function freezePlan(ledger, { now }) {
  requireAllowedRun(ledger, 'freezing a plan');
  const result = validatePlan(ledger);
  if (result.errors.length > 0) {
    throw new Error(`the plan has ${result.errors.length} error(s), so it cannot be frozen:\n- ${result.errors.join('\n- ')}`);
  }
  const hash = planDigest(ledger);
  ledger.planFrozen = {
    hash,
    frozenAt: now,
    warnings: result.warnings.length,
    gaps: result.gaps.length,
    coverage: result.coverage,
  };
  return ledger.planFrozen;
}

// Records the approval of the frozen plan. Only the user approves. The caller passes the approver's
// name or identifier, and this function refuses to approve a plan that changed after it was frozen.
export function approvePlan(ledger, { approver, approvedAt }) {
  requireAllowedRun(ledger, 'approving a plan');
  if (typeof approver !== 'string' || approver.trim() === '') throw new Error('an approver name or identifier is required');
  if (!ledger.planFrozen) throw new Error('freeze the plan before approving it');
  if (planState(ledger) !== 'frozen') throw new Error('the plan changed after it was frozen; freeze it again before approving');
  ledger.approval = { planHash: ledger.planFrozen.hash, approver, approvedAt };
  return ledger.approval;
}
