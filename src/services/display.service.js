/**
 * Collapses a site into the handful of strings a UI actually renders.
 *
 * The site payload carries everything — counts, dates, departments, SLA, the
 * 311 ticket's workflow stage — because the API should not throw data away.
 * But a frontend should not have to reason over all of it to draw a pin, and a
 * resident should not be shown it. So this is the one place that decides what
 * the end user sees, and it returns six fields with no logic left in them.
 *
 * If a label reads wrong, it is wrong here, not in the client.
 */

const DAY = 86400000;

/**
 * Tone is measured against the county's OWN published target, not a number we
 * invented. "Open 155 days" means nothing on its own; "past the county's
 * 126-day target" is a claim their own SLA supports.
 *
 *   ok       within target
 *   warn     past target
 *   critical past twice the target
 */
const BUSINESS_TO_CALENDAR = 7 / 5;
const FALLBACK_TARGET_DAYS = 126; // 90 business days, the pothole SLA

// "90 Business Days" / "10 Calendar Days" -> calendar days
function slaToCalendarDays(sla) {
  if (!sla) return FALLBACK_TARGET_DAYS;
  const m = /^(\d+)\s*(business|calendar)/i.exec(String(sla).trim());
  if (!m) return FALLBACK_TARGET_DAYS;
  const n = Number(m[1]);
  return /business/i.test(m[2]) ? Math.round(n * BUSINESS_TO_CALENDAR) : n;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function shortDate(d) {
  if (!d) return null;
  const x = new Date(d);
  return `${MONTHS[x.getUTCMonth()]} ${x.getUTCDate()}`;
}

// Capitalises each word AND each hyphenated part, so MIAMI-DADE does not come
// back as "Miami-dade".
function titleCase(s) {
  if (!s) return '';
  return s
    .toLowerCase()
    .replace(/[a-z]+/g, (w) => (w.length > 2 ? w[0].toUpperCase() + w.slice(1) : w.toUpperCase()));
}

/**
 * Plain English for the county's workflow status, when a ticket exists.
 *
 * `imported` is deliberately absent: an adopted case that has not been looked
 * up yet knows nothing the site does not already know, so the label falls
 * through to the site's own "Open N days" rather than showing a word that
 * reflects our bookkeeping instead of the road.
 */
const TICKET_LABEL = {
  reported: 'Filed with 311',
  acknowledged: 'Assigned to a crew',
  in_progress: 'Work started',
  fixed: 'Repaired',
  closed_unresolved: 'Closed without a repair',
  dry_run: 'Ready to file',
  pending: 'Filing…',
  failed: 'Could not file',
};

/**
 * @param site    a Site document or its toJSON()
 * @param ticket  the ExternalTicket for this site, if we filed one
 */
function describeSite(site, ticket = null, entry = null) {
  const s = site.toJSON ? site.toJSON() : site;

  const where = [s.address, s.municipality ? titleCase(s.municipality) : null]
    .filter(Boolean)
    .join(', ');

  // --- status line + tone -------------------------------------------------
  let statusLabel;
  let tone;
  let overdueBy = null;
  let targetDays = null;

  if (ticket && TICKET_LABEL[ticket.status]) {
    statusLabel = TICKET_LABEL[ticket.status];
    tone =
      ticket.status === 'fixed' ? 'done'
      : ticket.status === 'closed_unresolved' || ticket.status === 'failed' ? 'warn'
      : 'ok';

    // The county's own target date, which is better evidence than our estimate
    // from the site's SLA string. Keep it on an open ticket so a pin can still
    // say how late the county is.
    if (ticket.expectedAt) {
      const due = new Date(ticket.expectedAt).getTime();
      const end = ticket.closedAt ? new Date(ticket.closedAt).getTime() : Date.now();
      if (end > due) {
        overdueBy = Math.round((end - due) / DAY);
        targetDays = null;
        if (!ticket.closedAt) tone = overdueBy >= 90 ? 'critical' : 'warn';
      }
    }
  } else if (s.status === 'closed') {
    statusLabel = 'Marked fixed by the county';
    tone = 'done';
  } else {
    const days = s.daysOpen ?? (s.oldestOpenAt ? Math.round((Date.now() - new Date(s.oldestOpenAt)) / DAY) : null);
    if (days === null) {
      statusLabel = 'Open';
      tone = 'ok';
    } else {
      const target = slaToCalendarDays(s.sla);
      statusLabel = days === 0 ? 'Reported today' : `Open ${days} ${days === 1 ? 'day' : 'days'}`;
      tone = days >= target * 2 ? 'critical' : days > target ? 'warn' : 'ok';
      overdueBy = days > target ? days - target : null;
      targetDays = target;
    }
  }

  // --- one line of supporting evidence ------------------------------------
  const since = shortDate(s.firstReportedAt);
  const detail =
    s.reportCount > 1
      ? `Reported ${s.reportCount} times${since ? ` since ${since}` : ''}`
      : since
        ? `Reported ${since}`
        : 'Reported once';

  // --- exactly one thing the user can do ----------------------------------
  // Once anything claims it is fixed, the useful question flips: the resident
  // is the only one who can say whether the repair actually held.
  const claimedFixed =
    (ticket && (ticket.status === 'fixed' || ticket.status === 'closed_unresolved')) ||
    s.status === 'closed';

  const action = claimedFixed
    ? { kind: 'report_again', label: 'Still not fixed?' }
    : { kind: 'report_too', label: 'I see it too' };

  return {
    // Label from the category registry — it is not copied onto every row.
    title: (entry && entry.label) || s.categoryLabel || 'Reported problem',
    subtitle: where || 'Location on file',
    statusLabel,
    tone, // ok | warn | critical | done — drives colour, nothing else
    detail,
    // Present only when the county is past its own target, so the UI can add
    // "47 days past the county's 126-day target" without doing the maths.
    overdue:
      overdueBy === null
        ? null
        : {
            days: overdueBy,
            targetDays,
            sla: (ticket && ticket.slaTarget) || s.sla || null,
            expectedAt: (ticket && ticket.expectedAt) || null,
          },
    // The county's own reference, for "Case 26-00247866". Prefer the tracked
    // ticket's number when there is one, else the newest complaint at the site.
    caseNumber: (ticket && ticket.externalId) || s.latestCaseNumber || null,
    action,
    /**
     * Prefer the 13KB thumbnail. User uploads have none — we do not resize on
     * ingest — so fall back to the full image rather than showing no picture.
     * That photo can be up to 15MB, so generating thumbnails on upload (sharp)
     * is the proper fix when it matters.
     */
    thumbnail: (s.thumbnails && s.thumbnails[0]) || (s.photos && s.photos[0]) || null,
  };
}

module.exports = { describeSite, slaToCalendarDays };
