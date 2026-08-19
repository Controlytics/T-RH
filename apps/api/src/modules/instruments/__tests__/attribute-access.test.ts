import { describe, it, expect } from 'vitest';
import { refuseAttributeWrite, needsReauth } from '../attribute-access.js';
import type { AttributeAccess } from '@digilog/shared';

const access = (over: Partial<AttributeAccess> = {}): AttributeAccess =>
  ({ mode: 'ALL_EDIT', keys: [], requireReauth: false, ...over });

const GOOD_REMARK = 'Corrected against the calibration certificate';

/**
 * The gate three routes share. What matters here is that the two rules — may you,
 * and did you say why — cannot come apart, and that a first fill is treated as
 * registration rather than as a change.
 */
describe('refuseAttributeWrite', () => {
  it('lets a configured editor change a key with a remark', () => {
    expect(refuseAttributeWrite({
      access: access(), hasUpdatePermission: true,
      key: 'Room', isNewKey: false, remark: GOOD_REMARK,
    })).toBeNull();
  });

  it('refuses a change with no remark, and says which rule was broken', () => {
    const r = refuseAttributeWrite({
      access: access(), hasUpdatePermission: true, key: 'Room', isNewKey: false, remark: '',
    });
    expect(r?.status).toBe(400);
    expect(r?.body.error).toBe('REMARK_REQUIRED');
  });

  it('does NOT demand a remark for a first fill — that is registration', () => {
    expect(refuseAttributeWrite({
      access: access(), hasUpdatePermission: true, key: 'Room', isNewKey: true,
    })).toBeNull();
  });

  it('refuses a view-only role, before it ever looks at the remark', () => {
    // Order matters: a 400 "you must give a reason" for something that would be
    // refused anyway teaches the operator to write a reason and try again.
    const r = refuseAttributeWrite({
      access: access({ mode: 'ALL_VIEW' }), hasUpdatePermission: true,
      key: 'Room', isNewKey: false, remark: '',
    });
    expect(r?.status).toBe(403);
    expect(r?.body.error).toBe('ATTRIBUTE_NOT_EDITABLE');
  });

  it('refuses a view-only role adding a new key too', () => {
    expect(refuseAttributeWrite({
      access: access({ mode: 'ALL_VIEW' }), hasUpdatePermission: true, key: 'New', isNewKey: true,
    })?.status).toBe(403);
  });

  it('SELECTED protects the keys it does not name', () => {
    const sel = access({ mode: 'SELECTED', keys: ['Room'] });
    expect(refuseAttributeWrite({
      access: sel, hasUpdatePermission: true, key: 'Room', isNewKey: false, remark: GOOD_REMARK,
    })).toBeNull();
    expect(refuseAttributeWrite({
      access: sel, hasUpdatePermission: true,
      key: 'High Temperature Limit', isNewKey: false, remark: GOOD_REMARK,
    })?.status).toBe(403);
  });

  it('SELECTED still allows adding a NEW key — it cannot overwrite a protected one', () => {
    expect(refuseAttributeWrite({
      access: access({ mode: 'SELECTED', keys: ['Room'] }),
      hasUpdatePermission: true, key: 'Supplier Ref', isNewKey: true,
    })).toBeNull();
  });

  it('refuses without INSTRUMENT_UPDATE whatever the mode says', () => {
    expect(refuseAttributeWrite({
      access: access({ mode: 'ALL_EDIT' }), hasUpdatePermission: false,
      key: 'Room', isNewKey: false, remark: GOOD_REMARK,
    })?.status).toBe(403);
  });

  it('an unconfigured role behaves exactly as before — but still owes a remark', () => {
    expect(refuseAttributeWrite({
      access: null, hasUpdatePermission: true, key: 'Room', isNewKey: false, remark: GOOD_REMARK,
    })).toBeNull();
    expect(refuseAttributeWrite({
      access: null, hasUpdatePermission: true, key: 'Room', isNewKey: false, remark: null,
    })?.body.error).toBe('REMARK_REQUIRED');
  });

  it('refuses a remark long enough to overflow signature_meaning', () => {
    expect(refuseAttributeWrite({
      access: access(), hasUpdatePermission: true,
      key: 'Room', isNewKey: false, remark: 'a'.repeat(501),
    })?.body.error).toBe('REMARK_REQUIRED');
  });
});

describe('needsReauth', () => {
  it('is off unless the role is configured for it', () => {
    expect(needsReauth(null)).toBe(false);
    expect(needsReauth(access())).toBe(false);
    expect(needsReauth(access({ requireReauth: true }))).toBe(true);
  });
});
