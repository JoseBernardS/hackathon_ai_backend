const express = require('express');

const ctrl = require('../controllers/site.controller');
const { asyncHandler } = require('../middleware/asyncHandler');
const { resolveCategory } = require('../middleware/category');

const router = express.Router();

// The map feed. With lat/lng it is also the duplicate check — ask for a 100m
// radius and read the count.
router.get('/', resolveCategory(), asyncHandler(ctrl.listSites));

// One site: its reports and, when the county has a ticket, its progress.
router.get('/:id', asyncHandler(ctrl.getSite));

module.exports = router;
