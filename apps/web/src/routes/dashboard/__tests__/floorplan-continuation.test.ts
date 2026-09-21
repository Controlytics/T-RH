import { describe, it, expect } from 'vitest';
import { continuationBase } from '../floorplan-view';

describe('continuationBase — which corridor piece a suffixed code continues', () => {
  it('strips the " (N)" suffix and upper-cases', () => {
    expect(continuationBase('CWH-I/217 (2)')).toBe('CWH-I/217');
    expect(continuationBase('service corridor (3)')).toBe('SERVICE CORRIDOR');
  });
  it('is null for a code with no suffix', () => {
    expect(continuationBase('CWH-I/217')).toBeNull();
    expect(continuationBase('LOBBY')).toBeNull();
    expect(continuationBase('CWH-I/217(2)')).toBeNull();
  });
});

import { sameSpace } from '../floorplan-view';

describe('sameSpace — which adjoining rooms draw with no wall between them', () => {
  it('joins two circulation rooms whatever their codes', () => {
    expect(sameSpace({ code: 'LOBBY', grade: 'CIRCULATION' }, { code: 'CWH-I/217 (2)', grade: 'CIRCULATION' })).toBe(true);
  });
  it('joins the pieces of one code regardless of grade', () => {
    expect(sameSpace({ code: 'INCUBATOR-01', grade: null }, { code: 'INCUBATOR-01 (2)', grade: null })).toBe(true);
    expect(sameSpace({ code: 'CWH-I/187 (2)', grade: 'UTILITY' }, { code: 'CWH-I/187', grade: 'UTILITY' })).toBe(true);
    expect(sameSpace({ code: 'X (2)', grade: 'C' }, { code: 'X (3)', grade: 'C' })).toBe(true);
  });
  it('keeps a service band apart from a corridor, and unrelated rooms apart', () => {
    expect(sameSpace({ code: 'SHAFT-E', grade: 'UTILITY' }, { code: 'CWH-I/217 (3)', grade: 'CIRCULATION' })).toBe(false);
    expect(sameSpace({ code: 'CWH-I/224', grade: 'C' }, { code: 'CWH-I/225', grade: 'C' })).toBe(false);
  });
});
