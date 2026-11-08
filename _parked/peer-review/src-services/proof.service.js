/**
 * Photo-proof grading for peer-reported outcomes.
 *
 * A resident claiming "this pothole is fixed" is only as credible as the
 * evidence attached. We grade every submitted photo on what can actually be
 * checked from the bytes, and let that weight the claim rather than treating
 * every observation as equal.
 *
 * What is checked, in descending order of strength:
 *
 *   1. EXIF GPS within GPS_TOLERANCE_M of the site — the photo was taken where
 *      the claim says it was. Phone cameras write this; a downloaded stock
 *      image does not.
 *   2. EXIF DateTimeOriginal after the county closed the case — the photo shows
 *      the road *after* the repair, so it can speak to whether the repair held.
 *      A photo predating the closure proves nothing about the current state.
 *   3. The photo is not byte-identical to one already submitted elsewhere.
 *
 * Deliberate limits, so the grade is not oversold:
 *   - EXIF is trivially forgeable. A `geo_verified` grade means "consistent with
 *     the claim", not "proven". It raises the cost of a false claim; it does not
 *     eliminate it. Cryptographic capture attestation (Android Play Integrity,
 *     iOS App Attest) is the next rung and is not implemented here.
 *   - Duplicate detection is an exact SHA-256 match, so it catches literal
 *     re-uploads. A re-encoded or cropped copy needs a perceptual hash, which
 *     needs pixel decoding, which needs an image codec we do not depend on.
 *   - Nothing here judges whether the photo shows a road at all. That is a
 *     vision-model question, not a metadata question.
 */
const crypto = require('crypto');

const GPS_TOLERANCE_M = 150; // generous: phone GPS is poor in urban canyons
const MAX_PHOTO_AGE_DAYS = 365;

const GRADE = {
  GEO_VERIFIED: 'geo_verified',
  TIME_VERIFIED: 'time_verified',
  PHOTO_ONLY: 'photo_only',
  GEO_MISMATCH: 'geo_mismatch',
  DUPLICATE: 'duplicate',
  NONE: 'none',
};

// How much a claim at each grade counts toward corroboration.
const GRADE_WEIGHT = {
  [GRADE.GEO_VERIFIED]: 1.0,
  [GRADE.TIME_VERIFIED]: 0.6,
  [GRADE.PHOTO_ONLY]: 0.35,
  [GRADE.NONE]: 0.2,
  // The file's own metadata contradicts the claim, so it counts for almost
  // nothing — but it is not zero, because stripped-and-rewritten EXIF and a
  // genuinely bad GPS fix look the same from here.
  [GRADE.GEO_MISMATCH]: 0.1,
  [GRADE.DUPLICATE]: 0,
};

const GRADE_LABELS = {
  [GRADE.GEO_VERIFIED]: 'Photo GPS matches this location',
  [GRADE.TIME_VERIFIED]: 'Photo timestamped after the county closed the case',
  [GRADE.PHOTO_ONLY]: 'Photo attached, no usable location or timestamp',
  [GRADE.GEO_MISMATCH]: 'Photo GPS puts it somewhere else',
  [GRADE.DUPLICATE]: 'This exact photo was already submitted elsewhere',
  [GRADE.NONE]: 'No photo attached',
};

const M_PER_DEG_LAT = 110900;
const M_PER_DEG_LNG = 100300; // at Miami's latitude

function metresBetween([lng1, lat1], [lng2, lat2]) {
  const dx = (lng1 - lng2) * M_PER_DEG_LNG;
  const dy = (lat1 - lat2) * M_PER_DEG_LAT;
  return Math.sqrt(dx * dx + dy * dy);
}

/* ------------------------------ EXIF reading ------------------------------ */

const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 };

// Locates the TIFF block inside a JPEG's APP1/Exif segment.
function findExifBlock(buf) {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null; // not a JPEG
  let off = 2;
  while (off + 4 <= buf.length) {
    if (buf[off] !== 0xff) return null;
    const marker = buf[off + 1];
    if (marker === 0xda || marker === 0xd9) return null; // start of scan / end
    const size = buf.readUInt16BE(off + 2);
    if (marker === 0xe1 && buf.slice(off + 4, off + 8).toString('ascii') === 'Exif') {
      return buf.slice(off + 10, off + 2 + size);
    }
    off += 2 + size;
  }
  return null;
}

function readIfd(tiff, offset, little) {
  if (offset + 2 > tiff.length) return [];
  const count = little ? tiff.readUInt16LE(offset) : tiff.readUInt16BE(offset);
  const entries = [];
  for (let i = 0; i < count; i += 1) {
    const at = offset + 2 + i * 12;
    if (at + 12 > tiff.length) break;
    const tag = little ? tiff.readUInt16LE(at) : tiff.readUInt16BE(at);
    const type = little ? tiff.readUInt16LE(at + 2) : tiff.readUInt16BE(at + 2);
    const num = little ? tiff.readUInt32LE(at + 4) : tiff.readUInt32BE(at + 4);
    const bytes = (TYPE_SIZE[type] || 0) * num;
    const valueAt = bytes > 4 ? (little ? tiff.readUInt32LE(at + 8) : tiff.readUInt32BE(at + 8)) : at + 8;
    entries.push({ tag, type, num, valueAt, bytes });
  }
  return entries;
}

function readValue(tiff, entry, little) {
  const { type, num, valueAt } = entry;
  if (valueAt + (TYPE_SIZE[type] || 0) * num > tiff.length) return null;

  if (type === 2) {
    return tiff.slice(valueAt, valueAt + num).toString('ascii').replace(/\0.*$/, '').trim();
  }
  const read32 = (o) => (little ? tiff.readUInt32LE(o) : tiff.readUInt32BE(o));
  if (type === 5 || type === 10) {
    const out = [];
    for (let i = 0; i < num; i += 1) {
      const n = read32(valueAt + i * 8);
      const d = read32(valueAt + i * 8 + 4);
      out.push(d === 0 ? 0 : n / d);
    }
    return num === 1 ? out[0] : out;
  }
  if (type === 3) return little ? tiff.readUInt16LE(valueAt) : tiff.readUInt16BE(valueAt);
  if (type === 4) return read32(valueAt);
  return null;
}

// "2024:11:12 14:24:10" -> Date
function parseExifDate(s) {
  if (!s) return null;
  const m = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(s);
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]));
  return Number.isNaN(d.getTime()) ? null : d;
}

function dmsToDecimal(dms, ref) {
  if (!Array.isArray(dms) || dms.length < 3) return null;
  const sign = ref === 'S' || ref === 'W' ? -1 : 1;
  return sign * (dms[0] + dms[1] / 60 + dms[2] / 3600);
}

/**
 * Pulls the handful of EXIF tags we can actually verify something with.
 * Returns {} for a file with no EXIF — never throws on malformed input.
 */
function parseExif(buf) {
  try {
    const tiff = findExifBlock(buf);
    if (!tiff || tiff.length < 8) return {};

    const bom = tiff.slice(0, 2).toString('ascii');
    if (bom !== 'II' && bom !== 'MM') return {};
    const little = bom === 'II';
    const ifd0At = little ? tiff.readUInt32LE(4) : tiff.readUInt32BE(4);

    const out = {};
    const ifd0 = readIfd(tiff, ifd0At, little);
    let exifAt = null;
    let gpsAt = null;

    for (const e of ifd0) {
      if (e.tag === 0x010f) out.make = readValue(tiff, e, little);
      else if (e.tag === 0x0110) out.model = readValue(tiff, e, little);
      else if (e.tag === 0x0132) out.modifiedAt = parseExifDate(readValue(tiff, e, little));
      else if (e.tag === 0x8769) exifAt = readValue(tiff, e, little);
      else if (e.tag === 0x8825) gpsAt = readValue(tiff, e, little);
    }

    if (exifAt) {
      for (const e of readIfd(tiff, exifAt, little)) {
        if (e.tag === 0x9003) out.takenAt = parseExifDate(readValue(tiff, e, little));
        else if (e.tag === 0x9004 && !out.takenAt) out.takenAt = parseExifDate(readValue(tiff, e, little));
      }
    }

    if (gpsAt) {
      let lat = null;
      let latRef = null;
      let lng = null;
      let lngRef = null;
      for (const e of readIfd(tiff, gpsAt, little)) {
        if (e.tag === 0x0001) latRef = readValue(tiff, e, little);
        else if (e.tag === 0x0002) lat = readValue(tiff, e, little);
        else if (e.tag === 0x0003) lngRef = readValue(tiff, e, little);
        else if (e.tag === 0x0004) lng = readValue(tiff, e, little);
      }
      const dLat = dmsToDecimal(lat, latRef);
      const dLng = dmsToDecimal(lng, lngRef);
      if (dLat !== null && dLng !== null && Number.isFinite(dLat) && Number.isFinite(dLng)) {
        out.gps = { lat: dLat, lng: dLng };
      }
    }

    return out;
  } catch {
    return {}; // a malformed header is a missing grade, not a 500
  }
}

/* ------------------------------- grading --------------------------------- */

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/**
 * @param buffer          the uploaded image bytes, or null
 * @param siteLocation    [lng, lat] of the site being vouched for
 * @param countyClosedAt  when the county closed the case, if it did
 * @param isDuplicate     true if this sha256 already exists on another outcome
 * @param now             evaluation time
 */
function gradePhoto({ buffer, siteLocation, countyClosedAt = null, isDuplicate = false, now = Date.now() }) {
  // Always the same shape, so a client never has to branch on whether a photo
  // was attached before reading a check.
  const EMPTY_CHECKS = {
    hasPhoto: false,
    bytes: null,
    sha256: null,
    hasExifTimestamp: false,
    hasGps: false,
    gpsDistanceMeters: null,
    gpsMatchesSite: null,
    gpsToleranceMeters: GPS_TOLERANCE_M,
    takenAt: null,
    ageDays: null,
    timestampPlausible: null,
    takenAfterCountyClosure: null,
    camera: null,
    isDuplicate: false,
  };

  if (!buffer || !buffer.length) {
    return {
      grade: GRADE.NONE,
      label: GRADE_LABELS[GRADE.NONE],
      weight: GRADE_WEIGHT[GRADE.NONE],
      checks: { ...EMPTY_CHECKS },
    };
  }

  const hash = sha256(buffer);
  const exif = parseExif(buffer);

  const gpsDistanceMeters =
    exif.gps && siteLocation ? Math.round(metresBetween([exif.gps.lng, exif.gps.lat], siteLocation)) : null;
  const gpsMatchesSite = gpsDistanceMeters === null ? null : gpsDistanceMeters <= GPS_TOLERANCE_M;

  const takenAt = exif.takenAt || null;
  const ageDays = takenAt ? Math.round((now - takenAt.getTime()) / 86400000) : null;
  const takenAfterCountyClosure =
    takenAt && countyClosedAt ? takenAt.getTime() >= new Date(countyClosedAt).getTime() : null;
  // A timestamp in the future, or implausibly old, is not usable evidence.
  const timestampPlausible = takenAt ? takenAt.getTime() <= now && ageDays <= MAX_PHOTO_AGE_DAYS : null;

  const checks = {
    ...EMPTY_CHECKS,
    hasPhoto: true,
    bytes: buffer.length,
    sha256: hash,
    hasExifTimestamp: Boolean(takenAt),
    hasGps: Boolean(exif.gps),
    gpsDistanceMeters,
    gpsMatchesSite,
    gpsToleranceMeters: GPS_TOLERANCE_M,
    takenAt,
    ageDays,
    timestampPlausible,
    takenAfterCountyClosure,
    camera: exif.make || exif.model ? `${exif.make || ''} ${exif.model || ''}`.trim() : null,
    isDuplicate,
  };

  // Order matters. A photo that predates the county's closure cannot speak to
  // whether the repair held, however good its GPS is — that is the state of the
  // road *before* the work, which is what got fixed.
  let grade;
  if (isDuplicate) grade = GRADE.DUPLICATE;
  else if (gpsMatchesSite === false) grade = GRADE.GEO_MISMATCH;
  else if (gpsMatchesSite && timestampPlausible && takenAfterCountyClosure !== false) grade = GRADE.GEO_VERIFIED;
  else if (timestampPlausible && takenAfterCountyClosure !== false) grade = GRADE.TIME_VERIFIED;
  else grade = GRADE.PHOTO_ONLY;

  return { grade, label: GRADE_LABELS[grade], weight: GRADE_WEIGHT[grade], checks };
}

module.exports = {
  gradePhoto, parseExif, sha256, metresBetween,
  GRADE, GRADE_WEIGHT, GRADE_LABELS, GPS_TOLERANCE_M, MAX_PHOTO_AGE_DAYS,
};
