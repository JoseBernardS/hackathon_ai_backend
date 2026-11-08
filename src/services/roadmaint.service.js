/**
 * Who maintains the road at a coordinate — the authoritative answer.
 *
 * Miami-Dade publishes a Road Maintenance layer on its public map service.
 * Each segment carries a MAINTCODE saying which government is responsible, and
 * that is what decides whether a 311 request is the county's to accept and
 * which service code it should be filed under.
 *
 * This replaces guessing from the municipality name, which was wrong in both
 * directions:
 *   - a Coral Gables street came back MAINTCODE "CM" (county maintained within
 *     city), so the county does maintain it and we were refusing it
 *   - a City of Miami street came back "CI" (city maintained), so the county
 *     does not maintain it and we were about to file it under the county's
 *     service code instead of the city's
 */
const BASE =
  process.env.MDC_MAP_URL ||
  'https://giswspro.miamidade.gov/arcgis/rest/services/311/311CRM_Display/MapServer';

const ROAD_LAYER = 8;        // Road Maintenance
const MUNI_LAYER = 1;        // Municipality Name
const SEARCH_RADIUS_M = 30;  // the spec's distance

/** MAINTCODE -> who is responsible. From the layer's own coded-value domain. */
const MAINT = {
  CO: { label: 'County maintained', owner: 'county' },
  CM: { label: 'County maintained within city', owner: 'county' },
  CC: { label: 'County/City maintained', owner: 'county' },
  CI: { label: 'City maintained', owner: 'city' },
  PC: { label: 'Private City', owner: 'city' },
  SR: { label: 'State maintained', owner: 'state' },
  AP: { label: 'Airport/Port maintained', owner: 'other' },
  IS: { label: 'Miami-Dade Internal Services', owner: 'other' },
  MT: { label: 'Transit maintained', owner: 'other' },
  PK: { label: 'Parks maintained', owner: 'other' },
  SW: { label: 'Solid Waste maintained', owner: 'other' },
  PR: { label: 'Private ROW County', owner: 'private' },
  UR: { label: 'Undeveloped ROW', owner: 'none' },
  U: { label: 'Unknown', owner: 'unknown' },
};

async function queryLayer(layer, [lng, lat], outFields) {
  const params = new URLSearchParams({
    geometry: `${lng},${lat}`,
    geometryType: 'esriGeometryPoint',
    inSR: '4326',
    distance: String(SEARCH_RADIUS_M),
    units: 'esriSRUnit_Meter',
    spatialRel: 'esriSpatialRelIntersects',
    outFields,
    returnGeometry: 'false',
    f: 'json',
  });

  const res = await fetch(`${BASE}/${layer}/query?${params}`, {
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`map service HTTP ${res.status}`);

  const body = await res.json();
  if (body.error) throw new Error(body.error.message || 'map service query failed');
  return (body.features || []).map((f) => f.attributes);
}

/**
 * Looks up the road segments and municipality at a point.
 *
 * Returns `available: false` rather than throwing when the map service is
 * unreachable, so the caller can fall back to the municipality test instead of
 * failing a resident's report.
 */
async function lookupRoad([lng, lat]) {
  try {
    const [roads, munis] = await Promise.all([
      queryLayer(ROAD_LAYER, [lng, lat], 'SNAME,MAINTCODE,STREETID'),
      queryLayer(MUNI_LAYER, [lng, lat], 'NAME'),
    ]);

    const segments = roads
      .filter((r) => r.MAINTCODE)
      .map((r) => ({
        street: r.SNAME || null,
        streetId: r.STREETID ?? null,
        maintCode: r.MAINTCODE,
        maintLabel: (MAINT[r.MAINTCODE] || {}).label || r.MAINTCODE,
        owner: (MAINT[r.MAINTCODE] || {}).owner || 'unknown',
      }));

    // A point near a junction touches several segments. Prefer a county one —
    // if any adjacent segment is the county's, the county will take the report.
    const county = segments.find((s) => s.owner === 'county');
    const nearest = county || segments[0] || null;

    return {
      available: true,
      searchRadiusMeters: SEARCH_RADIUS_M,
      segments,
      // Boundary points return more than one municipality; this keeps them all.
      municipalities: [...new Set(munis.map((m) => m.NAME).filter(Boolean))],
      maintCode: nearest ? nearest.maintCode : null,
      maintLabel: nearest ? nearest.maintLabel : null,
      owner: nearest ? nearest.owner : 'none',
      street: nearest ? nearest.street : null,
    };
  } catch (err) {
    return {
      available: false,
      error: err.message,
      segments: [],
      municipalities: [],
      maintCode: null,
      maintLabel: null,
      owner: 'unknown',
      street: null,
    };
  }
}

module.exports = { lookupRoad, MAINT, BASE, ROAD_LAYER, MUNI_LAYER, SEARCH_RADIUS_M };
