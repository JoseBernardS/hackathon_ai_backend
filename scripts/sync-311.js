/**
 * Syncs every tracked 311 case against the county's live record and writes the
 * result into MongoDB.
 *
 *   node scripts/sync-311.js            # dry run — shows what changed
 *   node scripts/sync-311.js --apply
 *
 * Uses the public ArcGIS feature service, so it needs no credentials and no
 * Salesforce method names. Case numbers are batched 80 to a request, so the
 * whole set costs a handful of calls.
 *
 * It updates the status of the Report, the ExternalTicket and the Site, and
 * appends a StatusEvent for every change — so a pin that the county has since
 * closed stops claiming to be open.
 *
 * What this cannot give: activities, outcomes, the assigned crew and
 * resident-facing comments. Those live only in the portal's ticket record.
 */
require('dotenv').config();

const mongoose = require('mongoose');

const Report = require('../src/models/Report');
const Site = require('../src/models/Site');
const ExternalTicket = require('../src/models/ExternalTicket');
const StatusEvent = require('../src/models/StatusEvent');
const arcgis = require('../src/services/arcgis311.service');
const { rebuildSite } = require('../src/services/site.service');

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const scopeAll = args.includes('--all');

async function main() {
  await mongoose.connect(process.env.MONGO_URI);

  // Everything we think is still open is worth re-checking; --all re-checks
  // the closed ones too, in case a case was reopened.
  const filter = { categoryCode: 'pothole', sourceId: { $ne: null } };
  if (!scopeAll) filter.status = 'open';

  const reports = await Report.find(filter).select('sourceId status closedAt siteId').lean();
  console.log(`[sync] checking ${reports.length} cases against the county (${arcgis.BATCH} per request)`);

  const live = await arcgis.lookupCases(
    reports.map((r) => r.sourceId),
    { onProgress: (d, t) => process.stdout.write(`\r[sync] queried ${d}/${t}`) }
  );
  console.log(`\n[sync] county returned ${live.size} of ${reports.length}`);

  const changes = [];
  let missing = 0;
  for (const r of reports) {
    const l = live.get(r.sourceId);
    if (!l) { missing += 1; continue; }
    if (l.status !== r.status) {
      changes.push({ report: r, live: l });
    }
  }

  console.log(`[sync] ${changes.length} status changes, ${missing} not found at the county`);

  if (!changes.length) {
    console.log('[sync] nothing to write — our records match the county');
    await mongoose.disconnect();
    return;
  }

  console.log(`\n${'case'.padEnd(14)} ${'ours'.padEnd(8)} -> ${'county'.padEnd(20)} closed      days`);
  for (const c of changes.slice(0, 20)) {
    console.log(
      `${c.report.sourceId.padEnd(14)} ${c.report.status.padEnd(8)} -> ${c.live.countyStatusRaw.padEnd(20)} ` +
      `${(c.live.closedAt ? c.live.closedAt.toISOString().slice(0, 10) : '—').padEnd(11)} ${c.live.daysToClose ?? '—'}`
    );
  }
  if (changes.length > 20) console.log(`... and ${changes.length - 20} more`);

  if (!apply) {
    console.log('\n(dry run — pass --apply to write these)');
    await mongoose.disconnect();
    return;
  }

  const touchedSites = new Set();
  for (const { report, live: l } of changes) {
    await Report.updateOne(
      { _id: report._id },
      { $set: { status: l.status, closedAt: l.closedAt || undefined } }
    );
    if (report.siteId) touchedSites.add(String(report.siteId));

    const ticket = await ExternalTicket.findOne({ source: 'mdc311', externalId: report.sourceId });
    if (ticket) {
      const from = ticket.status;
      ticket.status = l.status === 'closed' ? 'closed_unresolved' : 'reported';
      ticket.closedAt = l.closedAt || undefined;
      ticket.ownerName = ticket.ownerName || l.department || undefined;
      ticket.lastCheckedAt = new Date();
      ticket.checkCount += 1;
      await ticket.save();

      await StatusEvent.create({
        ticketId: ticket._id,
        reportId: report._id,
        siteId: report.siteId,
        from,
        status: ticket.status,
        source: 'mdc311_sync',
        evidence: {
          externalId: report.sourceId,
          countyStatus: l.countyStatusRaw,
          countyTimestamp: l.closedAt || l.lastModified,
          // ArcGIS has no outcome field, so a closure cannot be called a repair.
          because: `county record now reads "${l.countyStatusRaw}" — ArcGIS carries no outcome, so this is not asserted as a repair`,
          via: 'arcgis_feature_service',
        },
      });
    }
  }

  for (const id of touchedSites) await rebuildSite(id);

  console.log(`\n[sync] wrote ${changes.length} changes, rebuilt ${touchedSites.size} sites`);
  console.log(`[sync] sites now: ${await Site.countDocuments({ status: 'open' })} open of ${await Site.countDocuments()}`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('\n[sync] failed:', err.message);
  process.exit(1);
});
