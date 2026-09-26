'use strict';

const axios  = require('axios');
const { Op } = require('sequelize');
const {
  Teacher,
  Student,
  Session,
  StudentActivity,
  StudentAvatar,
  StudentConceptProgress,
  StudentNote,
  PronunciationSessionResult,
} = require('../models');
const { isMastered } = require('./conceptService');
const ApiError = require('../utils/ApiError');
const {
  scorePronunciationAttemptData,
} = require('./pronunciationScoringService');
const {
  getReviewQueue,
  invalidateReviewedCountsCache,
} = require('./pronunciationReviewQueueService');
const { invalidateCalibrationCache } = require('./adaptiveCalibrationService');

const GNN_BASE = process.env.GNN_SERVICE_URL || 'http://localhost:8000';

/** Midnight on the most recent Sunday, in server-local time. */
function startOfWeek() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - d.getDay());
  return d;
}

function normalizeStudentId(studentId) {
  const numericId = Number(studentId);
  return Number.isInteger(numericId) && numericId > 0 ? numericId : studentId;
}

function flattenAvatar(student) {
  const plain = student.get({ plain: true });
  plain.avatar_key = plain.avatarRecord?.avatar_key ?? null;
  delete plain.avatarRecord;
  return plain;
}

async function findTeacherStudent(teacherId, studentId) {
  return Student.findOne({
    where: { sid: normalizeStudentId(studentId), teacher_id: teacherId },
  });
}

async function getDashboardStats(teacherId) {
  const [profile, students] = await Promise.all([
    Teacher.findByPk(teacherId, { attributes: { exclude: ['password_hash'] } }),
    Student.findAll({
      where: { teacher_id: teacherId },
      // date_of_birth is carried so the dashboard's student cards can show an age
      // without a second round trip per child.
      attributes: ['sid', 'full_name', 'profile_photo_url', 'date_of_birth'],
      order: [['student_code', 'ASC']],
    }),
  ]);

  if (!profile) throw new ApiError(404, 'Teacher not found');

  const studentIds = students.map((s) => s.sid);
  const totalStudents = studentIds.length;

  const weekStart = startOfWeek();

  const [
    conceptsMastered, avgEngagement, allSessions, recentAchievements,
    allProgress, weekActivities, weekMilestones,
    totalSessions, weeklySessions, lastSession,
  ] = await Promise.all([
    // "Mastered" means tier 1 AND tier 2, matching activityService and the concept
    // analytics report. This counts fewer concepts than the old tier-1-only rule.
    totalStudents > 0
      ? StudentConceptProgress.count({
          where: { tier1_status: 'passed', tier2_status: 'passed', student_id: studentIds },
        })
      : 0,
    totalStudents > 0
      ? axios
          .get(`${GNN_BASE}/gkb/teacher/engagement`, {
            params: { student_ids: studentIds.join(',') },
            timeout: 4000,
          })
          .then((r) => r.data.avg_engagement)
          .catch(() => null)
      : null,
    // Unlimited (rather than the old top-20 "recent" slice) so both the calendar
    // dots and the per-day detail list stay accurate for a teacher who pages back
    // to an older month, and so a student's most-recent session is never missed
    // by proficiency's lastSessionAt lookup below.
    totalStudents > 0
      ? Session.findAll({
          where: { student_id: studentIds },
          include: [{ model: Student, as: 'student', attributes: ['full_name'] }],
          order: [['started_at', 'DESC']],
        })
      : [],
    totalStudents > 0
      ? StudentConceptProgress.findAll({
          where: { tier1_status: 'passed', student_id: studentIds },
          include: [{ model: Student, as: 'student', attributes: ['full_name'] }],
          order: [['tier1_passed_at', 'DESC']],
          limit: 5,
        })
      : [],
    totalStudents > 0
      ? StudentConceptProgress.findAll({
          where: { student_id: studentIds },
          // tier2_status is required by isMastered — without it the predicate reads
          // undefined and silently counts nothing.
          attributes: ['student_id', 'tier1_status', 'tier2_status', 'tier1_score'],
        })
      : [],
    // Powers the three activity tiles in Class Overview. Rows are fetched rather
    // than counted because the same set answers assigned, completed, and the
    // average score, and three aggregate queries would cost more than one read of
    // a week's worth of rows.
    totalStudents > 0
      ? StudentActivity.findAll({
          where: { student_id: studentIds, created_at: { [Op.gte]: weekStart } },
          attributes: ['status', 'score', 'completed_at'],
        })
      : [],
    // The fourth tile. There is no tier2_passed_at column, so a milestone is dated
    // by the tier 1 pass — the same event recentAchievements already reports.
    totalStudents > 0
      ? StudentConceptProgress.count({
          where: {
            student_id: studentIds,
            tier1_status: 'passed',
            tier1_passed_at: { [Op.gte]: weekStart },
          },
        })
      : 0,
    PronunciationSessionResult.count({ where: { teacher_id: teacherId } }),
    PronunciationSessionResult.count({
      where: { teacher_id: teacherId, created_at: { [Op.gte]: weekStart } },
    }),
    PronunciationSessionResult.findOne({
      where: { teacher_id: teacherId },
      order: [['created_at', 'DESC'], ['id', 'DESC']],
      include: [
        { model: Student, as: 'student', attributes: ['sid', 'full_name', 'student_code'] },
      ],
    }),
  ]);

  const weekCompleted   = weekActivities.filter((a) => a.status === 'passed' || a.status === 'failed');
  const weekScores      = weekCompleted.map((a) => a.score).filter((s) => typeof s === 'number');
  const weekAvgProgress = weekScores.length
    ? weekScores.reduce((a, b) => a + b, 0) / weekScores.length
    : null;

  // Raw timestamps rather than pre-bucketed date strings: the client bucketing them
  // in its own timezone is what stops a late-evening session showing on the wrong
  // calendar day for a teacher offset from the server. All-time rather than a
  // rolling window, so a dot still shows up when the teacher pages the calendar
  // back to a month before the window would have covered.
  const sessionDates = allSessions
    .filter((s) => s.started_at)
    .map((s) => s.started_at);

  const proficiency = students.map((s) => {
    const progress = allProgress.filter((p) => p.student_id === s.sid);
    const scores = progress.filter((p) => p.tier1_score != null).map((p) => p.tier1_score);
    const avgScore = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null;
    const mastered = progress.filter(isMastered).length;
    // Named lastStudentSession, not lastSession: the outer scope already binds
    // lastSession to the latest pronunciation result used by stats below.
    const lastStudentSession = allSessions.find((sess) => sess.student_id === s.sid);

    return {
      studentId: s.sid,
      fullName: s.full_name,
      profilePhotoUrl: s.profile_photo_url,
      dateOfBirth: s.date_of_birth,
      conceptsAssigned: progress.length,
      conceptsMastered: mastered,
      avgScore,
      lastSessionAt: lastStudentSession?.started_at ?? null,
    };
  });

  return {
    profile,
    // Both branches shipped a dashboard: concept mastery (ours) and pronunciation
    // sessions (theirs). The union keeps every key both frontends already read.
    stats: {
      totalStudents,
      conceptsMastered,
      avgEngagement,
      totalSessions,
      weeklySessions,
      lastSession: lastSession
        ? {
            studentName: lastSession.student?.full_name,
            studentCode: lastSession.student?.student_code,
            date: lastSession.created_at,
            score: lastSession.overall_score,
            wordLabel: lastSession.word_label,
          }
        : null,
    },
    // Class Overview. Everything here is scoped to the current week, which is why
    // it is kept apart from `stats` — those are all-time figures and mixing the two
    // under one heading is how a dashboard starts lying.
    weekStats: {
      activitiesAssigned:  weekActivities.length,
      activitiesCompleted: weekCompleted.length,
      avgProgress:         weekAvgProgress,
      milestones:          weekMilestones,
    },
    sessionDates,
    proficiency,
    // Full session list (not just "recent") so the calendar's per-day detail view
    // can show every session on a date the teacher taps, however far back it is.
    sessions: allSessions.map((s) => ({
      studentName: s.student?.full_name ?? 'Student',
      startedAt: s.started_at,
      endedAt: s.ended_at,
      isActive: s.is_active,
    })),
    recentAchievements: recentAchievements.map((p) => ({
      // Carried so consumers can join on identity rather than on display name.
      // aiSummaryService pseudonymises by this id: keyed on name, two children
      // sharing one would collapse to a single label and the summary would
      // attribute one child's results to the other.
      studentId:   p.student_id,
      studentName: p.student?.full_name ?? 'Student',
      conceptKey: p.concept_key,
      categoryKey: p.category_key,
      passedAt: p.tier1_passed_at,
    })),
  };
}

async function getOwnStudents(teacherId) {
  const students = await Student.findAll({
    where: { teacher_id: teacherId },
    order: [['student_code', 'ASC']],
    include: [
      { model: StudentAvatar, as: 'avatarRecord', attributes: ['avatar_key'] },
    ],
  });
  return students.map(flattenAvatar);
}

async function getOwnStudentById(teacherId, studentId) {
  const student = await Student.findOne({
    where: { sid: normalizeStudentId(studentId), teacher_id: teacherId },
    include: [
      { model: StudentAvatar, as: 'avatarRecord', attributes: ['avatar_key'] },
    ],
  });
  if (!student) throw new ApiError(404, 'Student not found or not assigned to you');
  return flattenAvatar(student);
}

async function setAvatar(teacherId, studentId, avatarKey) {
  const student = await Student.findOne({
    where: { sid: studentId, teacher_id: teacherId },
  });
  if (!student) throw new ApiError(404, 'Student not found or not assigned to you');

  const [record] = await StudentAvatar.upsert({
    student_id: studentId,
    avatar_key: avatarKey,
    selected_by: teacherId,
    selected_at: new Date(),
  });
  return record;
}

async function setThreshold(teacherId, studentId, letter, value) {
  const student = await Student.findOne({
    where: { sid: normalizeStudentId(studentId), teacher_id: teacherId },
    attributes: ['sid', 'personal_thresholds'],
  });
  if (!student) throw new ApiError(404, 'Student not found or not assigned to you');

  const updated = { ...student.personal_thresholds, [letter]: value };
  await student.update({ personal_thresholds: updated });
  return { student_id: student.sid, letter, value, personal_thresholds: updated };
}

async function setSensorySettings(teacherId, studentId, reduceStimulation) {
  const student = await findTeacherStudent(teacherId, studentId);
  if (!student) throw new ApiError(404, 'Student not found or not assigned to you');

  await student.update({ reduce_stimulation: reduceStimulation });
  return { sid: student.sid, reduce_stimulation: student.reduce_stimulation };
}

function buildPronunciationResultRecord({ teacherId, studentId, data, rawAudioBuffer }) {
  return {
    teacher_id: teacherId,
    student_id: studentId,
    mode: data.mode,
    category_id: data.category_id || null,
    word_id: data.word_id,
    word_label: data.word_label,
    overall_score: data.overall_score,
    phoneme_scores: data.phoneme_scores || [],
    listen_choose_data: data.listen_choose_data || null,
    response_duration: data.response_duration ?? null,
    hesitation_time: data.hesitation_time ?? null,
    recommendation_type: data.recommendation_type || null,
    recommendation_message: data.recommendation_message || null,
    recommendation_details: data.recommendation_details || null,
    scoring_method: data.scoring_method || null,
    segmental_accuracy: data.segmental_accuracy ?? null,
    dtw_distance: data.dtw_distance ?? null,
    layer1_decision: data.layer1_decision || null,
    recognized_text: data.recognized_text || null,
    speech_verification: data.speech_verification || null,
    confidence_level: data.confidence_level || null,
    adaptive_score: data.adaptive_score ?? null,
    confidence_score: data.confidence_score ?? null,
    needs_teacher_review: Boolean(data.needs_teacher_review),
    heard_reference_audio: Boolean(data.heard_reference_audio),
    next_word_id: data.next_word_id || null,
    attempt_number: data.attempt_number || 1,
    workflow_completed: data.workflow_completed ?? true,
    recording_uri: data.recording_uri || null,
    raw_audio_data: rawAudioBuffer,
    raw_audio_mime_type: data.raw_audio_mime_type || null,
    // Audio presence must reflect bytes actually persisted, not client
    // metadata. Otherwise history advertises a playable clip that is absent.
    raw_audio_size: rawAudioBuffer?.length || null,
  };
}

function serializePronunciationResult(result, index) {
  const plain = result.get({ plain: true });
  const hasRawAudio = plain.raw_audio_data !== undefined
    ? Boolean(plain.raw_audio_data)
    : Boolean(plain.raw_audio_size);
  delete plain.raw_audio_data;

  return {
    ...plain,
    has_raw_audio: hasRawAudio,
    session_number: index + 1,
  };
}

async function savePronunciationResult(teacherId, studentId, data) {
  const student = await findTeacherStudent(teacherId, studentId);
  if (!student) throw new ApiError(404, 'Student not found or not assigned to you');

  // Scoring already persisted the attempt server-side (see
  // scorePronunciationAttempt); the client only finishes the workflow by
  // attaching the fields it alone knows. Scoring output (scores, phonemes,
  // recommendation, review flags) is never accepted back from the client on
  // this path — the stored row is the source of truth.
  if (data.result_id) {
    const result = await PronunciationSessionResult.findOne({
      where: { id: data.result_id, teacher_id: teacherId, student_id: student.sid },
    });
    if (!result) throw new ApiError(404, 'Pronunciation result not found');

    await result.update({
      listen_choose_data: data.listen_choose_data ?? result.listen_choose_data,
      recording_uri: data.recording_uri || result.recording_uri,
      workflow_completed: data.workflow_completed ?? true,
    });

    const plain = result.get({ plain: true });
    delete plain.raw_audio_data;
    return plain;
  }

  const rawAudioBuffer = data.raw_audio_base64
    ? Buffer.from(data.raw_audio_base64, 'base64')
    : null;

  return PronunciationSessionResult.create(
    buildPronunciationResultRecord({
      teacherId,
      studentId: student.sid,
      data,
      rawAudioBuffer,
    })
  );
}

async function scorePronunciationAttempt(teacherId, studentId, data) {
  const student = await findTeacherStudent(teacherId, studentId);
  if (!student) throw new ApiError(404, 'Student not found or not assigned to you');

  const previousResults = await PronunciationSessionResult.findAll({
    // Word and alphabet exercises use different targets (a word phoneme vs
    // a spoken letter name). Mixing their histories can make an unrelated
    // word attempt lower a letter's confidence/recurrence score.
    where: {
      teacher_id: teacherId,
      student_id: student.sid,
      mode: data.mode,
    },
    attributes: { exclude: ['raw_audio_data'] },
    order: [['created_at', 'DESC'], ['id', 'DESC']],
    limit: 12,
  });
  const previousResultData = previousResults.map((result) =>
    result.get({ plain: true })
  );

  const scored = await scorePronunciationAttemptData(data, previousResultData, {
    populationTag: student.disability,
  });

  // Persist the scoring output server-side immediately: the stored row is the
  // research record, so the client can never alter scores between scoring and
  // saving, and an interrupted session still keeps the attempt
  // (workflow_completed stays false until the client finishes the flow via
  // savePronunciationResult with result_id).
  const rawAudioBuffer = data.raw_audio_base64
    ? Buffer.from(data.raw_audio_base64, 'base64')
    : null;
  const saved = await PronunciationSessionResult.create(
    buildPronunciationResultRecord({
      teacherId,
      studentId: student.sid,
      data: {
        ...scored,
        raw_audio_mime_type: data.raw_audio_mime_type || null,
        raw_audio_size: data.raw_audio_size || null,
        workflow_completed: false,
      },
      rawAudioBuffer,
    }),
    // The default PostgreSQL RETURNING clause echoed the entire audio BLOB
    // back across the remote DB connection even though this path only needs
    // the new row id. That made an already expensive scoring request more
    // vulnerable to the connection stall seen in the failing attempt.
    { returning: ['id'] }
  );

  return { ...scored, result_id: saved.id };
}

async function getPronunciationReviewQueue(teacherId, limit) {
  return getReviewQueue(teacherId, { limit });
}

async function submitPronunciationReview(teacherId, resultId, teacherReviewedScore) {
  const result = await PronunciationSessionResult.findOne({
    where: { id: resultId, teacher_id: teacherId },
  });
  if (!result) throw new ApiError(404, 'Pronunciation result not found');

  result.teacher_reviewed_score = teacherReviewedScore;
  result.teacher_reviewed_at = new Date();
  result.teacher_reviewed_by = teacherId;
  result.needs_teacher_review = false;
  await result.save();

  // This review is new evidence for the layer-3 fit and for the queue's
  // coverage counts; drop both caches so the next scored attempt and the next
  // queue load see it instead of waiting out their TTLs.
  invalidateCalibrationCache();
  invalidateReviewedCountsCache();

  const plain = result.get({ plain: true });
  delete plain.raw_audio_data;
  return plain;
}

const RESULTS_HISTORY_DEFAULT_LIMIT = 4;
const RESULTS_HISTORY_MAX_LIMIT = 50;

async function getPronunciationResults(teacherId, studentId, limit = RESULTS_HISTORY_DEFAULT_LIMIT) {
  const student = await findTeacherStudent(teacherId, studentId);
  if (!student) throw new ApiError(404, 'Student not found or not assigned to you');

  const safeLimit = Math.max(1, Math.min(RESULTS_HISTORY_MAX_LIMIT, Number(limit) || RESULTS_HISTORY_DEFAULT_LIMIT));

  const results = await PronunciationSessionResult.findAll({
    where: { teacher_id: teacherId, student_id: student.sid },
    // Blob column excluded: fetching every attempt's stored audio just to
    // report has_raw_audio pulled hundreds of MB through the DB per history
    // load. raw_audio_size stands in for presence.
    attributes: { exclude: ['raw_audio_data'] },
    order: [['created_at', 'DESC'], ['id', 'DESC']],
    // Display-only cap: this only limits what the teacher's history screen
    // shows. Rows themselves are never deleted here — teacher_reviewed_score
    // on older rows is still the labeled corpus adaptiveCalibrationService
    // fits Layer 3 on, so those stay in the DB regardless of this limit.
    limit: safeLimit,
  });

  // Consumers select index 0 as the latest attempt and explicitly reverse a
  // copy when chronological calculations are needed.
  return results.map(serializePronunciationResult);
}

async function getPronunciationResultAudio(teacherId, resultId) {
  const result = await PronunciationSessionResult.findOne({
    where: { id: resultId, teacher_id: teacherId },
    attributes: [
      'id',
      'raw_audio_data',
      'raw_audio_mime_type',
      'raw_audio_size',
    ],
  });

  if (!result) throw new ApiError(404, 'Pronunciation result not found');
  if (!result.raw_audio_data) throw new ApiError(404, 'No audio saved for this session');

  return {
    id: result.id,
    raw_audio_base64: Buffer.from(result.raw_audio_data).toString('base64'),
    raw_audio_mime_type: result.raw_audio_mime_type || 'audio/mp4',
    raw_audio_size: result.raw_audio_size || result.raw_audio_data.length,
  };
}

async function assertOwnStudent(teacherId, studentId) {
  const student = await Student.findOne({ where: { sid: studentId, teacher_id: teacherId } });
  if (!student) throw new ApiError(404, 'Student not found or not assigned to you');
  return student;
}

async function getStudentNotes(teacherId, studentId) {
  await assertOwnStudent(teacherId, studentId);
  return StudentNote.findAll({
    where: { student_id: studentId },
    order: [['created_at', 'DESC']],
  });
}

async function addStudentNote(teacherId, studentId, bodyText) {
  await assertOwnStudent(teacherId, studentId);
  return StudentNote.create({
    student_id: studentId,
    teacher_id: teacherId,
    body: bodyText,
  });
}

async function deleteStudentNote(teacherId, studentId, noteId) {
  await assertOwnStudent(teacherId, studentId);
  const note = await StudentNote.findOne({ where: { id: noteId, student_id: studentId, teacher_id: teacherId } });
  if (!note) throw new ApiError(404, 'Note not found');
  await note.destroy();
}

// Opens and closes the `sessions` row that spans a teaching session. Other
// modules (category3, dialogue) create their own session rows inside their
// flows; the pronunciation module has no such natural anchor, so it brackets
// the flow with these instead. Without them the dashboard's session counts and
// Recent Activity never see a pronunciation session at all.
async function startSession(teacherId, studentId) {
  const id = normalizeStudentId(studentId);
  await assertOwnStudent(teacherId, id);

  // 409 rather than a second row: the caller treats it as "reuse the open one"
  // (an earlier session the app never closed after a crash), and endSession
  // below will close it.
  const existing = await Session.findOne({
    where: { teacher_id: teacherId, student_id: id, is_active: true },
  });
  if (existing) throw new ApiError(409, 'A session is already active for this student');

  return Session.create({ teacher_id: teacherId, student_id: id });
}

async function endSession(teacherId, studentId) {
  const id = normalizeStudentId(studentId);
  const session = await Session.findOne({
    where: { teacher_id: teacherId, student_id: id, is_active: true },
  });
  if (!session) throw new ApiError(404, 'No active session found for this student');

  await session.update({ ended_at: new Date(), is_active: false });
  return session;
}

module.exports = {
  startSession,
  endSession,
  startOfWeek,
  getDashboardStats,
  getOwnStudents,
  getOwnStudentById,
  setAvatar,
  getStudentNotes,
  addStudentNote,
  deleteStudentNote,
  setThreshold,
  setSensorySettings,
  scorePronunciationAttempt,
  savePronunciationResult,
  getPronunciationResults,
  getPronunciationResultAudio,
  submitPronunciationReview,
  getPronunciationReviewQueue,
};
