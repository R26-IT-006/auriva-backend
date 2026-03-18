'use strict';

const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const Teacher = sequelize.define('Teacher', {
  tid: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  },
  teacher_code: {
    type: DataTypes.STRING,
    allowNull: false,
    unique: true,
  },
  full_name: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  email: {
    type: DataTypes.STRING,
    allowNull: false,
    unique: true,
  },
  password_hash: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  is_first_login: {
    type: DataTypes.BOOLEAN,
    defaultValue: true,
  },
  profile_photo_url: {
    type: DataTypes.STRING,
    allowNull: true,
  },
  created_at: {
    type: DataTypes.DATE,
    defaultValue: DataTypes.NOW,
  },
  created_by: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
}, {
  tableName: 'teachers',
  timestamps: false,
  freezeTableName: true,
});

module.exports = Teacher;
