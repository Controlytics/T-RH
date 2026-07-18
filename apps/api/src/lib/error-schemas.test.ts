import { describe, it, expect } from 'vitest';
import { errorResponses } from './error-schemas.js';

describe('errorResponses', () => {
  it('defines schemas for common HTTP error codes', () => {
    expect(errorResponses).toHaveProperty('400');
    expect(errorResponses).toHaveProperty('401');
    expect(errorResponses).toHaveProperty('403');
    expect(errorResponses).toHaveProperty('404');
    expect(errorResponses).toHaveProperty('409');
    expect(errorResponses).toHaveProperty('500');
  });

  it('each schema has error and message properties', () => {
    for (const [code, schema] of Object.entries(errorResponses)) {
      expect(schema.type).toBe('object');
      expect(schema.properties).toHaveProperty('error');
      expect(schema.properties).toHaveProperty('message');
    }
  });

  it('allows additional properties for details/metadata', () => {
    expect(errorResponses[400].additionalProperties).toBe(true);
  });
});
