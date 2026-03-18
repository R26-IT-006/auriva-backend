'use strict';

const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const Principal = sequelize.define('Principal', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  },
  username: {
    type: DataTypes.STRING,
    allowNull: false,
    unique: true,
  },
  password_hash: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  created_at: {
    type: DataTypes.DATE,
    defaultValue: DataTypes.NOW,
  },
}, {
  tableName: 'principals',
  timestamps: false,
  freezeTableName: true,
});

module.exports = Principal;
