const express = require('express');

const ctrl = require('../controllers/category.controller');
const { asyncHandler } = require('../middleware/asyncHandler');

const router = express.Router();

router.get('/', asyncHandler(ctrl.listCategories));
router.get('/:code', asyncHandler(ctrl.getCategory));

module.exports = router;
