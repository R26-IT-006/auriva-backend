'use strict';

const {
  scoreWordPronunciationAttempt,
  scoreWordPronunciationAttemptWithoutReference,
} = require('./pronunciationAnalysisService');
const { WORD_PROFILES, LETTER_SOUNDS } = require('./wordProfiles');
const { computeCalibration, applyCalibration } = require('./adaptiveCalibrationService');
const logger = require('../utils/logger');

const PHONEME_CUES = {
  'æ': 'Open the mouth wide for the short /a/ sound.',
  'ɒ': 'Round the lips gently for the short /o/ sound.',
  'ɪ': 'Use a small smile for the short /i/ sound.',
  'ɜː': 'Keep the mouth relaxed for the long middle vowel.',
  'iː': 'Smile and stretch the long /ee/ sound.',
  'eɪ': 'Start with /e/ and glide to /i/.',
  'ɔː': 'Round the lips for the long /or/ sound.',
  'uː': 'Round the lips and hold the long /oo/ sound.',
  'ʌ': 'Open the mouth slightly for the short /u/ sound.',
  b: 'Close both lips, then release with voice.',
  p: 'Close both lips, then release with a soft pop.',
  m: 'Close both lips and hum through the nose.',
  f: 'Touch teeth to lower lip and blow air.',
  v: 'Touch teeth to lower lip and add voice.',
  s: 'Keep teeth close and send air forward.',
  z: 'Keep teeth close and add a buzzing voice.',
  t: 'Tap the tongue behind the teeth.',
  d: 'Tap the tongue behind the teeth with voice.',
  k: 'Lift the back of the tongue for the back-mouth sound.',
  g: 'Lift the back of the tongue and add voice.',
  h: 'Use an open mouth with gentle breath.',
  l: 'Lift the tongue tip behind the teeth.',
  r: 'Curl or bunch the tongue without touching the teeth.',
  w: 'Round the lips first, then open.',
  'ʃ': 'Round the lips slightly and push quiet air.',
  'tʃ': 'Start with a tongue tap, then release air.',
  'dʒ': 'Start with a tongue tap, then release with voice.',
  n: 'Lift the tongue tip behind the teeth and hum through the nose.',
  j: 'Lift the tongue toward the roof of the mouth for a soft /y/ glide.',
  e: 'Smile gently for the short /e/ sound.',
  i: 'Smile softly for the short /i/ sound.',
  a: 'Open the mouth for the short /a/ sound.',
  'ə': 'Relax the mouth for the soft, unstressed "uh" sound.',
  'ŋ': 'Lift the back of the tongue and hum through the nose.',
  'aɪ': 'Start with an open /a/ and glide up to /i/.',
  'aʊ': 'Start with an open /a/ and round toward /oo/.',
  'eə': 'Start with /e/ and relax into a soft "uh".',
  'ɪə': 'Start with a small /i/ and relax into a soft "uh".',
  'əʊ': 'Start relaxed, then round the lips toward /oh/.',
  'ɑː': 'Open the mouth wide for the long, deep "ah" sound.',
  'ʊ': 'Round the lips gently for the short /oo/ sound.',
  // The remaining keys are multi-sound blends this word bank groups as one
  // unit rather than true single IPA phonemes — the cue walks through the
  // blend so the teacher still has something concrete to say.
  'gwɪn': 'Round the lips for /g w/, then finish with a small smile and a nose hum for /n/.',
  sk: 'Blend a hissing /s/ straight into a back-of-tongue /k/.',
  'təʊ': 'Tap the tongue for /t/, then round the lips toward /oh/.',
  'əd': 'Relax into a soft "uh", then tap the tongue for /d/.',
  'ŋg': 'Hum through the nose for /ng/, then lift the tongue back for /g/.',
  'ruː': 'Curl the tongue for /r/, then round the lips and hold /oo/.',
  'ɪʃ': 'Small smile for /i/, then round the lips softly for /sh/.',
  ks: 'Lift the tongue back for /k/, then send air forward for /s/.',
  'əl': 'Relax into a soft "uh", then lift the tongue tip for /l/.',
  'flaɪ': 'Blow air for /f/, lift the tongue for /l/, then glide from /a/ to /i/.',
  'ləʊ': 'Lift the tongue tip for /l/, then round the lips toward /oh/.',
  'ŋgəʊ': 'Hum through the nose, lift the tongue back for /g/, then round the lips toward /oh/.',
  'ndʒ': 'Hum through the nose, then tap and release with voice for /j/.',
  'ən': 'Relax into a soft "uh", then hum through the nose for /n/.',
  'ənt': 'Relax into a soft "uh", hum for /n/, then tap the tongue for /t/.',
  gr: 'Lift the tongue back for /g/, then curl the tongue for /r/.',
  gw: 'Lift the tongue back for /g/, then round the lips for /w/.',
  mp: 'Hum through closed lips for /m/, then release with a soft pop for /p/.',
  dr: 'Tap the tongue for /d/, then curl the tongue for /r/.',
  sl: 'Send air forward for /s/, then lift the tongue tip for /l/.',
  kl: 'Lift the tongue back for /k/, then lift the tongue tip for /l/.',
  'ŋk': 'Hum through the nose, then lift the tongue back for /k/.',
  'gə': 'Lift the tongue back for /g/, then relax into a soft "uh".',
};

function clampScore(value) {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function roundNumber(value, digits = 3) {
  if (!Number.isFinite(value)) return 0;
  return Number(value.toFixed(digits));
}

function sigmoid(value) {
  return 1 / (1 + Math.exp(-value));
}

function softmax(logits) {
  const entries = Object.entries(logits);
  const maxLogit = Math.max(...entries.map(([, value]) => value));
  const exponentials = entries.map(([key, value]) => [key, Math.exp(value - maxLogit)]);
  const total = exponentials.reduce((sum, [, value]) => sum + value, 0) || 1;

  return exponentials.reduce((probabilities, [key, value]) => ({
    ...probabilities,
    [key]: roundNumber(value / total, 4),
  }), {});
}

function average(values) {
  if (!values.length) return 0;
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function standardDeviation(values) {
  if (values.length <= 1) return 0;
  const mean = average(values);
  const variance = average(values.map((value) => (value - mean) ** 2));
  return Math.sqrt(variance);
}

function getAudioQualityScore(audioQuality = {}) {
  const snrScore = sigmoid(((Number(audioQuality.snr_db) || 0) - 12) / 4) * 100;
  const silenceScore = (1 - Math.min(1, Math.max(0, Number(audioQuality.silence_ratio) || 0))) * 100;
  const clippingScore = (1 - Math.min(1, Math.max(0, Number(audioQuality.clipping_ratio) || 0) / 0.05)) * 100;
  const voicedScore = sigmoid(((Number(audioQuality.voiced_duration) || 0) - 0.22) / 0.08) * 100;

  return clampScore(
    snrScore * 0.4 +
    silenceScore * 0.25 +
    clippingScore * 0.2 +
    voicedScore * 0.15
  );
}

function buildAdaptiveModel({
  wordId,
  pronunciationSimilarity,
  phonemeScores,
  historyCounts,
  weakSound,
  hesitationTime,
  attemptNumber,
  difficulty,
  audioQuality,
}) {
  const scores = phonemeScores.map((sound) => Number(sound.score || 0));
  const phonemeMean = clampScore(average(scores));
  const phonemeMin = clampScore(Math.min(...scores, pronunciationSimilarity));
  const phonemeStdDev = standardDeviation(scores);
  const phonemeConsistency = clampScore(100 - phonemeStdDev);
  const repeatedWeakCount = weakSound?.text ? historyCounts[weakSound.text] || 0 : 0;
  const hesitationScore = clampScore(100 * Math.exp(-Math.max(0, Number(hesitationTime) || 0) / 3));
  const attemptScore = clampScore(100 * Math.exp(-Math.max(0, Number(attemptNumber || 1) - 1) * 0.35));
  const difficultyScore = clampScore(100 - Math.max(0, Number(difficulty || 1) - 1) * 12);
  const historyScore = clampScore(100 * Math.exp(-repeatedWeakCount * 0.38));
  const audioQualityScore = getAudioQualityScore(audioQuality);
  const phonemeErrorScore = clampScore(100 - phonemeMin);

  const features = {
    pronunciation_similarity: clampScore(pronunciationSimilarity),
    phoneme_mean: phonemeMean,
    phoneme_min: phonemeMin,
    phoneme_consistency: phonemeConsistency,
    phoneme_error_score: phonemeErrorScore,
    hesitation_score: hesitationScore,
    attempt_score: attemptScore,
    difficulty_score: difficultyScore,
    history_score: historyScore,
    repeated_weak_phoneme_count: repeatedWeakCount,
    audio_quality_score: audioQualityScore,
  };
  const weights = {
    pronunciation_similarity: 0.45,
    phoneme_mean: 0.15,
    phoneme_min: 0.1,
    hesitation_score: 0.1,
    attempt_score: 0.07,
    difficulty_score: 0.05,
    history_score: 0.03,
    audio_quality_score: 0.05,
  };
  const adaptiveScore = clampScore(
    Object.entries(weights).reduce(
      (score, [feature, weight]) => score + features[feature] * weight,
      0
    )
  );

  const normalized = Object.fromEntries(
    Object.entries(features).map(([key, value]) => [key, Number(value || 0) / 100])
  );
  const supportNeed =
    (1 - normalized.pronunciation_similarity) * 0.34 +
    (1 - normalized.phoneme_min) * 0.22 +
    (1 - normalized.hesitation_score) * 0.13 +
    (1 - normalized.attempt_score) * 0.12 +
    (1 - normalized.history_score) * 0.09 +
    (1 - normalized.audio_quality_score) * 0.1;
  const logits = {
    continue:
      normalized.pronunciation_similarity * 2.4 +
      normalized.phoneme_mean * 1.2 +
      normalized.phoneme_consistency * 0.45 +
      normalized.audio_quality_score * 0.45 -
      supportNeed * 1.9,
    reinforce:
      normalized.pronunciation_similarity * 0.9 +
      normalized.phoneme_error_score * 1.6 +
      (1 - normalized.phoneme_consistency) * 0.5 +
      supportNeed * 1.4,
    remediate:
      (1 - normalized.pronunciation_similarity) * 2.1 +
      (1 - normalized.phoneme_min) * 1.5 +
      (1 - normalized.hesitation_score) * 0.7 +
      (1 - normalized.attempt_score) * 0.6 +
      (1 - normalized.history_score) * 0.4,
  };
  const probabilities = softmax(logits);
  const sortedProbabilities = Object.entries(probabilities)
    .sort((a, b) => b[1] - a[1]);
  const [recommendationType, topProbability] = sortedProbabilities[0];
  const secondProbability = sortedProbabilities[1]?.[1] || 0;
  const probabilityMargin = topProbability - secondProbability;
  const confidenceScore = clampScore(
    topProbability * 62 +
    probabilityMargin * 28 +
    normalized.audio_quality_score * 10
  );
  const confidenceLevel = confidenceScore >= 75
    ? 'high'
    : confidenceScore >= 55
      ? 'medium'
      : 'low';
  const uncertaintyReasons = [
    probabilityMargin < 0.16 ? 'adaptive probabilities are close' : null,
    normalized.audio_quality_score < 0.68 ? 'audio quality lowers score reliability' : null,
    Math.abs(normalized.pronunciation_similarity - normalized.phoneme_mean) > 0.22
      ? 'overall similarity and phoneme scores disagree'
      : null,
    normalized.phoneme_min < 0.55 ? 'one phoneme is much weaker than the full-word score' : null,
  ].filter(Boolean);

  return {
    version: 'adaptive_linear_softmax_v1',
    word_id: wordId,
    features,
    weights,
    adaptive_score: adaptiveScore,
    class_logits: Object.fromEntries(
      Object.entries(logits).map(([key, value]) => [key, roundNumber(value, 4)])
    ),
    class_probabilities: probabilities,
    predicted_recommendation_type: recommendationType,
    confidence_score: confidenceScore,
    confidence_level: confidenceLevel,
    uncertainty_reasons: uncertaintyReasons,
  };
}

function getSoundPosition(index, total) {
  if (total <= 1) return 'single';
  if (index === 0) return 'initial';
  if (index === total - 1) return 'final';
  return 'medial';
}

function normalizeSounds(data) {
  const profile = WORD_PROFILES[data.word_id] || {};
  const sourceSounds = Array.isArray(data.target_phonemes) && data.target_phonemes.length
    ? data.target_phonemes
    : profile.sounds || LETTER_SOUNDS[data.word_id] || [];

  return sourceSounds.map((sound, index) => {
    const text = typeof sound === 'string' ? sound : sound.text;
    const type = typeof sound === 'string' ? null : sound.type || null;
    const position = typeof sound === 'string'
      ? getSoundPosition(index, sourceSounds.length)
      : sound.position || getSoundPosition(index, sourceSounds.length);

    return {
      text,
      type,
      position,
      cue: PHONEME_CUES[text] || (typeof sound === 'string' ? null : sound.cue || null),
    };
  }).filter((sound) => sound.text);
}

function pickWeakSound({ sounds, baseScore, difficulty, attemptNumber, historyCounts }) {
  if (!sounds.length) return null;

  return sounds
    .map((sound, index) => {
      const positionPenalty = sound.position === 'medial' ? 7 : sound.position === 'final' ? 4 : 2;
      const historyPenalty = (historyCounts[sound.text] || 0) * 9;
      const attemptPenalty = Math.max(0, attemptNumber - 1) * 3;
      const longSoundPenalty = String(sound.text).length > 1 ? 4 : 0;

      return {
        ...sound,
        score: clampScore(baseScore - difficulty * 4 - positionPenalty - historyPenalty - attemptPenalty - longSoundPenalty + index * 2),
      };
    })
    .sort((a, b) => a.score - b.score)[0];
}

function buildHistoryCounts(results = []) {
  return results.reduce((counts, result) => {
    const phonemeScores = Array.isArray(result.phoneme_scores) ? result.phoneme_scores : [];
    phonemeScores
      .filter((entry) => entry?.text && Number(entry.score) < 65)
      .forEach((entry) => {
        counts[entry.text] = (counts[entry.text] || 0) + 1;
      });
    return counts;
  }, {});
}

function getCandidateScore({ candidateId, weakSound, currentDifficulty, historyCounts, preferEasier }) {
  const candidate = WORD_PROFILES[candidateId];
  if (!candidate) return null;

  const sharesWeakSound = Boolean(weakSound?.text && candidate.sounds.includes(weakSound.text));
  const difficultyGap = currentDifficulty - candidate.difficulty;
  const repeatedWeakSound = weakSound?.text ? historyCounts[weakSound.text] || 0 : 0;
  const score =
    (sharesWeakSound ? 45 : 0) +
    (preferEasier && difficultyGap >= 0 ? 24 + difficultyGap * 4 : 0) +
    (!preferEasier && difficultyGap <= 1 ? 14 : 0) +
    Math.max(0, 10 - candidate.difficulty) +
    Math.min(12, repeatedWeakSound * 4);

  return {
    word_id: candidateId,
    difficulty: candidate.difficulty,
    shares_weak_phoneme: sharesWeakSound,
    difficulty_gap: difficultyGap,
    score,
    reason: sharesWeakSound
      ? `contains /${weakSound.text}/ for targeted practice`
      : preferEasier
        ? 'provides a simpler support step'
        : 'continues with a related planned word',
  };
}

function getRecurringPattern(historyCounts) {
  const entries = Object.entries(historyCounts).sort((a, b) => b[1] - a[1]);
  if (!entries.length) return null;

  const [phoneme, count] = entries[0];
  return {
    phoneme,
    count,
    description: count >= 2
      ? `Recurring weakness detected for /${phoneme}/ across ${count} saved attempts.`
      : `One previous weak attempt found for /${phoneme}/.`,
  };
}

function chooseNextWordDetails({ wordId, weakSound, overallScore, historyCounts }) {
  const profile = WORD_PROFILES[wordId] || {};
  const currentDifficulty = profile.difficulty || 2;
  const preferEasier = overallScore < 60 || Boolean(weakSound?.text && historyCounts[weakSound.text] >= 2);
  const candidateIds = overallScore < 60
    ? [...(profile.easierWords || []), ...(profile.relatedWords || [])]
    : [...(profile.relatedWords || []), ...(profile.easierWords || [])];
  const candidates = [...new Set(candidateIds)]
    .map((candidateId) => getCandidateScore({
      candidateId,
      weakSound,
      currentDifficulty,
      historyCounts,
      preferEasier,
    }))
    .filter(Boolean)
    .sort((a, b) => b.score - a.score);
  const selected = candidates[0] || null;

  if (selected) {
    return {
      nextWordId: selected.word_id,
      selectedCandidate: selected,
      candidateRankings: candidates,
      adaptationFocus: preferEasier ? 'remediation' : 'reinforcement',
    };
  }

  const recurringPattern = getRecurringPattern(historyCounts);
  const fallbackWordId = recurringPattern?.phoneme
    ? Object.entries(WORD_PROFILES).find(
      ([candidateId, candidate]) => candidateId !== wordId && candidate.sounds.includes(recurringPattern.phoneme)
    )?.[0] || null
    : null;

  return {
    nextWordId: fallbackWordId,
    selectedCandidate: fallbackWordId
      ? getCandidateScore({
        candidateId: fallbackWordId,
        weakSound: { text: recurringPattern.phoneme },
        currentDifficulty,
        historyCounts,
        preferEasier: true,
      })
      : null,
    candidateRankings: candidates,
    adaptationFocus: fallbackWordId ? 'recurring-phoneme-review' : 'planned-progression',
  };
}

function buildRecommendation({
  overallScore,
  weakSound,
  nextWordId,
  historyCounts,
  nextWordDecision,
  hesitationTime,
  difficulty,
  adaptiveModel = null,
}) {
  const repeatedCount = weakSound?.text ? historyCounts[weakSound.text] || 0 : 0;
  const positionText = weakSound?.position ? `${weakSound.position} ` : '';
  const soundText = weakSound?.text ? `/${weakSound.text}/` : 'the target sound';
  const recurringPattern = getRecurringPattern(historyCounts);
  const selectedReason = nextWordDecision?.selectedCandidate?.reason || null;
  const evidence = [
    `overall score ${overallScore}%`,
    weakSound?.text ? `${positionText}${soundText} scored lowest` : null,
    repeatedCount > 0 ? `${soundText} appeared weak in ${repeatedCount} previous attempt${repeatedCount === 1 ? '' : 's'}` : null,
    hesitationTime >= 1.5 ? `hesitation time ${hesitationTime}s suggests extra support` : null,
    difficulty >= 4 ? 'current word is high difficulty' : null,
    selectedReason ? `next word ${nextWordId} ${selectedReason}` : null,
  ].filter(Boolean);
  const recommendationType = adaptiveModel?.predicted_recommendation_type || null;

  if (recommendationType === 'continue' || (!recommendationType && overallScore >= 80)) {
    return {
      recommendation_type: 'continue',
      recommendation_message: nextWordId
        ? `Pronunciation is strong. Continue to ${nextWordId}.`
        : 'Pronunciation is strong. Continue to the next planned word.',
      recommendation_details: {
        focus: 'progression',
        evidence,
        recurring_pattern: recurringPattern,
        selected_candidate: nextWordDecision?.selectedCandidate || null,
        candidate_rankings: nextWordDecision?.candidateRankings || [],
      },
    };
  }

  if (recommendationType === 'reinforce' || (!recommendationType && overallScore >= 60)) {
    return {
      recommendation_type: 'reinforce',
      recommendation_message: repeatedCount > 0
        ? `Reinforce the ${positionText}${soundText} sound; it has appeared as a weak sound before. Recommended next word: ${nextWordId || 'related practice'}.`
        : `Reinforce the ${positionText}${soundText} sound with another related word. Recommended next word: ${nextWordId || 'related practice'}.`,
      recommendation_details: {
        focus: 'reinforcement',
        evidence,
        recurring_pattern: recurringPattern,
        selected_candidate: nextWordDecision?.selectedCandidate || null,
        candidate_rankings: nextWordDecision?.candidateRankings || [],
      },
    };
  }

  return {
    recommendation_type: 'remediate',
    recommendation_message: `Use a simpler support word before moving ahead because the ${positionText}${soundText} sound needs support. Recommended next word: ${nextWordId || 'simpler practice'}.`,
    recommendation_details: {
      focus: 'remediation',
      evidence,
      recurring_pattern: recurringPattern,
      selected_candidate: nextWordDecision?.selectedCandidate || null,
      candidate_rankings: nextWordDecision?.candidateRankings || [],
    },
  };
}

function scorePrototypePronunciationAttemptData(data, previousResults = []) {
  const profile = WORD_PROFILES[data.word_id] || {};
  const sounds = normalizeSounds(data);
  const historyCounts = buildHistoryCounts(previousResults);
  const rawAudioSize = data.raw_audio_base64
    ? Buffer.byteLength(data.raw_audio_base64, 'base64')
    : data.raw_audio_size || 0;
  const responseDuration = Number(data.response_duration || 0);
  const attemptNumber = Math.max(1, Number(data.attempt_number || 1));
  const difficulty = Number(data.difficulty || profile.difficulty || 2);
  const durationPenalty = responseDuration > 0
    ? Math.min(18, Math.abs(responseDuration - Math.max(1.2, difficulty * 0.75)) * 4)
    : 8;
  const audioPresenceBonus = rawAudioSize > 0 ? 8 : -18;
  const audioLengthSignal = rawAudioSize > 0
    ? Math.min(10, Math.log10(rawAudioSize) * 2)
    : 0;
  const attemptPenalty = Math.max(0, attemptNumber - 1) * 4;
  const recurringPenalty = Object.values(historyCounts).reduce((total, count) => total + Math.min(count, 3), 0);
  const baseScore = clampScore(
    78 + audioPresenceBonus + audioLengthSignal - difficulty * 3 - durationPenalty - attemptPenalty - recurringPenalty
  );
  const weakSound = pickWeakSound({
    sounds,
    baseScore,
    difficulty,
    attemptNumber,
    historyCounts,
  });
  const phonemeScores = sounds.map((sound, index) => {
    const isWeakSound = weakSound?.text === sound.text && weakSound?.position === sound.position;
    const positionPenalty = sound.position === 'medial' ? 5 : sound.position === 'final' ? 3 : 1;
    const historyPenalty = (historyCounts[sound.text] || 0) * 6;
    const score = isWeakSound
      ? weakSound.score
      : baseScore - positionPenalty - historyPenalty + index * 3;

    return {
      text: sound.text,
      type: sound.type,
      position: sound.position,
      cue: sound.cue,
      score: clampScore(score),
    };
  });
  const averagePhonemeScore = phonemeScores.length
    ? phonemeScores.reduce((total, sound) => total + sound.score, 0) / phonemeScores.length
    : baseScore;
  const overallScore = clampScore((baseScore + averagePhonemeScore) / 2);
  const nextWordDecision = chooseNextWordDetails({
    wordId: data.word_id,
    weakSound,
    overallScore,
    historyCounts,
  });
  const nextWordId = nextWordDecision.nextWordId;
  const hesitationTime = data.hesitation_time ?? null;
  const recommendation = buildRecommendation({
    overallScore,
    weakSound,
    nextWordId,
    historyCounts,
    nextWordDecision,
    hesitationTime,
    difficulty,
  });

  return {
    mode: data.mode || 'word',
    category_id: data.category_id || null,
    word_id: data.word_id,
    word_label: data.word_label || data.word_id,
    overall_score: overallScore,
    heard_reference_audio: Boolean(data.heard_reference_audio),
    phoneme_scores: phonemeScores,
    response_duration: responseDuration || null,
    hesitation_time: hesitationTime,
    weak_phoneme: weakSound?.text || null,
    weak_position: weakSound?.position || null,
    recurring_weak_phoneme_count: weakSound?.text ? historyCounts[weakSound.text] || 0 : 0,
    next_word_id: nextWordId,
    attempt_number: attemptNumber,
    scoring_method: 'prototype_signal_rule_v1',
    ...recommendation,
  };
}

async function scoreAcousticPronunciationAttemptData(
  data,
  previousResults,
  wordId,
  scoreEngine = scoreWordPronunciationAttempt,
  context = {}
) {
  const profile = WORD_PROFILES[wordId] || {};
  const sounds = normalizeSounds({ ...data, word_id: wordId });
  const historyCounts = buildHistoryCounts(previousResults);
  const attemptNumber = Math.max(1, Number(data.attempt_number || 1));
  const difficulty = Number(data.difficulty || profile.difficulty || 2);
  const mfccDtwScore = await scoreEngine({ ...data, word_id: wordId });
  const gopAssessment = mfccDtwScore.gop_assessment || null;
  const gopBySound = gopAssessment?.per_sound || [];
  const scoringMethod = gopAssessment
    ? (mfccDtwScore.dtw_distance != null ? 'wav2vec2_gop+mfcc_dtw_v1' : 'wav2vec2_gop_v1')
    : mfccDtwScore.scoring_method;
  const phonemeScores = sounds.map((sound, index) => ({
    text: sound.text,
    type: sound.type,
    position: sound.position,
    cue: sound.cue,
    score: clampScore(
      gopBySound[index]?.score ??
      mfccDtwScore.phoneme_boundary_alignment?.[index]?.score ??
      mfccDtwScore.segment_scores[index] ??
      mfccDtwScore.overall_score
    ),
    gop: gopBySound[index]?.gop ?? null,
    gop_score: gopBySound[index]?.score ?? null,
    similarity_score:
      mfccDtwScore.phoneme_boundary_alignment?.[index]?.similarity_score ?? null,
    timing_score:
      mfccDtwScore.phoneme_boundary_alignment?.[index]?.timing_score ?? null,
    reference_start:
      mfccDtwScore.phoneme_boundary_alignment?.[index]?.reference_start ?? null,
    reference_end:
      mfccDtwScore.phoneme_boundary_alignment?.[index]?.reference_end ?? null,
    student_start:
      mfccDtwScore.phoneme_boundary_alignment?.[index]?.student_start ?? null,
    student_end:
      mfccDtwScore.phoneme_boundary_alignment?.[index]?.student_end ?? null,
    duration_ratio:
      mfccDtwScore.phoneme_boundary_alignment?.[index]?.duration_ratio ?? null,
  }));
  const weakSound = phonemeScores
    .slice()
    .sort((a, b) => a.score - b.score)[0] || null;
  // GOP carries phoneme-identity evidence, DTW only acoustic closeness, so
  // GOP dominates the blend whenever the engine produced a score.
  const overallScore = gopAssessment?.overall_gop_score != null
    ? clampScore(gopAssessment.overall_gop_score * 0.7 + mfccDtwScore.overall_score * 0.3)
    : mfccDtwScore.overall_score;
  const nextWordDecision = chooseNextWordDetails({
    wordId,
    weakSound,
    overallScore,
    historyCounts,
  });
  const nextWordId = nextWordDecision.nextWordId;
  const preRecordDelay = Math.max(0, Math.min(30, Number(data.pre_record_delay_seconds) || 0));
  const speechOnset = Number(mfccDtwScore.audio_quality?.speech_onset_seconds) || 0;
  const hesitationTime = data.hesitation_time != null
    ? Number(data.hesitation_time)
    : Number((speechOnset + preRecordDelay).toFixed(2));
  const timingObservation = {
    ...mfccDtwScore.timing_observation,
    hesitation: {
      speech_onset_seconds: speechOnset,
      pre_record_delay_seconds: preRecordDelay,
      hesitation_time: hesitationTime,
      source: data.hesitation_time != null ? 'client_provided' : 'measured',
    },
  };
  const adaptiveModel = buildAdaptiveModel({
    wordId,
    pronunciationSimilarity: overallScore,
    phonemeScores,
    historyCounts,
    weakSound,
    hesitationTime,
    attemptNumber,
    difficulty,
    audioQuality: mfccDtwScore.audio_quality,
  });
  const recommendation = buildRecommendation({
    overallScore,
    weakSound,
    nextWordId,
    historyCounts,
    nextWordDecision,
    hesitationTime,
    difficulty,
    adaptiveModel,
  });
  // Low-confidence results suppress child-facing evaluative feedback and are
  // flagged for the teacher instead of risking an unreliable negative score.
  const needsTeacherReview = adaptiveModel.confidence_level === 'low';

  // Layer 3: a small recalibration model fit on teacher-reviewed attempts,
  // grouped by student population (Student.disability) so it can adapt as
  // labeled examples arrive from new populations (e.g. autistic students)
  // without needing separate models trained from scratch. Surfaced as
  // evidence only for now — it does not adjust overall_score/adaptive_score
  // until validated on more labeled data than the corpus currently holds.
  const calibration = context.populationTag
    ? await computeCalibration(context.populationTag)
    : null;
  const layer3Calibration = calibration
    ? { ...calibration, calibrated_score: applyCalibration(adaptiveModel.adaptive_score, calibration) }
    : null;

  return {
    mode: data.mode || 'word',
    category_id: data.category_id || null,
    word_id: wordId,
    word_label: data.word_label || data.word_id,
    overall_score: overallScore,
    pronunciation_similarity: overallScore,
    speech_verification: mfccDtwScore.speech_verification || null,
    recognized_text: mfccDtwScore.speech_verification?.recognized_text || null,
    gop_assessment: gopAssessment,
    decoded_phonemes: gopAssessment?.decoded_phonemes || null,
    segmental_accuracy: mfccDtwScore.segmental_accuracy,
    timing_observation: timingObservation,
    adaptive_score: adaptiveModel.adaptive_score,
    confidence_score: adaptiveModel.confidence_score,
    confidence_level: adaptiveModel.confidence_level,
    uncertainty_reasons: adaptiveModel.uncertainty_reasons,
    needs_teacher_review: needsTeacherReview,
    // Metadata only — must never influence overall_score, adaptive_score, or
    // recommendation_type. Whether the child just imitated the reference
    // audio or spoke independently changes how a low score should be read,
    // not what the score is.
    heard_reference_audio: Boolean(data.heard_reference_audio),
    phoneme_scores: phonemeScores,
    response_duration: Number(data.response_duration || 0) || null,
    hesitation_time: hesitationTime,
    weak_phoneme: weakSound?.text || null,
    weak_position: weakSound?.position || null,
    recurring_weak_phoneme_count: weakSound?.text ? historyCounts[weakSound.text] || 0 : 0,
    next_word_id: nextWordId,
    attempt_number: attemptNumber,
    scoring_method: scoringMethod,
    dtw_distance: mfccDtwScore.dtw_distance,
    layer1_decision: mfccDtwScore.layer1_decision || null,
    reference_word_id: mfccDtwScore.reference_word_id,
    mfcc_config: mfccDtwScore.mfcc_config,
    ...recommendation,
    recommendation_details: {
      ...(recommendation.recommendation_details || {}),
      adaptive_model: adaptiveModel,
      needs_teacher_review: needsTeacherReview,
      confidence: {
        score: adaptiveModel.confidence_score,
        level: adaptiveModel.confidence_level,
        uncertainty_reasons: adaptiveModel.uncertainty_reasons,
      },
      scoring_evidence: {
        method: scoringMethod,
        layer1_decision: mfccDtwScore.layer1_decision || null,
        layer3_calibration: layer3Calibration,
        gop_assessment: gopAssessment,
        dtw_distance: mfccDtwScore.dtw_distance,
        segment_scores: mfccDtwScore.segment_scores,
        phoneme_boundary_alignment: mfccDtwScore.phoneme_boundary_alignment,
        timing_observation: timingObservation,
        audio_quality: mfccDtwScore.audio_quality,
        mfcc_config: mfccDtwScore.mfcc_config,
      },
    },
  };
}

async function scorePronunciationAttemptData(data, previousResults = [], context = {}) {
  const wordId = String(data.word_id || '').toLowerCase();

  try {
    return await scoreAcousticPronunciationAttemptData(data, previousResults, wordId, undefined, context);
  } catch (error) {
    if (error.code === 'AUDIO_QUALITY_FAILED' || error.code === 'WORD_MISMATCH') {
      throw error;
    }

    if (error.code === 'REFERENCE_AUDIO_NOT_FOUND') {
      // No reference recording (alphabet mode, words without mp3s): GOP does
      // not need one — score phoneme identity directly. The signal-heuristic
      // prototype scorer is the last resort only when the GOP engine is down.
      try {
        return await scoreAcousticPronunciationAttemptData(
          data,
          previousResults,
          wordId,
          scoreWordPronunciationAttemptWithoutReference,
          context
        );
      } catch (gopError) {
        if (gopError.code === 'AUDIO_QUALITY_FAILED' || gopError.code === 'WORD_MISMATCH') {
          throw gopError;
        }
        return {
          ...scorePrototypePronunciationAttemptData(data, previousResults),
          scoring_fallback_reason: 'reference_audio_missing_gop_unavailable',
        };
      }
    }

    // Any other failure (GOP worker crash/timeout, unexpected engine error,
    // malformed model output, etc.) must still hand the child a usable
    // score rather than a dead end — a transient acoustic-engine problem is
    // not the same as a bad recording or a mismatched word (those two stay
    // real errors above), so it falls back the same way a missing reference
    // recording does instead of surfacing a raw 500 with no score.
    logger.error('Acoustic scoring failed, falling back to prototype scorer', {
      word_id: wordId,
      error_code: error.code,
      error_message: error.message,
    });
    return {
      ...scorePrototypePronunciationAttemptData(data, previousResults),
      scoring_fallback_reason: 'acoustic_scoring_failed',
    };
  }
}

module.exports = {
  scorePronunciationAttemptData,
  buildAdaptiveModel,
};
