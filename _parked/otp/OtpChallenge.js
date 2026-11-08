const mongoose = require('mongoose');

// A short-lived login challenge for a returning user. Carries the same OTP
// fields as Onboarding so both can share the provider and issue logic.
const otpChallengeSchema = new mongoose.Schema(
  {
    phone: { type: String, required: true, index: true },
    purpose: { type: String, default: 'login' },

    otpRef: { type: String, select: false },
    otpHash: { type: String, select: false },
    otpProvider: String,
    otpExpiresAt: Date,
    otpAttempts: { type: Number, default: 0 },
    otpSentAt: Date,

    consumedAt: Date,
  },
  { timestamps: true }
);

// Challenges clean themselves up an hour after creation.
otpChallengeSchema.index({ createdAt: 1 }, { expireAfterSeconds: 3600 });

module.exports = mongoose.model('OtpChallenge', otpChallengeSchema);
