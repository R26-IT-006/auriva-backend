'use strict';

const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const StudentNote = sequelize.define('StudentNote', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  },
  student_id: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
  teacher_id: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
  body: {
    type: DataTypes.TEXT,
    allowNull: false,
  },
  created_at: {
    type: DataTypes.DATE,
    defaultValue: DataTypes.NOW,
  },
}, {
  tableName: 'student_notes',
  timestamps: false,
  freezeTableName: true,
});

module.exports = StudentNote;
