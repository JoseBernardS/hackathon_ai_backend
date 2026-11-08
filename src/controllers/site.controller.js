const Report = require('../models/Report');
const Site = require('../models/Site');
const uploads = require('../services/upload.service');
const { rebuildSite, compose } = require('../services/site.service');
const categories = require('../services/categories.service');
const ExternalTicket = require('../models/ExternalTicket');
const { describeSite } = require('../services/display.service');
const { locate } = require('../services/locate.service');
const { normalise, daysToClose } = require('../services/report.schema');
const { buildTimeline, stagesFromTicket } = require('../services/mdc311.status');
const mdc311 = require('../services/mdc311.service');

/**
 * Sites and reports for any enabled category. `req.category` is the registry
 * entry, put there by middleware/category.js — nothing in here names a
 * specific category, so enabling a second one needs no changes to this file.
 */

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function parsePoint(q, { required = true } = {}) {
  const lat = Number(q.lat);
  const lng = Number(q.lng);
  if (q.lat === undefined && q.lng === undefined) {
    if (required) throw httpError(400, 'lat and lng are required');
    return null;
  }
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) throw httpError(400, 'lat and lng must be numbers');
  if (lat < 25.1 || lat > 26.1 || lng < -80.9 || lng > -80.0) {
    throw httpError(400, 'Coordinates are outside Miami-Dade County');
  }
  return [lng, lat];
}

function parseRadius(raw, fallback, max = 20000) {
  if (raw === undefined) return fallback;
  const r = Number(raw);
  if (!Number.isFinite(r) || r <= 0) throw httpError(400, 'radius must be a positive number of meters');
  return Math.min(r, max);
}

// `status` defaults to 'open' on the map feed: a resolved pothole is history,
// not something to put a pin on. Pass status=all to get everything.
function parseStatus(raw, fallback = 'open') {
  const s = raw === undefined ? fallback : String(raw);
  if (!['open', 'closed', 'all'].includes(s)) {
    throw httpError(400, 'status must be "open", "closed" or "all"');
  }
  return s;
}

// Corpus totals for the "6,104 reports -> 3,101 sites" line in the UI. They only
// change on a re-seed or a new submission, so cache them for a minute.
const totalsCache = new Map();
async function dedupeTotals(entry) {
  const hit = totalsCache.get(entry.code);
  if (hit && Date.now() - hit.at < 60000) return hit.value;
  const [totalSites, totalReports] = await Promise.all([
    Site.countDocuments({ categoryCode: entry.code }),
    Report.countDocuments({ categoryCode: entry.code }),
  ]);
  const value = { category: entry.code, siteRadiusMeters: entry.dedupeRadiusMeters, totalSites, totalReports };
  totalsCache.set(entry.code, { at: Date.now(), value });
  return value;
}

/**
 * List payloads get a presigned thumbnail (and one full photo) per site, so a
 * map pin has something to render without a second request. Presigning is
 * local HMAC — no network call — so doing it per row is cheap.
 */
async function withThumbs(doc, { maxThumbs = 3, ticketsBySite, entry } = {}) {
  const json = doc.toJSON ? doc.toJSON() : doc;
  const [thumbnails, photos] = await Promise.all([
    Promise.all((json.thumbKeys || []).slice(0, maxThumbs).map((k) => uploads.presign(k))),
    Promise.all((json.photoKeys || []).slice(0, 1).map((k) => uploads.presign(k))),
  ]);
  json.thumbnails = thumbnails;
  json.photos = photos;
  // Six ready-to-render strings, so a pin needs no client-side logic.
  json.display = describeSite(json, ticketsBySite ? ticketsBySite.get(String(json.id)) : null, entry);
  // Whether the county would accept a ticket here — a field, not an endpoint.
  json.canFileWith311 = mdc311.checkEligibility(json).eligible;
  return json;
}

/**
 * The county's progress on a ticket, rebuilt from what we stored so this needs
 * no call to the county. Shape matches what mdc311.status produces live.
 */
function countyProgress(ticket) {
  const replay = {
    service_request_id: ticket.externalId,
    requested_datetime: ticket.openedAt,
    expected_datetime: ticket.expectedAt,
    closed_datetime: ticket.closedAt,
    canceled_datetime: ticket.canceledAt,
    last_updated_datetime: ticket.lastUpdatedAt,
    service_level_agreement: ticket.slaTarget || undefined,
    owner: ticket.ownerName ? { name: ticket.ownerName } : undefined,
    activities: (ticket.activities || []).map((a) => ({
      code: a.code,
      name: a.name,
      order: a.order,
      status: a.status,
      completion_date: a.completionDate,
      external_comments: a.externalComments,
      outcome: a.outcome ? { name: a.outcome, action: a.outcomeAction } : undefined,
    })),
    events: (ticket.events || []).map((e) => ({ event_datetime: e.at, notes: e.description })),
  };

  const t = buildTimeline(replay);
  return {
    caseNumber: ticket.externalId,
    status: t.status,
    outcome: t.outcome,
    statusBecause: t.statusBecause,
    stage: t.stage,
    stages: stagesFromTicket(replay),
    owner: t.owner,
    slaTarget: t.slaTarget,
    sla: t.sla,
    lastUpdatedAt: t.lastUpdatedAt,
    countyPhotos: ticket.countyPhotos || [],
    events: t.events,
    checkedAt: ticket.lastCheckedAt || null,
  };
}

// One query for the whole page's tickets rather than one per site.
async function ticketsFor(sites) {
  const ids = sites.map((s) => s._id || s.id);
  const tickets = await ExternalTicket.find({ siteId: { $in: ids } })
    .sort({ createdAt: -1 })
    .select('siteId status externalId expectedAt closedAt slaTarget')
    .lean();
  const bySite = new Map();
  for (const t of tickets) if (!bySite.has(String(t.siteId))) bySite.set(String(t.siteId), t);
  return bySite;
}

async function withPhotoUrls(doc) {
  const json = doc.toJSON ? doc.toJSON() : doc;
  const [photos, thumbnails] = await Promise.all([
    Promise.all((json.photoKeys || []).map((k) => uploads.presign(k))),
    Promise.all((json.thumbKeys || []).map((k) => uploads.presign(k))),
  ]);
  if (photos.length) json.photos = photos;
  if (thumbnails.length) json.thumbnails = thumbnails;
  return json;
}

// GET /api/sites?category=<code>&lat=&lng=&radius=&status=&minReports=&limit=
// Deduplicated map feed: one pin per pothole, open only by default.
async function listSites(req, res) {
  const point = parsePoint(req.query, { required: false });
  const status = parseStatus(req.query.status);
  const limit = Math.min(Number(req.query.limit) || 200, 1000);

  const filter = { categoryCode: req.category.code };
  if (status !== 'all') filter.status = status;
  if (req.query.minReports) {
    const m = Number(req.query.minReports);
    if (!Number.isFinite(m) || m < 1) throw httpError(400, 'minReports must be a positive number');
    filter.reportCount = { $gte: m };
  }

  let sites;
  let radius = null;

  if (point) {
    // $geoNear so each row carries its distance — which is what makes a small
    // radius double as the "already reported here?" check.
    radius = parseRadius(req.query.radius, 3000);
    sites = await Site.aggregate([
      {
        $geoNear: {
          near: { type: 'Point', coordinates: point },
          distanceField: 'distanceMeters',
          maxDistance: radius,
          spherical: true,
          query: filter,
        },
      },
      { $limit: limit },
    ]);
    sites = sites.map((s) => ({ ...s, id: s._id, distanceMeters: Math.round(s.distanceMeters) }));
  } else {
    sites = (await Site.find(filter).sort({ reportCount: -1, lastReportedAt: -1 }).limit(limit)).map(
      (s) => s.toJSON()
    );
  }

  const ticketsBySite = await ticketsFor(sites);
  res.json({
    count: sites.length,
    radiusMeters: radius,
    sites: await Promise.all(sites.map((s) => withThumbs(s, { ticketsBySite, entry: req.category }))),
  });
}

// POST /api/reports   (auth required, multipart/form-data, photo field: "photo")
// Attaches to the existing site when there is one, so the map gains no new pin.
async function createReport(req, res) {
  const entry = req.category;
  const point = parsePoint(req.body);

  const subtypes = new Set(entry.subtypes.map((t) => t.code));
  const subType = req.body.subType || entry.subtypes[0].code;
  if (!subtypes.has(subType)) {
    throw httpError(400, `subType must be one of: ${[...subtypes].join(', ')}`);
  }

  const photoKeys = [];
  if (req.file) {
    const stored = await uploads.putObject(req.file, `${entry.code}s`);
    photoKeys.push(stored.key);
  }

  const [existing] = await Site.aggregate([
    {
      $geoNear: {
        near: { type: 'Point', coordinates: point },
        distanceField: 'distanceMeters',
        maxDistance: entry.dedupeRadiusMeters,
        spherical: true,
        query: { categoryCode: entry.code },
      },
    },
    { $sort: { status: -1, distanceMeters: 1 } },
    { $limit: 1 },
  ]);

  // A user report is bare lat/lng. Resolve the admin fields the 311 submit and
  // the map legend both need, or the site ends up with no municipality.
  const placed = await locate(point);

  // Through the shared contract, so a user report lands with the same field
  // set as a seeded one. See services/report.schema.js.
  const report = await Report.create(normalise({
    source: 'user',
    categoryCode: entry.code,
    subType,
    description: req.body.description ? String(req.body.description).trim().slice(0, 1000) : undefined,
    photoKeys,
    status: 'open',
    address: req.body.address ? String(req.body.address).trim().slice(0, 200) : undefined,
    location: { type: 'Point', coordinates: point },
    reportedBy: req.user._id,
    reportedAt: new Date(),
    siteId: existing ? existing._id : undefined,
  }, { placed, entry }));

  let site;
  if (existing) {
    site = await rebuildSite(existing._id);
  } else {
    site = await Site.create(compose([report.toObject()]));
    await Report.updateOne({ _id: report._id }, { $set: { siteId: site._id } });
    report.siteId = site._id;
  }

  // File it with the county in the same call. A 311 failure must not lose the
  // resident's report, so this never throws — the outcome is reported back.
  let filing = { filed: false, reason: 'not_attempted' };
  try {
    const out = await mdc311.submitReport({ report, site, user: req.user });
    filing = out.skipped
      ? { filed: false, reason: 'not_county_maintained', eligibility: out.eligibility }
      : {
          filed: Boolean(out.submitted),
          dryRun: Boolean(out.dryRun),
          alreadyFiled: Boolean(out.alreadySubmitted),
          reason: out.failed ? out.error : null,
          caseNumber: out.ticket ? out.ticket.externalId : null,
          eligibility: out.eligibility,
        };
  } catch (err) {
    filing = { filed: false, reason: err.message };
  }

  res.status(201).json({
    report: await withPhotoUrls(report),
    site: await withPhotoUrls(site),
    mergedIntoExistingSite: Boolean(existing),
    distanceToSiteMeters: existing ? Math.round(existing.distanceMeters) : 0,
    located: placed,
    expectedDaysToClose: entry.baseline ? entry.baseline.medianDaysToClose : null,
    filedWith311: filing,
  });
}

// GET /api/reports/mine   (auth required)
// All the caller's reports, or one category's with ?category=<code>.
async function myReports(req, res) {
  const filter = { reportedBy: req.user._id };
  if (req.category) filter.categoryCode = req.category.code;

  const reports = await Report.find(filter).sort({ reportedAt: -1 }).limit(100);
  res.json({
    category: req.category ? req.category.code : 'all',
    count: reports.length,
    reports: await Promise.all(reports.map(withPhotoUrls)),
  });
}

// GET /api/sites/:id   — a site plus every report behind it
async function getSite(req, res) {
  const site = await Site.findById(req.params.id).catch(() => null);
  if (!site) throw httpError(404, 'Site not found');

  const reports = await Report.find({ siteId: site._id })
    .sort({ reportedAt: -1 })
    .select('source sourceId status subType description reportedAt closedAt address department photoKeys thumbKeys');

  const ticket = await ExternalTicket.findOne({ siteId: site._id }).sort({ createdAt: -1 }).lean();
  const json = await withPhotoUrls(site);

  res.json({
    ...json,
    display: describeSite(json, ticket, categories.get(site.categoryCode)),
    canFileWith311: mdc311.checkEligibility(json).eligible,
    // The county's own view of the case, folded in here rather than behind a
    // separate tickets endpoint. Null when no ticket has been filed.
    progress: ticket ? countyProgress(ticket) : null,
    // daysToClose is derived, not stored — the two dates are the truth.
    reports: reports.map((r) => ({ ...r.toJSON(), daysToClose: daysToClose(r) })),
  });
}

module.exports = { listSites, createReport, myReports, getSite };
