import { describe, expect, it } from 'vitest';
import { parseArguments, validateInput } from '../src/tools/schema.js';
import type { InputSchema } from '../src/tools/types.js';

const schema: InputSchema = {
  type: 'object',
  properties: {
    file_path: { type: 'string' },
    limit: { type: 'integer' },
    mode: { type: 'string', enum: ['files', 'content'] },
    all: { type: 'boolean' },
  },
  required: ['file_path'],
};

describe('validateInput', () => {
  it('accepts valid input and ignores unknown extra keys', () => {
    expect(validateInput(schema, { file_path: 'a.ts', limit: 3, stray: 'ok' })).toEqual([]);
  });

  it('reports missing required and wrong types together', () => {
    const errors = validateInput(schema, { limit: 1.5, all: 'yes' });
    expect(errors).toContain('missing required parameter "file_path"');
    expect(errors).toContain('"limit" must be an integer');
    expect(errors).toContain('"all" must be a boolean');
  });

  it('enforces enums and rejects non-objects', () => {
    expect(validateInput(schema, { file_path: 'a', mode: 'nope' })).toEqual([
      '"mode" must be one of: files, content',
    ]);
    expect(validateInput(schema, 'x')[0]).toMatch(/must be a JSON object/);
    expect(validateInput(schema, [1])[0]).toMatch(/got array/);
  });
});

describe('parseArguments', () => {
  it('parses plain and fenced JSON, and empty string as {}', () => {
    expect(parseArguments('{"a":1}')).toEqual({ a: 1 });
    expect(parseArguments('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseArguments('')).toEqual({});
  });

  it('returns undefined for unrecoverable input', () => {
    expect(parseArguments('not json')).toBeUndefined();
    expect(parseArguments('[1,2]')).toBeUndefined();
  });
});
