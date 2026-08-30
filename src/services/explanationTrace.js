'use strict';

/**
 * explanationTrace.js
 *
 * PURE presentation layer for the rule engines' own output.
 *
 * What this module does NOT do, by construction:
 *   - no database access, no model/service imports that touch the DB;
 *   - no rule evaluation, no scoring, no decision-making;
 *   - no mutation of its inputs;
 *   - no invented values — every field is either copied from the engine's
 *     own output or derived arithmetically from constants the engine
 *     already exports (window size, increase step, required met count).
 *
 * It converts an existing `evaluateDynamicThresholds()` family decision
 * (plus, optionally, the already-computed teacher-protection and
 * automatic-persistence classification) into one structured, teacher-readable
 * trace.
 *
 * ── Wording rules ─────────────────────────────────────────────────────────
 * Every sentence states a RULE CONDITION that either held or did not hold.
 * Nothing here predicts future performance: a counterfactual says what the
 * rule would require, never what the learner will do. The engine's numbers
 * are deterministic comparisons, so no probability, likelihood or confidence
 * language is used or permitted.
 *
 * ── Internal identifiers ──────────────────────────────────────────────────
 * attempt ids, evidence fingerprints and ThresholdHistory row ids are
 * deliberately kept OUT of the teacher-facing structure. They are available
 * separately under `technical` for audit callers, which the teacher panel
 * does not render.
 */

const DECISION_RAISE = 'raise';
const DECISION_RAISE_REQUIRES_REVIEW = 'raise_requires_review';
const DECISION_HOLD = 'hold';
const DECISION_SUPPORT_REVIEW = 'support_review';
const DECISION_INSUFFICIENT_DATA = 'insufficient_data';
const DECISION_NO_TARGET = 'no_target';

const BASIS = 'rule_based_deterministic';

// Persistence actions that mean "an automatic update was blocked", each with
// its own truthful sentence. Mirrors classifyOneFamilyForAutomaticPersistence's
// own vocabulary — never a new synonym.
const BLOCKED_ACTION_MESSAGES = Object.freeze({
  skipped_teacher_protected:
    'Automatic updating was not applied because the current target is protected by a teacher-defined setting.',
  stale_decision:
    'The evidence used for this decision changed before the update could be applied, so the update was not used.',
  already_persisted:
    'This same evidence has already been applied, so it was not counted again.',
});

function plural(count, singular, pluralForm) {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

function isNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Builds the teacher-readable summary + counterfactual for one decision.
 * Pure and total: every decision code has an explicit branch, and an
 * unrecognized code yields a neutral statement rather than a guess.
 */
function buildExplanation({
  decision, currentThreshold, metTargetCount, observedCount,
  requiredCount, requiredMetCount, recommendedThreshold, rawRecommendedThreshold,
  increaseStep, blockedAction,
}) {
  const n = metTargetCount;

  if (decision === DECISION_RAISE) {
    return {
      summary:
        `${n} of the ${requiredCount} recent eligible attempts met the current target of `
        + `${currentThreshold}. The progression rule requires at least ${requiredMetCount} of `
        + `${requiredCount}, so the target was increased to ${recommendedThreshold}.`,
      counterfactual: null,
    };
  }

  if (decision === DECISION_RAISE_REQUIRES_REVIEW) {
    return {
      summary:
        `${n} of ${requiredCount} attempts met the current target of ${currentThreshold}. `
        + `Applying the standard +${increaseStep} step would produce ${rawRecommendedThreshold}, `
        + 'which exceeds the supported 0-100 score range, so no automatic change was applied.',
      counterfactual: null,
    };
  }

  if (decision === DECISION_HOLD) {
    const needed = requiredMetCount - n;
    return {
      summary:
        `${n} of the ${requiredCount} recent eligible attempts met the current target of `
        + `${currentThreshold}. At least ${requiredMetCount} of ${requiredCount} are required `
        + 'before the target can increase, so the current target was maintained.',
      counterfactual:
        `${plural(needed, 'more attempt', 'more attempts')} within the current `
        + `${requiredCount}-attempt window would need to meet the target for the progression `
        + 'condition to be satisfied.',
    };
  }

  if (decision === DECISION_SUPPORT_REVIEW) {
    const needed = requiredMetCount - n;
    return {
      summary:
        `${n} of the ${requiredCount} recent eligible attempts met the current target of `
        + `${currentThreshold}. The target was not reduced automatically. At least `
        + `${requiredMetCount} of ${requiredCount} are required before the target can increase.`,
      counterfactual:
        `${plural(needed, 'more attempt', 'more attempts')} within the current `
        + `${requiredCount}-attempt window would need to meet the target for the progression `
        + 'condition to be satisfied.',
    };
  }

  if (decision === DECISION_INSUFFICIENT_DATA) {
    const remaining = requiredCount - observedCount;
    return {
      // Deliberately never worded as failure — a short window means the
      // evidence is incomplete, not that the learner did not succeed.
      summary:
        `Only ${observedCount} of the ${requiredCount} eligible attempts required for a `
        + 'progression decision are currently available.',
      counterfactual:
        `${plural(remaining, 'more eligible attempt is', 'more eligible attempts are')} `
        + 'needed to complete the evidence window.',
    };
  }

  if (decision === DECISION_NO_TARGET) {
    return {
      summary:
        'No progression target is currently available for this movement family, '
        + 'so no progression decision was made.',
      counterfactual: null,
    };
  }

  return { summary: 'No progression decision is available for this movement family.', counterfactual: null };
}

/**
 * @param {Object} params
 * @param {Object} params.familyDecision — one family entry from evaluateDynamicThresholds()
 * @param {Object} [params.protection]   — isFamilyTargetProtected()/getFamilyThresholdProtection() result
 * @param {Object} [params.persistence]  — classifyAutomaticThresholdPersistence() family entry
 * @param {Object} [params.exclusions]   — getRecentFamilyPerformance().exclusions
 * @param {Object} params.constants      — { windowSize, increaseStep, requiredMetCount, mappingVersion }
 * @param {number} [params.previousThreshold]
 * @returns {Object} the structured trace (see this module's header)
 */
function buildThresholdDecisionTrace({
  familyDecision, protection = null, persistence = null, exclusions = null,
  constants, previousThreshold = null,
}) {
  const { windowSize, increaseStep, requiredMetCount, mappingVersion = null } = constants;

  // metTargetCount is null on a short window by design; the engine still
  // exposes the count it did observe under a different name, and that is
  // what the wording must use.
  const metTargetCount = isNumber(familyDecision.metTargetCount)
    ? familyDecision.metTargetCount
    : (isNumber(familyDecision.diagnosticMetTargetCount) ? familyDecision.diagnosticMetTargetCount : 0);

  const observedCount = familyDecision.window?.count ?? 0;
  const protectedTarget = protection?.protected === true;
  const action = persistence?.action ?? null;
  const applied = action === 'created';

  const explanation = buildExplanation({
    decision: familyDecision.decision,
    currentThreshold: familyDecision.currentThreshold,
    metTargetCount,
    observedCount,
    requiredCount: windowSize,
    requiredMetCount,
    recommendedThreshold: familyDecision.recommendedThreshold,
    rawRecommendedThreshold: familyDecision.rawRecommendedThreshold,
    increaseStep,
  });

  // A blocking note is ADDITIONAL context, never a replacement for the
  // decision's own explanation.
  const blockedNote = (protectedTarget && BLOCKED_ACTION_MESSAGES.skipped_teacher_protected)
    || BLOCKED_ACTION_MESSAGES[action]
    || null;

  return {
    engine: {
      name: 'dynamic_threshold',
      window_size: windowSize,
      increase_step: increaseStep,
      required_met_count: requiredMetCount,
      mapping_version: mappingVersion,
    },
    scope: { family: familyDecision.family },
    decision: {
      code: familyDecision.decision,
      reason: familyDecision.reason,
      requires_review: familyDecision.requiresReview === true,
    },
    target: {
      previous: isNumber(previousThreshold) ? previousThreshold : null,
      current: isNumber(familyDecision.currentThreshold) ? familyDecision.currentThreshold : null,
      proposed_raw: isNumber(familyDecision.rawRecommendedThreshold) ? familyDecision.rawRecommendedThreshold : null,
      proposed: isNumber(familyDecision.recommendedThreshold) ? familyDecision.recommendedThreshold : null,
      // The evaluator is read-only: unless an automatic update was actually
      // persisted, the target in force stays the current one.
      final: applied && isNumber(familyDecision.recommendedThreshold)
        ? familyDecision.recommendedThreshold
        : (isNumber(familyDecision.currentThreshold) ? familyDecision.currentThreshold : null),
      changed: applied === true,
    },
    evidence_window: {
      required_count: windowSize,
      observed_count: observedCount,
      complete: familyDecision.window?.complete === true,
      met_target_count: metTargetCount,
      // attempt_id is intentionally absent — see the header.
      attempts: (familyDecision.attemptEvaluations ?? []).map((a) => ({
        letter: a.letter,
        case_type: a.caseType,
        score: a.performanceScore,
        threshold: a.targetAtEvaluation,
        met_target: a.metTarget === true,
      })),
      excluded: exclusions
        ? {
          collection_mode: exclusions.collectionMode ?? null,
          non_third_attempt: exclusions.nonThirdAttempt ?? null,
          invalid_capture_status: exclusions.invalidCaptureStatus ?? null,
          unmapped_letter: exclusions.unmappedLetter ?? null,
          malformed_features: exclusions.malformedFeatures ?? null,
          duplicate_session: exclusions.duplicateSession ?? null,
        }
        : null,
    },
    teacher_override: {
      protected: protectedTarget,
      reason: protectedTarget ? (protection?.reason ?? null) : null,
    },
    persistence: {
      applied,
      action,
      note: blockedNote,
    },
    explanation,
    disclosure: {
      basis: BASIS,
      not_a_probability: true,
    },
  };
}

module.exports = {
  buildThresholdDecisionTrace,
  buildExplanation,
  BLOCKED_ACTION_MESSAGES,
  BASIS,
};
