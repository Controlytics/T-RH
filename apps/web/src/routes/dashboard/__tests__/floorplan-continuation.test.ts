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
