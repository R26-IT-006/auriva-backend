'use strict';

const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

// Rating scale for every teacher_*_rating column: 1 = Weak, 2 = Moderate, 3 = Good.
const TeacherValidation = sequelize.define('TeacherValidation', {
  id: {
    type:          DataTypes.INTEGER,
    primaryKey:    true,
    autoIncrement: true,
  },
  student_id: {
    type:      DataTypes.INTEGER,
    allowNull: false,
  },
  collection_session_id: {
    type:      DataTypes.UUID,
    allowNull: false,
  },
  teacher_straight_rating: {
    type:      DataTypes.SMALLINT,
    allowNull: true,
    validate:  { min: 1, max: 3 },
  },
  teacher_curve_rating: {
    type:      DataTypes.SMALLINT,
    allowNull: true,
    validate:  { min: 1, max: 3 },
  },
  teacher_complex_rating: {
    type:      DataTypes.SMALLINT,
    allowNull: true,
    validate:  { min: 1, max: 3 },
  },
  teacher_speed_rating: {
    type:      DataTypes.SMALLINT,
    allowNull: true,
    validate:  { min: 1, max: 3 },
  },
  teacher_fatigue_rating: {
    type:      DataTypes.SMALLINT,
    allowNull: true,
    validate:  { min: 1, max: 3 },
  },
  teacher_overall_rating: {
    type:      DataTypes.SMALLINT,
    allowNull: true,
    validate:  { min: 1, max: 3 },
  },
  teacher_notes: {
    type:      DataTypes.TEXT,
    allowNull: true,
  },
  teacher_validated: {
    type:         DataTypes.BOOLEAN,
    allowNull:    false,
    defaultValue: false,
  },
  validated_at: {
    type:      DataTypes.DATE,
    allowNull: true,
  },
  created_at: {
    type:         DataTypes.DATE,
    defaultValue: DataTypes.NOW,
  },
}, {
  tableName:       'teacher_validation',
  timestamps:      false,
  freezeTableName: true,
  indexes: [
    { fields: ['student_id'] },
    { fields: ['collection_session_id'] },
  ],
});

module.exports = TeacherValidation;
