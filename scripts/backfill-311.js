/**
 * Backfills the seeded 311 reports in MongoDB with the county's live record.
 *
 *   node scripts/backfill-311.js                      # dry run, prints the plan
 *   node scripts/backfill-311.js --apply              # adopt + look up + write
 *   node scripts/backfill-311.js --scope open --apply
 *   node scripts/backfill-311.js --apply --resume     # skip what is already fresh
 *
 * The seeded rows came from the 2026 bulk export, which carries only a status
 * and a closed date. Each one does have a real county case number, so it can be
 * adopted as a tracked ticket and enriched with the county's own activities,
 * outcomes and SLA target — which is what turns "closed after 0 days" into
 * "closed — unfounded" with a reason.
 *
 * Scopes, cheapest first:
 *   newest-open  one lookup per site, the newest still-open report   (default)
 *   open         every still-open report
 *   all          every report, including long-closed history
 *
 * Rate limited to --rate requests/second (default 1, the spec's ceiling).
 * Adoption is separated from lookup so a run interrupted halfway can resume.
 */
require('dotenv').config();

const mongoose = require('mongoose');

const Report = require('../src/models/Report');
const Site = require('../src/models/Site');
const ExternalTicket = require('../src/models/ExternalTicket');
const mdc311 = require('../src/services/mdc311.service');
const client = require('../src/services/mdc311.client');

const args = process.argv.slice(2);
const flag = (n) => {
  const i = args.indexOf(`--${n}`);
  return i === -1 ? undefined : args[i + 1];
};
const SCOPE = flag('scope') || 'newest-open';
const RATE = Number(flag('rate')) || 1;
const LIMIT = Number(flag('limit')) || Infinity;
const apply = args.includes('--apply');
const resume = args.includes('--resume');

const SCOPES = ['newest-open', 'open', 'all'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function selectReports() {
  if (SCOPE === 'all') {
    return Report.find({ categoryCode: 'pothole', sourceId: { $ne: null } })
      .sort({ reportedAt: -1 })
      .lean();
  }
  if (SCOPE === 'open') {
    return Report.find({ categoryCode: 'pothole', status: 'open', sourceId: { $ne: null } })
      .sort({ reportedAt: -1 })
      .lean();
  }
  // newest-open: the one report per site whose live status can change a pin
  const rows = await Report.aggregate([
    { $match: { categoryCode: 'pothole', status: 'open', sourceId: { $ne: null } } },
    { $sort: { reportedAt: -1 } },
    { $group: { _id: '$siteId', doc: { $first: '$$ROOT' } } },
    { $replaceRoot: { newRoot: '$doc' } },
    { $sort: { reportedAt: -1 } },
  ]);
  return rows;
}

async function main() {
  if (!SCOPES.includes(SCOPE)) {
    console.error(`--scope must be one of: ${SCOPES.join(', ')}`);
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGO_URI);

  const reports = (await selectReports()).slice(0, LIMIT === Infinity ? undefined : LIMIT);
  const sites = await Site.countDocuments();

  console.log(`[backfill] scope=${SCOPE}  candidates=${reports.length}  sites=${sites}`);
  console.log(`[backfill] rate=${RATE}/s  ~${Math.ceil(reports.length / RATE / 60)} min of lookups`);

  const lookupReady = Boolean(client.METHODS.getRequest);
  if (!lookupReady) {
    console.log(`[backfill] NOTE: MDC311_METHOD_GET_REQUEST is not set, so no lookups can run.`);
    console.log(`[backfill]       --apply will still adopt the cases as tracked tickets, which is`);
    console.log(`[backfill]       the half that needs no network. Re-run once the name is known.`);
  }

  if (!apply) {
    console.log(`\n${'case'.padEnd(14)} ${'status'.padEnd(8)} ${'reported'.padEnd(11)} site`);
    for (const r of reports.slice(0, 15)) {
      console.log(`${r.sourceId.padEnd(14)} ${r.status.padEnd(8)} ${r.reportedAt.toISOString().slice(0, 10)}  ${r.address || ''}`);
    }
    if (reports.length > 15) console.log(`... and ${reports.length - 15} more`);
    console.log('\n(dry run — pass --apply)');
    await mongoose.disconnect();
    return;
  }

  // --- phase 1: adopt (no network, resumable) ---
  let adopted = 0;
  let already = 0;
  let noCase = 0;
  const tickets = [];
  for (const r of reports) {
    const out = await mdc311.adoptReport(r);
    if (out.skipped) { noCase += 1; continue; }
    if (out.alreadyTracked) already += 1;
    if (out.adopted) adopted += 1;
    tickets.push(out.ticket);
  }
  console.log(`[backfill] adopted ${adopted} new tickets, ${already} already tracked, ${noCase} without a case number`);

  if (!lookupReady) {
    console.log(`[backfill] stopping before lookups — ${tickets.length} tickets are now tracked and ready.`);
    await mongoose.disconnect();
    return;
  }

  // --- phase 2: look up, one at a time, rate limited ---
  const interval = Math.ceil(1000 / RATE);
  let enriched = 0;
  let changed = 0;
  let empty = 0;
  let failed = 0;
  const skipFresh = resume ? Date.now() - mdc311.LOOKUP_CACHE_MS : null;

  for (const [i, t] of tickets.entries()) {
    if (skipFresh && t.lastCheckedAt && t.lastCheckedAt.getTime() > skipFresh) continue;
    try {
      const out = await mdc311.refreshTicket(t, { force: true, source: 'mdc311_sync' });
      enriched += 1;
      if (out.changed) changed += 1;
      if (out.empty) empty += 1;
    } catch (err) {
      failed += 1;
      console.log(`\n[backfill] ${t.externalId}: ${err.kind || 'error'} — ${err.message}`);
      // A rate limit or a bad method name will not fix itself; stop early.
      if (err.kind === 'rate_limit' || err.kind === 'unknown_method' || err.kind === 'stale_fwuid') {
        console.log('[backfill] stopping early — this will not resolve on retry');
        break;
      }
    }
    process.stdout.write(`\r[backfill] looked up ${i + 1}/${tickets.length}  changed=${changed} empty=${empty} failed=${failed}`);
    await sleep(interval);
  }

  console.log(`\n[backfill] done — ${enriched} enriched, ${changed} status changes, ${empty} empty, ${failed} failed`);
  const byStatus = await ExternalTicket.aggregate([
    { $group: { _id: '$status', n: { $sum: 1 } } },
    { $sort: { n: -1 } },
  ]);
  console.log('tickets by status:', byStatus.map((x) => `${x._id}=${x.n}`).join(' '));

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('\n[backfill] failed:', err.message);
  process.exit(1);
});
