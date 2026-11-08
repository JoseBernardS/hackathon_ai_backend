const mongoose = require('mongoose');

/**
 * Append-only log of status changes. Never updated, never deleted.
 *
 * Two sync paths write here — the on-demand lookup and the nightly bulk sweep —
 * and they can disagree. Recording which one produced each change, with the
 * county timestamp that justified it, is what makes a wrong status debuggable
 * instead of a mystery.
 */
const statusEventSchema = new mongoose.Schema(
  {
    ticketId: { type: mongoose.Schema.Types.ObjectId, ref: 'ExternalTicket', required: true, index: true },
    reportId: { type: mongoose.Schema.Types.ObjectId, ref: 'Report', index: true },
    siteId: { type: mongoose.Schema.Types.ObjectId, ref: 'Site', index: true },

    from: { type: String },
    status: { type: String, required: true },

    source: {
      type: String,
      enum: ['mdc311_submit', 'mdc311_lookup', 'mdc311_sync'],
      required: true,
    },

    // What in the county's record justified this change.
    evidence: { type: mongoose.Schema.Types.Mixed },

    at: { type: Date, default: Date.now, index: true },
  },
  { timestamps: false }
);

statusEventSchema.index({ ticketId: 1, at: 1 });

statusEventSchema.set('toJSON', {
  transform: (_doc, ret) => {
    ret.id = ret._id;
    delete ret._id;
    delete ret.__v;
    return ret;
  },
});

module.exports = mongoose.model('StatusEvent', statusEventSchema);
