'use strict';

// Feature 9 Step 3 — TeacherRecommendationValidation model shape + field
// validation, entirely offline (sequelize.define()/instance.validate() run
// without a live DB connection, matching tests/thresholdHistoryModel.test.js's
// own established pattern). No row is ever created against the real DB.

// The model file assigns named constants onto the exported model function
// itself (module.exports = Model; module.exports.CASE_TYPE_VALUES = ...),
// matching TeacherValidation.js's own plain `module.exports = Model` shape
// — a single require gives both the model and its constants.
const Model = require('../src/models/TeacherRecommendationValidation');
const {
  CASE_TYPE_VALUES, FAMILY_VALUES, VALIDATION_VALUES, RECOMMENDATION_TYPE_VALUES,
  MAX_TEACHER_NOTE_LENGTH,
} = Model;

const VALID_SHA256 = 'a'.repeat(64);
const VALID_SHA256_2 = 'b'.repeat(64);
const VALID_ACTION_ID = '11111111-1111-4111-8111-111111111111';

function validRecord(overrides = {}) {
  return {
    student_id: 13,
    teacher_id: 4,
    case_type: 'lowercase',
    family: 'curved',
    recommendation_type: 'motor_family_practice',
    recommendation_title: 'Curved Movement Practice',
    focus_letters: ['c', 'o'],
    suggested_activities: ['Circle tracing exercises', 'Curved-line guided tracing'],
    rationale: 'Curved movement practice is recommended because difficulty remained across two separate practice periods.',
    validation: 'confirmed',
    action_id: VALID_ACTION_ID,
    teacher_note: null,
    evidence_fingerprint: VALID_SHA256,
    recommendation_fingerprint: VALID_SHA256_2,
    persistent_policy_version: 'persistent_difficulty_v1',
    recommendation_policy_version: 'worksheet_recommendation_v1',
    mapping_version: 'letter-baseline-family-v1',
    ...overrides,
  };
}

describe('13. model registration', () => {
  it('is a defined Sequelize model', () => {
    expect(Model).toBeDefined();
    expect(typeof Model.build).toBe('function');
  });
});

describe('14. table name', () => {
  it('maps to teacher_recommendation_validations', () => {
    expect(Model.getTableName()).toBe('teacher_recommendation_validations');
  });
});

describe('15. timestamps disabled, explicit created_at only', () => {
  it('declares no updated_at attribute and no automatic timestamps', () => {
    expect(Model.rawAttributes.updated_at).toBeUndefined();
    expect(Model.rawAttributes.created_at).toBeDefined();
    expect(Model.options.timestamps).toBe(false);
  });

  it('a valid record passes with created_at unset (defaultValue applies)', async () => {
    const instance = Model.build(validRecord());
    await expect(instance.validate()).resolves.toBeDefined();
  });
});

describe('16. case_type enum', () => {
  it.each(CASE_TYPE_VALUES)('accepts %s', async (caseType) => {
    const instance = Model.build(validRecord({ case_type: caseType }));
    await expect(instance.validate()).resolves.toBeDefined();
  });

  it('rejects an unrecognized case_type', async () => {
    const instance = Model.build(validRecord({ case_type: 'mixedcase' }));
    await expect(instance.validate()).rejects.toThrow();
  });
});

describe('17. family enum', () => {
  it.each(FAMILY_VALUES)('accepts %s', async (family) => {
    const instance = Model.build(validRecord({ family }));
    await expect(instance.validate()).resolves.toBeDefined();
  });

  it('rejects a motor-primitive-taxonomy value (never a fourth family)', async () => {
    const instance = Model.build(validRecord({ family: 'diagonal' }));
    await expect(instance.validate()).rejects.toThrow();
  });
});

describe('18. validation enum', () => {
  it.each(VALIDATION_VALUES)('accepts %s', async (validation) => {
    const instance = Model.build(validRecord({ validation }));
    await expect(instance.validate()).resolves.toBeDefined();
  });

  it.each(['modified', 'approved', 'rejected', 'correct', 'incorrect'])(
    'rejects %s',
    async (value) => {
      const instance = Model.build(validRecord({ validation: value }));
      await expect(instance.validate()).rejects.toThrow();
    }
  );
});

describe('19. recommendation_type enum', () => {
  it.each(RECOMMENDATION_TYPE_VALUES)('accepts %s', async (recommendationType) => {
    const instance = Model.build(validRecord({ recommendation_type: recommendationType }));
    await expect(instance.validate()).resolves.toBeDefined();
  });

  it('rejects an unrecognized recommendation_type', async () => {
    const instance = Model.build(validRecord({ recommendation_type: 'some_other_type' }));
    await expect(instance.validate()).rejects.toThrow();
  });
});

describe('20. fingerprint format validation', () => {
  it('rejects a malformed evidence_fingerprint', async () => {
    const instance = Model.build(validRecord({ evidence_fingerprint: 'not-a-real-hash' }));
    await expect(instance.validate()).rejects.toThrow();
  });

  it('rejects a malformed recommendation_fingerprint', async () => {
    const instance = Model.build(validRecord({ recommendation_fingerprint: 'TOO-SHORT' }));
    await expect(instance.validate()).rejects.toThrow();
  });

  it('rejects an uppercase-hex fingerprint (lowercase only)', async () => {
    const instance = Model.build(validRecord({ evidence_fingerprint: 'A'.repeat(64) }));
    await expect(instance.validate()).rejects.toThrow();
  });

  it('accepts well-formed 64-char lowercase hex fingerprints', async () => {
    const instance = Model.build(validRecord());
    await expect(instance.validate()).resolves.toBeDefined();
  });
});

describe('21. focus_letters is stored/read as an array', () => {
  it('preserves order and case through build (no re-sort, no case change)', () => {
    const instance = Model.build(validRecord({ focus_letters: ['O', 'c', 'v'] }));
    expect(instance.focus_letters).toEqual(['O', 'c', 'v']);
  });
});

describe('22. suggested_activities is stored/read as an array', () => {
  it('preserves the exact array given, untouched', () => {
    const activities = ['Guided tracing of focus letters', 'Verbal step-by-step cues'];
    const instance = Model.build(validRecord({ suggested_activities: activities }));
    expect(instance.suggested_activities).toEqual(activities);
  });
});

describe('23. teacher_note is optional', () => {
  it('accepts null', async () => {
    const instance = Model.build(validRecord({ teacher_note: null }));
    await expect(instance.validate()).resolves.toBeDefined();
  });

  it('accepts a normal-length string', async () => {
    const instance = Model.build(validRecord({ teacher_note: 'Child was tired today.' }));
    await expect(instance.validate()).resolves.toBeDefined();
  });
});

describe('24. teacher_note length bound rejected when exceeded', () => {
  it(`accepts exactly ${MAX_TEACHER_NOTE_LENGTH} characters`, async () => {
    const instance = Model.build(validRecord({ teacher_note: 'x'.repeat(MAX_TEACHER_NOTE_LENGTH) }));
    await expect(instance.validate()).resolves.toBeDefined();
  });

  it(`rejects ${MAX_TEACHER_NOTE_LENGTH + 1} characters`, async () => {
    const instance = Model.build(validRecord({ teacher_note: 'x'.repeat(MAX_TEACHER_NOTE_LENGTH + 1) }));
    await expect(instance.validate()).rejects.toThrow();
  });
});

describe('25. no update-specific hooks/behavior on the model definition', () => {
  it('defines no beforeUpdate/afterUpdate hook', () => {
    const hooks = Model.options.hooks || {};
    expect(hooks.beforeUpdate).toBeUndefined();
    expect(hooks.afterUpdate).toBeUndefined();
  });
});

describe('26. no delete-specific behavior on the model definition', () => {
  it('defines no beforeDestroy/afterDestroy hook and no paranoid soft-delete mode', () => {
    const hooks = Model.options.hooks || {};
    expect(hooks.beforeDestroy).toBeUndefined();
    expect(hooks.afterDestroy).toBeUndefined();
    expect(Model.options.paranoid).not.toBe(true);
  });
});

describe('27. action_id (Feature 9 repair — sole idempotency key)', () => {
  it('accepts a well-formed UUID', async () => {
    const instance = Model.build(validRecord({ action_id: VALID_ACTION_ID }));
    await expect(instance.validate()).resolves.toBeDefined();
  });

  it('is required', async () => {
    const record = validRecord();
    delete record.action_id;
    const instance = Model.build(record);
    await expect(instance.validate()).rejects.toThrow();
  });

  it('rejects a malformed (non-UUID) value', async () => {
    const instance = Model.build(validRecord({ action_id: 'not-a-uuid' }));
    await expect(instance.validate()).rejects.toThrow();
  });
});

describe('required fields are enforced', () => {
  it.each([
    'student_id', 'teacher_id', 'case_type', 'family',
    'recommendation_type', 'recommendation_title',
    'focus_letters', 'suggested_activities', 'rationale',
    'validation', 'action_id', 'evidence_fingerprint', 'recommendation_fingerprint',
    'persistent_policy_version', 'recommendation_policy_version', 'mapping_version',
  ])('rejects a record missing %s', async (field) => {
    const record = validRecord();
    delete record[field];
    const instance = Model.build(record);
    await expect(instance.validate()).rejects.toThrow();
  });

  it('accepts a fully valid record', async () => {
    const instance = Model.build(validRecord());
    await expect(instance.validate()).resolves.toBeDefined();
  });
});

describe('positive-integer id fields', () => {
  it('rejects a non-positive student_id', async () => {
    const instance = Model.build(validRecord({ student_id: 0 }));
    await expect(instance.validate()).rejects.toThrow();
  });

  it('rejects a non-positive teacher_id', async () => {
    const instance = Model.build(validRecord({ teacher_id: -1 }));
    await expect(instance.validate()).rejects.toThrow();
  });
});
