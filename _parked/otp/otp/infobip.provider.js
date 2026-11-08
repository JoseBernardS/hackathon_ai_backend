// Infobip owns the PIN: it generates, delivers, expires and verifies it.
// All we persist is the pinId it hands back.
const infobip = require('../infobip.client');

const TTL_MS = 15 * 60 * 1000; // mirrors pinTimeToLive on the 2FA application

const APPLICATION_ID = process.env.INFOBIP_APPLICATION_ID;
const MESSAGE_ID = process.env.INFOBIP_MESSAGE_ID;

const isConfigured = Boolean(infobip.isConfigured && APPLICATION_ID && MESSAGE_ID);

async function send(phone) {
  // Infobip expects the number without a leading "+".
  const to = phone.replace(/^\+/, '');
  const res = await infobip.sendPin(APPLICATION_ID, MESSAGE_ID, to);

  return {
    ref: res.pinId,
    expiresAt: new Date(Date.now() + TTL_MS),
    meta: { smsStatus: res.smsStatus },
  };
}

async function verify(session, code) {
  if (!session.otpRef) return { ok: false, reason: 'No code has been sent for this session' };

  try {
    const res = await infobip.verifyPin(session.otpRef, code);

    if (res.verified) return { ok: true };

    const left = res.attemptsRemaining;
    return {
      ok: false,
      reason:
        typeof left === 'number'
          ? `Incorrect code, ${left} attempt(s) remaining`
          : 'Incorrect code',
    };
  } catch (err) {
    // Infobip returns 4xx for expired / exhausted PINs.
    return { ok: false, reason: err.message, status: err.status };
  }
}

module.exports = { name: 'infobip', isConfigured, send, verify, TTL_MS };
