const express = require('express');
const multer = require('multer');

const ctrl = require('../controllers/site.controller');
const { requireAuth } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/asyncHandler');
const { resolveCategory } = require('../middleware/category');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
});

const router = express.Router();

router.get('/mine', requireAuth, resolveCategory({ required: false }), asyncHandler(ctrl.myReports));

// Step 1: reads the photo and returns a draft for the resident to confirm.
// Nothing is on the map and nothing has reached the county after this call.
router.post(
  '/analyze',
  requireAuth,
  upload.single('photo'),
  resolveCategory(),
  asyncHandler(ctrl.analyzeDraft)
);

// Step 2 (or the direct path, with a photo and no draftId).
// Files the report and, if the county maintains that road, files it with 311
// in the same call. multer first so `category` is parsed from the body.
router.post('/', requireAuth, upload.single('photo'), resolveCategory(), asyncHandler(ctrl.createReport));

module.exports = router;
