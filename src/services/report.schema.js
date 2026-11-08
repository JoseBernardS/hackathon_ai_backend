/**
 * The minimal contract every report obeys, whatever produced it.
 *
 * Deliberately small. Every field here is either impossible to do without, or
 * is read by a feature that users can see. Anything redundant, derivable, or
 * only sometimes available has been removed — a field that one ingest path
 * fills and another does not is a bug waiting to happen, and this session has
 * already produced four of them.
 *
 * Removed on purpose, and why:
 *   city           identical to municipality on every observed row
 *   division       nothing branches on it
 *   zip, district  nothing reads them
 *   priority       "Standard" on effectively every row
 *   isDuplicate    reportCount on the site already says it better
 *   daysToClose    closedAt - reportedAt; storing it is what produced
 *                  "closed after 0 days" sitting next to an open pothole
 *   categoryLabel  look it up from the category registry
 *   group          same
 *
 * Two tiers only:
 *   CORE    present and non-null on every report, always
 *   OPTIONAL legitimately absent depending on origin, always present as null
 */

const CORE = {
  source: '311 | user — which pipeline produced this row',
  categoryCode: 'the reportable category; its label and group come from the registry',
  location: 'GeoJSON Point, [lng, lat]',
  status: 'open | closed',
  reportedAt: 'when it was filed',
  siteId: 'the deduplicated location it belongs to',
  municipality: 'decides whether the county will accept a 311 ticket',
  department: 'the owning agency — 311 routing, and which SLA applies',
  sla: "the agency's published target; drives the overdue colour",
  subType: "the category subtype; defaults to the category's first",
};

const OPTIONAL = {
  sourceId: '311 case number. Seed rows have one; a user row gets one after a 311 submit',
  address: 'street address — genuinely unknown for some coordinates',
  closedAt: 'only once the county closes it',
  description: 'user reports only — the bulk export carries no free text',
  reportedBy: 'user reports only',
  photoKeys: 'both paths',
  thumbKeys: 'seed only — the one intentional asymmetry, see note below',
  severity: 'user reports only — proposed from the photo, confirmed by the resident',
  aiAssisted: 'user reports only — was a photo analysis offered for this report',
  aiEdited: 'user reports only — did the resident change what the model proposed',
};

/**
 * `thumbKeys` is the single field that differs by path, and it is kept on
 * purpose: a map pin loads a 13KB thumbnail instead of a 116KB photo. It is
 * never uncertain — it is populated or an empty array — and the display block
 * falls back to the full photo when it is empty. Generating thumbnails on
 * upload would close the gap; until then this is a deliberate trade.
 */

const ALL_FIELDS = { ...CORE, ...OPTIONAL };
const ARRAY_FIELDS = new Set(['photoKeys', 'thumbKeys']);

/** Fills every contract field, so the two ingest paths cannot diverge. */
function normalise(raw, { placed = {}, entry = {} } = {}) {
  const primaryDepartment = (entry.departments || Object.keys(entry.sla || {}))[0] || null;
  const out = {};

  for (const f of Object.keys(ALL_FIELDS)) out[f] = raw[f];

  out.municipality = raw.municipality ?? placed.municipality ?? null;
  out.department = raw.department ?? placed.department ?? primaryDepartment ?? null;
  out.sla = raw.sla ?? placed.sla ?? (entry.sla || {})[out.department] ?? null;
  out.subType =
    raw.subType ?? (entry.subtypes && entry.subtypes[0] ? entry.subtypes[0].code : null);

  for (const f of ARRAY_FIELDS) out[f] = Array.isArray(raw[f]) ? raw[f] : [];
  for (const f of Object.keys(OPTIONAL)) {
    if (out[f] === undefined && !ARRAY_FIELDS.has(f)) out[f] = null;
  }

  return out;
}

/** Fields missing where the contract says they should not be. */
function auditReports(reports) {
  const problems = {};
  const note = (field, report, why) => {
    problems[field] = problems[field] || { count: 0, why, examples: [] };
    problems[field].count += 1;
    if (problems[field].examples.length < 3) {
      problems[field].examples.push(report.sourceId || String(report._id));
    }
  };

  for (const r of reports) {
    for (const f of Object.keys(CORE)) {
      if (r[f] === undefined || r[f] === null) note(f, r, 'CORE field missing');
    }
    if (r.status === 'closed' && !r.closedAt) note('closedAt', r, 'closed but no closedAt');
    if (r.source === '311' && !r.sourceId) note('sourceId', r, '311 row with no case number');
  }

  return problems;
}

/** Days a closed report took, computed rather than stored. */
function daysToClose(report) {
  if (!report.closedAt || !report.reportedAt) return null;
  const d = (new Date(report.closedAt) - new Date(report.reportedAt)) / 86400000;
  return Math.round(d * 10) / 10;
}

module.exports = { CORE, OPTIONAL, ALL_FIELDS, normalise, auditReports, daysToClose };
