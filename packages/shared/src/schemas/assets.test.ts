import { describe, it, expect } from 'vitest';
import {
  ATTRIBUTE_DATA_TYPES,
  TELEMETRY_DATA_TYPES,
  RELATIONSHIP_TYPES,
  IDENTIFIER_TYPES,
  ASSET_STATUSES,
  INVERSE_RELATIONSHIP_MAP,
  CHECKLIST_QUESTION_TYPES,
  createAssetTemplateSchema,
  updateAssetTemplateSchema,
  createAssetInstanceSchema,
  updateAssetInstanceSchema,
  createAssetRelationshipSchema,
  createAssetIdentifierSchema,
  assetQuerySchema,
  templateQuerySchema,
} from './assets.js';

// =============================================
// Constants Tests
// =============================================

describe('Constants', () => {
  it('has 9 attribute data types', () => {
    expect(ATTRIBUTE_DATA_TYPES).toHaveLength(9);
    expect(ATTRIBUTE_DATA_TYPES).toContain('TEXT');
    expect(ATTRIBUTE_DATA_TYPES).toContain('BOOLEAN');
    expect(ATTRIBUTE_DATA_TYPES).toContain('FILE');
  });

  it('has 5 telemetry data types', () => {
    expect(TELEMETRY_DATA_TYPES).toHaveLength(5);
    expect(TELEMETRY_DATA_TYPES).toContain('INTEGER');
    expect(TELEMETRY_DATA_TYPES).toContain('ENUM');
  });

  it('has 12 relationship types', () => {
    expect(RELATIONSHIP_TYPES).toHaveLength(12);
    expect(RELATIONSHIP_TYPES).toContain('CONTAINS');
    expect(RELATIONSHIP_TYPES).toContain('CUSTOM');
  });

  it('has 5 identifier types', () => {
    expect(IDENTIFIER_TYPES).toHaveLength(5);
    expect(IDENTIFIER_TYPES).toContain('QR');
    expect(IDENTIFIER_TYPES).toContain('MANUAL');
  });

  it('has 5 asset statuses', () => {
    expect(ASSET_STATUSES).toHaveLength(5);
    expect(ASSET_STATUSES).toContain('Active');
    expect(ASSET_STATUSES).toContain('Decommissioned');
  });

  it('has correct inverse relationship mappings', () => {
    expect(INVERSE_RELATIONSHIP_MAP['CONTAINS']).toBe('CONTAINED_IN');
    expect(INVERSE_RELATIONSHIP_MAP['CONTAINED_IN']).toBe('CONTAINS');
    expect(INVERSE_RELATIONSHIP_MAP['FEEDS']).toBe('FED_BY');
    expect(INVERSE_RELATIONSHIP_MAP['CONNECTED_TO']).toBe('CONNECTED_TO');
    expect(INVERSE_RELATIONSHIP_MAP['CUSTOM']).toBe('CUSTOM');
  });

  it('inverse map is symmetric', () => {
    for (const [key, value] of Object.entries(INVERSE_RELATIONSHIP_MAP)) {
      expect(INVERSE_RELATIONSHIP_MAP[value]).toBe(key);
    }
  });

});

// =============================================
// Template Schema Tests
// =============================================

describe('createAssetTemplateSchema', () => {
  it('accepts minimal template', () => {
    const result = createAssetTemplateSchema.safeParse({ name: 'Pump' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.category).toBe('General');
      expect(result.data.icon).toBe('box');
      expect(result.data.attributeSchema).toEqual([]);
      expect(result.data.maxParentConnections).toBe(1);
      expect(result.data.maxConnections).toBe(10);
    }
  });

  it('accepts full template with attributes', () => {
    const result = createAssetTemplateSchema.safeParse({
      name: 'Temperature Sensor',
      description: 'Industrial temperature sensor',
      category: 'Sensor',
      icon: 'thermometer',
      attributeSchema: [
        { fieldName: 'model', dataType: 'TEXT' },
        { fieldName: 'maxTemp', dataType: 'FLOAT', unit: 'C', numericConstraints: { enabled: true, min: -40, max: 200 } },
        { fieldName: 'installDate', dataType: 'DATE', required: true },
      ],
      telemetrySchema: [
        { fieldName: 'temperature', dataType: 'FLOAT', unit: 'C' },
      ],
      expectedIdentifiers: [
        { identifierType: 'QR', required: true },
      ],
      maxParentConnections: 1,
      maxConnections: 5,
    });
    expect(result.success).toBe(true);
  });

  it('rejects empty name', () => {
    expect(createAssetTemplateSchema.safeParse({ name: '' }).success).toBe(false);
  });

  it('rejects name over 100 chars', () => {
    expect(createAssetTemplateSchema.safeParse({ name: 'a'.repeat(101) }).success).toBe(false);
  });

  it('rejects invalid attribute data type', () => {
    const result = createAssetTemplateSchema.safeParse({
      name: 'Test',
      attributeSchema: [{ fieldName: 'x', dataType: 'INVALID_TYPE' }],
    });
    expect(result.success).toBe(false);
  });

  it('validates all attribute data types', () => {
    for (const dt of ATTRIBUTE_DATA_TYPES) {
      const result = createAssetTemplateSchema.safeParse({
        name: 'Test',
        attributeSchema: [{ fieldName: 'field', dataType: dt }],
      });
      expect(result.success).toBe(true);
    }
  });

  it('validates numeric constraints', () => {
    const result = createAssetTemplateSchema.safeParse({
      name: 'Test',
      attributeSchema: [{
        fieldName: 'value',
        dataType: 'FLOAT',
        numericConstraints: { enabled: true, min: 0, max: 100, resolution: 0.1 },
      }],
    });
    expect(result.success).toBe(true);
  });

  it('rejects negative resolution', () => {
    const result = createAssetTemplateSchema.safeParse({
      name: 'Test',
      attributeSchema: [{
        fieldName: 'value',
        dataType: 'FLOAT',
        numericConstraints: { enabled: true, resolution: -1 },
      }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects invalid telemetry data type', () => {
    const result = createAssetTemplateSchema.safeParse({
      name: 'Test',
      telemetrySchema: [{ fieldName: 'x', dataType: 'FILE' }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects invalid identifier type', () => {
    const result = createAssetTemplateSchema.safeParse({
      name: 'Test',
      expectedIdentifiers: [{ identifierType: 'BLUETOOTH' }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects negative maxParentConnections', () => {
    expect(createAssetTemplateSchema.safeParse({ name: 'T', maxParentConnections: -1 }).success).toBe(false);
  });

  it('accepts zero maxParentConnections (no parents)', () => {
    const result = createAssetTemplateSchema.safeParse({ name: 'T', maxParentConnections: 0 });
    expect(result.success).toBe(true);
  });
});

describe('updateAssetTemplateSchema', () => {
  it('accepts empty object (all optional)', () => {
    expect(updateAssetTemplateSchema.safeParse({}).success).toBe(true);
  });

  it('accepts partial update', () => {
    const result = updateAssetTemplateSchema.safeParse({ name: 'Updated Name', category: 'Equipment' });
    expect(result.success).toBe(true);
  });
});

// =============================================
// Instance Schema Tests
// =============================================

describe('createAssetInstanceSchema', () => {
  const validUUID = '550e8400-e29b-41d4-a716-446655440000';

  it('accepts valid instance', () => {
    const result = createAssetInstanceSchema.safeParse({
      name: 'Pump 01',
      templateId: validUUID,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.status).toBe('Active');
      expect(result.data.attributes).toEqual({});
    }
  });

  it('accepts with parent', () => {
    const result = createAssetInstanceSchema.safeParse({
      name: 'Sub-system A',
      templateId: validUUID,
      parentId: validUUID,
    });
    expect(result.success).toBe(true);
  });

  it('accepts null parentId', () => {
    const result = createAssetInstanceSchema.safeParse({
      name: 'Root Node',
      templateId: validUUID,
      parentId: null,
    });
    expect(result.success).toBe(true);
  });

  it('rejects empty name', () => {
    expect(createAssetInstanceSchema.safeParse({ name: '', templateId: validUUID }).success).toBe(false);
  });

  it('rejects invalid templateId', () => {
    expect(createAssetInstanceSchema.safeParse({ name: 'Test', templateId: 'not-uuid' }).success).toBe(false);
  });

  it('rejects name over 255 chars', () => {
    expect(createAssetInstanceSchema.safeParse({ name: 'a'.repeat(256), templateId: validUUID }).success).toBe(false);
  });
});

describe('updateAssetInstanceSchema', () => {
  it('accepts empty object', () => {
    expect(updateAssetInstanceSchema.safeParse({}).success).toBe(true);
  });

  it('accepts partial updates', () => {
    const result = updateAssetInstanceSchema.safeParse({
      name: 'Updated Pump',
      status: 'Under Maintenance',
    });
    expect(result.success).toBe(true);
  });
});

// =============================================
// Relationship Schema Tests
// =============================================

describe('createAssetRelationshipSchema', () => {
  const uuid1 = '550e8400-e29b-41d4-a716-446655440000';
  const uuid2 = '660e8400-e29b-41d4-a716-446655440000';

  it('accepts valid relationship', () => {
    const result = createAssetRelationshipSchema.safeParse({
      sourceAssetId: uuid1,
      targetAssetId: uuid2,
      relationshipType: 'CONTAINS',
    });
    expect(result.success).toBe(true);
  });

  it('accepts all relationship types', () => {
    for (const rt of RELATIONSHIP_TYPES) {
      const result = createAssetRelationshipSchema.safeParse({
        sourceAssetId: uuid1,
        targetAssetId: uuid2,
        relationshipType: rt,
      });
      expect(result.success).toBe(true);
    }
  });

  it('accepts with optional fields', () => {
    const result = createAssetRelationshipSchema.safeParse({
      sourceAssetId: uuid1,
      targetAssetId: uuid2,
      relationshipType: 'CUSTOM',
      customLabel: 'Adjacent to',
      notes: 'Physically adjacent units',
    });
    expect(result.success).toBe(true);
  });

  it('rejects invalid relationship type', () => {
    expect(createAssetRelationshipSchema.safeParse({
      sourceAssetId: uuid1,
      targetAssetId: uuid2,
      relationshipType: 'INVALID',
    }).success).toBe(false);
  });

  it('rejects non-UUID source', () => {
    expect(createAssetRelationshipSchema.safeParse({
      sourceAssetId: 'bad-id',
      targetAssetId: uuid2,
      relationshipType: 'FEEDS',
    }).success).toBe(false);
  });
});

// =============================================
// Identifier Schema Tests
// =============================================

describe('createAssetIdentifierSchema', () => {
  const validUUID = '550e8400-e29b-41d4-a716-446655440000';

  it('accepts valid identifier', () => {
    const result = createAssetIdentifierSchema.safeParse({
      assetId: validUUID,
      identifierType: 'QR',
      identifierValue: 'QR-12345',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.isPrimary).toBe(false);
    }
  });

  it('accepts all identifier types', () => {
    for (const it of IDENTIFIER_TYPES) {
      const result = createAssetIdentifierSchema.safeParse({
        assetId: validUUID,
        identifierType: it,
        identifierValue: `${it}-001`,
      });
      expect(result.success).toBe(true);
    }
  });

  it('rejects empty identifierValue', () => {
    expect(createAssetIdentifierSchema.safeParse({
      assetId: validUUID,
      identifierType: 'RFID',
      identifierValue: '',
    }).success).toBe(false);
  });

  it('rejects identifierValue over 255 chars', () => {
    expect(createAssetIdentifierSchema.safeParse({
      assetId: validUUID,
      identifierType: 'BARCODE',
      identifierValue: 'x'.repeat(256),
    }).success).toBe(false);
  });
});

// =============================================
// Query Schema Tests
// =============================================

describe('assetQuerySchema', () => {
  it('defaults page to 1 and leaves limit undefined (uncapped — returns all)', () => {
    // 2026-07-03: record lists are uncapped. An omitted limit stays undefined so
    // the service returns ALL rows (no `take`), instead of silently capping.
    const result = assetQuerySchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.page).toBe(1);
      expect(result.data.limit).toBeUndefined();
    }
  });

  it('coerces page and limit from strings when provided', () => {
    const result = assetQuerySchema.safeParse({ page: '2', limit: '25' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.page).toBe(2);
      expect(result.data.limit).toBe(25);
    }
  });

  it('accepts a large explicit limit (no upper cap — nothing is hidden)', () => {
    const result = assetQuerySchema.safeParse({ limit: '100000' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.limit).toBe(100000);
  });

  it('accepts all optional filters', () => {
    const validUUID = '550e8400-e29b-41d4-a716-446655440000';
    const result = assetQuerySchema.safeParse({
      search: 'pump',
      templateId: validUUID,
      status: 'Active',
      parentId: validUUID,
      isActive: 'true',
    });
    expect(result.success).toBe(true);
  });
});

describe('templateQuerySchema', () => {
  it('defaults page to 1 and leaves limit undefined (uncapped — returns all)', () => {
    const result = templateQuerySchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.page).toBe(1);
      expect(result.data.limit).toBeUndefined();
    }
  });

  it('accepts search filter', () => {
    const result = templateQuerySchema.safeParse({ search: 'sensor' });
    expect(result.success).toBe(true);
  });
});

// =============================================
// Checklist Schema Tests
// =============================================

describe('CHECKLIST_QUESTION_TYPES', () => {
  it('has 14 question types', () => {
    expect(CHECKLIST_QUESTION_TYPES).toHaveLength(14);
  });

  it('contains all expected types', () => {
    const expected = [
      'PASS_FAIL', 'YES_NO', 'YES_NO_NA', 'MCQ', 'MULTI_SELECT',
      'TEXT', 'NUMERIC', 'DROPDOWN', 'PHOTO', 'DATE_TIME',
      'SIGNATURE', 'YES_NO_COMMENT', 'CALCULATED', 'CONDITIONAL',
    ];
    for (const t of expected) {
      expect(CHECKLIST_QUESTION_TYPES).toContain(t);
    }
  });
});

describe('checklistSchema in createAssetTemplateSchema', () => {
  it('defaults checklistSchema to empty array', () => {
    const result = createAssetTemplateSchema.safeParse({ name: 'Test' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.checklistSchema).toEqual([]);
    }
  });

  it('accepts a simple checklist item', () => {
    const result = createAssetTemplateSchema.safeParse({
      name: 'Checklist Template',
      checklistSchema: [
        { question: 'Is pump running?', questionType: 'YES_NO' },
      ],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.checklistSchema).toHaveLength(1);
      expect(result.data.checklistSchema[0].question).toBe('Is pump running?');
      expect(result.data.checklistSchema[0].required).toBe(false);
      expect(result.data.checklistSchema[0].options).toEqual([]);
    }
  });

  it('accepts all question types', () => {
    for (const qt of CHECKLIST_QUESTION_TYPES) {
      const result = createAssetTemplateSchema.safeParse({
        name: 'Test',
        checklistSchema: [{ question: `Q for ${qt}`, questionType: qt }],
      });
      expect(result.success).toBe(true);
    }
  });

  it('accepts fully populated checklist item', () => {
    const result = createAssetTemplateSchema.safeParse({
      name: 'Full Checklist',
      checklistSchema: [{
        question: 'Measure temperature',
        questionType: 'NUMERIC',
        required: true,
        section: 'Pre-flight',
        description: 'Measure the operating temperature',
        options: [],
        passCriteria: 'Within range',
        numericUnit: 'C',
        numericMin: 10,
        numericMax: 100,
        calculatedExpression: '',
        conditionalField: '',
        conditionalValue: '',
      }],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      const item = result.data.checklistSchema[0];
      expect(item.required).toBe(true);
      expect(item.section).toBe('Pre-flight');
      expect(item.numericUnit).toBe('C');
      expect(item.numericMin).toBe(10);
      expect(item.numericMax).toBe(100);
    }
  });

  it('accepts MCQ with options', () => {
    const result = createAssetTemplateSchema.safeParse({
      name: 'MCQ Template',
      checklistSchema: [{
        question: 'Select severity',
        questionType: 'MCQ',
        options: ['Low', 'Medium', 'High', 'Critical'],
      }],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.checklistSchema[0].options).toEqual(['Low', 'Medium', 'High', 'Critical']);
    }
  });

  it('accepts CALCULATED with expression', () => {
    const result = createAssetTemplateSchema.safeParse({
      name: 'Calc Template',
      checklistSchema: [{
        question: 'Compute efficiency',
        questionType: 'CALCULATED',
        calculatedExpression: 'output / input * 100',
      }],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.checklistSchema[0].calculatedExpression).toBe('output / input * 100');
    }
  });

  it('accepts CONDITIONAL with field and value', () => {
    const result = createAssetTemplateSchema.safeParse({
      name: 'Cond Template',
      checklistSchema: [{
        question: 'If pump is off, describe reason',
        questionType: 'CONDITIONAL',
        conditionalField: 'isPumpRunning',
        conditionalValue: 'No',
      }],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.checklistSchema[0].conditionalField).toBe('isPumpRunning');
      expect(result.data.checklistSchema[0].conditionalValue).toBe('No');
    }
  });

  it('accepts multiple checklist items', () => {
    const result = createAssetTemplateSchema.safeParse({
      name: 'Multi Checklist',
      checklistSchema: [
        { question: 'Step 1', questionType: 'PASS_FAIL', section: 'Setup' },
        { question: 'Step 2', questionType: 'YES_NO', section: 'Setup' },
        { question: 'Step 3', questionType: 'TEXT', section: 'Verification' },
        { question: 'Step 4', questionType: 'SIGNATURE', section: 'Sign-off', required: true },
      ],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.checklistSchema).toHaveLength(4);
    }
  });

  it('rejects empty question string', () => {
    const result = createAssetTemplateSchema.safeParse({
      name: 'Test',
      checklistSchema: [{ question: '', questionType: 'YES_NO' }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects invalid question type', () => {
    const result = createAssetTemplateSchema.safeParse({
      name: 'Test',
      checklistSchema: [{ question: 'Q?', questionType: 'INVALID_TYPE' }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects question over 500 chars', () => {
    const result = createAssetTemplateSchema.safeParse({
      name: 'Test',
      checklistSchema: [{ question: 'x'.repeat(501), questionType: 'TEXT' }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects section over 100 chars', () => {
    const result = createAssetTemplateSchema.safeParse({
      name: 'Test',
      checklistSchema: [{ question: 'Q?', questionType: 'TEXT', section: 'x'.repeat(101) }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects description over 500 chars', () => {
    const result = createAssetTemplateSchema.safeParse({
      name: 'Test',
      checklistSchema: [{ question: 'Q?', questionType: 'TEXT', description: 'x'.repeat(501) }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing question field', () => {
    const result = createAssetTemplateSchema.safeParse({
      name: 'Test',
      checklistSchema: [{ questionType: 'TEXT' }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing questionType field', () => {
    const result = createAssetTemplateSchema.safeParse({
      name: 'Test',
      checklistSchema: [{ question: 'Test question' }],
    });
    expect(result.success).toBe(false);
  });

  it('update schema accepts partial checklist update', () => {
    const result = updateAssetTemplateSchema.safeParse({
      checklistSchema: [
        { question: 'Updated Q', questionType: 'PASS_FAIL', required: true },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('update schema accepts empty checklist (clear all)', () => {
    const result = updateAssetTemplateSchema.safeParse({
      checklistSchema: [],
    });
    expect(result.success).toBe(true);
  });
});
