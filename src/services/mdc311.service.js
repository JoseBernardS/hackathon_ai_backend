/**
 * Submitting and tracking Miami-Dade 311 tickets.
 *
 * Three things this is careful about:
 *
 *   1. Eligibility. The county only accepts roadway requests it actually owns.
 *      Filing one for a Coral Gables street wastes the resident's time and
 *      pollutes the county's queue, so we check before we send.
 *   2. Idempotency. A submissionKey is written before the POST, so a retry
 *      after a lost response cannot file a second ticket for the same pothole.
 *   3. Provenance. Every status change is appended to StatusEvent with the
 *      county field that justified it, and the county's record is never merged
 *      into our own report rows.
 */
const crypto = require('crypto');

const client = require('./mdc311.client');
const { lookupRoad } = require('./roadmaint.service');
const Report = require('../models/Report');
const Site = require('../models/Site');
const ExternalTicket = require('../models/ExternalTicket');
const StatusEvent = require('../models/StatusEvent');
const ServiceDefinition = require('../models/ServiceDefinition');
const {
  deriveStatus, buildTimeline, stagesFromTicket, sanitiseTicket,
} = require('./mdc311.status');
const config = require('../data/mdc311-pothole.json');

const LOOKUP_CACHE_MS = 10 * 60 * 1000; // spec: cache lookups 10 minutes

/* ------------------------------ eligibility ------------------------------ */

/**
 * Who maintains this road, and therefore whether we can file it and under
 * which service code.
 *
 * Reads the county's own Road Maintenance layer. The municipality name is only
 * a fallback for when that service is unreachable, and it is marked as such —
 * it was wrong in both directions: a Coral Gables street is MAINTCODE "CM"
 * (county maintained within city) so the county does take it, and a City of
 * Miami street is "CI" so the county does not.
 */
async function checkEligibility(site) {
  const road = await lookupRoad(site.location.coordinates);

  if (road.available && road.maintCode) {
    const muni = (road.municipalities[0] || site.municipality || '').toUpperCase();
    const serviceCode =
      road.owner === 'county'
        ? config.serviceCodeByRoadOwner.county
        : road.owner === 'city'
          ? config.serviceCodeByRoadOwner[`city:${muni}`] || null
          : null;

    return {
      eligible: Boolean(serviceCode),
      serviceCode,
      municipality: road.municipalities[0] || site.municipality || null,
      municipalities: road.municipalities,
      street: road.street,
      maintCode: road.maintCode,
      maintLabel: road.maintLabel,
      roadOwner: road.owner,
      reason: serviceCode
        ? `${road.street || 'This road'} is ${road.maintLabel.toLowerCase()} — filed under ${serviceCode}`
        : `${road.street || 'This road'} is ${road.maintLabel.toLowerCase()} — 311 does not accept it`,
      basis: 'road_maintenance_layer',
      authoritativeCheckAvailable: true,
    };
  }

  // Fallback: the map service is down. County-served municipalities only.
  const muni = (site.municipality || '').toUpperCase();
  const eligible = muni === 'UNINCORPORATED MIAMI-DADE';
  return {
    eligible,
    serviceCode: eligible ? config.serviceCodeByRoadOwner.county : null,
    municipality: site.municipality || null,
    municipalities: [],
    street: null,
    maintCode: null,
    maintLabel: null,
    roadOwner: 'unknown',
    reason: road.error
      ? `Road maintenance lookup unavailable (${road.error}); falling back to municipality`
      : 'No road segment found within 30m of this point',
    basis: 'municipality_fallback',
    authoritativeCheckAvailable: false,
  };
}

/* -------------------------------- payload -------------------------------- */

function buildPayload({ site, report, user, serviceCode = config.serviceCode }) {
  const [lng, lat] = site.location.coordinates;
  const attribute = { ...config.attributeDefaults };

  const mapped = config.subTypeToAttribute[report.subType];
  if (mapped) attribute['01PL-ROADWAYISSUE'] = mapped;

  return {
    service_code: serviceCode,
    attribute,
    reported_lat: lat,
    reported_lng: lng,
    address_string: report.address || site.address || '',
    language: 'EN',
    Dynamic_Questions: [],
    contact: {
      first_name: user.firstName || '',
      last_name: user.lastName || '',
      email: user.email || '',
      phone: user.phone || '',
    },
    user_consent: true,
    consent_message: '',
  };
}

/** Missing contact fields the county requires. */
function missingContactFields(user) {
  return ['firstName', 'lastName', 'email', 'phone'].filter((f) => !user[f]);
}

/* -------------------------------- submit --------------------------------- */

async function submitReport({ report, site, user }) {
  const eligibility = await checkEligibility(site);
  if (!eligibility.eligible) {
    return { skipped: true, eligibility };
  }

  const missing = missingContactFields(user);
  if (missing.length) {
    const err = new Error(`311 requires ${missing.join(', ')} on the account before a ticket can be filed`);
    err.status = 400;
    throw err;
  }

  // One ticket per report, ever. The key is derived, so a retry collides.
  const submissionKey = crypto
    .createHash('sha256')
    .update(`mdc311|${eligibility.serviceCode}|${report._id}`)
    .digest('hex')
    .slice(0, 32);

  const existing = await ExternalTicket.findOne({ submissionKey });
  if (existing && existing.status !== 'failed') {
    return { alreadySubmitted: true, ticket: existing, eligibility };
  }

  const payload = buildPayload({ site, report, user, serviceCode: eligibility.serviceCode });

  // Written BEFORE the POST: if the response is lost, the row is still here.
  const ticket =
    existing ||
    (await ExternalTicket.create({
      source: 'mdc311',
      submissionKey,
      reportId: report._id,
      siteId: site._id,
      submittedBy: user._id,
      serviceCode: eligibility.serviceCode,
      serviceName: config.serviceName,
      status: 'pending',
      requestPayload: payload,
    }));

  let result;
  try {
    result = await client.createServiceRequest(payload);
  } catch (err) {
    ticket.status = 'failed';
    ticket.lastError = `${err.kind || 'error'}: ${err.message}`;
    await ticket.save();
    return { failed: true, ticket, eligibility, error: ticket.lastError };
  }

  if (result.dryRun) {
    ticket.status = 'dry_run';
    ticket.lastError = undefined;
    await ticket.save();
    return { dryRun: true, ticket, eligibility, wouldSend: result.wouldSend };
  }

  const clean = sanitiseTicket(result.response || {});
  Object.assign(ticket, clean, { status: deriveStatus(result.response || {}).status });
  ticket.lastCheckedAt = new Date();
  await ticket.save();

  await StatusEvent.create({
    ticketId: ticket._id,
    reportId: report._id,
    siteId: site._id,
    from: 'pending',
    status: ticket.status,
    source: 'mdc311_submit',
    evidence: { externalId: clean.externalId, requestedDatetime: clean.openedAt },
  });

  return { submitted: true, ticket, eligibility };
}

/* ------------------------------- backfill -------------------------------- */

/**
 * Adopts a county case we did not file — a row from the 311 bulk export — so it
 * can be tracked like any other ticket.
 *
 * Returns the ticket without contacting the county. Enriching it is
 * refreshTicket's job, which keeps the slow network step separate from the
 * cheap bookkeeping and makes a backfill resumable.
 */
async function adoptReport(report, { siteId } = {}) {
  if (!report.sourceId) return { skipped: 'no county case number' };

  const existing = await ExternalTicket.findOne({ source: 'mdc311', externalId: report.sourceId });
  if (existing) return { ticket: existing, alreadyTracked: true };

  const ticket = await ExternalTicket.create({
    source: 'mdc311',
    origin: 'imported',
    externalId: report.sourceId,
    reportId: report._id,
    siteId: siteId || report.siteId,
    serviceCode: config.serviceCode,
    serviceName: config.serviceName,
    status: 'imported',
    // What the bulk export already told us, so a ticket is useful before any
    // lookup. A refresh replaces these with the county's live record.
    openedAt: report.reportedAt,
    closedAt: report.closedAt || undefined,
  });

  return { ticket, adopted: true };
}

/* -------------------------------- tracking ------------------------------- */

/** Cached stage ladder for a service code. */
// Subdocument _ids are storage noise, not part of the contract.
const cleanStages = (stages = []) =>
  stages.map(({ index, code, name, kind }) => ({ index, code, name, kind }));

async function stagesFor(serviceCode, ticket = null) {
  // Prefer the ticket's own activities — authoritative and always available.
  if (ticket && Array.isArray(ticket.activities) && ticket.activities.length) {
    return cleanStages(stagesFromTicket({ activities: ticket.activities.map((a) => ({ code: a.code, name: a.name, order: a.order })) }));
  }
  const def = await ServiceDefinition.findOne({ source: 'mdc311', serviceCode }).lean();
  if (def && def.stages && def.stages.length) return cleanStages(def.stages);

  // No definition cached yet — try to fetch it, but never fail the lookup
  // just because the schema is unavailable.
  try {
    const raw = await client.getServiceDefinition(serviceCode);
    const stages = stagesFromDefinition(raw || {});
    await ServiceDefinition.findOneAndUpdate(
      { source: 'mdc311', serviceCode, language: 'EN' },
      {
        $set: {
          serviceName: (raw && raw.service_name) || undefined,
          serviceLevelAgreement: (raw && raw.service_level_agreement) || undefined,
          requiredReporterFields:
            (raw && raw.definitions && raw.definitions.reporter && raw.definitions.reporter.required_fields) || [],
          raw,
          stages,
          fetchedAt: new Date(),
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    return cleanStages(stages);
  } catch {
    return [];
  }
}

/**
 * Refresh one ticket from the county. `force` bypasses the 10-minute cache.
 * `source` records which sweep produced any change.
 */
async function refreshTicket(ticket, { force = false, source = 'mdc311_lookup' } = {}) {
  if (!ticket.externalId) return { ticket, skipped: 'no external id yet' };

  const fresh =
    ticket.lastCheckedAt && Date.now() - ticket.lastCheckedAt.getTime() < LOOKUP_CACHE_MS;
  if (fresh && !force) return { ticket, cached: true };

  const raw = await client.getServiceRequest(ticket.externalId);

  // Spec: an empty array means keep the last known status, retry next sweep.
  if (!raw || (Array.isArray(raw) && raw.length === 0)) {
    ticket.lastCheckedAt = new Date();
    ticket.checkCount += 1;
    await ticket.save();
    return { ticket, empty: true };
  }

  const record = Array.isArray(raw) ? raw[0] : raw;
  const clean = sanitiseTicket(record);
  const { status, because } = deriveStatus(record);
  const from = ticket.status;

  Object.assign(ticket, clean);
  ticket.status = status;
  ticket.lastCheckedAt = new Date();
  ticket.checkCount += 1;
  await ticket.save();

  if (from !== status) {
    await StatusEvent.create({
      ticketId: ticket._id,
      reportId: ticket.reportId,
      siteId: ticket.siteId,
      from,
      status,
      source,
      evidence: {
        externalId: clean.externalId,
        because,
        countyTimestamp: clean.closedAt || clean.canceledAt || clean.openedAt,
        ownerName: clean.ownerName,
      },
    });
  }

  // The ladder is derived from the ticket's own activities[].order, so the
  // non-existent getServiceDefinition is not needed.
  return { ticket, changed: from !== status, timeline: buildTimeline(record) };
}

/** The open tickets due a check, oldest first. Rate limiting is the caller's job. */
function openTicketsDueCheck(limit = 50) {
  return ExternalTicket.find({
    status: { $in: ['reported', 'acknowledged', 'in_progress'] },
    externalId: { $ne: null },
  })
    .sort({ lastCheckedAt: 1 })
    .limit(limit);
}

module.exports = {
  checkEligibility, buildPayload, missingContactFields,
  submitReport, adoptReport, refreshTicket, openTicketsDueCheck, stagesFor,
  LOOKUP_CACHE_MS, config,
};
