// Thin wrapper over the Infobip 2FA REST API.
// https://www.infobip.com/docs/api/channels/sms/2fa
const BASE_URL = (process.env.INFOBIP_BASE_URL || '').replace(/\/+$/, '');
const API_KEY = process.env.INFOBIP_API_KEY;

const isConfigured = Boolean(BASE_URL && API_KEY);

async function request(method, path, body) {
  if (!isConfigured) throw new Error('Infobip is not configured');

  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      Authorization: `App ${API_KEY}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  const text = await res.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { raw: text };
  }

  if (!res.ok) {
    const detail =
      payload?.requestError?.serviceException?.text ||
      payload?.requestError?.serviceException?.messageId ||
      payload?.raw ||
      res.statusText;
    const err = new Error(`Infobip ${method} ${path} failed (${res.status}): ${detail}`);
    err.status = res.status;
    err.payload = payload;
    throw err;
  }

  return payload;
}

// --- one-time setup ---------------------------------------------------------

const createApplication = (name) =>
  request('POST', '/2fa/2/applications', {
    name,
    enabled: true,
    configuration: {
      pinAttempts: 10,
      allowMultiplePinVerifications: true,
      pinTimeToLive: '15m',
      verifyPinLimit: '1/3s',
      sendPinPerApplicationLimit: '100/1d',
      sendPinPerPhoneNumberLimit: '10/1d',
    },
  });

const createMessageTemplate = (applicationId, text) =>
  request('POST', `/2fa/2/applications/${applicationId}/messages`, {
    pinType: 'NUMERIC',
    pinLength: 6,
    messageText: text,
    language: 'en',
    senderId: process.env.INFOBIP_SENDER_ID || 'ServiceSMS',
  });

const listApplications = () => request('GET', '/2fa/2/applications');

// --- runtime ----------------------------------------------------------------

const sendPin = (applicationId, messageId, to) =>
  request('POST', '/2fa/2/pin?ncNeeded=false', { applicationId, messageId, to });

const verifyPin = (pinId, pin) => request('POST', `/2fa/2/pin/${pinId}/verify`, { pin });

module.exports = {
  isConfigured,
  request,
  createApplication,
  createMessageTemplate,
  listApplications,
  sendPin,
  verifyPin,
};
