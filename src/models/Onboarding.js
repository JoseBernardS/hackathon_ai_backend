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
      enum: ['documents_pending', 'documents_uploaded', 'verified'],
      default: 'started',
      index: true,
    },

    selfie: documentSchema,
    idDocument: documentSchema,

    phone: { type: String, index: true },
    displayName: { type: String, trim: true },


    verifiedAt: Date,
  },
  { timestamps: true }
);

onboardingSchema.methods.hasAllDocuments = function hasAllDocuments() {
  return Boolean(this.selfie?.key && this.idDocument?.key);
};

// Keeps internals out of every API response.
onboardingSchema.set('toJSON', {
  transform(doc, ret) {
    delete ret.__v;
    return ret;
  },
});

module.exports = mongoose.model('Onboarding', onboardingSchema);
