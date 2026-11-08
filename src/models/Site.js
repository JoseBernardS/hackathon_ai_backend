const mongoose = require('mongoose');

/**
 * A deduplicated problem location, for any reportable category.
 *
 * Many reports — 311 history plus in-app submissions — collapse into one site,
 * so the map shows one pin per actual problem instead of one per complaint.
 * Sites are built by leader clustering within the category's dedupe radius of
 * the running centroid (see services/dedupe.service.js).
 */
const siteSchema = new mongoose.Schema(
  {
    // Which reportable category this is. Its label and group come from the
    // registry at read time rather than being copied onto every row.
    categoryCode: { type: String, required: true, index: true },
    // The owning agency, and the target it publishes — both drive the UI.
    department: { type: String },

    location: {
      type: { type: String, enum: ['Point'], default: 'Point' },
      coordinates: { type: [Number], required: true }, // [lng, lat] centroid
    },

    // 'open' if any report at this site is still open
    status: { type: String, enum: ['open', 'closed'], required: true, index: true },

    reportCount: { type: Number, default: 1, index: true },

    // "It affects me too" — residents who confirmed the problem without filing
    // a second report. Kept separate from reportCount so the two claims stay
    // honest: one is a photographed report, the other is a tap.
    endorsedBy: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    openCount: { type: Number, default: 0 },
    userReportCount: { type: Number, default: 0 },

    firstReportedAt: { type: Date, required: true, index: true },
    lastReportedAt: { type: Date, required: true },
    oldestOpenAt: { type: Date }, // how long the current problem has been outstanding

    address: { type: String },
    municipality: { type: String, index: true },

    subtypes: [{ type: String }],

    /**
     * The county case numbers behind this pin, newest first. Every 311 report
     * has one, so a site with 28 reports has up to 28 cases. Surfaced here so
     * the map can show "Case 26-00247866" without fetching the detail.
     */
    caseNumbers: [{ type: String }],
    latestCaseNumber: { type: String, index: true },
    sla: { type: String },

    avgDaysToClose: { type: Number }, // across closed reports here
    photoKeys: [{ type: String }],
    thumbKeys: [{ type: String }],
  },
  { timestamps: true }
);

siteSchema.index({ location: '2dsphere' });
siteSchema.index({ categoryCode: 1, status: 1, reportCount: -1 });

// Days the current problem has been outstanding, or null if nothing is open.
siteSchema.virtual('daysOpen').get(function () {
  if (this.status !== 'open' || !this.oldestOpenAt) return null;
  return Math.round((Date.now() - this.oldestOpenAt.getTime()) / 86400000);
});

// Optional fields that must still appear, so a client never has to check
// whether a key exists before reading it.
const ALWAYS_PRESENT = [
  'address', 'municipality', 'sla', 'department',
  'avgDaysToClose', 'oldestOpenAt', 'latestCaseNumber',
];

siteSchema.set('toJSON', {
  virtuals: true,
  transform: (_doc, ret) => {
    ret.id = ret._id;
    delete ret._id;
    delete ret.__v;
    for (const k of ALWAYS_PRESENT) if (ret[k] === undefined) ret[k] = null;
    ret.subtypes = ret.subtypes || [];
    ret.photoKeys = ret.photoKeys || [];
    ret.thumbKeys = ret.thumbKeys || [];
    ret.caseNumbers = ret.caseNumbers || [];
    // Count, never the list — who endorsed is nobody else's business.
    ret.endorsementCount = (ret.endorsedBy || []).length;
    delete ret.endorsedBy;
    ret.totalVoices = (ret.reportCount || 0) + ret.endorsementCount;
    return ret;
  },
});

module.exports = mongoose.model('Site', siteSchema);
