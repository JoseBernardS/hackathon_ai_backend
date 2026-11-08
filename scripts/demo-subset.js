/**
 * Prunes the seeded pothole data down to a small, well-spread demo set.
 *
 *   node scripts/demo-subset.js                      # dry run, prints the picks
 *   node scripts/demo-subset.js --apply              # actually prune the database
 *   node scripts/demo-subset.js --count 40 --spacing 1500 --apply
 *   node scripts/demo-subset.js --near 25.7743,-80.1937 --within 12000 --apply
 *   node scripts/demo-subset.js --worst 5 --near 25.7743,-80.1937 --apply
 *
 * Selection is greedy: take the most-reported sites first, but skip any site
 * closer than `spacing` metres to one already picked. That gives severity at the
 * top of the list and geographic spread across Miami-Dade, so a map of the
 * result has no overlapping pins.
 *
 * Re-run scripts/seed-311.js to get the full data set back.
 */
require('dotenv').config();

const mongoose = require('mongoose');

const Report = require('../src/models/Report');
const Site = require('../src/models/Site');
const { metresBetween } = require('../src/services/dedupe.service');

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? undefined : args[i + 1];
};
const COUNT = Number(flag('count')) || 40;
const SPACING = Number(flag('spacing')) || 1500;
const RESOLVED_SHARE = 0.15; // keep a few fixed ones so the UI can show both states
const apply = args.includes('--apply');

// Optional geographic focus. The county's real hotspots are in far-south
// suburbia, which makes for a thin demo map; --near lets you centre the subset
// on somewhere recognisable instead.
const near = flag('near')
  ? flag('near').split(',').map(Number).reverse() // "lat,lng" -> [lng, lat]
  : null;
const within = Number(flag('within')) || 12000;

// The county's very worst sites, force-included wherever they are. Without this
// a --near focus drops them, and they are the whole point of the data.
const WORST = flag('worst') === undefined ? 0 : Number(flag('worst'));

// Greedy pick over `sites`, honouring a minimum separation from everything in
// `avoid` as well as from each other, so successive calls don't collide.
function pickSpread(sites, want, spacing, avoid = []) {
  const picked = [];
  let gap = spacing;

  while (picked.length < want && gap >= 50) {
    for (const s of sites) {
      if (picked.length >= want) break;
      if (picked.includes(s)) continue;
      const far = [...avoid, ...picked].every(
        (p) => metresBetween(s.location.coordinates, p.location.coordinates) >= gap
      );
      if (far) picked.push(s);
    }
    gap = Math.floor(gap / 2); // relax if the area runs out of room
  }
  return picked;
}

async function main() {
  await mongoose.connect(process.env.MONGO_URI);

  const openWanted = Math.round(COUNT * (1 - RESOLVED_SHARE));
  const resolvedWanted = COUNT - openWanted;

  const geo = near
    ? { location: { $near: { $geometry: { type: 'Point', coordinates: near }, $maxDistance: within } } }
    : {};

  // $near already sorts by distance, so sort by severity in memory instead.
  const bySeverity = (a, b) => b.reportCount - a.reportCount;
  const open = (await Site.find({ status: 'open', ...geo }).lean()).sort(bySeverity);
  const resolved = (await Site.find({ status: 'closed', ...geo }).lean()).sort(bySeverity);

  if (near) console.log(`\nfocus: within ${within}m of ${near[1]},${near[0]} — ${open.length} open / ${resolved.length} resolved candidates`);

  const worst = WORST
    ? await Site.find({ status: 'open' }).sort({ reportCount: -1, oldestOpenAt: 1 }).limit(WORST).lean()
    : [];
  if (WORST) {
    console.log(`forcing in the ${worst.length} worst sites countywide (${worst.map((w) => w.reportCount).join(', ')} reports)`);
  }

  const worstIds = new Set(worst.map((w) => String(w._id)));
  const openPool = open.filter((o) => !worstIds.has(String(o._id)));

  const openPicks = [...worst, ...pickSpread(openPool, Math.max(openWanted - worst.length, 0), SPACING, worst)];
  const picked = [...openPicks, ...pickSpread(resolved, resolvedWanted, SPACING, openPicks)];

  const keepIds = picked.map((s) => s._id);
  const totalSites = await Site.countDocuments();
  const keptReports = picked.reduce((s, p) => s + p.reportCount, 0);

  console.log(`\nkeeping ${picked.length} of ${totalSites} sites (${keptReports} underlying reports)`);
  console.log(`spacing target ${SPACING}m, ${openWanted} open + ${resolvedWanted} resolved\n`);
  console.log(`${'#'.padStart(3)} ${'reports'.padStart(7)} ${'open'.padStart(5)} ${'days'.padStart(5)}  ${'address'.padEnd(32)} ${'municipality'.padEnd(24)} subtypes`);
  picked.forEach((s, i) => {
    const days = s.oldestOpenAt ? Math.round((Date.now() - new Date(s.oldestOpenAt)) / 86400000) : '-';
    console.log(
      `${String(i + 1).padStart(3)} ${String(s.reportCount).padStart(7)} ${String(s.openCount).padStart(5)} ${String(days).padStart(5)}  ${String(s.address || '').slice(0, 31).padEnd(32)} ${String(s.municipality || '').slice(0, 23).padEnd(24)} ${(s.subtypes || []).join(',')}`
    );
  });

  // How well spread is it, really?
  let min = Infinity;
  for (let i = 0; i < picked.length; i += 1) {
    for (let j = i + 1; j < picked.length; j += 1) {
      min = Math.min(min, metresBetween(picked[i].location.coordinates, picked[j].location.coordinates));
    }
  }
  const lats = picked.map((s) => s.location.coordinates[1]);
  const lngs = picked.map((s) => s.location.coordinates[0]);
  console.log(`\nclosest pair: ${Math.round(min)}m`);
  console.log(`bbox: lat ${Math.min(...lats).toFixed(3)}..${Math.max(...lats).toFixed(3)}  lng ${Math.min(...lngs).toFixed(3)}..${Math.max(...lngs).toFixed(3)}`);
  const byMuni = picked.reduce((m, s) => ({ ...m, [s.municipality]: (m[s.municipality] || 0) + 1 }), {});
  console.log('municipalities:', Object.entries(byMuni).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', '));

  if (!apply) {
    console.log('\n(dry run — pass --apply to prune the database)');
    await mongoose.disconnect();
    return;
  }

  const r = await Report.deleteMany({ categoryCode: 'pothole', siteId: { $nin: keepIds }, source: '311' });
  const s = await Site.deleteMany({ _id: { $nin: keepIds } });
  console.log(`\npruned — removed ${s.deletedCount} sites and ${r.deletedCount} reports`);
  console.log(`sites now: ${await Site.countDocuments()}  reports now: ${await Report.countDocuments({ categoryCode: 'pothole' })}`);

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('[demo-subset] failed:', err.message);
  process.exit(1);
});
