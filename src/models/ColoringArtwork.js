'use strict';

const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

// One row per finished Tier 3 colouring. Kept as history rather than one row per
// concept: a child may colour the same picture on different days, and the
// earlier attempts are part of what a teacher wants to look back at.
const ColoringArtwork = sequelize.define('ColoringArtwork', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  },
  student_id: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
  category_key: {
    type: DataTypes.STRING(60),
    allowNull: false,
  },
  concept_key: {
    type: DataTypes.STRING(60),
    allowNull: false,
  },
  image_url: {
    type: DataTypes.TEXT,
    allowNull: false,
  },
  stroke_count: {
    type: DataTypes.INTEGER,
    allowNull: true,
  },
  time_spent_ms: {
    type: DataTypes.INTEGER,
    allowNull: true,
  },
  created_at: {
    type: DataTypes.DATE,
    defaultValue: DataTypes.NOW,
  },
}, {
  tableName: 'coloring_artworks',
  timestamps: false,
  freezeTableName: true,
  indexes: [
    { fields: ['student_id', 'created_at'] },
  ],
});

module.exports = ColoringArtwork;
