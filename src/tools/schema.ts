import type { InputSchema } from './types.js';

/**
 * Validate model-produced arguments against a tool's schema. Strict on
 * required fields and types (execution safety), lenient on unknown extra
 * keys (small models add them; rejecting would just burn a retry loop).
 * Returns error strings phrased so the model can self-correct.
 */
export function validateInput(schema: InputSchema, input: unknown): string[] {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return [`arguments must be a JSON object, got ${input === null ? 'null' : Array.isArray(input) ? 'array' : typeof input}`];
  }
  const obj = input as Record<string, unknown>;
  const errors: string[] = [];
  for (const key of schema.required ?? []) {
    if (obj[key] === undefined || obj[key] === null || obj[key] === '') {
      errors.push(`missing required parameter "${key}"`);
    }
  }
  for (const [key, value] of Object.entries(obj)) {
    const prop = schema.properties[key];
    if (!prop || value === undefined || value === null) continue;
    switch (prop.type) {
      case 'string':
        if (typeof value !== 'string') errors.push(`"${key}" must be a string`);
        else if (prop.enum && !prop.enum.includes(value)) {
          errors.push(`"${key}" must be one of: ${prop.enum.join(', ')}`);
        }
        break;
      case 'number':
        if (typeof value !== 'number' || !Number.isFinite(value)) errors.push(`"${key}" must be a number`);
        break;
      case 'integer':
        if (typeof value !== 'number' || !Number.isInteger(value)) errors.push(`"${key}" must be an integer`);
        break;
      case 'boolean':
        if (typeof value !== 'boolean') errors.push(`"${key}" must be a boolean`);
        break;
      default:
        // Types beyond our subset (object/array — e.g. from MCP server
        // schemas) are not validated locally; the executing side owns them.
        break;
    }
  }
  return errors;
}

/**
 * Parse a raw tool-call arguments string leniently: models wrap JSON in code
 * fences or emit an empty string for no-arg calls. Returns undefined when the
 * string is not recoverable JSON — the caller feeds that back as an error.
 */
export function parseArguments(raw: string): Record<string, unknown> | undefined {
  let s = raw.trim();
  if (s === '') return {};
  const fence = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fence) s = fence[1];
  try {
    const parsed = JSON.parse(s);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fall through
  }
  return undefined;
}
