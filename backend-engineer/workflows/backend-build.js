export const meta = {
  name: 'backend-implement-waves',
  description: 'Implement an approved backend plan wave by wave. Tasks in a wave run in parallel; the run stops at the first wave that does not complete.',
  whenToUse: 'Only when the user asks to use a workflow. Run after the contract phase is approved. Pass the output of orchestrate.mjs plan as args.',
  phases: [{ title: 'Implement', detail: 'one wave at a time, with the tasks of each wave in parallel' }],
}

// Each task returns a status and the files it changed. The orchestrator records the result in the
// ledger after the workflow returns, so no agent here writes the ledger.
const RESULT = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['complete', 'partial', 'blocked'] },
    changed: { type: 'array', items: { type: 'string' } },
    blockers: { type: 'array', items: { type: 'string' } },
  },
  required: ['status', 'changed', 'blockers'],
}

function brief(task, context) {
  return [
    `You are the ${task.owner} for task ${task.id}.`,
    `Edit only these files: ${task.files.join(', ')}.`,
    context.contractPath ? `The approved contract is at ${context.contractPath}. Implement it exactly.` : '',
    context.journeyIds ? `The journeys this work serves: ${context.journeyIds.join(', ')}.` : '',
    'Do not run the test suite and do not change the run ledger. Never read or write .env files or credentials.',
    'Return your status, the files you changed, and any blockers.',
  ]
    .filter(Boolean)
    .join('\n')
}

phase('Implement')

const plan = args?.plan ?? args
if (!plan || !Array.isArray(plan.waves)) {
  return { error: 'args must be the output of orchestrate.mjs plan, with a waves list' }
}

const context = args?.context ?? {}
const results = []
let stoppedAt = null

for (const wave of plan.waves) {
  log(`wave ${wave.wave}: ${wave.tasks.map((t) => t.id).join(', ')}`)
  const outcomes = await parallel(
    wave.tasks.map((task) => () =>
      agent(brief(task, context), {
        label: `implement:${task.id}`,
        phase: 'Implement',
        model: task.model,
        schema: RESULT,
      }),
    ),
  )
  wave.tasks.forEach((task, i) => results.push({ task: task.id, wave: wave.wave, result: outcomes[i] }))
  const incomplete = wave.tasks.filter((_, i) => !outcomes[i] || outcomes[i].status !== 'complete')
  if (incomplete.length) {
    stoppedAt = wave.wave
    log(`wave ${wave.wave} did not complete: ${incomplete.map((t) => t.id).join(', ')}. Later waves are not started.`)
    break
  }
}

// No silent cap: anything the plan did not schedule is reported, not dropped.
const notScheduled = [...(plan.blocked ?? []), ...(plan.waiting ?? [])]
if (notScheduled.length) log(`not scheduled: ${notScheduled.join(', ')}`)

return { results, stoppedAt, notScheduled }
