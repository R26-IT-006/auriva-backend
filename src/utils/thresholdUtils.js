'use strict';

const { Student } = require('../models');

const GLOBAL_DEFAULT = 55;

async function getStudentThreshold(studentId, letter) {
  const student = await Student.findByPk(studentId, {
    attributes: ['personal_thresholds'],
  });
  const thresholds = student?.personal_thresholds ?? {};
  if (typeof thresholds[letter] === 'number') return thresholds[letter];
  if (typeof thresholds.default === 'number') return thresholds.default;
  return GLOBAL_DEFAULT;
}

module.exports = { getStudentThreshold };
