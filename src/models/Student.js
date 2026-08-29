'use strict';

const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const Student = sequelize.define('Student', {
  sid: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  },
  student_code: {
    type: DataTypes.STRING,
    allowNull: false,
    unique: true,
  },
  full_name: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  date_of_birth: {
    type: DataTypes.DATEONLY,
    allowNull: false,
  },
  disability: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  father_name: {
    type: DataTypes.STRING,
    allowNull: true,
  },
  mother_name: {
    type: DataTypes.STRING,
    allowNull: true,
  },
  address: {
    type: DataTypes.TEXT,
    allowNull: true,
  },
  marital_status: {
    type: DataTypes.STRING,
    allowNull: true,
  },
  mobile_number: {
    type: DataTypes.STRING,
    allowNull: true,
  },
  home_number: {
    type: DataTypes.STRING,
    allowNull: true,
  },
  profile_photo_url: {
    type: DataTypes.STRING,
    allowNull: true,
  },
  // ASD sensory sensitivity varies hugely per child — one kid's motivating
  // reward (confetti, vibration, triumphant sound) is another's overload
  // trigger. Teacher-set, defaults off so existing behavior is unchanged.
  reduce_stimulation: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: false,
  },
  teacher_id: {
    type: DataTypes.INTEGER,
    allowNull: true,
  },
  created_at: {
    type: DataTypes.DATE,
    defaultValue: DataTypes.NOW,
  },
}, {
  tableName: 'students',
  timestamps: false,
  freezeTableName: true,
});

module.exports = Student;
