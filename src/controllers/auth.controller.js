const User = require('../models/User');
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
    throw httpError(400, 'phone must be E.164, e.g. +13055551234');
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

// POST /api/auth/login   { phone }
// Returning users sign in with the number they signed up with.
async function login(req, res) {
  const phone = normalizePhone(req.body.phone);

  const user = await User.findOne({ phone });
  if (!user) {
    throw httpError(404, 'No account for that number — sign up first');
  }
  if (user.status !== 'active') {
    throw httpError(403, `Account is ${user.status}`);
  }

  user.lastLoginAt = new Date();
  await user.save();

  res.json(authPayload(user));
}

// GET /api/auth/me
async function me(req, res) {
  res.json(req.user.toJSON());
}

// POST /api/auth/logout
// Bumps tokenVersion, which invalidates every token issued so far.
async function logout(req, res) {
  req.user.tokenVersion += 1;
  await req.user.save();
  res.json({ loggedOut: true });
}

module.exports = { login, me, logout, authPayload, normalizePhone };
