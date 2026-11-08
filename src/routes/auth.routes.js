const express = require('express');

const ctrl = require('../controllers/auth.controller');
const { requireAuth } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/asyncHandler');

const router = express.Router();

router.post('/login', asyncHandler(ctrl.login));
router.get('/me', asyncHandler(requireAuth), asyncHandler(ctrl.me));
router.post('/logout', asyncHandler(requireAuth), asyncHandler(ctrl.logout));

module.exports = router;
