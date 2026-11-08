const express = require('express');
const multer = require('multer');

const ctrl = require('../controllers/site.controller');
const { asyncHandler } = require('../middleware/asyncHandler');
const { requireAuth, optionalAuth } = require('../middleware/auth');
const { resolveCategory } = require('../middleware/category');

// Optional proof photo on a verification.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
});

const router = express.Router();

// The map feed. With lat/lng it is also the duplicate check — ask for a 100m
// radius and read the count.
router.get('/', resolveCategory(), asyncHandler(ctrl.listSites));

// One site: its reports and, when the county has a ticket, its progress.
// "It affects me too" — adds the resident's weight to a problem already on the
// map, instead of filing a second report on it.
router.post('/:id/affects-me', requireAuth, asyncHandler(ctrl.endorseSite));

// "Is it actually fixed?" — the community's answer to the county's claim.
// Optional `photo`, so a "still there" can carry proof.
router.post(
  '/:id/verify',
  requireAuth,
  upload.single('photo'),
  asyncHandler(ctrl.verifySite)
);

// optionalAuth: public to read, but a signed-in resident also gets back
// whether they already pressed "Affects me too".
router.get('/:id', asyncHandler(optionalAuth), asyncHandler(ctrl.getSite));

module.exports = router;
