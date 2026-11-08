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
const vision = require('../services/vision.service');
const ReportDraft = require('../models/ReportDraft');

/**
 * Sites and reports for any enabled category. `req.category` is the registry
 * entry, put there by middleware/category.js — nothing in here names a
 * specific category, so enabling a second one needs no changes to this file.
 */

/**
 * What to call a resident on screen.
 *
 * Never null: 2 of 15 accounts have neither a displayName nor a firstName
 * (both are optional at sign-up), and a null here reaches the client as
 * `by: null`, which breaks any renderer that takes an initial off it.
 * They passed ID onboarding, so "A resident" is accurate, not a placeholder.
 */
function residentName(user) {
  if (!user) return 'A resident';
  return user.displayName || user.firstName || 'A resident';
}

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
  // Road-ownership lookup is a network call, so the list feed reports what we
  // can know locally and the detail call does the authoritative check.
  json.canFileWith311 = null;
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
// How far out we look for "is it this one?" candidates. Wider than the dedupe
// radius on purpose: a pothole 120m away will not be auto-merged, but it is
// still worth showing the resident before they file a second pin.
const CANDIDATE_RADIUS_M = 150;

// How many "is it this one?" cards to offer. More than three is a wall.
const MAX_CANDIDATES = 3;

/** Open sites near a point, nearest first. The resident decides, not us. */
async function candidateSites(point, entry, limit = MAX_CANDIDATES) {
  const near = await Site.aggregate([
    {
      $geoNear: {
        near: { type: 'Point', coordinates: point },
        distanceField: 'distanceMeters',
        maxDistance: CANDIDATE_RADIUS_M,
        spherical: true,
        query: { categoryCode: entry.code, status: 'open' },
      },
    },
    { $sort: { distanceMeters: 1 } },
    { $limit: limit },
  ]);

  return near.map((site) => ({ site, distanceMeters: Math.round(site.distanceMeters) }));
}

/**
 * POST /api/reports/analyze — step 1 of two.
 *
 * Uploads the photo, asks the model what it shows, and returns a draft for the
 * resident to confirm. Nothing is on the map and nothing has reached the county
 * at this point; `POST /api/reports` with the returned draftId does that.
 *
 * If the model is unreachable the draft is still created, with
 * `ai.available: false` — the resident then fills the fields in by hand and the
 * flow is exactly what it was before any of this existed.
 */
async function analyzeDraft(req, res) {
  const entry = req.category;
  const point = parsePoint(req.body);

  if (!req.file) throw httpError(400, 'A photo is required — send it in the "photo" field');

  const [stored, candidates, verdict] = await Promise.all([
    uploads.putObject(req.file, `${entry.code}s`),
    candidateSites(point, entry),
    vision.analysePhoto({
      buffer: req.file.buffer,
      mimeType: req.file.mimetype,
      entry,
    }),
  ]);

  // Road ownership is deliberately NOT surfaced here. It routes the filing
  // server-side — which county or city service code the case goes under — and
  // the resident never sees it. They learn the outcome from `filedWith311`
  // after they submit, not before.

  const a = verdict.available ? verdict.analysis : {};
  const draft = await ReportDraft.create({
    categoryCode: entry.code,
    location: { type: 'Point', coordinates: point },
    address: req.body.address ? String(req.body.address).trim().slice(0, 200) : undefined,
    photoKey: stored.key,
    ai: {
      available: verdict.available,
      reason: verdict.available ? null : verdict.reason,
      model: verdict.model || null,
      matchesCategory: verdict.available ? a.matchesCategory : null,
      confidence: verdict.available ? a.confidence : null,
      subType: verdict.available ? a.subType : null,
      severity: verdict.available ? a.severity : null,
      description: verdict.available ? a.description : null,
      hazards: verdict.available ? a.hazards : [],
      rejectionReason: verdict.available ? a.rejectionReason : null,
    },
    reportedBy: req.user._id,
  });

  // What the resident is being asked to agree to. Pre-filled with the model's
  // answer where it has one, with the registry default where it does not, so
  // the form is never empty.
  const proposal = {
    subType: draft.ai.subType || entry.subtypes[0].code,
    severity: draft.ai.severity,
    description: draft.ai.description,
    hazards: draft.ai.hazards || [],
  };

  /**
   * "Is it this one?" — the cards the resident picks between.
   *
   * Deliberately just the facts and a photo. The person is standing in front of
   * the pothole; they can tell whether it is the same one from a thumbnail far
   * more reliably than anything server-side can, and for nothing.
   */
  const nearby = await Promise.all(
    candidates.map(async (c) => {
      const id = String(c.site._id);
      const key = (c.site.thumbKeys || [])[0] || (c.site.photoKeys || [])[0];
      return {
        siteId: id,
        distanceMeters: c.distanceMeters,
        reportCount: c.site.reportCount,
        endorsementCount: (c.site.endorsedBy || []).length,
        totalVoices: c.site.reportCount + (c.site.endorsedBy || []).length,
        address: c.site.address || null,
        statusLabel: describeSite(c.site).statusLabel,
        thumbnail: key ? await uploads.presign(key) : null,
        // "It affects me too" — adds their weight here, files nothing new.
        affectsMeEndpoint: `POST /api/sites/${id}/affects-me`,
      };
    })
  );

  res.status(201).json({
    draftId: draft.id,
    expiresInHours: 24,
    photo: await uploads.presign(stored.key),
    location: { lat: point[1], lng: point[0] },
    nearby,
    ai: {
      available: draft.ai.available,
      reason: draft.ai.reason,
      model: draft.ai.model,
      looksLikeCategory: draft.ai.matchesCategory,
      confidence: draft.ai.confidence,
      rejectionReason: draft.ai.rejectionReason,
    },
    proposal,
    subtypeOptions: entry.subtypes.map((t) => ({ code: t.code, label: t.label })),
    next: nearby.length
      ? 'Ask "is it one of these?" — yes: POST the site\'s affectsMeEndpoint. No: POST /api/reports with { draftId, confirmed: true, consent: true, forceNewSite: true }'
      : 'POST /api/reports with { draftId, confirmed: true, consent: true } plus any edits',
  });
}

// Multipart sends booleans as the strings "true"/"false".
function parseBool(raw) {
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (typeof raw === 'boolean') return raw;
  return ['true', '1', 'yes', 'on'].includes(String(raw).trim().toLowerCase());
}

async function createReport(req, res) {
  const entry = req.category;

  /**
   * Two ways in.
   *
   * With a draftId the resident has already seen what the AI proposed and is
   * agreeing to it, so the photo and coordinates come off the draft and the body
   * carries only their edits. Without one this is the original direct path: a
   * photo and a form, no model involved.
   */
  let draft = null;
  if (req.body.draftId) {
    draft = await ReportDraft.findById(req.body.draftId);
    if (!draft) throw httpError(404, 'Draft not found or expired — analyze the photo again');
    if (String(draft.reportedBy) !== String(req.user._id)) {
      throw httpError(403, 'That draft belongs to another account');
    }
    if (draft.status === 'used') {
      throw httpError(409, 'That draft has already been filed');
    }
    if (draft.categoryCode !== entry.code) {
      throw httpError(400, `Draft is for category "${draft.categoryCode}", not "${entry.code}"`);
    }
    // The point of the two-step flow: nothing is written until they say so.
    if (parseBool(req.body.confirmed) !== true) {
      throw httpError(400, 'Send confirmed: true to file this draft');
    }
  }

  const point = draft && req.body.lat === undefined
    ? draft.location.coordinates
    : parsePoint(req.body);

  const subtypes = new Set(entry.subtypes.map((t) => t.code));
  const subType =
    req.body.subType || (draft && draft.ai.subType) || entry.subtypes[0].code;
  if (!subtypes.has(subType)) {
    throw httpError(400, `subType must be one of: ${[...subtypes].join(', ')}`);
  }

  // The resident's text wins; the model's stands only where they left it alone.
  const ownDescription = req.body.description
    ? String(req.body.description).trim().slice(0, 1000)
    : undefined;
  const description = ownDescription || (draft ? draft.ai.description || undefined : undefined);

  const ownSeverity = Number(req.body.severity);
  const severity = Number.isInteger(ownSeverity)
    ? Math.min(5, Math.max(1, ownSeverity))
    : (draft && draft.ai.severity) || undefined;

  /**
   * Preview mode — everything except the writes.
   *
   * For demoing on stage: the eligibility check, the payload and the dedupe
   * decision are all real, the response is the same shape, and the database is
   * untouched. The draft stays unused, so the same one can be replayed.
   */
  const preview = parseBool(req.body.preview) === true;

  const photoKeys = [];
  if (draft) {
    photoKeys.push(draft.photoKey);
  } else if (req.file && !preview) {
    const stored = await uploads.putObject(req.file, `${entry.code}s`);
    photoKeys.push(stored.key);
  }

  /**
   * Which site this joins.
   *
   * `joinSiteId` — the resident said "yes, that one", so attach to it even if it
   *   sits outside the dedupe radius.
   * `forceNewSite` — they said "no, this is a different one". Geo would have
   *   merged them silently; this is how they say otherwise.
   * Neither — the original behaviour: nearest open site inside the radius.
   */
  let existing = null;
  if (req.body.joinSiteId) {
    existing = await Site.findById(req.body.joinSiteId);
    if (!existing) throw httpError(404, 'joinSiteId does not match a site');
    if (existing.categoryCode !== entry.code) {
      throw httpError(400, 'joinSiteId is a site in another category');
    }
    existing.distanceMeters = 0;
  } else if (parseBool(req.body.forceNewSite) !== true) {
    [existing] = await Site.aggregate([
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
  }

  // A user report is bare lat/lng. Resolve the admin fields the 311 submit and
  // the map legend both need, or the site ends up with no municipality.
  const placed = await locate(point);

  if (preview) {
    const shape = normalise({
      source: 'user', categoryCode: entry.code, subType, description, severity,
      aiAssisted: Boolean(draft && draft.ai.available), aiEdited: false,
      photoKeys, status: 'open',
      address: req.body.address
        ? String(req.body.address).trim().slice(0, 200)
        : (draft && draft.address) || undefined,
      location: { type: 'Point', coordinates: point },
      reportedBy: req.user._id, reportedAt: new Date(),
      siteId: existing ? existing._id : undefined,
    }, { placed: await locate(point), entry });

    const out = await mdc311.previewSubmit({
      report: { ...shape, _id: 'preview' },
      site: existing || { location: { type: 'Point', coordinates: point } },
      user: req.user,
      consent: parseBool(req.body.consent),
    });

    return res.status(200).json({
      preview: true,
      wouldCreate: {
        report: { ...shape, photos: await Promise.all(photoKeys.map((k) => uploads.presign(k))) },
        newSite: !existing,
        joiningSiteId: existing ? String(existing._id) : null,
      },
      mergedIntoExistingSite: Boolean(existing),
      distanceToSiteMeters: existing ? Math.round(existing.distanceMeters || 0) : 0,
      located: await locate(point),
      expectedDaysToClose: entry.baseline ? entry.baseline.medianDaysToClose : null,
      filedWith311: out.skipped
        ? { filed: false, reason: 'not_county_maintained', eligibility: out.eligibility }
        : {
            filed: Boolean(out.submitted),
            simulated: true,
            reason: out.failed ? out.error : null,
            caseNumber: out.ticket ? out.ticket.externalId : null,
            slaTarget: out.ticket ? out.ticket.slaTarget : null,
            expectedAt: out.ticket ? out.ticket.expectedAt : null,
            eligibility: out.eligibility,
          },
      note: 'Nothing was saved. Send without preview to file for real.',
    });
  }

  // Through the shared contract, so a user report lands with the same field
  // set as a seeded one. See services/report.schema.js.
  const report = await Report.create(normalise({
    source: 'user',
    categoryCode: entry.code,
    subType,
    description,
    severity,
    aiAssisted: Boolean(draft && draft.ai.available),
    // True when they changed what the model wrote — the honest signal for
    // whether a human actually reviewed it or just tapped through.
    aiEdited: Boolean(
      draft && draft.ai.available && (ownDescription || Number.isInteger(ownSeverity) || req.body.subType)
    ),
    photoKeys,
    status: 'open',
    address: req.body.address
      ? String(req.body.address).trim().slice(0, 200)
      : (draft && draft.address) || undefined,
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

  if (draft) {
    draft.status = 'used';
    draft.usedAt = new Date();
    draft.reportId = report._id;
    await draft.save();
  }

  // File it with the county in the same call. A 311 failure must not lose the
  // resident's report, so this never throws — the outcome is reported back.
  let filing = { filed: false, reason: 'not_attempted' };
  try {
    const out = await mdc311.submitReport({
      report,
      site,
      user: req.user,
      consent: parseBool(req.body.consent),
    });
    filing = out.skipped
      ? { filed: false, reason: 'not_county_maintained', eligibility: out.eligibility }
      : {
          filed: Boolean(out.submitted),
          // True when the case number came from MDC311_DRY_RUN, not the county.
          // Show a "simulated" badge — never present it as a real case.
          simulated: Boolean(out.simulated || (out.ticket && out.ticket.simulated)),
          alreadyFiled: Boolean(out.alreadySubmitted),
          reason: out.failed ? out.error : null,
          caseNumber: out.ticket ? out.ticket.externalId : null,
          slaTarget: out.ticket ? out.ticket.slaTarget || null : null,
          expectedAt: out.ticket ? out.ticket.expectedAt || null : null,
          eligibility: out.eligibility,
        };
  } catch (err) {
    filing = { filed: false, reason: err.message };
  }

  // A real filing stamps the report with the county case number, which is one
  // of the fields the site summarises. Rebuild so caseNumbers[] carries it.
  if (filing.caseNumber) {
    site = await rebuildSite(site._id);
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

/**
 * POST /api/sites/:id/affects-me ὑ2 — "It affects me too".
 *
 * The alternative to filing a second report on a problem already on the map:
 * it adds the resident's weight to the existing site without creating another
 * pin, another 311 case or another photo to store.
 *
 * Idempotent — $addToSet, so a double tap is the same as one. Counted apart
 * from reportCount so the two claims stay honest: one is a photographed
 * report, this is a tap.
 */
async function endorseSite(req, res) {
  const site = await Site.findById(req.params.id);
  if (!site) throw httpError(404, 'Site not found');

  const already = (site.endorsedBy || []).some((u) => String(u) === String(req.user._id));
  if (!already) {
    await Site.updateOne({ _id: site._id }, { $addToSet: { endorsedBy: req.user._id } });
  }

  const fresh = await Site.findById(site._id);
  res.json({
    siteId: String(fresh._id),
    endorsed: true,
    alreadyEndorsed: already,
    endorsementCount: (fresh.endorsedBy || []).length,
    reportCount: fresh.reportCount,
    // What to show: "29 reports and 4 others say it affects them too"
    totalVoices: fresh.reportCount + (fresh.endorsedBy || []).length,
  });
}


/**
 * POST /api/sites/:id/verify ὑ2 — "is it actually fixed?"
 *
 * The counterweight to the county's own record. A 311 case closing means the
 * agency considers the ticket done; in the 2026 export 25.1% of closed pothole
 * cases were re-reported at the same spot, 99 of them within a week. Only the
 * people who walk past it can say which.
 *
 * One answer per resident, replaced if they change their mind. A photo is
 * optional — a "still there" with a picture is worth more than one without,
 * but demanding one would silence anyone without a camera to hand.
 */
async function verifySite(req, res) {
  const site = await Site.findById(req.params.id);
  if (!site) throw httpError(404, 'Site not found');

  const fixed = parseBool(req.body.fixed);
  if (fixed === undefined) {
    throw httpError(400, 'Send fixed: true or fixed: false');
  }

  let photoKey;
  if (req.file) {
    const stored = await uploads.putObject(req.file, `verifications`);
    photoKey = stored.key;
  }

  const entry = {
    user: req.user._id,
    fixed,
    at: new Date(),
    // Denormalised: "Confirmed fixed by Maria G." must survive a rename.
    name: residentName(req.user),
    note: req.body.note ? String(req.body.note).trim().slice(0, 500) : undefined,
    photoKey,
  };

  const mine = (site.verifications || []).find((v) => String(v.user) === String(req.user._id));
  const changed = Boolean(mine) && mine.fixed !== fixed;

  // $pull then $push, so a resident who changes their mind replaces their
  // answer rather than voting twice.
  await Site.updateOne({ _id: site._id }, { $pull: { verifications: { user: req.user._id } } });
  await Site.updateOne({ _id: site._id }, { $push: { verifications: entry } });

  const fresh = await Site.findById(site._id);
  const json = fresh.toJSON();

  res.json({
    siteId: String(fresh._id),
    yourAnswer: fixed ? 'fixed' : 'not_fixed',
    changedYourAnswer: changed,
    ...json.verification,
    // What the county claims, for the UI to show side by side with the above.
    countyStatus: fresh.status,
    photo: photoKey ? await uploads.presign(photoKey) : null,
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
    roadOwnership: await mdc311.checkEligibility(json),
    /**
     * "Affects me too" state for whoever is reading.
     *
     * `youEndorsed` is false for a signed-out visitor, so the button renders
     * unpressed and the sign-in prompt happens on tap rather than on load.
     */
    verification: {
      ...json.verification,
      // null when signed out, so the sign-in prompt fires on tap not on load.
      yourAnswer: req.user
        ? (() => {
            const mine = (site.verifications || []).find(
              (v) => String(v.user) === String(req.user._id)
            );
            return mine ? (mine.fixed ? 'fixed' : 'not_fixed') : null;
          })()
        : null,
      // Names of the residents who said it is fixed — "Confirmed by Maria G."
      confirmedBy: (site.verifications || [])
        .filter((v) => v.fixed)
        .slice(-3)
        // Entries written before this fallback existed can still hold null.
        .map((v) => v.name || 'A resident'),
      /**
       * The pictures residents attached, newest first.
       *
       * This is the point of allowing a photo at all: a "still there" with an
       * image is evidence someone can hold up against the county's "Inspection
       * Completed". Storing it and never showing it would be theatre.
       */
      evidence: await Promise.all(
        (site.verifications || [])
          .filter((v) => v.photoKey)
          .slice(-6)
          .reverse()
          .map(async (v) => ({
            says: v.fixed ? 'fixed' : 'not_fixed',
            by: v.name || 'A resident',
            at: v.at,
            note: v.note || null,
            photo: await uploads.presign(v.photoKey),
          }))
      ),
      endpoint: `POST /api/sites/${site.id}/verify`,
    },
    endorsement: {
      endorsementCount: (site.endorsedBy || []).length,
      totalVoices: site.reportCount + (site.endorsedBy || []).length,
      youEndorsed: Boolean(
        req.user && (site.endorsedBy || []).some((u) => String(u) === String(req.user._id))
      ),
      endpoint: `POST /api/sites/${site.id}/affects-me`,
    },
    // The county's own view of the case, folded in here rather than behind a
    // separate tickets endpoint. Null when no ticket has been filed.
    progress: ticket ? countyProgress(ticket) : null,
    // daysToClose is derived, not stored — the two dates are the truth.
    reports: reports.map((r) => ({ ...r.toJSON(), daysToClose: daysToClose(r) })),
  });
}

module.exports = {
  listSites, analyzeDraft, createReport, myReports, getSite, endorseSite, verifySite,
};
