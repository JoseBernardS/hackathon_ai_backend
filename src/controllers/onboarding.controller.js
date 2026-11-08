const Onboarding = require('../models/Onboarding');
const uploads = require('../services/upload.service');
const User = require('../models/User');
const { provider, issueCode } = require('../services/otp');
const { authPayload } = require('./auth.controller');

// Accepts +15551234567 style numbers. Kept permissive on purpose.
const E164 = /^\+[1-9]\d{7,14}$/;
const NAME_MAX = 50;

// Optional on every step; validated only when something was sent.
function parseDisplayName(raw) {
  if (raw === undefined || raw === null) return undefined;

  const name = String(raw).trim();
  if (!name) return undefined;
  if (name.length > NAME_MAX) {
    throw httpError(400, `displayName must be ${NAME_MAX} characters or fewer`);
  }
  return name;
}

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

async function loadSession(id, withOtp = false) {
  const query = Onboarding.findById(id);
  if (withOtp) query.select('+otpHash +otpRef');

  const session = await query;
  if (!session) throw httpError(404, 'Onboarding session not found');
  return session;
}

function docMeta(file, stored) {
  return {
    ...stored,
    originalName: file.originalname,
    mimeType: file.mimetype,
    size: file.size,
    uploadedAt: new Date(),
  };
}

// POST /api/onboarding — step 0, open a session
async function start(req, res) {
  const session = await Onboarding.create({ status: 'documents_pending' });
  res.status(201).json({
    sessionId: session._id,
    status: session.status,
    next: 'POST /api/onboarding/:id/documents with fields "selfie" and "idDocument"',
  });
}

// POST /api/onboarding/:id/documents — steps 1 and 2
// Accepts either field alone or both at once, so the client can upload the
// screenshot and the ID in one request or in two.
async function uploadDocuments(req, res) {
  const session = await loadSession(req.params.id);

  if (session.status === 'verified') throw httpError(409, 'Session is already verified');

  const selfieFile = req.files?.selfie?.[0];
  const idFile = req.files?.idDocument?.[0];

  if (!selfieFile && !idFile) {
    throw httpError(400, 'Send at least one file in the "selfie" or "idDocument" field');
  }

  if (selfieFile) {
    const stored = await uploads.putObject(selfieFile, `onboarding/${session.id}/selfie`);
    session.selfie = docMeta(selfieFile, stored);
  }

  if (idFile) {
    const stored = await uploads.putObject(idFile, `onboarding/${session.id}/id`);
    session.idDocument = docMeta(idFile, stored);
  }

  session.status = session.hasAllDocuments() ? 'documents_uploaded' : 'documents_pending';
  await session.save();

  res.json({
    sessionId: session.id,
    status: session.status,
    selfieUploaded: Boolean(session.selfie?.key),
    idDocumentUploaded: Boolean(session.idDocument?.key),
    next: session.hasAllDocuments()
      ? 'POST /api/onboarding/:id/phone with { "phone": "+1..." }'
      : 'Upload the remaining document',
  });
}

// POST /api/onboarding/:id/phone — step 3, store the number and send the code
async function submitPhone(req, res) {
  const session = await loadSession(req.params.id, true);

  const phone = String(req.body?.phone || '').trim();
  if (!E164.test(phone)) {
    throw httpError(400, 'phone must be in E.164 format, e.g. +13055551234');
  }

  if (!session.hasAllDocuments()) {
    throw httpError(409, 'Upload both the selfie and the ID document first');
  }

  if (session.status === 'verified') throw httpError(409, 'Session is already verified');

  const displayName = parseDisplayName(req.body?.displayName);
  if (displayName) session.displayName = displayName;

  session.phone = phone;
  const result = await issueCode(session, session.phone);
  session.status = 'otp_sent';
  await session.save();

  res.json({
    sessionId: session.id,
    status: session.status,
    phone: session.phone,
    displayName: session.displayName,
    expiresAt: session.otpExpiresAt,
    ...result,
    next: 'POST /api/onboarding/:id/verify with { "code": "123456" }',
  });
}

// POST /api/onboarding/:id/resend
async function resendCode(req, res) {
  const session = await loadSession(req.params.id, true);

  if (!session.phone) throw httpError(409, 'No phone number on this session yet');
  if (session.status === 'verified') throw httpError(409, 'Session is already verified');

  const result = await issueCode(session, session.phone);
  session.status = 'otp_sent';
  await session.save();

  res.json({
    sessionId: session.id,
    status: session.status,
    expiresAt: session.otpExpiresAt,
    ...result,
  });
}

// POST /api/onboarding/:id/verify — step 4
async function verifyCode(req, res) {
  const session = await loadSession(req.params.id, true);

  const code = String(req.body?.code || '').trim();
  if (!code) throw httpError(400, 'code is required');

  const displayName = parseDisplayName(req.body?.displayName);
  if (displayName) session.displayName = displayName;

  if (session.status === 'verified') {
    throw httpError(409, 'Already verified. Sign in with POST /api/auth/otp/request');
  }

  const result = await provider.verify(session, code);

  if (!result.ok) {
    throw httpError(result.status || 401, result.reason || 'Incorrect code');
  }

  session.status = 'verified';
  session.verifiedAt = new Date();
  session.otpHash = undefined;
  session.otpRef = undefined;
  session.otpExpiresAt = undefined;
  session.otpAttempts = 0;
  await session.save();

  // Onboarding doubles as sign-up: the verified number becomes the account,
  // and the caller is signed in straight away.
  const user = await User.findOneAndUpdate(
    { phone: session.phone },
    {
      $set: {
        onboardingId: session.id,
        ...(session.displayName ? { displayName: session.displayName } : {}),
        selfieKey: session.selfie?.key,
        idDocumentKey: session.idDocument?.key,
        verifiedAt: session.verifiedAt,
        lastLoginAt: new Date(),
      },
      $setOnInsert: { phone: session.phone },
    },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );

  res.json({
    sessionId: session.id,
    status: session.status,
    verifiedAt: session.verifiedAt,
    ...authPayload(user),
  });
}

// GET /api/onboarding/:id — status plus short-lived links to the documents
async function getSession(req, res) {
  const session = await loadSession(req.params.id);
  const body = session.toJSON();

  if (session.selfie?.key) body.selfie.downloadUrl = await uploads.presign(session.selfie.key);
  if (session.idDocument?.key) {
    body.idDocument.downloadUrl = await uploads.presign(session.idDocument.key);
  }

  res.json(body);
}

module.exports = { start, uploadDocuments, submitPhone, resendCode, verifyCode, getSession };
