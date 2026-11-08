/**
 * Pothole deduplication.
 *
 * Reports within SITE_RADIUS_M of a site's centroid are the same pothole. The
 * radius is applied against the running centroid (leader clustering) rather
 * than nearest-neighbour, which is what stops a street's worth of potholes
 * chaining into one giant blob: single-link at 150m produced a 1,033m cluster,
 * leader clustering at 100m keeps the widest site at 91m.
 */
const SITE_RADIUS_M = 100;


// Rolls a list of reports up into the fields of one site.
function summarise(reports) {
  const open = reports.filter((r) => r.status === 'open');
  // daysToClose is no longer stored — it is the two dates subtracted.
  const closedDurations = reports
    .filter((r) => r.status === 'closed' && r.closedAt && r.reportedAt)
    .map((r) => (new Date(r.closedAt) - new Date(r.reportedAt)) / 86400000);
  const times = reports.map((r) => new Date(r.reportedAt).getTime());

  // Describe the site by its most recent report: freshest address and agency.
  const newest = reports.reduce((a, b) => (new Date(a.reportedAt) > new Date(b.reportedAt) ? a : b));

  /**
   * The newest report that actually has this field.
   *
   * A user-submitted report carries less than a 311 export row — it has no
   * division, and may have no municipality if the coordinate is far from any
   * known record. Reading such a field straight off `newest` would blank it on
   * the site as soon as someone reported from the app.
   */
  const byRecency = [...reports].sort((a, b) => new Date(b.reportedAt) - new Date(a.reportedAt));
  const freshest = (field) => {
    const hit = byRecency.find((r) => r[field] !== undefined && r[field] !== null && r[field] !== '');
    return hit ? hit[field] : undefined;
  };

  let lng = 0;
  let lat = 0;
  for (const r of reports) {
    lng += r.location.coordinates[0];
    lat += r.location.coordinates[1];
  }

  return {
    categoryCode: newest.categoryCode,
    location: { type: 'Point', coordinates: [lng / reports.length, lat / reports.length] },
    status: open.length ? 'open' : 'closed',
    reportCount: reports.length,
    openCount: open.length,
    userReportCount: reports.filter((r) => r.source === 'user').length,
    firstReportedAt: new Date(Math.min(...times)),
    lastReportedAt: new Date(Math.max(...times)),
    oldestOpenAt: open.length
      ? new Date(Math.min(...open.map((r) => new Date(r.reportedAt).getTime())))
      : undefined,
    address: freshest('address'),
    municipality: freshest('municipality'),
    // Newest-first, so caseNumbers[0] is the most recent complaint at this spot.
    caseNumbers: byRecency.map((r) => r.sourceId).filter(Boolean).slice(0, 30),
    latestCaseNumber: freshest('sourceId'),
    subtypes: [...new Set(reports.map((r) => r.subType).filter(Boolean))],
    department: freshest('department'),
    sla: freshest('sla'),
    avgDaysToClose: closedDurations.length
      ? Math.round((closedDurations.reduce((a, b) => a + b, 0) / closedDurations.length) * 10) / 10
      : undefined,
    photoKeys: reports.flatMap((r) => r.photoKeys || []).slice(0, 12),
    thumbKeys: reports.flatMap((r) => r.thumbKeys || []).slice(0, 12),
  };
}

// Metres per degree at Miami's latitude — good enough over a 100m window.
const M_PER_DEG_LAT = 110900;
const M_PER_DEG_LNG = 100300;

function metresBetween([lng1, lat1], [lng2, lat2]) {
  const dx = (lng1 - lng2) * M_PER_DEG_LNG;
  const dy = (lat1 - lat2) * M_PER_DEG_LAT;
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * Groups reports into sites. Reports must be sorted oldest-first so the result
 * is deterministic: the earliest report at a spot seeds the site.
 * Returns an array of arrays of reports.
 */
function clusterReports(reports, radius = SITE_RADIUS_M) {
  const cell = radius;
  const grid = new Map(); // "gx,gy" -> site indexes
  const sites = []; // { lng, lat, n, members }

  const key = (gx, gy) => `${gx},${gy}`;

  for (const r of reports) {
    const [lng, lat] = r.location.coordinates;
    const gx = Math.floor((lng * M_PER_DEG_LNG) / cell);
    const gy = Math.floor((lat * M_PER_DEG_LAT) / cell);

    let best = -1;
    let bestDist = radius;
    for (let dx = -1; dx <= 1; dx += 1) {
      for (let dy = -1; dy <= 1; dy += 1) {
        for (const si of grid.get(key(gx + dx, gy + dy)) || []) {
          const d = metresBetween([lng, lat], [sites[si].lng, sites[si].lat]);
          if (d < bestDist) {
            bestDist = d;
            best = si;
          }
        }
      }
    }

    if (best === -1) {
      sites.push({ lng, lat, n: 1, members: [r] });
      const k = key(gx, gy);
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k).push(sites.length - 1);
    } else {
      const s = sites[best];
      s.lng = (s.lng * s.n + lng) / (s.n + 1);
      s.lat = (s.lat * s.n + lat) / (s.n + 1);
      s.n += 1;
      s.members.push(r);
    }
  }

  return sites.map((s) => s.members);
}

module.exports = { SITE_RADIUS_M, clusterReports, summarise, metresBetween };
