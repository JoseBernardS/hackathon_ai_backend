const mongoose = require('mongoose');

/**
 * A peer-reported observation about whether a pothole is actually fixed.
 *
 * This is the counterweight to the county's own record. A 311 case closing means
 * the agency considers the ticket done, which is not the same as the hole being
 * gone — the seed data is full of sites that closed and were re-reported weeks
 * later. An Outcome is a verified resident saying what they can see.
 */
const outcomeSchema = new mongoose.Schema(
  {
    siteId: { type: mongoose.Schema.Types.ObjectId, ref: 'Site', required: true, index: true },

    // 'still_there' disputes a fix; 'fixed' confirms one.
    kind: { type: String, enum: ['still_there', 'fixed'], required: true },

    observedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
    observedAt: { type: Date, required: true, index: true },

    // 'user' is a real submission; 'seed' is synthetic demo data.
    origin: { type: String, enum: ['user', 'seed'], default: 'user', index: true },

    // Denormalised at write time so "Reported fixed by Maria G." survives even
    // if the user later changes their display name or deletes the account.
    reporterName: { type: String },

    note: { type: String },
    photoKeys: [{ type: String }],
    thumbKeys: [{ type: String }],

    /**
     * What the attached photo could actually be verified against.
     * See services/proof.service.js — grade drives how much this claim counts.
     */
    proof: {
      grade: {
        type: String,
        enum: ['geo_verified', 'time_verified', 'photo_only', 'geo_mismatch', 'duplicate', 'none'],
        default: 'none',
        index: true,
      },
      label: { type: String },
      weight: { type: Number, default: 0.2 },
      sha256: { type: String, index: true, sparse: true },
      bytes: { type: Number },
      hasGps: { type: Boolean },
      hasExifTimestamp: { type: Boolean },
      gpsDistanceMeters: { type: Number },
      gpsMatchesSite: { type: Boolean },
      takenAt: { type: Date },
      ageDays: { type: Number },
      takenAfterCountyClosure: { type: Boolean },
      timestampPlausible: { type: Boolean },
      camera: { type: String },
      isDuplicate: { type: Boolean, default: false },
    },

    // Where the observer actually stood, which may differ from the site centroid.
    location: {
      type: { type: String, enum: ['Point'] },
      coordinates: { type: [Number] },
    },
  },
  { timestamps: true }
);

outcomeSchema.index({ siteId: 1, observedAt: -1 });
outcomeSchema.index({ siteId: 1, observedBy: 1 });

outcomeSchema.set('toJSON', {
  transform: (_doc, ret) => {
    ret.id = ret._id;
    delete ret._id;
    delete ret.__v;
    return ret;
  },
});

module.exports = mongoose.model('Outcome', outcomeSchema);
