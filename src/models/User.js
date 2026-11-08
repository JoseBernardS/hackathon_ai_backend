const mongoose = require('mongoose');

const userSchema = new mongoose.Schema(
  {
    // The phone number is the identity. There is no password anywhere.
    phone: { type: String, required: true, unique: true, index: true },
    displayName: { type: String, trim: true },

    // Miami-Dade 311 requires a real first name, last name, email and phone on
    // every submitted ticket. We split displayName for the contact block, and
    // keep email here because 311 sends the case confirmation to it.
    firstName: { type: String, trim: true },
    lastName: { type: String, trim: true },
    email: { type: String, trim: true, lowercase: true },

    status: { type: String, enum: ['active', 'suspended'], default: 'active' },

    onboardingId: { type: mongoose.Schema.Types.ObjectId, ref: 'Onboarding' },
    selfieKey: String,
    idDocumentKey: String,

    verifiedAt: Date,
    lastLoginAt: Date,

    // Bumped to invalidate every token already issued to this user.
    tokenVersion: { type: Number, default: 0 },
  },
  { timestamps: true }
);

userSchema.set('toJSON', {
  transform(doc, ret) {
    delete ret.__v;
    delete ret.tokenVersion;
    return ret;
  },
});

module.exports = mongoose.model('User', userSchema);
