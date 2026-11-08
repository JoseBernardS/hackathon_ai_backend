const mongoose = require('mongoose');

/**
 * A ticket we filed with an outside agency, and everything we know about it
 * from that agency's own record.
 *
 * Deliberately separate from Report and Site: a report is what a resident told
 * us, a ticket is what the county says. Keeping them apart is what makes the
 * timeline trustworthy — we never overwrite one with the other.
 */
const externalTicketSchema = new mongoose.Schema(
  {
    source: { type: String, enum: ['mdc311'], default: 'mdc311', index: true },

    /**
     * 'submitted' — we filed it through the API.
     * 'imported'  — it already existed at the county and we adopted it for
     *               tracking, which is what the 311 bulk export rows are.
     * Both are tracked identically; the distinction matters for provenance
     * and because only a submitted ticket has a requestPayload.
     */
    origin: { type: String, enum: ['submitted', 'imported'], default: 'submitted', index: true },

    // The county's own case number, e.g. "26-00375271". Unique per source.
    externalId: { type: String, index: true, sparse: true },

    // True when the case number came from MDC311_DRY_RUN rather than the
    // county. Rides out to the API response so a simulated case is never
    // shown as a real one, and keeps the status sweep from asking Miami-Dade
    // about a number it never issued.
    simulated: { type: Boolean, default: false, index: true },

    reportId: { type: mongoose.Schema.Types.ObjectId, ref: 'Report', index: true },
    siteId: { type: mongoose.Schema.Types.ObjectId, ref: 'Site', index: true },
    submittedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },

    serviceCode: { type: String, index: true }, // PWROADWY
    serviceName: { type: String },

    /**
     * Written BEFORE the POST and used to detect a submit whose response was
     * lost. Without it a retry files a second ticket for the same pothole.
     */
    // Only set on a submitted ticket; sparse so many imported rows can omit it.
    submissionKey: { type: String, unique: true, sparse: true, index: true },

    status: {
      type: String,
      enum: ['pending', 'dry_run', 'failed', 'imported', 'reported', 'acknowledged', 'in_progress', 'fixed', 'closed_unresolved'],
      default: 'pending',
      index: true,
    },

    // The payload we sent, kept verbatim so a failure is reproducible.
    requestPayload: { type: mongoose.Schema.Types.Mixed },
    lastError: { type: String },

    // --- the county's own timestamps, never ours ---
    openedAt: { type: Date },      // requested_datetime
    expectedAt: { type: Date },    // expected_datetime (their SLA target)
    closedAt: { type: Date },      // closed_datetime
    canceledAt: { type: Date },
    ownerName: { type: String },
    serviceNotice: { type: String },
    closureReason: { type: String },   // the deciding activity's outcome name
    lastUpdatedAt: { type: Date },     // for "updated 2 days ago"
    slaTarget: { type: String },       // e.g. "90 Business Days"

    // Photos the original reporter attached at the county. Salesforce URLs, not
    // ours — stored for display, never re-hosted.
    countyPhotos: [{ url: String, mimeType: String, createdAt: Date }],

    // activities[] as returned, trimmed of the fields we must not store
    activities: [
      {
        code: String,
        name: String,
        status: String,
        order: Number,
        completionDate: Date,
        externalComments: String,
        outcome: String,
        outcomeAction: String,
      },
    ],

    // events[] as returned
    events: [{ at: Date, description: String }],

    lastCheckedAt: { type: Date, index: true },
    checkCount: { type: Number, default: 0 },
  },
  { timestamps: true }
);

/**
 * One ticket per county case number.
 *
 * Must be PARTIAL, not sparse. A sparse compound index only skips a document
 * when every indexed field is missing, and `source` always has a value — so
 * every row got indexed and the second ticket with externalId null collided
 * with the first. Tickets are written before the county call, and every
 * dry-run ticket keeps externalId null, so that is the normal case rather
 * than an edge one.
 */
externalTicketSchema.index(
  { source: 1, externalId: 1 },
  { unique: true, partialFilterExpression: { externalId: { $type: 'string' } } }
);
// Drives the sweep: open tickets, oldest check first.
externalTicketSchema.index({ status: 1, lastCheckedAt: 1 });

// Optional fields that must still appear, so a client never has to check
// whether a key exists before reading it.
const ALWAYS_PRESENT = [
  'externalId', 'openedAt', 'expectedAt', 'closedAt', 'canceledAt',
  'ownerName', 'serviceNotice', 'closureReason', 'lastError', 'lastCheckedAt',
  'lastUpdatedAt', 'slaTarget',
];

externalTicketSchema.set('toJSON', {
  transform: (_doc, ret) => {
    ret.id = ret._id;
    delete ret._id;
    delete ret.__v;
    for (const k of ALWAYS_PRESENT) if (ret[k] === undefined) ret[k] = null;
    ret.activities = ret.activities || [];
    ret.events = ret.events || [];
    ret.countyPhotos = ret.countyPhotos || [];
    return ret;
  },
});

module.exports = mongoose.model('ExternalTicket', externalTicketSchema);
