'use strict';

const { QueryTypes } = require('sequelize');
const sequelize = require('../config/database');
const { Student, ConceptReport } = require('../models');
const conceptAnalyticsService = require('./conceptAnalyticsService');
const aiSummaryService = require('./aiSummaryService');
const { resolvePeriod, periodsFromDates, REPORT_TZ } = require('../utils/periods');
const ApiError = require('../utils/ApiError');
const logger = require('../utils/logger');

// Bump when the stored payload shape changes. Existing rows keep their old number
// — a saved report is never rewritten to match new code, because a snapshot that
// changes is not a snapshot.
const SCHEMA_VERSION = 1;

/**
 * Ownership gate. Mirrors conceptAnalyticsService.assertOwnedStudent — 404 rather
 * than 403 for another teacher's student, so the endpoint cannot be used to
 * enumerate ids.
 *
 * Gates on the student, never on the report's `teacher_id`: a child reallocated
 * between terms must not lose access to their own history, and the teacher who
 * inherits them needs to read what the previous one generated.
 */
async function assertOwnedStudent(teacherId, studentId) {
  const student = await Student.findOne({
    where: { sid: studentId, teacher_id: teacherId },
    attributes: ['sid', 'full_name'],
  });
  if (!student) throw new ApiError(404, 'Student not found or not assigned to you');
  return student;
}

/**
 * The weeks and months that actually hold something, newest first.
 *
 * Built from the days the child was active rather than by walking the calendar
 * between their first and last session: a child off ill for a fortnight should not
 * be offered two blank weeks that would each generate an empty report.
 *
 * Both source tables are scanned because a day whose only event was a drawing is
 * still a day the child worked — dropping those would tell a teacher nothing
 * happened on an afternoon the child spent colouring.
 */
async function getAvailablePeriods(teacherId, studentId) {
  await assertOwnedStudent(teacherId, studentId);

  const rows = await sequelize.query(
    `SELECT DISTINCT to_char((created_at AT TIME ZONE :tz)::date, 'YYYY-MM-DD') AS date
       FROM concept_interaction_logs
      WHERE student_id = :sid
      UNION
     SELECT DISTINCT to_char((created_at AT TIME ZONE :tz)::date, 'YYYY-MM-DD')
       FROM coloring_artworks
      WHERE student_id = :sid
      ORDER BY 1 DESC`,
    { replacements: { sid: Number(studentId), tz: REPORT_TZ }, type: QueryTypes.SELECT },
  );

  const dates = rows.map((r) => r.date).filter(Boolean);
  const { weeks, months } = periodsFromDates(dates);

  // Which periods are already saved, so the picker can say "regenerate" rather
  // than silently overwriting a report the teacher has already shown someone.
  const saved = await ConceptReport.findAll({
    where: { student_id: Number(studentId) },
    attributes: ['id', 'period_type', 'period_start'],
    raw: true,
  });
  const savedKey = new Set(saved.map((r) => `${r.period_type}/${r.period_start}`));
  const mark = (p) => ({ ...p, saved: savedKey.has(`${p.type}/${p.period_start}`) });

  return {
    timezone: REPORT_TZ,
    active_days: dates.length,
    weeks:  weeks.map(mark),
    months: months.map(mark),
  };
}

/** One child's archive, newest period first. Never reads `payload`. */
async function listReports(teacherId, studentId) {
  await assertOwnedStudent(teacherId, studentId);

  const rows = await ConceptReport.findAll({
    where: { student_id: Number(studentId) },
    attributes: { exclude: ['payload', 'narrative'] },
    order: [['period_start', 'DESC'], ['period_type', 'ASC']],
    raw: true,
  });

  return rows.map(withLabels);
}

/** One saved report in full, exactly as it was generated. */
async function getReport(teacherId, studentId, reportId) {
  await assertOwnedStudent(teacherId, studentId);

  const row = await ConceptReport.findOne({
    where: { id: Number(reportId), student_id: Number(studentId) },
    raw: true,
  });
  if (!row) throw new ApiError(404, 'Report not found');

  return withLabels(row);
}

/**
 * Generate and store one period's report.
 *
 * Regenerating an existing period replaces it. A teacher who runs "this week" on
 * Wednesday and again on Friday means the same week both times, and two rows
 * differing only by when the button was pressed would make the archive unreadable.
 */
async function generateReport(teacherId, studentId, { period_type: type, period_start: start }) {
  await assertOwnedStudent(teacherId, studentId);

  let period;
  try {
    period = resolvePeriod({ type, start });
  } catch (err) {
    throw new ApiError(400, err.message);
  }

  const payload = await conceptAnalyticsService.getConceptReport(teacherId, studentId, {
    from: period.from,
    to: period.to,
    // A report dated August must not carry July's mix-ups. The live screen keeps
    // the cumulative list; a dated one is a record of a period.
    confusionScope: 'range',
  });

  // Refuse rather than store an empty record. A teacher who opens "week of 4 Aug"
  // and finds a report full of zeroes cannot tell whether the child did nothing or
  // whether the report is broken.
  if (!hasActivity(payload)) {
    // Only the first letter is lowered. Lowercasing the whole label turns
    // "Week of 7 Jan 2019" into "week of 7 jan 2019", which reads as a typo in a
    // message a teacher sees.
    const named = period.label.charAt(0).toLowerCase() + period.label.slice(1);
    throw new ApiError(422, `Nothing was recorded in ${named}, so there is no report to make.`);
  }

  // Advisory. A model outage must not cost the teacher the report — the figures
  // are the report, and the paragraph is commentary on them.
  let narrative = null;
  try {
    const result = await aiSummaryService.narrativeFor(payload, { studentId, period });
    if (result?.available !== false) narrative = result;
  } catch (err) {
    logger.warn(`Narrative failed for report ${type}/${period.period_start}: ${err.message}`);
  }

  const row = {
    student_id: Number(studentId),
    teacher_id: Number(teacherId),
    period_type: period.type,
    period_start: period.period_start,
    period_end: period.period_end,
    schema_version: SCHEMA_VERSION,
    payload,
    narrative,
    headline: buildHeadline(payload),
    generated_at: new Date(),
  };

  await ConceptReport.upsert(row, {
    conflictFields: ['student_id', 'period_type', 'period_start'],
  });

  const saved = await ConceptReport.findOne({
    where: {
      student_id: row.student_id,
      period_type: row.period_type,
      period_start: row.period_start,
    },
    raw: true,
  });

  return withLabels(saved);
}

async function deleteReport(teacherId, studentId, reportId) {
  await assertOwnedStudent(teacherId, studentId);

  const removed = await ConceptReport.destroy({
    where: { id: Number(reportId), student_id: Number(studentId) },
  });
  if (!removed) throw new ApiError(404, 'Report not found');
}

/**
 * Did anything happen in this period?
 *
 * Deliberately generous about what counts. A day spent only colouring, or only
 * watching, is a day the child worked — judging on attempts alone would refuse to
 * report the quietest weeks, which are often the ones a teacher most wants a
 * record of.
 */
function hasActivity(payload) {
  if ((payload.days || []).length > 0) return true;
  if ((payload.activities || []).length > 0) return true;
  const e = payload.engagement || {};
  return (e.total_taps || 0) > 0
    || (e.exposure_ms || 0) > 0
    || (e.video_ms || 0) > 0
    || (e.coloring_sessions || 0) > 0;
}

/**
 * The few figures the archive list shows, lifted out so listing a year of reports
 * never reads a year of full payloads.
 *
 * `learned_in_period` counts concepts whose tier-2 pass — the second and final
 * gate — landed inside the period. Mastery totals in the payload are cumulative
 * and would report the child's whole history on every single card.
 */
function buildHeadline(payload) {
  const from = payload.scan?.from;
  const to = payload.scan?.to;

  const learned = (payload.concepts || []).filter((c) => {
    if (!c.mastered || !c.tier2_passed_at) return false;
    const at = new Date(c.tier2_passed_at);
    return (!from || at >= new Date(from)) && (!to || at < new Date(to));
  }).length;

  const attempts = (payload.days || []).length;
  const t = payload.timeline || [];
  const totalAttempts = t.reduce((n, d) => n + (d.attempts || 0), 0);
  const totalCorrect = t.reduce((n, d) => n + (d.correct || 0), 0);

  return {
    learned_in_period: learned,
    session_days: attempts,
    time_spent_ms: (payload.days || []).reduce((n, d) => n + (d.time_spent_ms || 0), 0),
    accuracy: totalAttempts > 0 ? Math.round((totalCorrect / totalAttempts) * 100) / 100 : null,
    mix_up_count: (payload.mix_ups || []).length,
    artwork_count: (payload.days || []).reduce((n, d) => n + (d.artworks || []).length, 0),
  };
}

/**
 * Re-derive the display labels rather than storing them.
 *
 * They are a pure function of the period, and freezing wording into the database
 * means a copy change never reaches the reports already saved.
 */
function withLabels(row) {
  const period = resolvePeriod({ type: row.period_type, start: row.period_start });
  return {
    ...row,
    label: period.label,
    range_label: period.range_label,
  };
}

module.exports = {
  getAvailablePeriods,
  listReports,
  getReport,
  generateReport,
  deleteReport,
  SCHEMA_VERSION,
};
