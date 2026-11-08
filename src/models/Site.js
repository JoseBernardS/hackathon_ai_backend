const mongoose = require('mongoose');

/**
 * What the neighbourhood collectively says.
 *
 * `disputed` is a real answer, not a failure to decide — if two residents say
 * it is fixed and two say it is not, showing "fixed" would be a lie and showing
 * nothing would waste what they told us.
 */
function verdictOf(list = []) {
  const yes = list.filter((v) => v.fixed).length;
  const no = list.length - yes;
  if (!list.length) return null;
  if (yes > no) return 'fixed';
  if (no > yes) return 'not_fixed';
  return 'disputed';
}

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

    /**
     * Community verification of a fix.
     *
     * The county closing a case means the agency considers the ticket done,
     * which is not the same as the hole being gone: 25.1% of closed pothole
     * cases in the 2026 export were re-reported at the same spot, 99 of them
     * within a week. Residents are the only ones who can say which.
     *
     * One entry per resident, replaced if they change their mind.
     */
    verifications: [
      {
        user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
        fixed: { type: Boolean, required: true },
        at: { type: Date, required: true },
        // Denormalised so "Confirmed fixed by Maria G." survives a rename.
        name: { type: String },
        note: { type: String },
        photoKey: { type: String },
        // Demo data, not a real resident. Set only by scripts/seed-verifications.js
        // so it can be told apart and removed without touching real answers.
        seeded: { type: Boolean, default: false },
      },
    ],
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
    // Counts and a verdict, never the raw list — who voted stays private.
    const v = ret.verifications || [];
    ret.verification = {
      fixedCount: v.filter((x) => x.fixed).length,
      notFixedCount: v.filter((x) => !x.fixed).length,
      verdict: verdictOf(v),
    };
    delete ret.verifications;
    return ret;
  },
});

module.exports = mongoose.model('Site', siteSchema);
