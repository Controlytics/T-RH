import { describe, it, expect } from 'vitest';
import { findMissingRequiredAttributes } from '../validate-template-attributes';
import type { TemplateField } from '../../types';

/**
 * Audit H5 (2026-05-04) regression tests — guards Block/Area/AHU/Filter
 * create dialogs from accepting blank values for required template
 * attributeSchema fields.
 *
 * The helper is the FE-side UX guard. Backend authoritative validator lives
 * at `apps/api/src/modules/assets/helpers/attribute-validator.ts` and has
 * its own test suite (`attribute-validator.test.ts`).
 */

const field = (name: string, required = true, dataType = 'TEXT'): TemplateField => ({
  fieldName: name,
  dataType,
  required,
});

describe('findMissingRequiredAttributes', () => {
  it('returns [] when schema is empty', () => {
    expect(findMissingRequiredAttributes({}, [])).toEqual([]);
  });

  it('returns [] when schema is null/undefined (defensive)', () => {
    // Real callers in filter-list.tsx coerce to [] before calling, but the
    // helper still defends against accidental nulls.
    expect(findMissingRequiredAttributes({}, null as unknown as TemplateField[])).toEqual([]);
    expect(findMissingRequiredAttributes({}, undefined as unknown as TemplateField[])).toEqual([]);
  });

  it('flags a required field that is missing from attrs', () => {
    expect(findMissingRequiredAttributes({}, [field('location')])).toEqual(['location']);
  });

  it('flags a required field whose value is undefined', () => {
    expect(findMissingRequiredAttributes({ location: undefined }, [field('location')])).toEqual(['location']);
  });

  it('flags a required field whose value is null', () => {
    expect(findMissingRequiredAttributes({ location: null }, [field('location')])).toEqual(['location']);
  });

  it('flags a required field whose value is the empty string', () => {
    expect(findMissingRequiredAttributes({ location: '' }, [field('location')])).toEqual(['location']);
  });

  it('flags a required field whose value is whitespace-only', () => {
    expect(findMissingRequiredAttributes({ location: '   ' }, [field('location')])).toEqual(['location']);
  });

  it('does NOT flag a required field with a populated value', () => {
    expect(findMissingRequiredAttributes({ location: 'Cleanroom A' }, [field('location')])).toEqual([]);
  });

  it('does NOT flag a non-required field that is missing', () => {
    expect(findMissingRequiredAttributes({}, [field('notes', false)])).toEqual([]);
  });

  it('does NOT flag numeric zero (0 is a valid required value)', () => {
    // Zero is intentionally valid: a capacity / pressure of 0 is meaningful.
    expect(findMissingRequiredAttributes({ capacity: 0 }, [field('capacity', true, 'INTEGER')])).toEqual([]);
  });

  it('does NOT flag boolean false (false is a valid required value)', () => {
    expect(findMissingRequiredAttributes({ active: false }, [field('active', true, 'BOOLEAN')])).toEqual([]);
  });

  it('returns multiple missing fields preserving schema order', () => {
    const schema = [field('location'), field('capacity'), field('serial')];
    expect(findMissingRequiredAttributes({ capacity: 'X' }, schema)).toEqual(['location', 'serial']);
  });

  it('mixes required + non-required correctly', () => {
    const schema = [field('location', true), field('notes', false), field('serial', true)];
    expect(findMissingRequiredAttributes({}, schema)).toEqual(['location', 'serial']);
  });
});
