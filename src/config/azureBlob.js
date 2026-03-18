'use strict';

const { BlobServiceClient, StorageSharedKeyCredential } = require('@azure/storage-blob');

const sharedKeyCredential = new StorageSharedKeyCredential(
  process.env.AZURE_STORAGE_ACCOUNT_NAME,
  process.env.AZURE_STORAGE_ACCOUNT_KEY
);

const blobServiceClient = new BlobServiceClient(
  `https://${process.env.AZURE_STORAGE_ACCOUNT_NAME}.blob.core.windows.net`,
  sharedKeyCredential
);

module.exports = blobServiceClient;
