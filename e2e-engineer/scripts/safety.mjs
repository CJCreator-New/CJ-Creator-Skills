// Target safety for the e2e-engineer. Every run passes through here before any request is sent or
// any write is made. A target that is off the allowlist, or that looks like production, stops the
// run. There is no override in this version: a production-looking name is always refused.

const PRODUCTION_LIKE = /(^|[.\-_])(prod|production|live)([.\-_]|$)/i;
const SCHEMES = new Set(['http:', 'https:']);

export function productionLike(name) {
  return PRODUCTION_LIKE.test(String(name));
}

function isText(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function checkShape(config, problems) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    problems.push('config must be a JSON object');
    return false;
  }
  if (!isText(config.name)) problems.push('config.name is required');
  if (!config.targets || typeof config.targets !== 'object') {
    problems.push('config.targets is required');
  } else if (!['web', 'mobile-web', 'android', 'ios'].some((t) => config.targets[t])) {
    problems.push('config.targets must declare at least one of web, mobile-web, android, ios');
  }
  const allow = config.allowlist;
  if (!allow || typeof allow !== 'object') {
    problems.push('config.allowlist is required');
  } else {
    for (const key of ['hosts', 'bundleIds', 'packageNames']) {
      if (allow[key] !== undefined && !Array.isArray(allow[key])) problems.push(`config.allowlist.${key} must be a list`);
    }
  }
  if (config.authorization !== null && config.authorization !== undefined) {
    const auth = config.authorization;
    for (const key of ['scope', 'authorizedBy', 'date']) {
      if (!isText(auth[key])) problems.push(`config.authorization.${key} is required when authorization is given`);
    }
  }
  if (config.allowReset !== undefined && typeof config.allowReset !== 'boolean') {
    problems.push('config.allowReset must be true or false');
  }
  return problems.length === 0;
}

function webProblems(label, url, allowHosts, problems) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    problems.push(`${label}: baseUrl is not a valid URL`);
    return;
  }
  if (!SCHEMES.has(parsed.protocol)) problems.push(`${label}: baseUrl must use http or https`);
  if (productionLike(parsed.hostname)) problems.push(`${label}: host "${parsed.hostname}" looks like production and is refused`);
  if (!allowHosts.includes(parsed.hostname)) problems.push(`${label}: host "${parsed.hostname}" is not on the allowlist`);
}

// Returns the list of problems with the target declarations. An empty list means every declared
// target is on the allowlist.
export function checkTargets(config) {
  const problems = [];
  const allow = config.allowlist || {};
  const hosts = allow.hosts || [];
  const targets = config.targets || {};
  for (const name of ['web', 'mobile-web']) {
    if (targets[name]) webProblems(name, targets[name].baseUrl, hosts, problems);
  }
  if (targets.android) {
    const pkg = targets.android.packageName;
    if (!isText(pkg)) problems.push('android: packageName is required');
    else if (!(allow.packageNames || []).includes(pkg)) problems.push(`android: package "${pkg}" is not on the allowlist`);
    else if (productionLike(pkg)) problems.push(`android: package "${pkg}" looks like production and is refused`);
  }
  if (targets.ios) {
    const id = targets.ios.bundleId;
    if (!isText(id)) problems.push('ios: bundleId is required');
    else if (!(allow.bundleIds || []).includes(id)) problems.push(`ios: bundle "${id}" is not on the allowlist`);
    else if (productionLike(id)) problems.push(`ios: bundle "${id}" looks like production and is refused`);
  }
  return problems;
}

// The database must be named by the allowlist pattern, and its name must not look like production.
// Reset is allowed only when a database is declared and passes these checks.
export function checkDatabase(config) {
  const problems = [];
  const db = config.db;
  if (!db) {
    if (config.allowReset === true) problems.push('allowReset is true but no db is declared');
    return { problems, resetAllowed: false };
  }
  if (!isText(db.name)) problems.push('db.name is required');
  const pattern = config.allowlist && config.allowlist.dbNamePattern;
  if (!isText(pattern)) {
    problems.push('allowlist.dbNamePattern is required when a db is declared');
  } else if (isText(db.name)) {
    let re = null;
    try {
      re = new RegExp(pattern);
    } catch {
      problems.push('allowlist.dbNamePattern is not a valid regular expression');
    }
    if (re && !re.test(db.name)) problems.push(`db "${db.name}" does not match allowlist.dbNamePattern`);
    if (productionLike(db.name)) problems.push(`db "${db.name}" looks like production and is refused`);
  }
  const resetAllowed = config.allowReset === true && problems.length === 0;
  return { problems, resetAllowed };
}

// Security probes need a recorded authorization. Without one they are refused, and the run continues
// with static checks only. The refusal is reported, not hidden.
export function securityProbeDecision(config) {
  const auth = config.authorization;
  if (auth && isText(auth.scope) && isText(auth.authorizedBy) && isText(auth.date)) {
    return { allowed: true, reason: null };
  }
  return { allowed: false, reason: 'no authorization is recorded, so security probes are refused and static checks only will run' };
}

// The decision for one run. `allowed` is false when any target, database or shape check fails. The
// run then stops. Security probes are decided separately because they never stop the run.
export function validateRun(config) {
  const problems = [];
  if (!checkShape(config, problems)) {
    return { allowed: false, problems, resetAllowed: false, securityProbes: securityProbeDecision({}) };
  }
  problems.push(...checkTargets(config));
  const db = checkDatabase(config);
  problems.push(...db.problems);
  return {
    allowed: problems.length === 0,
    problems,
    resetAllowed: db.resetAllowed,
    securityProbes: securityProbeDecision(config),
  };
}
