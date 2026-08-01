import { describe, it, expect } from 'vitest';
import { AUDIT_ACTIONS } from '../audit-actions.js';

describe('data-injection audit actions', () => {
  it('registers all 15 actions so historic rows render', () => {
    for (const a of [
      'HIERARCHY_NODE_CREATED', 'HIERARCHY_NODE_UPDATED', 'HIERARCHY_NODE_MOVED', 'HIERARCHY_NODE_DELETED',
      'GATEWAY_CREATED', 'GATEWAY_UPDATED', 'GATEWAY_DELETED',
      'INSTRUMENT_CREATED', 'INSTRUMENT_UPDATED', 'INSTRUMENT_DELETED',
      'INSTRUMENT_TOPIC_OVERRIDE_SET', 'INSTRUMENT_TOPIC_OVERRIDE_CLEARED',
      'COMMUNICATION_PROFILE_CREATED', 'COMMUNICATION_PROFILE_UPDATED', 'COMMUNICATION_PROFILE_DELETED',
    ]) expect(AUDIT_ACTIONS, `missing ${a}`).toHaveProperty(a);
  });
});
