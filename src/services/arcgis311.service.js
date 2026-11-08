/**
 * Live 311 case status from Miami-Dade's public ArcGIS feature service.
 *
 * This is the same dataset the seed geojson was exported from
 * (`data_311_2026`), queryable per case number with no auth and no Salesforce
 * method names — which is why it works today while the portal's Aura lookup is
 * still blocked on an unknown method name.
 *
 * What it gives:   Status, Closed_Date, Days_to_Close, Last_Modified
 * What it does NOT: activities, outcomes, assigned crew, resident-facing
 *                   comments, stage. Those exist only in the portal's own
 *                   ticket record, so a progress *ladder* still needs that.
 *
 * Cases are queried in batches with a WHERE ... IN (...), so all 334 seeded
 * cases cost about five requests rather than 334.
 */
const BASE =
  process.env.ARCGIS_311_URL ||
  'https://services.arcgis.com/8Pc9XBTAsYuxx9Ny/arcgis/rest/services/data_311_2026/FeatureServer/0';

// Keeps the WHERE clause well inside URL length limits.
const BATCH = 80;

const FIELDS = [
  'Service_Request_Number',
  'Status',
  'Closed_Date',
  'Days_to_Close',
  'Last_Modified',
  'Department',
  'Division',
  'SLA',
  'Municipality',
  'District',
  'Zip_Code',
  'Street_Number',
].join(',');

const toDate = (ms) => (ms === null || ms === undefined ? null : new Date(ms));

/** Normalises the county's status strings the same way the seeder does. */
function normaliseStatus(raw) {
  const s = String(raw || '');
  return {
    status: s.startsWith('Open') ? 'open' : 'closed',
    isDuplicate: /Duplicate/i.test(s),
    raw: s,
  };
}

async function queryBatch(caseNumbers) {
  const where = `Service_Request_Number IN (${caseNumbers.map((c) => `'${c}'`).join(',')})`;
  const params = new URLSearchParams({
    where,
    outFields: FIELDS,
    returnGeometry: 'false',
    f: 'json',
  });

  const res = await fetch(`${BASE}/query?${params}`, {
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`ArcGIS returned HTTP ${res.status}`);

  const body = await res.json();
  if (body.error) throw new Error(`ArcGIS: ${body.error.message || 'query failed'}`);

  return (body.features || []).map((f) => {
    const a = f.attributes;
    const { status, isDuplicate, raw } = normaliseStatus(a.Status);
    return {
      caseNumber: a.Service_Request_Number,
      status,
      isDuplicate,
      countyStatusRaw: raw,
      closedAt: toDate(a.Closed_Date),
      daysToClose: a.Days_to_Close ?? null,
      lastModified: toDate(a.Last_Modified),
      department: a.Department || null,
      division: a.Division || null,
      sla: a.SLA && a.SLA !== 'No SLA Defined' ? a.SLA : null,
      municipality: a.Municipality || null,
      district: a.District ?? null,
      zip: a.Zip_Code ?? null,
      address: a.Street_Number || null,
    };
  });
}

/**
 * Looks up many case numbers. Returns a Map keyed by case number.
 * `onProgress(done, total)` is called after each batch.
 */
async function lookupCases(caseNumbers, { onProgress } = {}) {
  const unique = [...new Set(caseNumbers.filter(Boolean))];
  const found = new Map();

  for (let i = 0; i < unique.length; i += BATCH) {
    const slice = unique.slice(i, i + BATCH);
    for (const row of await queryBatch(slice)) found.set(row.caseNumber, row);
    if (onProgress) onProgress(Math.min(i + BATCH, unique.length), unique.length);
  }

  return found;
}

/** One case, for an on-demand refresh. */
async function lookupCase(caseNumber) {
  const m = await lookupCases([caseNumber]);
  return m.get(caseNumber) || null;
}

module.exports = { lookupCases, lookupCase, normaliseStatus, BASE, BATCH, FIELDS };
