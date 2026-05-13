'use strict';

const {
  HandwritingAssessment,
  LetterProgress,
  ExplanationResult,
  RecommendationHistory,
  StudentMotorFeature,
} = require('../models');
const ApiError = require('../utils/ApiError');
const { analyzeMotorDifficulty } = require('../services/explainabilityService');

const LETTERS = 'abcdefghijklmnopqrstuvwxyz';

const CURVE_SHAPES = ['half_circle', 'full_circle', 'curve_wave'];
const LINE_SHAPES  = ['horizontal_line', 'vertical_line'];

function average(values) {
  const validValues = values.filter(value => Number.isFinite(value));
  if (validValues.length === 0) return null;
  return validValues.reduce((sum, value) => sum + value, 0) / validValues.length;
}

function toNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function buildMotorFeatureSummary(shapes) {
  const safeShapes = Array.isArray(shapes) ? shapes : [];

  const avg_duration_ms = average(safeShapes.map(shape => toNumber(shape.features?.duration_ms)));
  const avg_total_distance = average(safeShapes.map(shape => toNumber(shape.features?.total_distance)));
  const avg_speed = average(safeShapes.map(shape => toNumber(shape.features?.avg_speed)));
  const avg_smoothness = average(safeShapes.map(shape => toNumber(shape.features?.smoothness)));
  const avg_pause_count = average(safeShapes.map(shape => toNumber(shape.features?.pause_count)));
  const avg_accuracy = average(safeShapes.map(shape => toNumber(shape.features?.accuracy)));
  const avg_stroke_count = average(safeShapes.map(shape => toNumber(shape.stroke_count)));

  return {
    shape_count: safeShapes.length,
    avg_duration_ms,
    avg_total_distance,
    avg_speed,
    avg_smoothness,
    avg_pause_count,
    avg_accuracy,
    avg_stroke_count,
    feature_vector: {
      avg_duration_ms,
      avg_total_distance,
      avg_speed,
      avg_smoothness,
      avg_pause_count,
      avg_accuracy,
      avg_stroke_count,
    },
  };
}

function deriveReason(shapes) {
  if (!Array.isArray(shapes)) return 'Continue regular letter practice.';

  const curveIssue = shapes.some(s =>
    CURVE_SHAPES.includes(s.shape_id) && (s.features?.smoothness ?? 0) > 0.3
  );
  if (curveIssue) return 'Curve control practice is required.';

  const lineIssue = shapes.some(s =>
    LINE_SHAPES.includes(s.shape_id) && (s.features?.avg_deviation ?? 0) > 20
  );
  if (lineIssue) return 'Straight line control practice is required.';

  const zigzag = shapes.find(s => s.shape_id === 'zigzag');
  if (zigzag && (zigzag.features?.smoothness ?? 0) > 0.4) {
    return 'Direction change control practice is required.';
  }

  return 'Continue regular letter practice.';
}

async function submitAssessment(req, res) {
  const { student_id, session_start, session_end, shapes } = req.body;

  if (!student_id || !session_start || !session_end || !Array.isArray(shapes) || shapes.length === 0) {
    throw new ApiError(422, 'student_id, session_start, session_end, and shapes are required');
  }

  const existingCount = await HandwritingAssessment.count({ where: { student_id } });
  const is_initial    = existingCount === 0;

  const assessment = await HandwritingAssessment.create({
    student_id,
    session_start,
    session_end,
    shapes,
    is_initial,
  });

  try {
    const featureSummary = buildMotorFeatureSummary(shapes);
    await StudentMotorFeature.create({
      student_id,
      assessment_id: assessment.id,
      is_initial,
      ...featureSummary,
    });
  } catch (dbErr) {
    console.error('StudentMotorFeature save error (non-fatal):', dbErr.message);
  }

  res.status(201).json({ id: assessment.id, is_initial, message: 'Assessment saved' });
}

async function getProgress(req, res) {
  const studentId = parseInt(req.params.studentId, 10);
  if (!studentId) throw new ApiError(422, 'Invalid student ID');

  const [latest, lowercase_completed, uppercase_completed] = await Promise.all([
    HandwritingAssessment.findOne({
      where: { student_id: studentId },
      order: [['created_at', 'DESC']],
    }),
    LetterProgress.count({ where: { student_id: studentId, case_type: 'lowercase' } }),
    LetterProgress.count({ where: { student_id: studentId, case_type: 'uppercase' } }),
  ]);

  const reason = latest ? deriveReason(latest.shapes) : 'Continue regular letter practice.';

  res.json({
    lowercase_completed,
    uppercase_completed,
    next_lowercase_letter: lowercase_completed < 26 ? LETTERS[lowercase_completed] : null,
    next_uppercase_letter: uppercase_completed < 26 ? LETTERS[uppercase_completed].toUpperCase() : null,
    reason,
  });
}

async function recordLetterCompletion(req, res) {
  const { student_id, letter, case_type } = req.body;

  if (!student_id || !letter || !case_type) {
    throw new ApiError(422, 'student_id, letter, and case_type are required');
  }
  if (!['lowercase', 'uppercase'].includes(case_type)) {
    throw new ApiError(422, 'case_type must be lowercase or uppercase');
  }

  const [record, created] = await LetterProgress.findOrCreate({
    where: { student_id, letter, case_type },
    defaults: { student_id, letter, case_type },
  });

  res.status(created ? 201 : 200).json({ id: record.id, letter, case_type });
}

/**
 * POST /handwriting/explain
 *
 * Accepts shape-assessment data + optional letter metrics, runs the
 * rule-based explainability engine, stores the result, and returns a
 * structured teacher-friendly explanation with feature contributions.
 *
 * Request body:
 *  {
 *    student_id       : number,
 *    assessment_id    : number  (optional – link to an existing assessment)
 *    shapes           : [{ shapeId, features: { smoothness, avg_deviation } }],
 *    letter_metrics   : { avgPauses, avgTime }  (optional)
 *    motor_score      : number  (optional pre-computed score)
 *  }
 */
async function explainAssessment(req, res) {
  const { student_id, assessment_id, shapes, letter_metrics, motor_score } = req.body;

  if (!student_id || !Array.isArray(shapes) || shapes.length === 0) {
    throw new ApiError(422, 'student_id and shapes array are required');
  }

  const result = analyzeMotorDifficulty(shapes, letter_metrics ?? {}, motor_score ?? null);

  // Persist explanation result (fire-and-forget — don't block response on DB error)
  try {
    const saved = await ExplanationResult.create({
      assessment_id:        assessment_id ?? null,
      student_id,
      difficulty_type:      result.difficultyKey,
      difficulty_label:     result.difficulty,
      confidence_score:     result.confidence ?? null,
      motor_score:          result.motorScore ?? null,
      feature_contributions: result.featureContributions,
      explanation_lines:    result.explanation,
      recommendations:      result.recommendations,
    });

    // Record in recommendation history only when a real difficulty was detected
    if (result.difficultyKey && result.difficultyKey !== 'NONE') {
      await RecommendationHistory.create({
        student_id,
        difficulty_type:  result.difficultyKey,
        difficulty_label: result.difficulty,
        recommendations:  result.recommendations,
      });
    }

    res.status(201).json({
      id:                   saved.id,
      difficulty:           result.difficulty,
      difficultyKey:        result.difficultyKey,
      confidence:           result.confidence,
      motorScore:           result.motorScore,
      description:          result.description,
      featureContributions: result.featureContributionsMap,
      explanation:          result.explanation,
      recommendations:      result.recommendations.map(r => r.text),
      letterFocus:          result.letterFocus,
      secondaryDifficulty:  result.secondaryDifficulty ?? null,
    });
  } catch (dbErr) {
    // DB storage failed — still return analysis so teacher can see it
    console.error('ExplanationResult save error (non-fatal):', dbErr.message);
    res.status(200).json({
      difficulty:           result.difficulty,
      difficultyKey:        result.difficultyKey,
      confidence:           result.confidence,
      motorScore:           result.motorScore,
      description:          result.description,
      featureContributions: result.featureContributionsMap,
      explanation:          result.explanation,
      recommendations:      result.recommendations.map(r => r.text),
      letterFocus:          result.letterFocus,
      secondaryDifficulty:  result.secondaryDifficulty ?? null,
      _warning:             'Result could not be saved to database.',
    });
  }
}

/**
 * GET /handwriting/explanation/:studentId
 *
 * Fetches the most recent explanation result for a student.
 */
async function getLatestExplanation(req, res) {
  const studentId = parseInt(req.params.studentId, 10);
  if (!studentId) throw new ApiError(422, 'Invalid student ID');

  const record = await ExplanationResult.findOne({
    where: { student_id: studentId },
    order: [['created_at', 'DESC']],
  });

  if (!record) {
    return res.json({ message: 'No explanation found for this student', data: null });
  }

  res.json({
    id:                   record.id,
    difficulty:           record.difficulty_label,
    difficultyKey:        record.difficulty_type,
    confidence:           record.confidence_score,
    motorScore:           record.motor_score,
    featureContributions: record.feature_contributions,
    explanation:          record.explanation_lines,
    recommendations:      record.recommendations,
    createdAt:            record.created_at,
  });
}

/**
 * PATCH /handwriting/assessment/:id/finalize
 *
 * Called after the client computes the motor profile.
 * Stores motor_score + motor_profile on the assessment record,
 * then runs the explainability engine and saves to ExplanationResult.
 */
async function finalizeAssessment(req, res) {
  const assessmentId = parseInt(req.params.id, 10);
  const { motor_score, motor_profile } = req.body;

  if (!assessmentId || motor_score == null || !motor_profile) {
    throw new ApiError(422, 'Assessment ID, motor_score, and motor_profile are required');
  }

  const assessment = await HandwritingAssessment.findByPk(assessmentId);
  if (!assessment) throw new ApiError(404, 'Assessment not found');

  await assessment.update({ motor_score, motor_profile });

  // Map stored shapes (shape_id) → format expected by explainabilityService (shapeId)
  const shapesForAnalysis = (assessment.shapes ?? []).map(s => ({
    shapeId:  s.shape_id,
    features: s.features,
  }));

  const result = analyzeMotorDifficulty(shapesForAnalysis, {}, motor_score);

  try {
    await ExplanationResult.create({
      assessment_id:         assessmentId,
      student_id:            assessment.student_id,
      difficulty_type:       result.difficultyKey,
      difficulty_label:      result.difficulty,
      confidence_score:      result.confidence ?? null,
      motor_score,
      feature_contributions: result.featureContributions,
      explanation_lines:     result.explanation,
      recommendations:       result.recommendations,
    });

    if (result.difficultyKey && result.difficultyKey !== 'NONE') {
      await RecommendationHistory.create({
        student_id:       assessment.student_id,
        difficulty_type:  result.difficultyKey,
        difficulty_label: result.difficulty,
        recommendations:  result.recommendations,
      });
    }
  } catch (dbErr) {
    console.error('ExplanationResult save error (non-fatal):', dbErr.message);
  }

  res.json({
    id:           assessmentId,
    is_initial:   assessment.is_initial,
    motor_score,
    difficulty:   result.difficulty,
    difficultyKey: result.difficultyKey,
    message:      'Assessment finalized',
  });
}

/**
 * GET /handwriting/initial-report/:studentId
 *
 * Returns the stored initial assessment + explanation for a student,
 * used by TeacherReportScreen to show permanent motor analysis data.
 */
async function getInitialReport(req, res) {
  const studentId = parseInt(req.params.studentId, 10);
  if (!studentId) throw new ApiError(422, 'Invalid student ID');

  const assessment = await HandwritingAssessment.findOne({
    where: { student_id: studentId, is_initial: true },
    order: [['created_at', 'ASC']],
  });

  if (!assessment) {
    return res.json({ hasData: false });
  }

  const explanation = await ExplanationResult.findOne({
    where: { assessment_id: assessment.id },
    order: [['created_at', 'DESC']],
  });

  res.json({
    hasData: true,
    assessment: {
      id:            assessment.id,
      motor_score:   assessment.motor_score,
      motor_profile: assessment.motor_profile,
      shapes:        assessment.shapes,
      created_at:    assessment.created_at,
      is_initial:    assessment.is_initial,
    },
    explanation: explanation ? {
      difficulty:           explanation.difficulty_label,
      difficultyKey:        explanation.difficulty_type,
      confidence:           explanation.confidence_score,
      featureContributions: explanation.feature_contributions,
      explanation:          explanation.explanation_lines,
      recommendations:      explanation.recommendations,
    } : null,
  });
}

module.exports = { submitAssessment, getProgress, recordLetterCompletion, explainAssessment, getLatestExplanation, finalizeAssessment, getInitialReport };
