const { verifyToken } = require('../services/token.service');
const User = require('../models/User');

// Rejects the request unless it carries a valid bearer token.
async function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');

  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({ error: 'Missing bearer token' });
  }

  let payload;
  try {
    payload = verifyToken(token);
  } catch (err) {
    const expired = err.name === 'TokenExpiredError';
    return res.status(401).json({ error: expired ? 'Token expired' : 'Invalid token' });
  }

  const user = await User.findById(payload.sub);
  if (!user) return res.status(401).json({ error: 'User no longer exists' });
  if (user.status !== 'active') return res.status(403).json({ error: 'Account suspended' });
  if (user.tokenVersion !== payload.tv) {
    return res.status(401).json({ error: 'Token revoked. Sign in again' });
  }

  req.user = user;
  next();
}

/**
 * Attaches `req.user` when a valid token is present, and does nothing when it
 * is not. Never rejects.
 *
 * For endpoints that are public but render differently once signed in — the
 * site sheet needs to know whether *this* resident already pressed "Affects me
 * too", and a signed-out visitor must still be able to read the page.
 */
async function optionalAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) return next();

  try {
    const payload = verifyToken(token);
    const user = await User.findById(payload.sub);
    if (user && user.status === 'active' && user.tokenVersion === payload.tv) {
      req.user = user;
    }
  } catch {
    // An expired or junk token on a public route is just an anonymous visit.
  }
  next();
}

module.exports = { requireAuth, optionalAuth };
