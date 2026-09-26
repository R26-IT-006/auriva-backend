'use strict';

// Reliability investigation (2026-08-09) — verifies the repair migration's
// logic directly against a mocked queryInterface. No real DB connection, no
// real ALTER TABLE — this is unit coverage of the migration's own
// conditional (columnExists-then-addColumn) logic, mirroring how this
// project's other idempotent migrations (e.g.
// 20260714000007-add-missing-personal-thresholds-column.js, which this one
// deliberately follows the same pattern as) would be tested the same way.
const migration = require('../migrations/20260809000001-restore-personal-thresholds-column');

function makeQueryInterface({ columnPresent }) {
  return {
    describeTable: jest.fn().mockResolvedValue(
      columnPresent ? { sid: {}, personal_thresholds: {} } : { sid: {} }
    ),
    addColumn: jest.fn().mockResolvedValue(undefined),
    removeColumn: jest.fn().mockResolvedValue(undefined),
  };
}

const Sequelize = require('sequelize');

describe('up() — column absent', () => {
  it('adds the column with the model-compatible definition', async () => {
    const qi = makeQueryInterface({ columnPresent: false });

    await migration.up(qi, Sequelize);

    expect(qi.addColumn).toHaveBeenCalledTimes(1);
    const [table, column, def] = qi.addColumn.mock.calls[0];
    expect(table).toBe('students');
    expect(column).toBe('personal_thresholds');
    expect(def.type).toBe(Sequelize.JSONB);
    expect(def.allowNull).toBe(false);
    expect(def.defaultValue).toEqual({});
  });
});

describe('up() — column already present', () => {
  it('is a no-op — addColumn is never called', async () => {
    const qi = makeQueryInterface({ columnPresent: true });

    await migration.up(qi, Sequelize);

    expect(qi.addColumn).not.toHaveBeenCalled();
  });
});

describe('up() — idempotent across repeated runs', () => {
  it('running up() twice never calls addColumn a second time once the column exists', async () => {
    const qi = makeQueryInterface({ columnPresent: false });
    await migration.up(qi, Sequelize);
    expect(qi.addColumn).toHaveBeenCalledTimes(1);

    qi.describeTable.mockResolvedValue({ sid: {}, personal_thresholds: {} }); // now present
    await migration.up(qi, Sequelize);
    expect(qi.addColumn).toHaveBeenCalledTimes(1); // still just once
  });
});

describe('down() — mirrors up() conditionally', () => {
  it('removes the column when present', async () => {
    const qi = makeQueryInterface({ columnPresent: true });
    await migration.down(qi);
    expect(qi.removeColumn).toHaveBeenCalledWith('students', 'personal_thresholds');
  });

  it('does nothing when already absent', async () => {
    const qi = makeQueryInterface({ columnPresent: false });
    await migration.down(qi);
    expect(qi.removeColumn).not.toHaveBeenCalled();
  });
});

describe('this migration touches only students.personal_thresholds', () => {
  it('never calls addColumn/removeColumn for any other table or column', async () => {
    const qi = makeQueryInterface({ columnPresent: false });
    await migration.up(qi, Sequelize);
    for (const call of qi.addColumn.mock.calls) {
      expect(call[0]).toBe('students');
      expect(call[1]).toBe('personal_thresholds');
    }
  });
});
