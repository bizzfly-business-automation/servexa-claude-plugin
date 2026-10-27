/**
 * Nothing this process prints or returns may contain a credential. Known token shapes are replaced wherever they appear, and the exact
 * strings of the credentials the process was started with are replaced even if their shape changes.
 */
const TOKEN_SHAPES = /\b(?:sgt|sk|scs)_[A-Za-z0-9_-]{8,}\b/g;
const BEARER = /(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi;

let known: string[] = [];

export function registerSecrets(...secrets: Array<string | undefined>): void {
  known = [...known, ...secrets.filter((secret): secret is string => typeof secret === 'string' && secret.length >= 8)];
}

export function redact(text: string): string {
  let out = text.replace(TOKEN_SHAPES, '[redacted-token]').replace(BEARER, '$1[redacted]');
  for (const secret of known) out = out.split(secret).join('[redacted-token]');
  return out;
}

/** Deep copy of a JSON value with every string redacted (used on tool results as a last line of defence). */
export function redactDeep<T>(value: T): T {
  if (typeof value === 'string') return redact(value) as T;
  if (Array.isArray(value)) return value.map((item) => redactDeep(item)) as T;
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactDeep(item)])) as T;
  return value;
}
