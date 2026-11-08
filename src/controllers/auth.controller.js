const User = require('../models/User');
const OtpChallenge = require('../models/OtpChallenge');
const { provider, issueCode } = require('../services/otp');
const { signToken, EXPIRES_IN } = require('../services/token.service');

const E164 = /^\+[1-9]\d{7,14}$/;

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function normalizePhone(raw) {
  const phone = String(raw || '').trim();
  if (!E164.test(phone)) {
    throw httpError(400, 'phone must be in E.164 format, e.g. +13055551234');
  }
  return phone;
}

function authPayload(user) {
  return {
    token: signToken(user),
    tokenType: 'Bearer',
    expiresIn: EXPIRES_IN,
    user: user.toJSON(),
  };
}

// POST /api/auth/otp/request — step 1 of sign-in
async function requestOtp(req, res) {
  const phone = normalizePhone(req.body?.phone);

  const user = await User.findOne({ phone });
  if (!user) {
    throw httpError(404, 'No account for this number. Complete onboarding first');
  }
  if (user.status !== 'active') throw httpError(403, 'Account suspended');

  // Reuse a live challenge so the resend cooldown is actually enforced.
  let challenge = await OtpChallenge.findOne({ phone, consumedAt: null })
    .sort({ createdAt: -1 })
    .select('+otpHash +otpRef');

  if (!challenge) challenge = await OtpChallenge.create({ phone });

  const result = await issueCode(challenge, phone);

  res.json({
    challengeId: challenge.id,
    phone,
    expiresAt: challenge.otpExpiresAt,
    ...result,
    next: 'POST /api/auth/otp/verify with { "phone", "code" }',
  });
}

// POST /api/auth/otp/verify — step 2, returns the token
async function verifyOtp(req, res) {
  const phone = normalizePhone(req.body?.phone);
  const code = String(req.body?.code || '').trim();
  if (!code) throw httpError(400, 'code is required');

  const challenge = await OtpChallenge.findOne({ phone, consumedAt: null })
    .sort({ createdAt: -1 })
    .select('+otpHash +otpRef');

  if (!challenge) throw httpError(409, 'No code has been sent for this number');

  const result = await provider.verify(challenge, code);
  if (!result.ok) throw httpError(result.status || 401, result.reason || 'Incorrect code');

  challenge.consumedAt = new Date();
  challenge.otpHash = undefined;
  challenge.otpRef = undefined;
  await challenge.save();

  const user = await User.findOne({ phone });
  if (!user) throw httpError(404, 'No account for this number');

  user.lastLoginAt = new Date();
  await user.save();

  res.json(authPayload(user));
}

// GET /api/auth/me
async function me(req, res) {
  res.json(req.user.toJSON());
}

// POST /api/auth/logout — invalidates every token issued so far
async function logout(req, res) {
  req.user.tokenVersion += 1;
  await req.user.save();
  res.json({ loggedOut: true });
}

module.exports = { requestOtp, verifyOtp, me, logout, authPayload };
