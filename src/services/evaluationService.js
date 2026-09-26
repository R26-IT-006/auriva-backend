'use strict';

const { Op } = require('sequelize');
const { DialogueWord, DialogueWordProgress, DialogueEvaluationAttempt, Student } = require('../models');
const ApiError = require('../utils/ApiError');

// Evaluations unlock once this many words in a category are mastered (DEC-04, Amendment A1).
const EVAL_UNLOCK_THRESHOLD = 3;

const EVAL_CATEGORIES = ['greetings', 'magic_words', 'abilities'];

// Evaluations show up to this many word/image pairs per attempt (DEC-04, provisional).
const EVAL_SIZE_CAP = 5;

// ── Helpers ───────────────────────────────────────────────────────────────

async function assertStudentBelongsToTeacher(teacherId, studentId) {
  const student = await Student.findOne({ where: { sid: studentId, teacher_id: teacherId } });
  if (!student) throw new ApiError(404, 'Student not found or not assigned to you');
  return student;
}

function shuffle(array) {
  const result = [...array];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

async function masteredCountForCategory(studentId, category) {
  return DialogueWordProgress.count({
    where: { student_id: studentId, status: 'mastered' },
    include: [
      {
        model: DialogueWord,
        as: 'word',
        where: { category },
        required: true,
      },
    ],
  });
}

// ── Public service functions ──────────────────────────────────────────────

async function getEvaluationStatus(teacherId, studentId) {
  await assertStudentBelongsToTeacher(teacherId, studentId);

  const results = [];
  for (const category of EVAL_CATEGORIES) {
    const mastered_count = await masteredCountForCategory(studentId, category);

    const lastAttempt = await DialogueEvaluationAttempt.findOne({
      where: { student_id: studentId, category },
      order: [['attempted_at', 'DESC']],
    });

    results.push({
      category,
      mastered_count,
      unlocked: mastered_count >= EVAL_UNLOCK_THRESHOLD,
      last_attempt: lastAttempt
        ? {
            correct_count: lastAttempt.correct_count,
            total_count: lastAttempt.total_count,
            attempted_at: lastAttempt.attempted_at,
          }
        : null,
    });
  }

  return results;
}

async function buildEvaluation(teacherId, studentId, category) {
  await assertStudentBelongsToTeacher(teacherId, studentId);

  if (!EVAL_CATEGORIES.includes(category)) {
    throw new ApiError(422, 'Unknown evaluation category');
  }

  const mastered_count = await masteredCountForCategory(studentId, category);
  if (mastered_count < EVAL_UNLOCK_THRESHOLD) {
    throw new ApiError(404, 'Evaluation not yet unlocked for this category');
  }

  const masteredProgress = await DialogueWordProgress.findAll({
    where: { student_id: studentId, status: 'mastered' },
    include: [
      {
        model: DialogueWord,
        as: 'word',
        where: { category },
        required: true,
      },
    ],
  });

  const chosenWords = shuffle(masteredProgress.map((p) => p.word)).slice(0, EVAL_SIZE_CAP);

  return {
    words: chosenWords.map((w) => ({ word_id: w.id, text: w.word })),
    // Word images are frontend-bundled assets keyed by asset_key (see dialogueService.js /
    // category3Service.js — no blob/URL storage exists for dialogue_words); the frontend
    // resolves asset_key to its bundled image, same as every other Level 1 screen.
    images: shuffle(chosenWords.map((w) => ({ word_id: w.id, asset_key: w.asset_key }))),
  };
}

async function recordEvaluation(teacherId, studentId, category, pairs) {
  await assertStudentBelongsToTeacher(teacherId, studentId);

  if (!EVAL_CATEGORIES.includes(category)) {
    throw new ApiError(422, 'Unknown evaluation category');
  }

  const wordIds = pairs.map((p) => p.word_id);
  const words = await DialogueWord.findAll({ where: { id: wordIds, category } });

  if (words.length !== wordIds.length) {
    throw new ApiError(422, 'One or more word_ids do not belong to this category');
  }

  const pairsDetail = pairs.map((p) => ({
    word_id: p.word_id,
    chosen_word_id_for_image: p.chosen_word_id_for_image,
    correct: p.word_id === p.chosen_word_id_for_image,
  }));

  const correct_count = pairsDetail.filter((p) => p.correct).length;
  const total_count = pairsDetail.length;

  const attempt = await DialogueEvaluationAttempt.create({
    student_id: studentId,
    category,
    word_ids: wordIds,
    pairs_detail: pairsDetail,
    correct_count,
    total_count,
    attempted_at: new Date(),
  });

  return {
    correct_count: attempt.correct_count,
    total_count: attempt.total_count,
    attempted_at: attempt.attempted_at,
  };
}

module.exports = {
  EVAL_UNLOCK_THRESHOLD,
  getEvaluationStatus,
  buildEvaluation,
  recordEvaluation,
};
