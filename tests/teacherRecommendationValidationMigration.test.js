'use strict';

// Feature 9 Step 3 — migration unit coverage against a mocked
// queryInterface (no real DB connection, no real CREATE TABLE), mirroring
// tests/restorePersonalThresholdsColumnMigration.test.js's own established
// pattern for testing a migration's logic directly.

const Sequelize = require('sequelize');
const migration = require('../migrations/20260814000001-create-teacher-recommendation-validations');

function makeQueryInterface() {
  return {
    createTable: jest.fn().mockResolvedValue(undefined),
    addIndex:    jest.fn().mockResolvedValue(undefined),
    dropTable:   jest.fn().mockResolvedValue(undefined),
  };
}

describe('up() — 1. creates exactly the expected table', () => {
  it('calls createTable with teacher_recommendation_validations', async () => {
    const qi = makeQueryInterface();
    await migration.up(qi, Sequelize);
    expect(qi.createTable).toHaveBeenCalledTimes(1);
    expect(qi.createTable.mock.calls[0][0]).toBe('teacher_recommendation_validations');
  });
});

describe('down() — 2. removes the table', () => {
  it('calls dropTable with teacher_recommendation_validations', async () => {
    const qi = makeQueryInterface();
    await migration.down(qi, Sequelize);
    expect(qi.dropTable).toHaveBeenCalledWith('teacher_recommendation_validations');
  });
});

describe('up() — 3. expected columns exist', () => {
  it('defines every required column', () => {
    const qi = makeQueryInterface();
    return migration.up(qi, Sequelize).then(() => {
      const columns = qi.createTable.mock.calls[0][1];
      expect(Object.keys(columns)).toEqual([
        'id', 'student_id', 'teacher_id',
        'case_type', 'family',
        'recommendation_type', 'recommendation_title',
        'focus_letters', 'suggested_activities', 'rationale',
        'validation', 'teacher_note',
        'evidence_fingerprint', 'recommendation_fingerprint',
        'persistent_policy_version', 'recommendation_policy_version', 'mapping_version',
        'created_at',
      ]);
    });
  });
});

describe('up() — 4-8. individual column types', () => {
  let columns;
  beforeAll(async () => {
    const qi = makeQueryInterface();
    await migration.up(qi, Sequelize);
    columns = qi.createTable.mock.calls[0][1];
  });

  it('4. focus_letters is JSONB', () => {
    expect(columns.focus_letters.type).toBe(Sequelize.JSONB);
    expect(columns.focus_letters.allowNull).toBe(false);
  });

  it('5. suggested_activities is JSONB', () => {
    expect(columns.suggested_activities.type).toBe(Sequelize.JSONB);
    expect(columns.suggested_activities.allowNull).toBe(false);
  });

  it('6. rationale is TEXT and required', () => {
    expect(columns.rationale.type).toBe(Sequelize.TEXT);
    expect(columns.rationale.allowNull).toBe(false);
  });

  it('7. teacher_note is nullable TEXT', () => {
    expect(columns.teacher_note.type).toBe(Sequelize.TEXT);
    expect(columns.teacher_note.allowNull).toBe(true);
  });

  it('8. created_at exists', () => {
    expect(columns.created_at).toBeDefined();
    expect(columns.created_at.type).toBe(Sequelize.DATE);
  });
});

describe('up() — 9. no updated_at column', () => {
  it('the table definition never includes updated_at', async () => {
    const qi = makeQueryInterface();
    await migration.up(qi, Sequelize);
    const columns = qi.createTable.mock.calls[0][1];
    expect(columns.updated_at).toBeUndefined();
  });
});

describe('up() — 10. history indexes exist', () => {
  it('creates (student_id, created_at) and (student_id, case_type, family, created_at) indexes', async () => {
    const qi = makeQueryInterface();
    await migration.up(qi, Sequelize);
    const indexCalls = qi.addIndex.mock.calls;

    const studentCreated = indexCalls.find(([, fields]) =>
      JSON.stringify(fields) === JSON.stringify(['student_id', 'created_at']));
    expect(studentCreated).toBeDefined();

    const streamLookup = indexCalls.find(([, fields]) =>
      JSON.stringify(fields) === JSON.stringify(['student_id', 'case_type', 'family', 'created_at']));
    expect(streamLookup).toBeDefined();
  });
});

describe('up() — 11. idempotency unique index exists', () => {
  it('creates a unique index on (student_id, teacher_id, case_type, family, validation, recommendation_fingerprint)', async () => {
    const qi = makeQueryInterface();
    await migration.up(qi, Sequelize);
    const indexCalls = qi.addIndex.mock.calls;

    const idempotencyIndex = indexCalls.find(([, fields]) =>
      JSON.stringify(fields) === JSON.stringify([
        'student_id', 'teacher_id', 'case_type', 'family', 'validation', 'recommendation_fingerprint',
      ]));
    expect(idempotencyIndex).toBeDefined();
    expect(idempotencyIndex[2].unique).toBe(true);
  });
});

describe('up() — 12. no incorrect (student_id, case_type, family)-only unique index', () => {
  it('never creates a unique index on just (student_id, case_type, family)', async () => {
    const qi = makeQueryInterface();
    await migration.up(qi, Sequelize);
    const indexCalls = qi.addIndex.mock.calls;

    const wrongIndex = indexCalls.find(([, fields]) =>
      JSON.stringify(fields) === JSON.stringify(['student_id', 'case_type', 'family']));
    expect(wrongIndex).toBeUndefined();
  });

  it('no index call anywhere sets unique:true on fewer than 6 fields', async () => {
    const qi = makeQueryInterface();
    await migration.up(qi, Sequelize);
    const uniqueIndexCalls = qi.addIndex.mock.calls.filter(([, , opts]) => opts && opts.unique);
    for (const [, fields] of uniqueIndexCalls) {
      expect(fields.length).toBeGreaterThanOrEqual(6);
    }
  });
});
