'use strict';

const path = require('path');

const CONTAINER = process.env.AZURE_BLOB_CONTAINER;
const ACCOUNT   = process.env.AZURE_STORAGE_ACCOUNT_NAME;
let blobServiceClient;

function getBlobServiceClient() {
  if (!blobServiceClient) {
    blobServiceClient = require('../config/azureBlob');
  }

  return blobServiceClient;
}

/**
 * Upload a buffer to Azure Blob Storage.
 * @param {Buffer} buffer    - File buffer from multer memoryStorage
 * @param {string} blobPath  - e.g. 'teachers/TCH-0001/profile.jpg'
 * @param {string} mimeType  - e.g. 'image/jpeg'
 * @returns {Promise<string>} Public URL of the uploaded blob
 */
async function uploadBuffer(buffer, blobPath, mimeType) {
  const containerClient = getBlobServiceClient().getContainerClient(CONTAINER);
  const blockBlobClient = containerClient.getBlockBlobClient(blobPath);

  await blockBlobClient.uploadData(buffer, {
    blobHTTPHeaders: { blobContentType: mimeType },
  });

  return `https://${ACCOUNT}.blob.core.windows.net/${CONTAINER}/${blobPath}`;
}

/**
 * Delete a blob by its path.
 * @param {string} blobPath - e.g. 'teachers/TCH-0001/profile.jpg'
 */
async function deleteBlob(blobPath) {
  if (!blobPath) return;
  const containerClient = getBlobServiceClient().getContainerClient(CONTAINER);
  const blockBlobClient = containerClient.getBlockBlobClient(blobPath);
  await blockBlobClient.deleteIfExists();
}

/**
 * Extract the blob path from a full Azure Blob Storage URL.
 * e.g. 'https://auriva.blob.core.windows.net/auriva/teachers/TCH-0001/profile.jpg'
 *      → 'teachers/TCH-0001/profile.jpg'
 * @param {string} url
 * @returns {string|null}
 */
function extractBlobPath(url) {
  if (!url) return null;
  const marker = `/${CONTAINER}/`;
  const idx = url.indexOf(marker);
  return idx !== -1 ? url.slice(idx + marker.length) : null;
}

/**
 * Derive a blob path from an entity code and original file name.
 * @param {'teachers'|'students'} entity
 * @param {string} code   - e.g. 'TCH-0001'
 * @param {string} originalname - original filename from multer
 * @returns {string}
 */
function buildBlobPath(entity, code, originalname) {
  const ext = path.extname(originalname).toLowerCase() || '.jpg';
  return `${entity}/${code}/profile${ext}`;
}

module.exports = { uploadBuffer, deleteBlob, extractBlobPath, buildBlobPath };
