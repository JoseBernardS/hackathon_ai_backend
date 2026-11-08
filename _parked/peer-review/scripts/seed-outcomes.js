/**
 * Seeds synthetic peer-reported outcomes so every reconciliation state has a
 * worked example in the demo data.
 *
 *   node scripts/seed-outcomes.js --dir <pics folder>            # dry run
 *   node scripts/seed-outcomes.js --dir <pics folder> --apply
 *
 * THESE ARE SYNTHETIC. Every row is written with origin: 'seed' and is
 * filterable/removable on that basis. Real submissions come in through
 * POST /api/potholes/:id/outcome with origin: 'user'.
 *
 * What is *not* faked: the proof grade. Photos destined for a GPS-verified
 * outcome get real EXIF written into them at the site's own coordinates, then
 * go through the same services/proof.service.js grader as a live upload. The
 * grades below are earned by the bytes, not assigned.
 */
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const { PutObjectCommand } = require('@aws-sdk/client-s3');

const { s3, BUCKET } = require('../src/config/s3');
const Site = require('../src/models/Site');
const Outcome = require('../src/models/Outcome');
const { rebuildAll } = require('../src/services/site.service');
const proof = require('../src/services/proof.service');
const { injectExif } = require('./lib/exif-inject');

const args = process.argv.slice(2);
const flag = (n) => {
  const i = args.indexOf(`--${n}`);
  return i === -1 ? undefined : args[i + 1];
};
const DIR = flag('dir');
const PREFIX = flag('prefix') || 'outcomes/seed';
const apply = args.includes('--apply');

if (!DIR) {
  console.error('usage: node scripts/seed-outcomes.js --dir <folder with full/ and thumb/> [--apply]');
  process.exit(1);
}

// Plausible neighbours, so the UI can say "Reported fixed by Marisol R."
const NAMES = [
  'Marisol R.', 'Andre P.', 'Yolanda B.', 'Dwayne C.', 'Camila T.', 'Rashad M.',
  'Ileana F.', 'Keisha W.', 'Tomas G.', 'Danielle O.', 'Hector V.', 'Simone A.',
  'Omar D.', 'Priya N.', 'Luis E.', 'Tanya S.', 'Jamal H.', 'Esperanza L.',
];

const NOTES = {
  still_there: [
    'Still here, hit it again this morning.',
    'Nothing has been done, it is getting wider.',
    'They patched the wrong side of the street.',
    'Case says closed but the hole is still open.',
    'Marked closed in the system, nothing fixed on the ground.',
  ],
  fixed: [
    'Repaved last week, smooth now.',
    'Crew came out and filled it properly.',
    'Fixed — thanks for pushing on this.',
    'Patched and holding so far.',
  ],
};

// Carries genuine EXIF GPS from Milpa Alta, Mexico City (19.2768, -99.1218),
// which is 2,022km from Miami — so it grades as geo_mismatch on its own merits.
const MISMATCH_IMAGE = '13_Bache_en_una_banqueta.jpg';

function mulberry32(seed) {
  return function rand() {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const exifStamp = (d) => {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}:${p(d.getUTCMonth() + 1)}:${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
};

async function upload(key, body, contentType = 'image/jpeg') {
  await s3.send(
    new PutObjectCommand({
      Bucket: BUCKET, Key: key, Body: body, ContentType: contentType,
      CacheControl: 'public, max-age=31536000, immutable',
    })
  );
}

async function main() {
  const fullDir = path.join(DIR, 'full');
  const thumbDir = path.join(DIR, 'thumb');
  const names = fs.readdirSync(fullDir).filter((f) => f.endsWith('.jpg')).sort();

  await mongoose.connect(process.env.MONGO_URI);
  const sites = await Site.find().sort({ reportCount: -1 }).lean();
  const closed = sites.filter((s) => s.status === 'closed');
  const open = sites.filter((s) => s.status === 'open');
  console.log(`[outcomes] ${sites.length} sites — ${open.length} county-open, ${closed.length} county-closed`);

  // One scenario per site, chosen to cover every reconciliation state.
  const plan = [];
  const push = (site, kinds, evidence) => plan.push({ site, kinds, evidence });

  // Deliberately leaves closed.slice(5) untouched, so `closed_unverified`
  // — county closed the case and nobody has checked — has an example too.
  closed.slice(0, 3).forEach((s) => push(s, ['still_there', 'still_there', 'still_there'], 'strong'));
  closed.slice(3, 4).forEach((s) => push(s, ['fixed', 'fixed'], 'mixed'));
  closed.slice(4, 5).forEach((s) => push(s, ['still_there', 'fixed'], 'mixed'));
  open.slice(0, 5).forEach((s) => push(s, ['still_there', 'still_there'], 'strong'));
  open.slice(5, 8).forEach((s) => push(s, ['still_there'], 'weak'));
  open.slice(8, 11).forEach((s) => push(s, ['fixed'], 'mixed'));
  // One claim backed by a photo whose own GPS puts it in Mexico City. Nobody
  // told the grader; it reads the EXIF and demotes the claim on its own.
  open.slice(11, 12).forEach((s) => push(s, ['fixed'], 'mismatch'));

  const rand = mulberry32(7342026);
  const rows = [];
  let dupSource = null;

  for (const { site, kinds, evidence } of plan) {
    const closedAt = site.county && site.county.closedAt ? new Date(site.county.closedAt) : null;
    // Draw reporters without replacement so one person never appears twice on
    // the same site — that would read as a bug rather than as corroboration.
    const pool = [...NAMES];
    const notePool = { still_there: [...NOTES.still_there], fixed: [...NOTES.fixed] };
    kinds.forEach((kind, i) => {
      // Observed after the county closed, so the claim is admissible.
      const base = closedAt ? closedAt.getTime() : new Date(site.lastReportedAt).getTime();
      const observedAt = new Date(Math.min(base + (5 + i * 18 + rand() * 20) * 86400000, Date.now() - 86400000));
      // strong -> GPS-verified photo, mixed -> plain photo, weak -> no photo
      const tier =
        evidence === 'strong' ? 'geo'
        : evidence === 'mismatch' ? 'mismatch'
        : evidence === 'mixed' ? (i === 0 ? 'photo' : 'none')
        : 'none';
      rows.push({
        site, kind, observedAt, tier,
        name: pool.splice(Math.floor(rand() * pool.length), 1)[0],
        note: (notePool[kind].length ? notePool[kind] : NOTES[kind]).splice(
          Math.floor(rand() * (notePool[kind].length || NOTES[kind].length)), 1
        )[0],
        image: tier === 'mismatch' ? MISMATCH_IMAGE : names[Math.floor(rand() * names.length)],
      });
    });
  }

  // One deliberate duplicate: the same bytes submitted at a second site, so the
  // duplicate path has a worked example too.
  const geoRows = rows.filter((r) => r.tier === 'geo');
  if (geoRows.length >= 2) {
    dupSource = geoRows[0];
    geoRows[geoRows.length - 1].duplicateOf = dupSource;
  }

  const byTier = rows.reduce((m, r) => ({ ...m, [r.tier]: (m[r.tier] || 0) + 1 }), {});
  console.log(`[outcomes] planning ${rows.length} observations across ${plan.length} sites`);
  console.log(`[outcomes] evidence tiers: ${JSON.stringify(byTier)}  (+1 forced duplicate)`);

  if (!apply) {
    console.log(`\n${'site'.padEnd(32)} ${'kind'.padEnd(12)} ${'tier'.padEnd(6)} ${'observed'.padEnd(12)} reporter`);
    for (const r of rows) {
      console.log(`${String(r.site.address || '').slice(0, 31).padEnd(32)} ${r.kind.padEnd(12)} ${r.tier.padEnd(6)} ${r.observedAt.toISOString().slice(0, 10)}   ${r.name}`);
    }
    console.log('\n(dry run — pass --apply to upload and write)');
    await mongoose.disconnect();
    return;
  }

  await Outcome.deleteMany({ origin: 'seed' });
  const cache = new Map(); // key -> {photoKeys, thumbKeys, buffer}

  for (const [i, r] of rows.entries()) {
    let photoKeys = [];
    let thumbKeys = [];
    let buffer = null;

    if (r.tier !== 'none') {
      const src = r.duplicateOf || r;
      // Include the row for geo photos: each carries its own DateTimeOriginal,
      // so a photo is never stamped earlier than the observation that filed it.
      const cacheKey =
        src.tier === 'geo'
          ? `${src.site._id}-${src.image}-geo-${rows.indexOf(src)}`
          : `${src.site._id}-${src.image}-${src.tier}`;
      let entry = cache.get(cacheKey);

      if (!entry) {
        const raw = fs.readFileSync(path.join(fullDir, src.image));
        // A GPS-verified tier gets real EXIF at the site's own coordinates.
        buffer = src.tier === 'geo' && src.tier !== 'mismatch'
          ? injectExif(raw, {
              lat: src.site.location.coordinates[1],
              lng: src.site.location.coordinates[0],
              taken: exifStamp(src.observedAt),
              make: 'Pixel 9',
            })
          : raw;
        const key = `${PREFIX}/${src.site._id}-${i}-${src.image}`;
        const thumbKey = key.replace(`${PREFIX}/`, `${PREFIX}/thumb/`);
        await upload(key, buffer);
        await upload(thumbKey, fs.readFileSync(path.join(thumbDir, src.image)));
        entry = { photoKeys: [key], thumbKeys: [thumbKey], buffer };
        cache.set(cacheKey, entry);
      }
      photoKeys = entry.photoKeys;
      thumbKeys = entry.thumbKeys;
      buffer = entry.buffer;
    }

    const sha = buffer ? proof.sha256(buffer) : null;
    const isDuplicate = Boolean(
      sha && (await Outcome.exists({ 'proof.sha256': sha, siteId: { $ne: r.site._id } }))
    );

    // Graded by the real pipeline, same as a live upload.
    const graded = proof.gradePhoto({
      buffer,
      siteLocation: r.site.location.coordinates,
      countyClosedAt: r.site.county ? r.site.county.closedAt : null,
      isDuplicate,
      now: r.observedAt.getTime(),
    });

    await Outcome.create({
      siteId: r.site._id,
      kind: r.kind,
      observedBy: undefined, // synthetic: no real account behind it
      reporterName: r.name,
      observedAt: r.observedAt,
      origin: 'seed',
      note: r.note,
      photoKeys,
      thumbKeys,
      location: { type: 'Point', coordinates: r.site.location.coordinates },
      proof: {
        grade: graded.grade, label: graded.label, weight: graded.weight,
        sha256: graded.checks.sha256, bytes: graded.checks.bytes,
        hasGps: graded.checks.hasGps, hasExifTimestamp: graded.checks.hasExifTimestamp,
        gpsDistanceMeters: graded.checks.gpsDistanceMeters ?? undefined,
        gpsMatchesSite: graded.checks.gpsMatchesSite ?? undefined,
        takenAt: graded.checks.takenAt || undefined,
        ageDays: graded.checks.ageDays ?? undefined,
        takenAfterCountyClosure: graded.checks.takenAfterCountyClosure ?? undefined,
        timestampPlausible: graded.checks.timestampPlausible ?? undefined,
        camera: graded.checks.camera || undefined,
        isDuplicate,
      },
    });
    process.stdout.write(`\r[outcomes] wrote ${i + 1}/${rows.length}`);
  }
  console.log('');

  const n = await rebuildAll({ log: (m) => process.stdout.write(`\r[outcomes] ${m}`) });
  console.log(`\n[outcomes] rebuilt ${n} sites`);

  const dist = await Site.aggregate([
    { $group: { _id: '$reconciliation.effectiveStatus', n: { $sum: 1 } } },
    { $sort: { n: -1 } },
  ]);
  console.log('\nreconciliation states now in the data:');
  for (const d of dist) console.log(`  ${String(d._id).padEnd(20)} ${d.n}`);

  const grades = await Outcome.aggregate([
    { $group: { _id: '$proof.grade', n: { $sum: 1 } } }, { $sort: { n: -1 } },
  ]);
  console.log('\nproof grades earned:');
  for (const g of grades) console.log(`  ${String(g._id).padEnd(20)} ${g.n}`);

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('\n[outcomes] failed:', err.message);
  process.exit(1);
});
