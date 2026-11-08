const express = require('express');

const ctrl = require('../controllers/auth.controller');
const { requireAuth } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/asyncHandler');

const router = express.Router();

router.post('/otp/request', asyncHandler(ctrl.requestOtp));
router.post('/otp/verify', asyncHandler(ctrl.verifyOtp));
router.get('/me', asyncHandler(requireAuth), asyncHandler(ctrl.me));
router.post('/logout', asyncHandler(requireAuth), asyncHandler(ctrl.logout));

module.exports = router;
