const mongoose = require('mongoose');

/**
 * Cached form schema and workflow for one 311 service code.
 *
 * Fetched once per service and stored raw, because it is the source of two
 * things we cannot invent: which attribute keys a submission must carry, and
 * the ordered list of workflow stages a ticket passes through. The stage list
 * is what lets the UI show "step 2 of 5" instead of a status word with no
 * context.
 */
const serviceDefinitionSchema = new mongoose.Schema(
  {
    source: { type: String, default: 'mdc311', index: true },
    serviceCode: { type: String, required: true, index: true },
    serviceName: { type: String },
    language: { type: String, default: 'EN' },

    departments: [{ code: String, name: String }],
    categories: [{ code: String, name: String }],

    serviceLevelAgreement: { type: String },
    requiredReporterFields: [{ type: String }],

    // The whole payload, so a schema change is diffable rather than guesswork.
    raw: { type: mongoose.Schema.Types.Mixed },

    /**
     * Derived progress ladder: Submitted -> one row per activity -> Closed.
     * `index` is the position, which is what a progress bar reads.
     */
    stages: [
      {
        index: Number,
        code: String,
        name: String,
        kind: { type: String, enum: ['submitted', 'activity', 'closed'] },
      },
    ],

    fetchedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

serviceDefinitionSchema.index({ source: 1, serviceCode: 1, language: 1 }, { unique: true });

module.exports = mongoose.model('ServiceDefinition', serviceDefinitionSchema);
