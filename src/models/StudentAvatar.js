'use strict';

const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const StudentAvatar = sequelize.define('StudentAvatar', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  },
  student_id: {
    type: DataTypes.INTEGER,
    allowNull: false,
    unique: true,
  },
  avatar_key: {
    type: DataTypes.ENUM('boba', 'glitter', 'lily', 'megatron'),
    allowNull: false,
  },
  selected_by: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
  selected_at: {
    type: DataTypes.DATE,
    defaultValue: DataTypes.NOW,
  },
}, {
  tableName: 'student_avatars',
  timestamps: false,
  freezeTableName: true,
});

module.exports = StudentAvatar;