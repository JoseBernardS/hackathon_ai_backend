/**
 * The one place a Site gets rebuilt.
 *
 * A site is derived data: its centroid, counts and dates all come from the
 * reports attached to it. Everything that changes those — the seeder, the photo
 * attacher, a new report — calls through here, so the derived fields can never
 * drift from the rows they summarise.
 */
const Report = require('../models/Report');
const Site = require('../models/Site');
const { summarise } = require('./dedupe.service');

const REPORT_FIELDS =
  'categoryCode location status reportedAt closedAt address municipality subType department sla source sourceId photoKeys thumbKeys';

// Builds the full field set for a site from its reports.
function compose(reports) {
  return summarise(reports);
}

/**
 * Recomputes one site in place. Deletes it and returns null if it has no
 * reports left, so pruning can never leave an orphan pin on the map.
 */
async function rebuildSite(siteId) {
  const reports = await Report.find({ siteId }).sort({ reportedAt: 1 }).select(REPORT_FIELDS).lean();

  if (!reports.length) {
    await Site.deleteOne({ _id: siteId });
    return null;
  }

  return Site.findByIdAndUpdate(siteId, { $set: compose(reports) }, { new: true });
}

/** Recomputes every site. Used after a bulk import or photo attach. */
async function rebuildAll({ log } = {}) {
  const ids = await Site.find().distinct('_id');
  let done = 0;
  for (const id of ids) {
    await rebuildSite(id);
    done += 1;
    if (log && done % 10 === 0) log(`  rebuilt ${done}/${ids.length}`);
  }
  return done;
}

module.exports = { compose, rebuildSite, rebuildAll, REPORT_FIELDS };
