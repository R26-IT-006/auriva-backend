'use strict';

const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const Stroke = sequelize.define('Stroke', {

  // ── Primary key ────────────────────────────────────────────────────────────
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  },

  // ── Foreign keys ───────────────────────────────────────────────────────────
  assessment_id: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
  student_id: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },

  // ── Shape & attempt ────────────────────────────────────────────────────────
  shape_type: {
    type: DataTypes.ENUM(
      'horizontal_line',
      'vertical_line',
      'full_circle',
      'half_circle',
      'zigzag',
      'curve_wave'
    ),
    allowNull: false,
  },
  attempt_number: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 1,
    validate: { min: 1, max: 5 },
  },

  // ── Raw stroke data ────────────────────────────────────────────────────────
  // Array of { x, y, timestamp } captured from PanResponder
  stroke_points: {
    type: DataTypes.JSONB,
    allowNull: false,
    defaultValue: [],
  },
  stroke_start_time: {
    type: DataTypes.DATE,
    allowNull: true,
  },
  stroke_end_time: {
    type: DataTypes.DATE,
    allowNull: true,
  },

  // ── Status flags ───────────────────────────────────────────────────────────
  is_complete: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: true,
  },
  was_interrupted: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: false,
  },

  // ── Auto-calculated fields (set by beforeCreate hook) ─────────────────────
  total_points: {
    type: DataTypes.INTEGER,
    allowNull: true,
  },
  duration_ms: {
    type: DataTypes.INTEGER,
    allowNull: true,
  },

  // ── Scoring ────────────────────────────────────────────────────────────────
  quality_score: {
    type: DataTypes.INTEGER,
    allowNull: true,
    validate: { min: 0, max: 100 },
  },

  // ── Timestamps (manual, matching project convention) ──────────────────────
  created_at: {
    type: DataTypes.DATE,
    defaultValue: DataTypes.NOW,
  },
  updated_at: {
    type: DataTypes.DATE,
    defaultValue: DataTypes.NOW,
  },

}, {
  tableName: 'strokes',
  timestamps: false,
  freezeTableName: true,

  indexes: [
    { fields: ['assessment_id'] },
    { fields: ['student_id'] },
    { fields: ['shape_type'] },
    {
      fields: ['stroke_points'],
      using: 'gin',
      name: 'strokes_stroke_points_gin_idx',
    },
  ],

  hooks: {
    beforeCreate: (stroke) => {
      if (Array.isArray(stroke.stroke_points)) {
        stroke.total_points = stroke.stroke_points.length;
      }
      if (stroke.stroke_start_time && stroke.stroke_end_time) {
        stroke.duration_ms =
          new Date(stroke.stroke_end_time) - new Date(stroke.stroke_start_time);
      }
    },
  },
});

module.exports = Stroke;
