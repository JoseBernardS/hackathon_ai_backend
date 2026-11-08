const infobip = require('./infobip.provider');
const local = require('./local.provider');

// OTP_PROVIDER=local forces the console-logging fallback even when Infobip is
// configured, so development does not burn real SMS.
const forced = (process.env.OTP_PROVIDER || '').toLowerCase();

const provider = forced === 'local' ? local : infobip.isConfigured ? infobip : local;

console.log(
  `[otp] provider: ${provider.name}${forced === 'local' && infobip.isConfigured ? ' (forced)' : ''}`
);

const RESEND_COOLDOWN_MS = 60 * 1000;

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

// Sends a code for any document carrying the shared OTP fields
// (an Onboarding session or an OtpChallenge) and persists the result.
async function issueCode(holder, phone) {
  const now = Date.now();

  if (holder.otpSentAt && now - holder.otpSentAt.getTime() < RESEND_COOLDOWN_MS) {
    const wait = Math.ceil((RESEND_COOLDOWN_MS - (now - holder.otpSentAt.getTime())) / 1000);
    throw httpError(429, `Wait ${wait}s before requesting another code`);
  }

  const sent = await provider.send(phone, holder);

  holder.otpRef = sent.ref;
  holder.otpHash = sent.hash;
  holder.otpExpiresAt = sent.expiresAt;
  holder.otpProvider = provider.name;
  holder.otpAttempts = 0;
  holder.otpSentAt = new Date(now);
  await holder.save();

  return sent.devCode
    ? { provider: provider.name, smsSimulated: true, devCode: sent.devCode }
    : { provider: provider.name, smsSimulated: false };
}

module.exports = { provider, issueCode, RESEND_COOLDOWN_MS };
