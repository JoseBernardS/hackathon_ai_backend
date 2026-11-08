const mongoose = require('mongoose');

/**
 * A proposed report, waiting on the resident.
 *
 * The photo is uploaded once, at draft time, and the key is carried forward so
 * confirming does not re-upload it. A draft is not a report: it never appears
 * on the map, is never deduplicated and is never filed with the county. It
 * exists only so the resident can see what the AI wrote before agreeing to it.
 */
const reportDraftSchema = new mongoose.Schema(
  {
    categoryCode: { type: String, required: true },

    location: {
      type: { type: String, enum: ['Point'], default: 'Point' },
      coordinates: { type: [Number], required: true }, // [lng, lat]
    },
    address: { type: String },

    photoKey: { type: String, required: true },

    // What the model proposed. Kept verbatim, so the final report can be
    // compared against it — see `edited` on the created report.
    ai: {
      available: { type: Boolean, default: false },
      reason: { type: String, default: null }, // why it is unavailable
      model: { type: String, default: null },
      matchesCategory: { type: Boolean, default: null },
      confidence: { type: Number, default: null },
      subType: { type: String, default: null },
      severity: { type: Number, default: null },
      description: { type: String, default: null },
      hazards: [{ type: String }],
      rejectionReason: { type: String, default: null },
    },

    status: { type: String, enum: ['pending', 'used'], default: 'pending', index: true },
    reportedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    reportId: { type: mongoose.Schema.Types.ObjectId, ref: 'Report' },
    usedAt: { type: Date },
  },
  { timestamps: true }
);

// Abandoned drafts delete themselves after a day, along with nothing else —
// the S3 object is left for the nightly sweep rather than deleted from a TTL.
reportDraftSchema.index({ createdAt: 1 }, { expireAfterSeconds: 86400 });

reportDraftSchema.set('toJSON', {
  virtuals: true,
  transform: (_doc, ret) => {
    ret.id = ret._id;
    delete ret._id;
    delete ret.__v;
    return ret;
  },
});

module.exports = mongoose.model('ReportDraft', reportDraftSchema);
