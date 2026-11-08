/**
 * Reconciles the county's resolution record against peer-reported outcomes.
 *
 * These are two independent channels and they disagree often enough to be the
 * most interesting thing in the data:
 *
 *   county  — a 311 case marked Closed. Authoritative about the *ticket*, not
 *             about the road. The seed data has sites closed and re-reported
 *             weeks later, and whole categories that close same-day as an
 *             administrative disposition rather than a repair.
 *   peer    — a verified resident standing at the spot saying what they see.
 *             Current and specific, but unofficial and low-volume.
 *
 * Neither overrides the other. We publish both, plus a verdict that says
 * whether they agree — and when they don't, that disagreement is the finding.
 */

// How long a peer observation carries weight before it is treated as stale.
const HALF_LIFE_DAYS = 60;
/**
 * Total proof weight at which peer evidence counts as fully corroborated.
 * Weights come from services/proof.service.js, so this is roughly three
 * GPS-verified photos, or eight bare unevidenced claims. Counting headcount
 * instead would make eight people with no photos outrank three with proof.
 */
const CORROBORATION_TARGET = 3;

const STATUS = {
  OPEN_UNVERIFIED: 'open_unverified',
  OPEN_CONFIRMED: 'open_confirmed',
  FIXED_UNRECORDED: 'fixed_unrecorded',
  CLOSED_UNVERIFIED: 'closed_unverified',
  FIXED_CONFIRMED: 'fixed_confirmed',
  DISPUTED_CLOSURE: 'disputed_closure',
  CONTESTED: 'contested',
};

const LABELS = {
  [STATUS.OPEN_UNVERIFIED]: 'Open, no resident has confirmed it',
  [STATUS.OPEN_CONFIRMED]: 'Open, residents confirm it is still there',
  [STATUS.FIXED_UNRECORDED]: 'Residents say it is fixed, county case still open',
  [STATUS.CLOSED_UNVERIFIED]: 'County closed the case, unverified',
  [STATUS.FIXED_CONFIRMED]: 'Fixed, county closed and residents agree',
  [STATUS.DISPUTED_CLOSURE]: 'County closed the case but residents say it is still there',
  [STATUS.CONTESTED]: 'Residents disagree about whether it is fixed',
};

const days = (ms) => ms / 86400000;

// Weakest to strongest, for picking a site's best piece of evidence.
const PROOF_RANK = ['duplicate', 'none', 'geo_mismatch', 'photo_only', 'time_verified', 'geo_verified'];

/**
 * One observation per observer: the most recent one they filed. Someone who
 * said "still there" in March and "fixed" in June counts once, as fixed.
 */
function latestPerObserver(outcomes) {
  const byObserver = new Map();
  for (const o of outcomes) {
    const who = String(o.observedBy || o._id); // anonymous seed rows count individually
    const prev = byObserver.get(who);
    if (!prev || new Date(o.observedAt) > new Date(prev.observedAt)) byObserver.set(who, o);
  }
  return [...byObserver.values()];
}

/**
 * Observations the county has not had a chance to respond to yet. If the county
 * closed the case, only what was seen *after* that closure can dispute it —
 * a "still there" from before the repair is exactly what got repaired.
 */
function relevantOutcomes(outcomes, countyClosedAt) {
  if (!countyClosedAt) return outcomes;
  const cutoff = new Date(countyClosedAt).getTime();
  return outcomes.filter((o) => new Date(o.observedAt).getTime() >= cutoff);
}

const weightOf = (o) => (o.proof && typeof o.proof.weight === 'number' ? o.proof.weight : 0.2);

// 0..1 from how much *evidence* corroborates the claim, and how recent it is.
function confidence(observations, now) {
  if (!observations.length) return 0;
  const evidence = observations.reduce((sum, o) => sum + weightOf(o), 0);
  const corroboration = Math.min(evidence / CORROBORATION_TARGET, 1);
  const newest = Math.max(...observations.map((o) => new Date(o.observedAt).getTime()));
  const age = Math.max(days(now - newest), 0);
  const freshness = Math.pow(0.5, age / HALF_LIFE_DAYS);
  return Math.round(corroboration * freshness * 100) / 100;
}

/**
 * @param county  { status: 'open'|'closed', closedAt?, reportCount, openCount, lastReportedAt?, department?, sla? }
 * @param outcomes array of Outcome-shaped objects for this site
 * @returns { county, peer, reconciliation }
 */
function reconcile(county, outcomes = [], now = Date.now()) {
  const relevant = relevantOutcomes(outcomes, county.status === 'closed' ? county.closedAt : null);
  // A photo already submitted elsewhere carries no weight and does not vote.
  const admissible = relevant.filter((o) => weightOf(o) > 0);
  const deduped = latestPerObserver(admissible);

  const stillThere = deduped.filter((o) => o.kind === 'still_there');
  const fixed = deduped.filter((o) => o.kind === 'fixed');

  const peer = {
    observations: deduped.length,
    stillThere: stillThere.length,
    fixed: fixed.length,
    // Everything on record, including observations superseded or pre-dating a closure.
    totalSubmitted: outcomes.length,
    ignoredAsPreClosure: outcomes.length - relevant.length,
    ignoredAsDuplicate: relevant.length - admissible.length,
    // Evidence quality behind the verdict, not just a headcount.
    evidenceWeight: Math.round(deduped.reduce((sum, o) => sum + weightOf(o), 0) * 100) / 100,
    geoVerified: deduped.filter((o) => o.proof && o.proof.grade === 'geo_verified').length,
    withPhoto: deduped.filter((o) => (o.photoKeys || []).length > 0).length,
    strongestProof: deduped.length
      ? deduped.map((o) => (o.proof && o.proof.grade) || 'none').sort(
          (a, b) => PROOF_RANK.indexOf(b) - PROOF_RANK.indexOf(a)
        )[0]
      : null,
    lastObservedAt: deduped.length
      ? new Date(Math.max(...deduped.map((o) => new Date(o.observedAt).getTime())))
      : null,
    verdict: 'unverified',
  };

  if (stillThere.length && fixed.length) peer.verdict = 'contested';
  else if (stillThere.length) peer.verdict = 'still_there';
  else if (fixed.length) peer.verdict = 'fixed';

  let effectiveStatus;
  let agreement;

  if (peer.verdict === 'contested') {
    effectiveStatus = STATUS.CONTESTED;
    agreement = 'contested';
  } else if (county.status === 'open') {
    if (peer.verdict === 'fixed') {
      effectiveStatus = STATUS.FIXED_UNRECORDED;
      agreement = 'disagree';
    } else if (peer.verdict === 'still_there') {
      effectiveStatus = STATUS.OPEN_CONFIRMED;
      agreement = 'agree';
    } else {
      effectiveStatus = STATUS.OPEN_UNVERIFIED;
      agreement = 'unknown';
    }
  } else if (peer.verdict === 'still_there') {
    effectiveStatus = STATUS.DISPUTED_CLOSURE;
    agreement = 'disagree';
  } else if (peer.verdict === 'fixed') {
    effectiveStatus = STATUS.FIXED_CONFIRMED;
    agreement = 'agree';
  } else {
    effectiveStatus = STATUS.CLOSED_UNVERIFIED;
    agreement = 'unknown';
  }

  // The side with evidence behind it drives the confidence number.
  const driving = peer.verdict === 'still_there' ? stillThere : peer.verdict === 'fixed' ? fixed : deduped;

  return {
    county: {
      status: county.status,
      closedAt: county.closedAt || null,
      reportCount: county.reportCount ?? null,
      openCount: county.openCount ?? null,
      lastReportedAt: county.lastReportedAt || null,
      department: county.department || null,
      sla: county.sla || null,
      daysToClose: county.daysToClose ?? null,
    },
    peer,
    reconciliation: {
      effectiveStatus,
      label: LABELS[effectiveStatus],
      agreement,
      confidence: confidence(driving, now),
      disputed: effectiveStatus === STATUS.DISPUTED_CLOSURE || effectiveStatus === STATUS.CONTESTED,
      needsVerification:
        effectiveStatus === STATUS.CLOSED_UNVERIFIED || effectiveStatus === STATUS.OPEN_UNVERIFIED,
      evaluatedAt: new Date(now),
    },
  };
}

module.exports = { reconcile, STATUS, LABELS, HALF_LIFE_DAYS, CORROBORATION_TARGET };
