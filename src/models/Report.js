const mongoose = require('mongoose');

const reportSchema = new mongoose.Schema(
  {
    // provenance: '311' for seeded historical data, 'user' for in-app reports
    source: { type: String, enum: ['311', 'user'], required: true, index: true },
    sourceId: { type: String, index: true, sparse: true }, // 311 Service_Request_Number

    categoryCode: { type: String, required: true, index: true },
    subType: { type: String },

    description: { type: String },
    photoKeys: [{ type: String }],
    thumbKeys: [{ type: String }], // small versions for map pins; may be empty

    status: { type: String, enum: ['open', 'closed'], required: true, index: true },

    department: { type: String },
    sla: { type: String },

    address: { type: String },
    municipality: { type: String, index: true },
    location: {
      type: { type: String, enum: ['Point'], default: 'Point' },
      coordinates: { type: [Number], required: true }, // [lng, lat]
    },

    // set by the dedupe pass — the canonical location this report belongs to
    siteId: { type: mongoose.Schema.Types.ObjectId, ref: 'Site', index: true },

    reportedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    reportedAt: { type: Date, required: true, index: true },
    closedAt: { type: Date },
  },
  { timestamps: true }
);

reportSchema.index({ location: '2dsphere' });
reportSchema.index({ categoryCode: 1, reportedAt: -1 });

reportSchema.set('toJSON', {
  virtuals: true,
  transform: (_doc, ret) => {
    ret.id = ret._id;
    delete ret._id;
    delete ret.__v;
    return ret;
  },
});

module.exports = mongoose.model('Report', reportSchema);
