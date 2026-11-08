/**
 * Seed historical Miami-Dade 311 reports into MongoDB.
 *
 *   node scripts/seed-311.js ~/Downloads/data_311_2026.geojson
 *   node scripts/seed-311.js <file> --drop            # wipe seeded 311 docs first
 *   node scripts/seed-311.js <file> --since 2026-07-01
 *   node scripts/seed-311.js <file> --only pothole    # one category only
 *   node scripts/seed-311.js <file> --limit 5000      # quick smoke test
 *
 * Only "real problem" categories are imported — scheduling, account admin and
 * permit/inspection requests are filtered out via src/data/subject-map.json.
 */
require('dotenv').config();

const fs = require('fs');
const readline = require('readline');
const mongoose = require('mongoose');

const Report = require('../src/models/Report');
const Site = require('../src/models/Site');
const { clusterReports, SITE_RADIUS_M } = require('../src/services/dedupe.service');
const { compose } = require('../src/services/site.service');
const { normalise } = require('../src/services/report.schema');
const categories = require('../src/services/categories.service');
const subjectMap = require('../src/data/subject-map.json');
const { categories: allCategories } = require('../src/data/categories.all.json');

const byCode = new Map(allCategories.map((c) => [c.code, c]));

// Raw 311 SubType strings -> our own subtype codes, so seeded and user-submitted
// reports share one vocabulary. Categories without a mapping keep the raw value.
const subTypeAliases = new Map();
for (const file of ['../src/data/pothole.json']) {
  for (const st of require(file).subtypes || []) {
    for (const a of st.aliases311 || []) subTypeAliases.set(a, st.code);
  }
}

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? undefined : args[i + 1];
};
const drop = args.includes('--drop');
const only = flag('only');
const limit = Number(flag('limit')) || Infinity;
const since = flag('since') ? new Date(flag('since')) : null;
const BATCH = 2000;

if (!file) {
  console.error('usage: node scripts/seed-311.js <path-to-geojson> [--drop] [--since YYYY-MM-DD] [--limit N]');
  process.exit(1);
}

function toReport(p) {
  const code = subjectMap[p.Subject];
  if (!code) return null; // non-problem category, skip
  if (only && code !== only) return null;
  if (p.Latitude == null || p.Longitude == null) return null;

  const reportedAt = new Date(p.Created_Date);
  if (since && reportedAt < since) return null;

  const status = String(p.Status || '');
  // The registry entry supplies the defaults normalise() falls back to.
  const entry = categories.get(code);

  // Through the shared contract, so a seeded row and an in-app one land with
  // the same field set. See src/services/report.schema.js.
  return normalise(
    {
      source: '311',
      sourceId: p.Service_Request_Number,
      categoryCode: code,
      subType: p.SubType ? subTypeAliases.get(p.SubType) || p.SubType : undefined,
      status: status.startsWith('Open') ? 'open' : 'closed',
      department: p.Department || undefined,
      sla: p.SLA && p.SLA !== 'No SLA Defined' ? p.SLA : undefined,
      address: p.Street_Number || undefined,
      municipality: p.Municipality || undefined,
      location: { type: 'Point', coordinates: [p.Longitude, p.Latitude] },
      reportedAt,
      closedAt: p.Closed_Date ? new Date(p.Closed_Date) : undefined,
    },
    { entry: entry || {} }
  );
}

async function main() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log('[seed] connected');

  if (only && !byCode.has(only)) {
    console.error(`[seed] unknown category "${only}"`);
    process.exit(1);
  }
  if (only) console.log(`[seed] filtering to category: ${only}`);

  if (drop) {
    const { deletedCount } = await Report.deleteMany({ source: '311' });
    console.log(`[seed] dropped ${deletedCount} existing 311 reports`);
  }

  const rl = readline.createInterface({
    input: fs.createReadStream(file),
    crlfDelay: Infinity,
  });

  let scanned = 0;
  let inserted = 0;
  let skipped = 0;
  let batch = [];

  const flush = async () => {
    if (!batch.length) return;
    await Report.insertMany(batch, { ordered: false });
    inserted += batch.length;
    batch = [];
    process.stdout.write(`\r[seed] scanned ${scanned}  inserted ${inserted}  skipped ${skipped}`);
  };

  for await (const raw of rl) {
    const line = raw.trim().replace(/,$/, '');
    if (!line.startsWith('{"type":"Feature"')) continue;
    scanned += 1;

    let doc;
    try {
      doc = toReport(JSON.parse(line).properties);
    } catch {
      skipped += 1;
      continue;
    }
    if (!doc) {
      skipped += 1;
      continue;
    }

    batch.push(doc);
    if (batch.length >= BATCH) await flush();
    if (inserted >= limit) break;
  }
  await flush();

  console.log(`\n[seed] done — ${inserted} reports imported, ${skipped} skipped of ${scanned} scanned`);

  if (only === 'pothole' || !only) await buildSites();
  await mongoose.disconnect();
}

/**
 * Collapses every pothole report into deduplicated sites, so the map shows one
 * pin per hole rather than one per complaint.
 */
async function buildSites() {
  const reports = await Report.find({ categoryCode: 'pothole' })
    .sort({ reportedAt: 1 })
    .select('categoryCode location status reportedAt closedAt address municipality subType department sla source sourceId photoKeys thumbKeys')
    .lean();

  if (!reports.length) return;

  await Site.deleteMany({ categoryCode: 'pothole' });
  const clusters = clusterReports(reports);
  console.log(`[seed] dedupe: ${reports.length} reports -> ${clusters.length} sites (${SITE_RADIUS_M}m radius)`);

  const sites = await Site.insertMany(clusters.map((c) => compose(c)), { ordered: false });

  // Point each report back at its site, so a pin can show its own history.
  const ops = [];
  clusters.forEach((members, i) => {
    ops.push({
      updateMany: {
        filter: { _id: { $in: members.map((m) => m._id) } },
        update: { $set: { siteId: sites[i]._id } },
      },
    });
  });
  for (let i = 0; i < ops.length; i += 500) {
    await Report.bulkWrite(ops.slice(i, i + 500), { ordered: false });
  }

  const open = await Site.countDocuments({ status: 'open' });
  console.log(`[seed] sites linked — ${open} open, ${clusters.length - open} resolved`);
}

main().catch((err) => {
  console.error('\n[seed] failed:', err.message);
  process.exit(1);
});
