'use strict';

const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const PasswordResetOtp = sequelize.define('PasswordResetOtp', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  },
  email: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  otp_code: {
    type: DataTypes.STRING(6),
    allowNull: false,
  },
  expires_at: {
    type: DataTypes.DATE,
    allowNull: false,
  },
  used: {
    type: DataTypes.BOOLEAN,
    defaultValue: false,
  },
  created_at: {
    type: DataTypes.DATE,
    defaultValue: DataTypes.NOW,
  },
}, {
  tableName: 'password_reset_otps',
  timestamps: false,
  freezeTableName: true,
});

module.exports = PasswordResetOtp;
