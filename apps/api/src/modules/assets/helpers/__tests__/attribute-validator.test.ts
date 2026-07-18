import { describe, it, expect } from 'vitest';
import { validateAttributeValues } from '../attribute-validator.js';

// ── Helpers ────────────────────────────────────────────────

function schema(fieldName: string, dataType: string, extra: Record<string, unknown> = {}) {
  return { fieldName, dataType, ...extra };
}

// ── Tests ──────────────────────────────────────────────────

describe('validateAttributeValues', () => {
  // ── Empty / null schema ──
  it('returns no errors when schema is empty', () => {
    expect(validateAttributeValues({ foo: 'bar' }, [])).toEqual([]);
  });

  it('returns no errors when schema is null', () => {
    expect(validateAttributeValues({ foo: 'bar' }, null as any)).toEqual([]);
  });

  // ── Required fields ──
  describe('required fields', () => {
    it('fails when required field is missing', () => {
      const errors = validateAttributeValues({}, [schema('name', 'TEXT', { required: true })]);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain('"name" is required');
    });

    it('fails when required field is empty string', () => {
      const errors = validateAttributeValues({ name: '' }, [schema('name', 'TEXT', { required: true })]);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain('"name" is required');
    });

    it('fails when required field is null', () => {
      const errors = validateAttributeValues({ name: null }, [schema('name', 'TEXT', { required: true })]);
      expect(errors[0]).toContain('"name" is required');
    });

    it('passes when required field has value', () => {
      expect(validateAttributeValues({ name: 'hello' }, [schema('name', 'TEXT', { required: true })])).toEqual([]);
    });
  });

  // ── INTEGER ──
  describe('INTEGER', () => {
    it('passes for valid integer', () => {
      expect(validateAttributeValues({ count: 42 }, [schema('count', 'INTEGER')])).toEqual([]);
    });

    it('fails for float value', () => {
      const errors = validateAttributeValues({ count: 3.14 }, [schema('count', 'INTEGER')]);
      expect(errors[0]).toContain('must be an integer');
    });

    it('fails for string value', () => {
      const errors = validateAttributeValues({ count: 'five' }, [schema('count', 'INTEGER')]);
      expect(errors[0]).toContain('must be an integer');
    });

    it('validates min constraint', () => {
      const s = schema('count', 'INTEGER', { numericConstraints: { enabled: true, min: 0 } });
      const errors = validateAttributeValues({ count: -1 }, [s]);
      expect(errors[0]).toContain('>= 0');
    });

    it('validates max constraint', () => {
      const s = schema('count', 'INTEGER', { numericConstraints: { enabled: true, max: 100 } });
      const errors = validateAttributeValues({ count: 101 }, [s]);
      expect(errors[0]).toContain('<= 100');
    });

    it('passes when within min/max range', () => {
      const s = schema('count', 'INTEGER', { numericConstraints: { enabled: true, min: 0, max: 100 } });
      expect(validateAttributeValues({ count: 50 }, [s])).toEqual([]);
    });
  });

  // ── FLOAT ──
  describe('FLOAT', () => {
    it('passes for valid float', () => {
      expect(validateAttributeValues({ temp: 72.5 }, [schema('temp', 'FLOAT')])).toEqual([]);
    });

    it('passes for integer as float', () => {
      expect(validateAttributeValues({ temp: 72 }, [schema('temp', 'FLOAT')])).toEqual([]);
    });

    it('fails for string', () => {
      const errors = validateAttributeValues({ temp: 'warm' }, [schema('temp', 'FLOAT')]);
      expect(errors[0]).toContain('must be a number');
    });

    it('fails for Infinity', () => {
      const errors = validateAttributeValues({ temp: Infinity }, [schema('temp', 'FLOAT')]);
      expect(errors[0]).toContain('must be a number');
    });

    it('fails for NaN', () => {
      const errors = validateAttributeValues({ temp: NaN }, [schema('temp', 'FLOAT')]);
      expect(errors[0]).toContain('must be a number');
    });
  });

  // ── BOOLEAN ──
  describe('BOOLEAN', () => {
    it('passes for true', () => {
      expect(validateAttributeValues({ active: true }, [schema('active', 'BOOLEAN')])).toEqual([]);
    });

    it('passes for false', () => {
      expect(validateAttributeValues({ active: false }, [schema('active', 'BOOLEAN')])).toEqual([]);
    });

    it('fails for string "true"', () => {
      const errors = validateAttributeValues({ active: 'true' }, [schema('active', 'BOOLEAN')]);
      expect(errors[0]).toContain('must be a boolean');
    });

    it('fails for number 1', () => {
      const errors = validateAttributeValues({ active: 1 }, [schema('active', 'BOOLEAN')]);
      expect(errors[0]).toContain('must be a boolean');
    });
  });

  // ── TEXT ──
  describe('TEXT', () => {
    it('passes for string', () => {
      expect(validateAttributeValues({ name: 'hello' }, [schema('name', 'TEXT')])).toEqual([]);
    });

    it('fails for number', () => {
      const errors = validateAttributeValues({ name: 42 }, [schema('name', 'TEXT')]);
      expect(errors[0]).toContain('must be a text string');
    });
  });

  // ── URL ──
  describe('URL', () => {
    it('passes for valid URL', () => {
      expect(validateAttributeValues({ link: 'https://example.com' }, [schema('link', 'URL')])).toEqual([]);
    });

    it('fails for invalid URL', () => {
      const errors = validateAttributeValues({ link: 'not-a-url' }, [schema('link', 'URL')]);
      expect(errors[0]).toContain('must be a valid URL');
    });

    it('fails for non-string', () => {
      const errors = validateAttributeValues({ link: 123 }, [schema('link', 'URL')]);
      expect(errors[0]).toContain('must be a URL string');
    });
  });

  // ── DATE ──
  describe('DATE', () => {
    it('passes for YYYY-MM-DD format', () => {
      expect(validateAttributeValues({ dob: '2024-01-15' }, [schema('dob', 'DATE')])).toEqual([]);
    });

    it('fails for datetime format', () => {
      const errors = validateAttributeValues({ dob: '2024-01-15T10:30:00Z' }, [schema('dob', 'DATE')]);
      expect(errors[0]).toContain('must be a valid date');
    });

    it('fails for slash format', () => {
      const errors = validateAttributeValues({ dob: '01/15/2024' }, [schema('dob', 'DATE')]);
      expect(errors[0]).toContain('must be a valid date');
    });
  });

  // ── DATETIME ──
  describe('DATETIME', () => {
    it('passes for ISO string', () => {
      expect(validateAttributeValues({ ts: '2024-01-15T10:30:00Z' }, [schema('ts', 'DATETIME')])).toEqual([]);
    });

    it('fails for invalid datetime', () => {
      const errors = validateAttributeValues({ ts: 'not-a-date' }, [schema('ts', 'DATETIME')]);
      expect(errors[0]).toContain('must be a valid datetime');
    });
  });

  // ── DROPDOWN ──
  describe('DROPDOWN', () => {
    it('passes for value in options', () => {
      const s = schema('color', 'DROPDOWN', { dropdownOptions: ['red', 'green', 'blue'] });
      expect(validateAttributeValues({ color: 'red' }, [s])).toEqual([]);
    });

    it('fails for value not in options', () => {
      const s = schema('color', 'DROPDOWN', { dropdownOptions: ['red', 'green', 'blue'] });
      const errors = validateAttributeValues({ color: 'yellow' }, [s]);
      expect(errors[0]).toContain('must be one of');
    });

    it('passes when no dropdownOptions defined', () => {
      expect(validateAttributeValues({ color: 'any' }, [schema('color', 'DROPDOWN')])).toEqual([]);
    });
  });

  // ── FILE ──
  describe('FILE', () => {
    it('passes for string', () => {
      expect(validateAttributeValues({ doc: '/path/to/file.pdf' }, [schema('doc', 'FILE')])).toEqual([]);
    });

    it('fails for non-string', () => {
      const errors = validateAttributeValues({ doc: 123 }, [schema('doc', 'FILE')]);
      expect(errors[0]).toContain('must be a text string');
    });
  });

  // ── Optional fields ──
  describe('optional fields', () => {
    it('skips validation for undefined optional field', () => {
      expect(validateAttributeValues({}, [schema('opt', 'INTEGER')])).toEqual([]);
    });

    it('skips validation for null optional field', () => {
      expect(validateAttributeValues({ opt: null }, [schema('opt', 'INTEGER')])).toEqual([]);
    });

    it('skips validation for empty string optional field', () => {
      expect(validateAttributeValues({ opt: '' }, [schema('opt', 'INTEGER')])).toEqual([]);
    });
  });

  // ── Multiple fields ──
  describe('multiple field validation', () => {
    it('validates all fields and collects errors', () => {
      const schemas = [
        schema('name', 'TEXT', { required: true }),
        schema('count', 'INTEGER'),
        schema('active', 'BOOLEAN'),
      ];
      const errors = validateAttributeValues(
        { count: 'not-a-number', active: 'yes' },
        schemas,
      );
      // name is required (missing), count is wrong type, active is wrong type
      expect(errors).toHaveLength(3);
    });
  });
});
