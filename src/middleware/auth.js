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

module.exports = { requireAuth };
