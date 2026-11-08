// Fallback used when Infobip is not configured: the code is generated here,
// stored as an HMAC, logged to the console and returned to the caller as
// devCode so the flow stays testable without credentials.
const crypto = require('crypto');

const CODE_LENGTH = 6;
const TTL_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 5;

const SECRET = process.env.OTP_SECRET || 'dev-only-otp-secret';

function generateCode() {
  return String(crypto.randomInt(0, 10 ** CODE_LENGTH)).padStart(CODE_LENGTH, '0');
}

function hashCode(code, salt) {
  return crypto.createHmac('sha256', SECRET).update(`${salt}:${code}`).digest('hex');
}

async function send(phone, session) {
  const code = generateCode();
  console.log(`[otp:simulated] to=${phone} code=${code}`);

  return {
    ref: null,
    hash: hashCode(code, session.id),
    expiresAt: new Date(Date.now() + TTL_MS),
    devCode: code,
  };
}

async function verify(session, code) {
  if (!session.otpHash || !session.otpExpiresAt) {
    return { ok: false, reason: 'No code has been sent for this session' };
  }

  if (session.otpExpiresAt.getTime() < Date.now()) {
    return { ok: false, reason: 'Code expired. Request a new one', status: 410 };
  }

  if (session.otpAttempts >= MAX_ATTEMPTS) {
    return { ok: false, reason: 'Too many attempts. Request a new code', status: 429 };
  }

  const actual = Buffer.from(hashCode(code, session.id));
  const expected = Buffer.from(session.otpHash);
  const match = actual.length === expected.length && crypto.timingSafeEqual(actual, expected);

  if (!match) {
    session.otpAttempts += 1;
    await session.save();
    const left = Math.max(0, MAX_ATTEMPTS - session.otpAttempts);
    return { ok: false, reason: `Incorrect code, ${left} attempt(s) remaining` };
  }

  return { ok: true };
}

module.exports = { name: 'local', isConfigured: true, send, verify, TTL_MS, MAX_ATTEMPTS };
