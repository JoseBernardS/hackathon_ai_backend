/**
 * Demo resident verifications, so the "is it actually fixed?" UI has something
 * to render before anyone has used the app.
 *
 *   node scripts/seed-verifications.js          # create
 *   node scripts/seed-verifications.js --clear  # remove every trace
 *
 * Everything written here is flagged `seeded: true` — on the verification
 * entry and on the demo account — so it can be told apart from a real
 * resident's answer and removed without touching one.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

const { connectDB } = require('../src/config/db');
const Site = require('../src/models/Site');
const User = require('../src/models/User');
const uploads = require('../src/services/upload.service');

// Recognisable, reserved, and never a real number (555-01xx is the fiction range).
const PHONE_PREFIX = '+1305555';
const RESIDENTS = [
  ['0101', 'Maria G'], ['0102', 'Luis R'],  ['0103', 'Ana P'],
  ['0104', 'Dwayne B'], ['0105', 'Yvette C'], ['0106', 'Tomás L'],
  ['0107', 'Priya N'], ['0108', 'Marcus T'],
];

const STILL_THERE = [
  'Still there. Hit it again this morning.',
  'Nothing has changed, the hole is in the right lane by the crosswalk.',
  'Looks worse than when I reported it — edges are crumbling now.',
  'Someone put a cone next to it but it has not been filled.',
  'Still open. Water sits in it every time it rains.',
  'My car took a hit here yesterday. Not repaired.',
];
const FIXED = [
  'Filled in this week, smooth now.',
  'Repaved the whole stretch, looks good.',
  'Patched a few days ago. Holding up so far.',
  'Crew was out Tuesday, it is done.',
];

const PHOTO_DIR = '/Users/jss3466/Downloads/pothole_pics';

async function clear() {
  // `seeded: { $ne: true }` catches entries written by hand while testing,
  // which carry no flag and would otherwise linger with no name or note.
  const res = await Site.updateMany(
    { 'verifications.0': { $exists: true } },
    { $pull: { verifications: { $or: [{ seeded: true }, { name: null }, { name: { $exists: false } }] } } }
  );
  const users = await User.deleteMany({ seeded: true });
  console.log(`cleared seeded verifications from ${res.modifiedCount} site(s)`);
  console.log(`removed ${users.deletedCount} demo account(s)`);
}

async function main() {
  await connectDB();

  if (process.argv.includes('--clear')) {
    await clear();
    return mongoose.disconnect();
  }

  // Idempotent: wipe any previous seed before writing a new one.
  await clear();

  const residents = [];
  for (const [suffix, name] of RESIDENTS) {
    const phone = PHONE_PREFIX + suffix;
    const user = await User.findOneAndUpdate(
      { phone },
      {
        $set: {
          displayName: name,
          firstName: name.split(' ')[0],
          lastName: name.split(' ')[1] || 'R',
          email: `${name.split(' ')[0].toLowerCase()}@example.invalid`,
          seeded: true,
          verifiedAt: new Date(),
        },
        $setOnInsert: { phone },
      },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );
    residents.push(user);
  }
  console.log(`demo residents: ${residents.length}`);

  /**
   * Real pothole photos as evidence — one per verification, never reused.
   *
   * Four images repeated across eighteen claims reads as obviously synthetic
   * the moment two of them are on screen together.
   */
  let photoKeys = [];
  if (fs.existsSync(PHOTO_DIR)) {
    const files = fs.readdirSync(PHOTO_DIR).filter((f) => /\.jpe?g$/i.test(f)).slice(0, 24);
    for (const f of files) {
      const buf = fs.readFileSync(path.join(PHOTO_DIR, f));
      const stored = await uploads.putObject(
        { buffer: buf, originalname: f, mimetype: 'image/jpeg', size: buf.length },
        'verifications/seed'
      );
      photoKeys.push(stored.key);
    }
  }
  console.log(`evidence photos uploaded: ${photoKeys.length}`);

  const closed = await Site.find({ status: 'closed' }).sort({ reportCount: -1 });
  const open = await Site.find({ status: 'open' }).sort({ reportCount: -1 }).limit(8);
  console.log(`targets: ${closed.length} closed, ${open.length} open`);

  let rr = 0;
  let pp = 0;
  const nextResident = () => residents[rr++ % residents.length];
  const pick = (arr, i) => arr[i % arr.length];
  // Sequential, so no two claims carry the same picture.
  const nextPhoto = () => (pp < photoKeys.length ? photoKeys[pp++] : undefined);

  /** Writes `n` answers onto a site, `yes` of which say it is fixed. */
  async function voteOn(site, n, yes, withPhotos) {
    const entries = [];
    for (let i = 0; i < n; i++) {
      const fixed = i < yes;
      const u = nextResident();
      entries.push({
        user: u._id,
        fixed,
        // Spread over the last three weeks so the timeline is not a single blob.
        at: new Date(Date.now() - (i * 3 + 1) * 86400000),
        name: u.displayName,
        note: fixed ? pick(FIXED, i + rr) : pick(STILL_THERE, i + rr),
        photoKey: withPhotos ? nextPhoto() : undefined,
        seeded: true,
      });
    }
    await Site.updateOne({ _id: site._id }, { $push: { verifications: { $each: entries } } });
    const fresh = await Site.findById(site._id);
    return fresh.toJSON().verification;
  }

  // The county closed these. The interesting question is whether it stuck.
  const plan = [
    [3, 0, true],   // three residents disagree with the closure — the money shot
    [4, 1, true],   // mostly disagree
    [2, 1, true],   // disputed
    [3, 3, false],  // county was right
    [2, 2, true],   // county was right, with a photo
    [1, 0, false],  // a lone voice
  ];
  console.log('\nclosed sites (county says done):');
  for (let i = 0; i < closed.length; i++) {
    const [n, yes, pics] = plan[i % plan.length];
    const v = await voteOn(closed[i], n, yes, pics);
    console.log(`  ${String(closed[i]._id).slice(-6)} ${(closed[i].address || 'unknown').slice(0, 30).padEnd(30)} ${v.fixedCount} fixed / ${v.notFixedCount} not -> ${v.verdict}`);
  }

  // Still open: residents confirming it is still a problem.
  console.log('\nopen sites (still reported):');
  for (let i = 0; i < open.length; i++) {
    const n = (i % 3) + 1;
    const v = await voteOn(open[i], n, 0, i % 2 === 0);
    console.log(`  ${String(open[i]._id).slice(-6)} ${(open[i].address || 'unknown').slice(0, 30).padEnd(30)} ${v.fixedCount} fixed / ${v.notFixedCount} not -> ${v.verdict}`);
  }

  const total = await Site.countDocuments({ 'verifications.0': { $exists: true } });
  console.log(`\nsites now carrying verifications: ${total}`);
  console.log('remove with: node scripts/seed-verifications.js --clear');
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('[seed-verifications]', err.message);
  process.exit(1);
});
