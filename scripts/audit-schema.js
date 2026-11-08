/**
 * Audits every report against the contract in services/report.schema.js and
 * reports where the ingest paths have drifted apart.
 *
 * CORE fields must be filled on every row. OPTIONAL fields are legitimately
 * absent depending on origin — the table shows coverage per source so a gap
 * that should not exist is obvious.
 *
 *   node scripts/audit-schema.js
 *   node scripts/audit-schema.js --fix     # backfill DERIVED fields in place
 */
require('dotenv').config();

const mongoose = require('mongoose');

const Report = require('../src/models/Report');
const Site = require('../src/models/Site');
const { CORE, OPTIONAL, auditReports, normalise } = require('../src/services/report.schema');
const { locate } = require('../src/services/locate.service');
const categories = require('../src/services/categories.service');
const { rebuildSite } = require('../src/services/site.service');

const fix = process.argv.includes('--fix');

async function main() {
  await mongoose.connect(process.env.MONGO_URI);

  const reports = await Report.find().lean();
  const bySource = reports.reduce((m, r) => ({ ...m, [r.source]: (m[r.source] || 0) + 1 }), {});
  console.log(`[audit] ${reports.length} reports — ${Object.entries(bySource).map(([k, v]) => `${k}=${v}`).join(' ')}`);

  // Field coverage per source, so a gap on one path is obvious.
  const sources = Object.keys(bySource);
  const fields = [...Object.keys(CORE), ...Object.keys(OPTIONAL)];
  console.log(`\n${'field'.padEnd(16)}${'tier'.padEnd(9)}${sources.map((s) => `${s} filled`.padEnd(14)).join('')}`);
  for (const f of fields) {
    const tier = CORE[f] ? 'CORE' : 'OPTIONAL';
    const cells = sources.map((s) => {
      const rows = reports.filter((r) => r.source === s);
      const filled = rows.filter((r) => {
        const v = r[f];
        return Array.isArray(v) ? v.length > 0 : v !== undefined && v !== null;
      }).length;
      return `${filled}/${rows.length}`.padEnd(14);
    });
    console.log(`${f.padEnd(16)}${tier.padEnd(9)}${cells.join('')}`);
  }

  const problems = auditReports(reports);
  const keys = Object.keys(problems);
  console.log(`\n[audit] ${keys.length} field(s) with gaps`);
  for (const k of keys) {
    const p = problems[k];
    console.log(`  ${k.padEnd(16)} ${String(p.count).padStart(4)} rows  ${p.why}  e.g. ${p.examples.join(', ')}`);
  }

  if (!keys.length) {
    console.log('[audit] clean — every path produces the same shape');
    await mongoose.disconnect();
    return;
  }

  if (!fix) {
    console.log('\n(pass --fix to backfill the CORE fields)');
    await mongoose.disconnect();
    return;
  }

  const entry = categories.get('pothole');
  const touched = new Set();
  let fixed = 0;
  for (const r of reports) {
    const missing = Object.keys(CORE).filter((f) => r[f] === undefined || r[f] === null);
    if (!missing.length) continue;
    const placed = await locate(r.location.coordinates);
    const next = normalise(r, { placed, entry });
    const set = {};
    for (const f of missing) if (next[f] !== null && next[f] !== undefined) set[f] = next[f];
    if (!Object.keys(set).length) continue;
    await Report.updateOne({ _id: r._id }, { $set: set });
    if (r.siteId) touched.add(String(r.siteId));
    fixed += 1;
  }
  for (const id of touched) await rebuildSite(id);
  console.log(`\n[audit] filled gaps on ${fixed} reports, rebuilt ${touched.size} sites`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('[audit] failed:', err.message);
  process.exit(1);
});
