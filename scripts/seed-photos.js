/**
 * Uploads a folder of pothole photos to S3 and attaches them to seeded reports.
 *
 *   node scripts/seed-photos.js --dir /path/to/pics            # dry run
 *   node scripts/seed-photos.js --dir /path/to/pics --apply
 *
 * The folder must contain `full/` and `thumb/` subfolders with matching
 * filenames. Keys are derived from the filename, so re-running overwrites
 * rather than duplicating.
 *
 * Assignment is random but seeded, so the same photo lands on the same report
 * every time — screenshots and demos stay stable.
 */
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const { PutObjectCommand } = require('@aws-sdk/client-s3');

const { s3, BUCKET } = require('../src/config/s3');
const Report = require('../src/models/Report');
const Site = require('../src/models/Site');
const { rebuildAll } = require('../src/services/site.service');

const args = process.argv.slice(2);
const flag = (n) => {
  const i = args.indexOf(`--${n}`);
  return i === -1 ? undefined : args[i + 1];
};
const DIR = flag('dir');
const COVERAGE = flag('coverage') === undefined ? 0.65 : Number(flag('coverage'));
const PREFIX = flag('prefix') || 'potholes/seed';
const apply = args.includes('--apply');

if (!DIR) {
  console.error('usage: node scripts/seed-photos.js --dir <folder with full/ and thumb/> [--coverage 0.65] [--apply]');
  process.exit(1);
}

// Deterministic PRNG so repeated runs produce the same assignment.
function mulberry32(seed) {
  return function rand() {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CONTENT_TYPES = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };

function listImages(dir) {
  return fs
    .readdirSync(dir)
    .filter((f) => CONTENT_TYPES[path.extname(f).toLowerCase()])
    .sort();
}

async function upload(localPath, key) {
  await s3.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: fs.readFileSync(localPath),
      ContentType: CONTENT_TYPES[path.extname(localPath).toLowerCase()],
      CacheControl: 'public, max-age=31536000, immutable',
    })
  );
}

async function main() {
  const fullDir = path.join(DIR, 'full');
  const thumbDir = path.join(DIR, 'thumb');
  for (const d of [fullDir, thumbDir]) {
    if (!fs.existsSync(d)) {
      console.error(`[photos] missing ${d}`);
      process.exit(1);
    }
  }

  const names = listImages(fullDir);
  const missingThumbs = names.filter((n) => !fs.existsSync(path.join(thumbDir, n)));
  if (missingThumbs.length) {
    console.error(`[photos] no thumbnail for: ${missingThumbs.join(', ')}`);
    process.exit(1);
  }

  const bytes = names.reduce((s, n) => s + fs.statSync(path.join(fullDir, n)).size, 0);
  const thumbBytes = names.reduce((s, n) => s + fs.statSync(path.join(thumbDir, n)).size, 0);
  console.log(`[photos] ${names.length} images — ${(bytes / 1e6).toFixed(1)}MB full, ${(thumbBytes / 1e6).toFixed(2)}MB thumbs`);
  console.log(`[photos] prefix s3://${BUCKET}/${PREFIX}/`);

  await mongoose.connect(process.env.MONGO_URI);

  const reports = await Report.find({ categoryCode: 'pothole' })
    .sort({ _id: 1 })
    .select('_id siteId')
    .lean();
  const sites = await Site.find().select('_id').lean();
  console.log(`[photos] ${reports.length} reports across ${sites.length} sites, coverage ${COVERAGE}`);

  // Decide the assignment first so a dry run reports exactly what --apply would do.
  const rand = mulberry32(20261107);
  const keyFor = (n) => `${PREFIX}/${n}`;
  const assignment = new Map(); // reportId -> key
  for (const r of reports) {
    if (rand() < COVERAGE) assignment.set(String(r._id), keyFor(names[Math.floor(rand() * names.length)]));
  }

  // Every pin should have an image, so top up any site the dice missed.
  const sitesWithPhoto = new Set();
  for (const r of reports) if (assignment.has(String(r._id))) sitesWithPhoto.add(String(r.siteId));
  let toppedUp = 0;
  for (const s of sites) {
    if (sitesWithPhoto.has(String(s._id))) continue;
    const candidate = reports.find((r) => String(r.siteId) === String(s._id));
    if (candidate) {
      assignment.set(String(candidate._id), keyFor(names[Math.floor(rand() * names.length)]));
      toppedUp += 1;
    }
  }

  console.log(`[photos] would attach ${assignment.size} photos (${toppedUp} added so every site has one)`);

  if (!apply) {
    console.log('\n(dry run — pass --apply to upload and write)');
    await mongoose.disconnect();
    return;
  }

  for (const n of names) {
    await upload(path.join(fullDir, n), `${PREFIX}/${n}`);
    await upload(path.join(thumbDir, n), `${PREFIX}/thumb/${n}`);
    process.stdout.write(`\r[photos] uploaded ${names.indexOf(n) + 1}/${names.length}`);
  }
  console.log('');

  await Report.updateMany({ categoryCode: 'pothole' }, { $set: { photoKeys: [], thumbKeys: [] } });
  const ops = [...assignment].map(([id, key]) => ({
    updateOne: {
      filter: { _id: id },
      update: { $set: { photoKeys: [key], thumbKeys: [key.replace(`${PREFIX}/`, `${PREFIX}/thumb/`)] } },
    },
  }));
  for (let i = 0; i < ops.length; i += 500) await Report.bulkWrite(ops.slice(i, i + 500), { ordered: false });
  console.log(`[photos] attached ${ops.length} photos to reports`);

  const n = await rebuildAll({ log: (m) => process.stdout.write(`\r[photos] ${m}`) });
  console.log(`\n[photos] rebuilt ${n} sites`);

  const withPhotos = await Site.countDocuments({ 'photoKeys.0': { $exists: true } });
  console.log(`[photos] sites with at least one photo: ${withPhotos}/${sites.length}`);

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('\n[photos] failed:', err.message);
  process.exit(1);
});
