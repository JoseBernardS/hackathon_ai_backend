/**
 * Turning a live 311 ticket into a status, a progress stage, and a timeline.
 *
 * Written against the real `getServiceRequest` payload, not the spec's
 * summary. Four things differ from what a reading of the spec suggests, and
 * each one silently broke an earlier version of this file:
 *
 *   1. `activities[].outcome` is an OBJECT — {code, name, action, response} —
 *      not a string. Regex-matching it directly tests "[object Object]".
 *   2. `closure_details.reason` is null on every pothole case observed. The
 *      real outcome lives in the activity's `outcome.name`.
 *   3. `events[]` carries `notes` and `type`, not `description`, and most rows
 *      are integration-user noise with null notes. Rendering them all is how
 *      you get an unreadable log.
 *   4. `service_level_agreement` is {type, value}, not a string.
 *
 * The progress ladder is built from the ticket's own `activities[].order`, so
 * no separate service-definition call is needed — which matters, because
 * `getServiceDefinition` does not exist on this endpoint.
 */

const STATUS = {
  REPORTED: 'reported',
  ACKNOWLEDGED: 'acknowledged',
  IN_PROGRESS: 'in_progress',
  FIXED: 'fixed',
  CLOSED_UNRESOLVED: 'closed_unresolved',
};

const NOT_STARTED = 'not started';

/**
 * Outcomes that mean the county closed the case WITHOUT fixing the road.
 * Checked first, because the safe direction is never to claim a repair the
 * county did not record.
 */
const NON_REPAIR = new RegExp(
  [
    'unfounded',
    'duplicate',
    'referred',
    'no\\s*action',
    // Observed live: "No Problem Found" closes a case without a repair, and
    // reporting that as "Repaired" is the worst thing this file could do.
    'no\\s*problem',
    'nothing\\s*found',
    'not\\s*found',
    'no\\s*issue',
    'cancel',
    'withdraw',
    'invalid',
    'unable',
    'no\\s*access',
    'wrong',
  ].join('|'),
  'i'
);

const toDate = (v) => {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

/** The outcome is an object; this is the human-readable label from it. */
function outcomeName(activity) {
  const o = activity && activity.outcome;
  if (!o) return null;
  if (typeof o === 'string') return o; // tolerate the shape the spec implied
  return o.name || o.code || null;
}

function outcomeAction(activity) {
  const o = activity && activity.outcome;
  return o && typeof o === 'object' ? o.action || null : null;
}

const activityStarted = (a) =>
  Boolean(a && ((a.status && a.status.trim().toLowerCase() !== NOT_STARTED) || a.completion_date));

/** The activity whose outcome closed the case, if any. */
function decidingActivity(activities = []) {
  const withOutcome = activities.filter((a) => outcomeName(a));
  if (!withOutcome.length) return null;
  // Prefer one that explicitly closed the case.
  return withOutcome.find((a) => outcomeAction(a) === 'Close') || withOutcome[withOutcome.length - 1];
}

/**
 * Maps a live ticket onto our status ladder, most-advanced first.
 *
 * The county's own outcome text is returned alongside, because our five words
 * are a simplification of theirs and the UI should be able to show both.
 */
function deriveStatus(ticket = {}) {
  const closedAt = toDate(ticket.closed_datetime);
  const canceledAt = toDate(ticket.canceled_datetime);
  const activities = Array.isArray(ticket.activities) ? ticket.activities : [];

  if (canceledAt) {
    return {
      status: STATUS.CLOSED_UNRESOLVED,
      outcome: ticket.cancel_reason || 'Canceled',
      because: 'the county canceled the request',
    };
  }

  if (closedAt) {
    const deciding = decidingActivity(activities);
    const outcome =
      outcomeName(deciding) ||
      (ticket.closure_details && ticket.closure_details.reason) ||
      null;

    if (outcome && NON_REPAIR.test(outcome)) {
      return {
        status: STATUS.CLOSED_UNRESOLVED,
        outcome,
        because: `closed without a repair (${outcome})`,
      };
    }
    if (outcome) {
      return { status: STATUS.FIXED, outcome, because: `closed by the county (${outcome})` };
    }
    return {
      status: STATUS.CLOSED_UNRESOLVED,
      outcome: null,
      because: 'closed with no recorded outcome — not assumed to be a repair',
    };
  }

  if (activities.some(activityStarted)) {
    const live = activities.filter(activityStarted).pop();
    return {
      status: STATUS.IN_PROGRESS,
      outcome: outcomeName(live),
      because: `${live.name || live.code} is ${live.status}`,
    };
  }

  // owner is {id, name, type} — a work queue picks a case up before any
  // activity starts, which is what distinguishes acknowledged from reported.
  const owner = ticket.owner && ticket.owner.name;
  if (owner) {
    return { status: STATUS.ACKNOWLEDGED, outcome: null, because: `assigned to ${owner}` };
  }

  return { status: STATUS.REPORTED, outcome: null, because: 'filed, not yet assigned' };
}

/**
 * The progress ladder, built from the ticket's own activities.
 * Submitted -> each activity in `order` -> Closed.
 */
function stagesFromTicket(ticket = {}) {
  const activities = [...(Array.isArray(ticket.activities) ? ticket.activities : [])].sort(
    (a, b) => (a.order || 0) - (b.order || 0)
  );
  return [
    { index: 0, code: 'SUBMITTED', name: 'Submitted', kind: 'submitted' },
    ...activities.map((a, i) => ({
      index: i + 1,
      code: a.code || `ACT${i + 1}`,
      name: a.name || a.code || `Step ${i + 1}`,
      kind: 'activity',
    })),
    { index: activities.length + 1, code: 'CLOSED', name: 'Closed', kind: 'closed' },
  ];
}

/** Where the ticket is on that ladder right now. */
function deriveStage(ticket = {}, stages = stagesFromTicket(ticket)) {
  if (!stages.length) return null;
  const last = stages[stages.length - 1];

  if (toDate(ticket.closed_datetime) || toDate(ticket.canceled_datetime)) {
    return { ...last, of: stages.length - 1 };
  }

  const activities = Array.isArray(ticket.activities) ? ticket.activities : [];
  let furthest = stages[0];
  for (const stage of stages) {
    if (stage.kind !== 'activity') continue;
    const match = activities.find((a) => a.code === stage.code);
    if (activityStarted(match)) furthest = stage;
  }
  return { ...furthest, of: stages.length - 1 };
}

/**
 * The timeline. County-stamped facts only.
 *
 * `events[]` is filtered hard: most rows are an integration user touching the
 * record with null notes, which tells a resident nothing. A row survives only
 * if it carries notes, or if it is the event that closed the case.
 */
function buildTimeline(ticket = {}, stages = stagesFromTicket(ticket)) {
  const rows = [];
  const push = (at, kind, label, extra = {}) => {
    const d = toDate(at);
    if (d) rows.push({ at: d, kind, label, ...extra });
  };

  push(ticket.requested_datetime, 'submitted', 'Reported to 311', {
    caseNumber: ticket.service_request_id || null,
  });

  for (const a of Array.isArray(ticket.activities) ? ticket.activities : []) {
    if (!a.completion_date) continue;
    push(a.completion_date, 'activity', a.name || a.code, {
      code: a.code || null,
      outcome: outcomeName(a),
      // external_comments is the resident-facing note; internal is never read.
      comment: a.external_comments || null,
    });
  }

  for (const e of Array.isArray(ticket.events) ? ticket.events : []) {
    if (!e.notes) continue; // drop the integration-user churn
    push(e.event_datetime, 'event', e.notes);
  }

  const { status, outcome, because } = deriveStatus(ticket);

  if (ticket.canceled_datetime) {
    push(ticket.canceled_datetime, 'canceled', 'Request canceled', { reason: ticket.cancel_reason || null });
  } else if (ticket.closed_datetime) {
    push(ticket.closed_datetime, 'closed', outcome || 'Closed', { outcome, because });
  }

  const seen = new Set();
  const events = rows
    .filter((r) => {
      const k = `${r.at.toISOString().slice(0, 13)}|${r.kind}|${r.label}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .sort((a, b) => b.at - a.at);

  const expectedAt = toDate(ticket.expected_datetime);
  const closedAt = toDate(ticket.closed_datetime);
  const now = Date.now();
  const sla = ticket.service_level_agreement;

  return {
    status,
    outcome,
    statusBecause: because,
    stage: deriveStage(ticket, stages),
    owner: (ticket.owner && ticket.owner.name) || null,
    // {type: "Business Days", value: 90} -> "90 Business Days"
    slaTarget: sla && typeof sla === 'object' ? `${sla.value} ${sla.type}` : sla || null,
    lastUpdatedAt: toDate(ticket.last_updated_datetime) || toDate(ticket.updated_datetime),
    sla: expectedAt
      ? {
          expectedAt,
          metOnTime: closedAt ? closedAt <= expectedAt : null,
          daysRemaining: closedAt ? null : Math.round((expectedAt - now) / 86400000),
          overdue: closedAt ? closedAt > expectedAt : now > expectedAt,
        }
      : null,
    events,
  };
}

/**
 * Strips the ticket to what we store. Everything dropped here is either
 * personal data or internal to the county.
 */
function sanitiseTicket(ticket = {}) {
  const { status } = deriveStatus(ticket);
  return {
    externalId: ticket.service_request_id || null,
    slaTarget:
      ticket.service_level_agreement && typeof ticket.service_level_agreement === 'object'
        ? `${ticket.service_level_agreement.value} ${ticket.service_level_agreement.type}`
        : ticket.service_level_agreement || null,
    openedAt: toDate(ticket.requested_datetime),
    expectedAt: toDate(ticket.expected_datetime),
    closedAt: toDate(ticket.closed_datetime),
    canceledAt: toDate(ticket.canceled_datetime),
    lastUpdatedAt: toDate(ticket.last_updated_datetime) || toDate(ticket.updated_datetime),
    ownerName: (ticket.owner && ticket.owner.name) || null,
    serviceNotice: ticket.service_notice || null,
    closureReason:
      outcomeName(decidingActivity(ticket.activities || [])) ||
      (ticket.closure_details && ticket.closure_details.reason) ||
      null,
    countyStatus: status,
    activities: (Array.isArray(ticket.activities) ? ticket.activities : []).map((a) => ({
      code: a.code,
      name: a.name,
      order: a.order ?? undefined,
      status: a.status,
      completionDate: toDate(a.completion_date),
      externalComments: a.external_comments || undefined,
      outcome: outcomeName(a) || undefined,
      outcomeAction: outcomeAction(a) || undefined,
    })),
    events: (Array.isArray(ticket.events) ? ticket.events : [])
      .filter((e) => e.notes)
      .map((e) => ({ at: toDate(e.event_datetime), description: e.notes })),
    // The county exposes the original reporter's photos. Keep the URLs only —
    // they are Salesforce links, not ours, and may require their session.
    countyPhotos: (Array.isArray(ticket.media_url) ? ticket.media_url : [])
      .filter((m) => m && !m.private && m.url)
      .map((m) => ({ url: m.url, mimeType: m.mime_type, createdAt: toDate(m.created_datetime) })),
    // Dropped: contact, owner.id, events[].event_by, internal_comments,
    // additional_comments, folio, address_details, geolayers.
  };
}

module.exports = {
  STATUS, deriveStatus, deriveStage, buildTimeline,
  stagesFromTicket, sanitiseTicket, outcomeName, outcomeAction,
};
