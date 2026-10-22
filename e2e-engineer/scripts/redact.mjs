// Redaction for everything a run stores: request and response records, console output, and any text
// written to evidence. Credentials, tokens and cookies never reach a file. The rules are applied to
// header names, to JSON keys, to token-shaped strings, and to the exact secret values the run was
// given, so a secret is removed even when it turns up in an unexpected place.

export const REDACTED = '[redacted]';

const SENSITIVE_HEADER = /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|x-auth-token)$/i;
const SENSITIVE_KEY = /(pass(word)?|secret|token|authoriz|cookie|api[_-]?key|credential)/i;
const BEARER = /Bearer\s+[A-Za-z0-9._~+/=-]+/gi;
const JWT = /eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/g;
const QUERY_SECRET = /([?&](?:token|access_token|key|password|sig|secret)=)[^&#\s]*/gi;
const MIN_SECRET_LENGTH = 4;

// Replaces each known secret value. A value shorter than four characters is ignored, because it
// would match ordinary text and remove it.
export function redactString(text, secrets = []) {
  let out = String(text).replace(BEARER, `Bearer ${REDACTED}`).replace(JWT, REDACTED).replace(QUERY_SECRET, `$1${REDACTED}`);
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length >= MIN_SECRET_LENGTH) out = out.split(secret).join(REDACTED);
  }
  return out;
}

// Headers whose names mark a credential are replaced whole. Other headers are kept.
export function redactHeaders(headers = {}, secrets = []) {
  const out = {};
  for (const [name, value] of Object.entries(headers)) {
    out[name] = SENSITIVE_HEADER.test(name) ? REDACTED : redactString(value, secrets);
  }
  return out;
}

// Walks a value. A key that names a credential has its whole value replaced. Strings are redacted.
export function redactValue(value, secrets = []) {
  if (Array.isArray(value)) return value.map((item) => redactValue(item, secrets));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = SENSITIVE_KEY.test(key) ? REDACTED : redactValue(item, secrets);
    }
    return out;
  }
  if (typeof value === 'string') return redactString(value, secrets);
  return value;
}

// The text of a JSON body, redacted by key, and then as text. A body that is not JSON is redacted as text.
export function redactBody(text, secrets = []) {
  if (text === undefined || text === null || text === '') return text ?? '';
  try {
    return redactValue(JSON.parse(text), secrets);
  } catch {
    return redactString(text, secrets);
  }
}
