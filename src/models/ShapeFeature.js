'use strict';

const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const ShapeFeature = sequelize.define('ShapeFeature', {
  id: {
    type:          DataTypes.INTEGER,
    primaryKey:    true,
    autoIncrement: true,
  },
  assessment_id: {
    type:      DataTypes.INTEGER,
    allowNull: false,
  },
  student_id: {
    type:      DataTypes.INTEGER,
    allowNull: false,
  },
  shape_type: {
    type:      DataTypes.STRING(50),
    allowNull: false,
  },
  attempt_number: {
    type:         DataTypes.INTEGER,
    allowNull:    false,
    defaultValue: 1,
  },
  // full features object from the frontend: {duration_ms, total_distance,
  // avg_speed, smoothness, pause_count, accuracy}
  features: {
    type:         DataTypes.JSONB,
    allowNull:    false,
    defaultValue: {},
  },
  // array of {stroke_id, points:[{x,y,t,tAbs,stroke_id}]} — one element per
  // pen-lift within this shape attempt
  stroke_points: {
    type:         DataTypes.JSONB,
    allowNull:    false,
    defaultValue: [],
  },
  // true when captured during a fixed research protocol session
  collection_mode: {
    type:         DataTypes.BOOLEAN,
    allowNull:    false,
    defaultValue: false,
  },
  created_at: {
    type:         DataTypes.DATE,
    defaultValue: DataTypes.NOW,
  },
}, {
  tableName:       'shape_features',
  timestamps:      false,
  freezeTableName: true,
  indexes: [
    { fields: ['assessment_id'] },
    { fields: ['student_id']   },
    { fields: ['shape_type']   },
  ],
});

module.exports = ShapeFeature;
