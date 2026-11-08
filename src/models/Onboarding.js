const mongoose = require('mongoose');

const documentSchema = new mongoose.Schema(
  {
    key: String,
    bucket: String,
    url: String,
    originalName: String,
    mimeType: String,
    size: Number,
    uploadedAt: Date,
  },
  { _id: false }
);

const onboardingSchema = new mongoose.Schema(
  {
    status: {
      type: String,
      enum: ['started', 'documents_pending', 'documents_uploaded', 'otp_sent', 'verified'],
      default: 'started',
      index: true,
    },

    selfie: documentSchema,
    idDocument: documentSchema,

    phone: { type: String, index: true },
    displayName: { type: String, trim: true },

    // OTP state. With Infobip only the pinId is kept; the local fallback
    // stores an HMAC of the code. Neither stores the code itself.
    otpRef: { type: String, select: false },
    otpHash: { type: String, select: false },
    otpProvider: String,
    otpExpiresAt: Date,
    otpAttempts: { type: Number, default: 0 },
    otpSentAt: Date,

    verifiedAt: Date,
  },
  { timestamps: true }
);

onboardingSchema.methods.hasAllDocuments = function hasAllDocuments() {
  return Boolean(this.selfie?.key && this.idDocument?.key);
};

// Keeps OTP internals out of every API response.
onboardingSchema.set('toJSON', {
  transform(doc, ret) {
    delete ret.otpHash;
    delete ret.otpRef;
    delete ret.__v;
    return ret;
  },
});

module.exports = mongoose.model('Onboarding', onboardingSchema);
