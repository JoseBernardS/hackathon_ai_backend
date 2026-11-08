const express = require('express');
const multer = require('multer');

const ctrl = require('../controllers/file.controller');
const { asyncHandler } = require('../middleware/asyncHandler');

// Keep the file in memory, then stream the buffer to S3. 25 MB cap.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

const router = express.Router();

router.post('/', upload.single('file'), asyncHandler(ctrl.uploadFile));
router.get('/', asyncHandler(ctrl.listFiles));
router.get('/:id', asyncHandler(ctrl.getFile));
router.delete('/:id', asyncHandler(ctrl.deleteFile));

module.exports = router;
