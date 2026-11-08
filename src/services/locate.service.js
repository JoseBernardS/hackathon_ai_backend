/**
 * Resolves a coordinate to the admin fields the report contract requires:
 * municipality, owning department and that department's SLA.
 *
 * Needed because a user-submitted report arrives as bare lat/lng, while the
 * 311 export carries `Municipality` and `District` on every row — and the 311
 * eligibility check is *based* on municipality. Without this, a new report
 * creates a site with no municipality and the county submit refuses it.
 *
 * The authoritative source is the county's Municipal Boundary layer. Until
 * that is wired up, this uses the 6,104 geocoded 311 records we already hold:
 * the nearest known report's municipality is the best available answer, and in
 * a county this densely reported it is almost always right.
 *
 * The result says which method produced it, so a guess is never mistaken for
 * an authoritative lookup.
 */
const Report = require('../models/Report');

// Beyond this, the nearest known report is too far away to vouch for a boundary.
const MAX_NEIGHBOUR_M = 800;

async function locate([lng, lat]) {
  const [nearest] = await Report.aggregate([
    {
      $geoNear: {
        near: { type: 'Point', coordinates: [lng, lat] },
        distanceField: 'distanceMeters',
        maxDistance: MAX_NEIGHBOUR_M,
        spherical: true,
        query: { source: '311', municipality: { $ne: null } },
      },
    },
    { $limit: 1 },
    {
      $project: {
        municipality: 1, distanceMeters: 1,
        // Which agency handles this street, and the target they publish for it.
        // Taken from the data rather than a hardcoded municipality->agency map,
        // because the 311 records already answer it per street.
        department: 1, sla: 1,
      },
    },
  ]);

  if (!nearest) {
    return {
      municipality: null, department: null, sla: null,
      method: 'none',
      confident: false,
      note: `No geocoded 311 record within ${MAX_NEIGHBOUR_M}m — location details unknown`,
    };
  }

  return {
    municipality: nearest.municipality ?? null,
    department: nearest.department ?? null,
    sla: nearest.sla ?? null,
    method: 'nearest_311_record',
    distanceMeters: Math.round(nearest.distanceMeters),
    // Close enough that a boundary crossing is unlikely.
    confident: nearest.distanceMeters <= 200,
    note: 'Derived from the nearest geocoded 311 record, not the county boundary layer',
  };
}

module.exports = { locate, MAX_NEIGHBOUR_M };
