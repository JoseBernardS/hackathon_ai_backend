const express = require('express');
const multer = require('multer');

const ctrl = require('../controllers/onboarding.controller');
const { asyncHandler } = require('../middleware/asyncHandler');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter(req, file, cb) {
    if (!file.mimetype.startsWith('image/')) {
      return cb(Object.assign(new Error('Only image uploads are allowed'), { status: 400 }));
    }
    cb(null, true);
  },
});

const documents = upload.fields([
  { name: 'selfie', maxCount: 1 },
  { name: 'idDocument', maxCount: 1 },
]);

const router = express.Router();

router.post('/', asyncHandler(ctrl.start));
router.post('/:id/documents', documents, asyncHandler(ctrl.uploadDocuments));
router.post('/:id/phone', asyncHandler(ctrl.submitPhone));
router.get('/:id', asyncHandler(ctrl.getSession));

module.exports = router;
