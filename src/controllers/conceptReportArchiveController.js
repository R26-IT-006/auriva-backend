'use strict';

const { validationResult } = require('express-validator');
const archive = require('../services/conceptReportArchiveService');
const ApiError = require('../utils/ApiError');

async function getPeriods(req, res) {
  const data = await archive.getAvailablePeriods(req.user.id, req.params.id);
  res.json(data);
}

async function listReports(req, res) {
  const data = await archive.listReports(req.user.id, req.params.id);
  res.json(data);
}

async function getReport(req, res) {
  const data = await archive.getReport(req.user.id, req.params.id, req.params.reportId);
  res.json(data);
}

async function createReport(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) throw new ApiError(422, 'Validation failed', errors.array());

  const data = await archive.generateReport(req.user.id, req.params.id, req.body);
  res.status(201).json(data);
}

async function deleteReport(req, res) {
  await archive.deleteReport(req.user.id, req.params.id, req.params.reportId);
  res.status(204).send();
}

module.exports = { getPeriods, listReports, getReport, createReport, deleteReport };
