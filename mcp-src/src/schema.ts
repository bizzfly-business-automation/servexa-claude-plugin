/**
 * A small JSON Schema subset (what the Servexa OpenAPI document uses: object / properties / required / additionalProperties:false,
 * enum, string length / pattern / format, number bounds, arrays, $ref into components.schemas) for two jobs:
 *   validatePayload  check a request body before generated code ships it
 *   exampleFor       build a valid example body from the schema
 * It does not try to be a general validator; a keyword it does not know is ignored, so it can only under-report, never block a valid body.
 */

export type Schema = Record<string, unknown>;
export type Schemas = Record<string, Schema>;

export interface Problem {
  path: string;
  message: string;
}

const FORMATS: Record<string, RegExp> = {
  email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
  uuid: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  uri: /^[a-z][a-z0-9+.-]*:\/\/\S+$/i,
  'date-time': /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/,
};

function resolve(schema: Schema, schemas: Schemas): Schema {
  const ref = schema.$ref;
  if (typeof ref === 'string') {
    const name = ref.replace('#/components/schemas/', '');
    return schemas[name] ?? {};
  }
  return schema;
}

const typeOf = (value: unknown): string => (value === null ? 'null' : Array.isArray(value) ? 'array' : Number.isInteger(value) ? 'integer' : typeof value);

export function validatePayload(value: unknown, schema: Schema, schemas: Schemas, path = '$', depth = 0): Problem[] {
  if (depth > 8) return [];
  const s = resolve(schema, schemas);
  const problems: Problem[] = [];
  const type = s.type as string | undefined;
  const actual = typeOf(value);
  if (type && !(type === actual || (type === 'number' && actual === 'integer'))) {
    return [{ path, message: `expected ${type}, got ${actual}` }];
  }
  if (Array.isArray(s.enum) && !s.enum.includes(value)) problems.push({ path, message: `must be one of ${JSON.stringify(s.enum)}` });
  if (typeof value === 'string') {
    if (typeof s.minLength === 'number' && value.length < s.minLength) problems.push({ path, message: `must be at least ${s.minLength} characters` });
    if (typeof s.maxLength === 'number' && value.length > s.maxLength) problems.push({ path, message: `must be at most ${s.maxLength} characters` });
    if (typeof s.pattern === 'string') {
      try {
        if (!new RegExp(s.pattern).test(value)) problems.push({ path, message: `must match ${s.pattern}` });
      } catch {
        /* an unusable pattern is not the caller's problem */
      }
    }
    const format = typeof s.format === 'string' ? FORMATS[s.format] : undefined;
    if (format && !format.test(value)) problems.push({ path, message: `must be a valid ${String(s.format)}` });
  }
  if (typeof value === 'number') {
    if (typeof s.minimum === 'number' && value < s.minimum) problems.push({ path, message: `must be at least ${s.minimum}` });
    if (typeof s.maximum === 'number' && value > s.maximum) problems.push({ path, message: `must be at most ${s.maximum}` });
  }
  if (Array.isArray(value)) {
    if (typeof s.minItems === 'number' && value.length < s.minItems) problems.push({ path, message: `must have at least ${s.minItems} items` });
    if (typeof s.maxItems === 'number' && value.length > s.maxItems) problems.push({ path, message: `must have at most ${s.maxItems} items` });
    if (s.items && typeof s.items === 'object') value.forEach((item, index) => problems.push(...validatePayload(item, s.items as Schema, schemas, `${path}[${index}]`, depth + 1)));
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const properties = (s.properties ?? {}) as Record<string, Schema>;
    const record = value as Record<string, unknown>;
    for (const name of (s.required as string[] | undefined) ?? []) {
      if (record[name] === undefined) problems.push({ path: `${path}.${name}`, message: 'is required' });
    }
    for (const [name, item] of Object.entries(record)) {
      if (item === undefined) continue;
      const property = properties[name];
      if (!property) {
        if (s.additionalProperties === false) problems.push({ path: `${path}.${name}`, message: 'is not an accepted field' });
        continue;
      }
      problems.push(...validatePayload(item, property, schemas, `${path}.${name}`, depth + 1));
    }
  }
  return problems;
}

/** A valid example for the schema. `includeOptional` also fills the optional fields. */
export function exampleFor(schema: Schema, schemas: Schemas, includeOptional: boolean, depth = 0): unknown {
  if (depth > 6) return null;
  const s = resolve(schema, schemas);
  if (Array.isArray(s.enum) && s.enum.length) return s.enum[0];
  switch (s.type) {
    case 'string': {
      if (s.format === 'email') return 'person@example.com';
      if (s.format === 'uuid') return '00000000-0000-4000-8000-000000000000';
      if (s.format === 'uri') return 'https://example.com/';
      if (s.format === 'date-time') return '2026-01-01T00:00:00Z';
      if (typeof s.pattern === 'string') return patternExample(s.pattern, s.minLength as number | undefined);
      const min = typeof s.minLength === 'number' ? s.minLength : 1;
      const max = typeof s.maxLength === 'number' ? s.maxLength : 40;
      const base = 'Example text for the Servexa integration';
      return (base.length >= min ? base : base.padEnd(min, '.')).slice(0, Math.max(min, Math.min(max, 40)));
    }
    case 'integer':
    case 'number':
      return typeof s.minimum === 'number' ? s.minimum : typeof s.maximum === 'number' ? Math.min(1, s.maximum) : 1;
    case 'boolean':
      return true;
    case 'array': {
      const min = typeof s.minItems === 'number' ? s.minItems : 1;
      return Array.from({ length: Math.max(1, min) }, () => (s.items ? exampleFor(s.items as Schema, schemas, includeOptional, depth + 1) : 'x'));
    }
    case 'object':
    default: {
      const properties = (s.properties ?? {}) as Record<string, Schema>;
      if (!Object.keys(properties).length && s.type !== 'object') return null;
      const required = new Set((s.required as string[] | undefined) ?? []);
      const out: Record<string, unknown> = {};
      for (const [name, property] of Object.entries(properties)) {
        if (required.has(name) || includeOptional) out[name] = exampleFor(property, schemas, includeOptional, depth + 1);
      }
      return out;
    }
  }
}

/** Good enough for the simple character-class patterns the contract uses (`^[A-Za-z0-9._:-]{8,64}$`). */
function patternExample(pattern: string, minLength?: number): string {
  const counted = /\{(\d+)(?:,(\d+))?\}/.exec(pattern);
  const length = Math.max(counted ? Number(counted[1]) : 1, minLength ?? 1, 8);
  const candidate = 'abcdefgh1234567890'.repeat(5).slice(0, length);
  try {
    if (new RegExp(pattern).test(candidate)) return candidate;
  } catch {
    /* fall through */
  }
  return candidate;
}
