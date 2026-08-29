'use strict';

const { ColoringArtwork, Student } = require('../models');
const { uploadBuffer, deleteBlob, extractBlobPath } = require('./blobService');
const ApiError = require('../utils/ApiError');

// A child can colour the same picture many times; keeping every attempt forever
// would grow without bound, so only the most recent few per concept are kept.
const KEEP_PER_CONCEPT = 5;

/**
 * Store one finished Tier 3 colouring.
 *
 * @param {number} studentId
 * @param {string} categoryKey
 * @param {string} conceptKey
 * @param {{buffer: Buffer, mimetype: string}} file - PNG from multer memoryStorage
 * @param {{strokeCount?: number, timeSpentMs?: number}} meta
 * @returns {Promise<{id: number, image_url: string}>}
 */
async function saveArtwork(studentId, categoryKey, conceptKey, file, meta = {}) {
  if (!file) throw new ApiError(422, 'An image file is required');

  const student = await Student.findByPk(studentId);
  if (!student) throw new ApiError(404, 'Student not found');

  // Timestamped path: unlike a profile photo this is history, so a new save must
  // never overwrite the blob an existing row still points at.
  const blobPath = `coloring/${student.student_code}/${categoryKey}/${conceptKey}-${Date.now()}.png`;
  const imageUrl = await uploadBuffer(file.buffer, blobPath, file.mimetype || 'image/png');

  const artwork = await ColoringArtwork.create({
    student_id:    studentId,
    category_key:  categoryKey,
    concept_key:   conceptKey,
    image_url:     imageUrl,
    stroke_count:  meta.strokeCount ?? null,
    time_spent_ms: meta.timeSpentMs ?? null,
    created_at:    new Date(),
  });

  // Trim older attempts of this same concept. Best-effort: the child's new
  // artwork is already saved, and failing to tidy up is not worth a 500.
  pruneOldArtworks(studentId, categoryKey, conceptKey).catch(() => {});

  return { id: artwork.id, image_url: artwork.image_url };
}

async function pruneOldArtworks(studentId, categoryKey, conceptKey) {
  const rows = await ColoringArtwork.findAll({
    where: { student_id: studentId, category_key: categoryKey, concept_key: conceptKey },
    order: [['created_at', 'DESC'], ['id', 'DESC']],
  });

  const stale = rows.slice(KEEP_PER_CONCEPT);
  for (const row of stale) {
    await deleteBlob(extractBlobPath(row.image_url));
    await row.destroy();
  }
}

/**
 * A student's saved artwork, newest first. Optionally narrowed to one category.
 */
async function listArtworks(studentId, categoryKey) {
  const where = { student_id: studentId };
  if (categoryKey) where.category_key = categoryKey;

  const rows = await ColoringArtwork.findAll({
    where,
    order: [['created_at', 'DESC'], ['id', 'DESC']],
    limit: 100,
  });

  return rows.map((r) => ({
    id:            r.id,
    category_key:  r.category_key,
    concept_key:   r.concept_key,
    image_url:     r.image_url,
    stroke_count:  r.stroke_count,
    time_spent_ms: r.time_spent_ms,
    created_at:    r.created_at,
  }));
}

module.exports = { saveArtwork, listArtworks };
