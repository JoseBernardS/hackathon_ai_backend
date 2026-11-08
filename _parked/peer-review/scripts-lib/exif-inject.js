/**
 * Writes an EXIF APP1 segment (GPS + DateTimeOriginal) into a JPEG.
 *
 * DEMO TOOLING ONLY. This exists so seeded peer outcomes can carry genuine,
 * parseable GPS metadata and be graded by the real proof pipeline instead of
 * having a grade hardcoded. It is not used by the server at runtime.
 *
 * It also doubles as the honest demonstration that EXIF is forgeable — which is
 * exactly why services/proof.service.js treats a `geo_verified` grade as
 * "consistent with the claim" rather than as proof.
 */
const MAKE_MAX = 23; // the Make field's reserved slot, minus its NUL

function buildExifTiff({ lat, lng, taken, make = 'Seed Camera' }) {
  if (make.length > MAKE_MAX) throw new Error(`make must be <= ${MAKE_MAX} chars`);

  // Fixed layout, all offsets relative to the start of the TIFF block:
  //   8..50   IFD0        (3 entries)
  //  50..68   Exif IFD    (1 entry)
  //  68..122  GPS IFD     (4 entries)
  // 122..146  Make        (24 bytes reserved)
  // 146..166  DateTimeOriginal (20 bytes, "YYYY:MM:DD HH:MM:SS\0")
  // 166..190  GPSLatitude  (3 rationals)
  // 190..214  GPSLongitude (3 rationals)
  const IFD0 = 8, EXIF_IFD = 50, GPS_IFD = 68;
  const MAKE_AT = 122, DATE_AT = 146, LAT_AT = 166, LNG_AT = 190;
  const t = Buffer.alloc(214);
  t.write('II', 0, 'ascii');
  t.writeUInt16LE(0x2a, 2);
  t.writeUInt32LE(IFD0, 4);

  const entry = (at, tag, type, num, val) => {
    t.writeUInt16LE(tag, at);
    t.writeUInt16LE(type, at + 2);
    t.writeUInt32LE(num, at + 4);
    if (typeof val === 'string') t.write(val, at + 8, 'ascii');
    else t.writeUInt32LE(val, at + 8);
  };

  t.writeUInt16LE(3, IFD0);
  entry(IFD0 + 2, 0x010f, 2, make.length + 1, MAKE_AT);
  entry(IFD0 + 14, 0x8769, 4, 1, EXIF_IFD);
  entry(IFD0 + 26, 0x8825, 4, 1, GPS_IFD);
  t.writeUInt32LE(0, IFD0 + 38);

  t.writeUInt16LE(1, EXIF_IFD);
  entry(EXIF_IFD + 2, 0x9003, 2, 20, DATE_AT);
  t.writeUInt32LE(0, EXIF_IFD + 14);

  t.writeUInt16LE(4, GPS_IFD);
  entry(GPS_IFD + 2, 0x0001, 2, 2, lat >= 0 ? 'N\0' : 'S\0');
  entry(GPS_IFD + 14, 0x0002, 5, 3, LAT_AT);
  entry(GPS_IFD + 26, 0x0003, 2, 2, lng >= 0 ? 'E\0' : 'W\0');
  entry(GPS_IFD + 38, 0x0004, 5, 3, LNG_AT);
  t.writeUInt32LE(0, GPS_IFD + 50);

  t.write(`${make}\0`, MAKE_AT, 'ascii');
  t.write(`${taken}\0`, DATE_AT, 'ascii');

  const dms = (v) => {
    const a = Math.abs(v);
    const d = Math.floor(a);
    const m = Math.floor((a - d) * 60);
    return [d, m, (a - d - m / 60) * 3600];
  };
  const rats = (at, vals) =>
    vals.forEach(([n, d], i) => {
      t.writeUInt32LE(n, at + i * 8);
      t.writeUInt32LE(d, at + i * 8 + 4);
    });
  const [la, lb, lc] = dms(lat);
  rats(LAT_AT, [[la, 1], [lb, 1], [Math.round(lc * 1000), 1000]]);
  const [ga, gb, gc] = dms(lng);
  rats(LNG_AT, [[ga, 1], [gb, 1], [Math.round(gc * 1000), 1000]]);

  return t;
}

/** Returns a copy of `jpeg` with any existing APP1 replaced by ours. */
function injectExif(jpeg, opts) {
  if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) throw new Error('not a JPEG');

  const tiff = buildExifTiff(opts);
  const app1 = Buffer.concat([
    Buffer.from([0xff, 0xe1]),
    Buffer.alloc(2),
    Buffer.from('Exif\0\0', 'ascii'),
    tiff,
  ]);
  app1.writeUInt16BE(app1.length - 2, 2);

  // Walk the marker chain and drop any APP1 that is already there.
  const segments = [];
  let off = 2;
  while (off + 4 <= jpeg.length) {
    if (jpeg[off] !== 0xff) break;
    const marker = jpeg[off + 1];
    if (marker === 0xda) break; // start of scan — rest is image data
    const size = jpeg.readUInt16BE(off + 2);
    const isApp1 = marker === 0xe1 && jpeg.slice(off + 4, off + 8).toString('ascii') === 'Exif';
    if (!isApp1) segments.push(jpeg.slice(off, off + 2 + size));
    off += 2 + size;
  }

  return Buffer.concat([Buffer.from([0xff, 0xd8]), app1, ...segments, jpeg.slice(off)]);
}

module.exports = { injectExif, buildExifTiff };
