const jwt = require('jsonwebtoken');

const SECRET = process.env.JWT_SECRET || 'dev-only-jwt-secret';
const EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';

function signToken(user) {
  return jwt.sign(
    { sub: user.id, phone: user.phone, tv: user.tokenVersion },
    SECRET,
    { expiresIn: EXPIRES_IN }
  );
}

function verifyToken(token) {
  return jwt.verify(token, SECRET);
}

module.exports = { signToken, verifyToken, EXPIRES_IN };
