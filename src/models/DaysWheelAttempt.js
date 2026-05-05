'use strict';

const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const DaysWheelAttempt = sequelize.define('DaysWheelAttempt', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  },
  student_id: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
  session_id: {
    type: DataTypes.INTEGER,
    allowNull: true,
  },
  target_word_id: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
  selected_word_id: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
  correct: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
  },
  attempted_at: {
    type: DataTypes.DATE,
    defaultValue: DataTypes.NOW,
  },
}, {
  tableName: 'days_wheel_attempts',
  timestamps: false,
  freezeTableName: true,
});

module.exports = DaysWheelAttempt;
