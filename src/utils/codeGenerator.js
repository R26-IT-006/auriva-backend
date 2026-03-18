'use strict';

/**
 * Generates the next sequential code for a model.
 * MUST be called within a Sequelize transaction to prevent race conditions.
 *
 * @param {Model}       model       - Sequelize model class
 * @param {string}      field       - Column name holding the code (e.g. 'teacher_code')
 * @param {string}      prefix      - Code prefix (e.g. 'TCH', 'STU')
 * @param {Transaction} transaction - Active Sequelize transaction
 * @returns {Promise<string>}       - e.g. 'TCH-0003'
 */
async function generateCode(model, field, prefix, transaction) {
  const last = await model.findOne({
    attributes: [field],
    order: [[field, 'DESC']],
    transaction,
    lock: transaction.LOCK.UPDATE,
  });

  if (!last) return `${prefix}-0001`;

  const num = parseInt(last[field].split('-')[1], 10);
  const next = String(num + 1).padStart(4, '0');
  return `${prefix}-${next}`;
}

module.exports = { generateCode };
