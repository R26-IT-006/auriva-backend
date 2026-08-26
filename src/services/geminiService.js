'use strict';

const axios  = require('axios');
const logger = require('../utils/logger');

// Transport only. This module knows nothing about students, reports or teachers —
// it takes a system instruction, a payload and a response schema, and returns
// parsed JSON or null. Keeping it that thin is what lets aiSummaryService be
// tested without a network, and what would let Gemini be swapped for another
// provider by rewriting one file.

const API_ROOT = 'https://generativelanguage.googleapis.com/v1beta/models';

// Flash tier: these calls are short, bounded in volume and not latency-critical.
// Pro would multiply the cost for output a teacher reads once. Overridable via
// env because model identifiers move faster than this codebase does.
const DEFAULT_MODEL = 'gemini-3.6-flash';

/** The kill switch from the feasibility report's §6.2 guardrails. */
function isEnabled() {
  return process.env.GEMINI_ENABLED === 'true' && Boolean(process.env.GEMINI_API_KEY);
}

function modelName() {
  return process.env.GEMINI_MODEL || DEFAULT_MODEL;
}

/**
 * One schema-constrained generation.
 *
 * Returns the parsed object, or `null` for every failure mode — timeout, non-2xx,
 * a safety block, or a response body that isn't the JSON we asked for. It never
 * throws: every caller is decorating a screen that must render without it, and
 * the existing GNN call in teacherService uses the same `.catch(() => null)`
 * contract for exactly that reason.
 */
async function generate(systemInstruction, payload, responseSchema) {
  if (!isEnabled()) return null;

  const model   = modelName();
  const timeout = Number(process.env.GEMINI_TIMEOUT_MS) || 15000;

  try {
    const { data } = await axios.post(
      `${API_ROOT}/${model}:generateContent`,
      {
        systemInstruction: { parts: [{ text: systemInstruction }] },
        contents: [{
          role: 'user',
          parts: [{ text: JSON.stringify(payload) }],
        }],
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema,
          temperature: 0.2,      // summarising numbers, not writing prose
          // Thinking tokens are drawn from this same budget, so it has to cover
          // both. 1200 was enough for the output alone and produced truncated,
          // unparseable JSON — finishReason MAX_TOKENS — once the model started
          // reasoning first.
          maxOutputTokens: 4000,
          // Gemini 3 syntax. The task is restating supplied figures against a
          // fixed schema, so extended reasoning buys nothing here and competes
          // with the output for the budget above.
          thinkingConfig: { thinkingLevel: 'low' },
        },
      },
      {
        timeout,
        headers: {
          'Content-Type':   'application/json',
          'x-goog-api-key': process.env.GEMINI_API_KEY,
        },
      },
    );

    const candidate = data?.candidates?.[0];

    // A blocked or truncated candidate carries no usable parts. Log the reason —
    // a run of MAX_TOKENS finishes means the schema has outgrown the budget above,
    // and that is invisible otherwise.
    const finish = candidate?.finishReason;
    if (finish && finish !== 'STOP') {
      logger.warn(`Gemini returned finishReason=${finish} for model ${model}`);
    }

    const text = candidate?.content?.parts?.map((p) => p.text).join('') ?? '';
    if (!text.trim()) return null;

    return JSON.parse(text);
  } catch (err) {
    // Google puts the useful part in the response body, not the axios message.
    const detail = err.response?.data?.error?.message || err.message;
    logger.error(`Gemini generateContent failed (model ${model}): ${detail}`);
    return null;
  }
}

module.exports = { generate, isEnabled, modelName };
