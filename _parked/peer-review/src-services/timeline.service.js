/**
 * Builds a readable history for a site.
 *
 * A naive flatten of reports into (reported, closed) events is unreadable: one
 * site with 8 reports produces 15 rows, three of them identical because a crew
 * closed three tickets on the same afternoon, and two of them closures that
 * landed in under a day — paperwork, not pavement.
 *
 * So: group events by day and type, label the administrative closures, and
 * mark the closures that did not hold. A closure followed by a fresh report is
 * the single most interesting thing in this data and deserves to be findable.
 */

const day = (d) => new Date(d).toISOString().slice(0, 10);

// A closure this fast is a case disposition, not a repair.
const ADMIN_CLOSURE_DAYS = 1;

function buildTimeline(reports, outcomes = []) {
  const events = [];

  // --- reports, grouped by the day they were filed ---
  const reportDays = new Map();
  for (const r of reports) {
    const k = day(r.reportedAt);
    if (!reportDays.has(k)) reportDays.set(k, []);
    reportDays.get(k).push(r);
  }
  for (const [at, group] of reportDays) {
    events.push({
      at,
      type: 'reported',
      count: group.length,
      cases: group.map((r) => r.sourceId).filter(Boolean),
      fromApp: group.filter((r) => r.source === 'user').length,
    });
  }

  // --- closures, grouped by the day the county closed them ---
  const closureDays = new Map();
  for (const r of reports) {
    if (!r.closedAt) continue;
    const k = day(r.closedAt);
    if (!closureDays.has(k)) closureDays.set(k, []);
    closureDays.get(k).push(r);
  }

  const reportTimes = reports.map((r) => new Date(r.reportedAt).getTime()).sort((a, b) => a - b);

  for (const [at, group] of closureDays) {
    const times = group.map((r) => r.daysToClose).filter((d) => d !== null && d !== undefined);
    const closedAt = new Date(at).getTime();

    // Did a new report arrive after this closure? Then it did not hold.
    const nextReport = reportTimes.find((t) => t > closedAt);

    events.push({
      at,
      type: 'closed',
      count: group.length,
      cases: group.map((r) => r.sourceId).filter(Boolean),
      avgDaysToClose: times.length
        ? Math.round((times.reduce((s, d) => s + d, 0) / times.length) * 10) / 10
        : null,
      // Every closure in this group landed inside a day.
      administrative: times.length > 0 && times.every((d) => d < ADMIN_CLOSURE_DAYS),
      reportedAgainAfterDays: nextReport
        ? Math.round((nextReport - closedAt) / 86400000)
        : null,
    });
  }

  // --- peer checks, one row each: these are the signal, never grouped ---
  for (const o of outcomes) {
    events.push({
      at: day(o.observedAt),
      type: o.kind === 'fixed' ? 'peer_fixed' : 'peer_still_there',
      by: o.reporterName || 'A resident',
      note: o.note || null,
      proofGrade: o.proof ? o.proof.grade : 'none',
      thumbKey: (o.thumbKeys || [])[0] || null,
      outcomeId: String(o._id),
    });
  }

  events.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));

  // --- one-line summary, so the UI can lead with it and collapse the rest ---
  const closed = reports.filter((r) => r.closedAt);
  const reopened = events.filter((e) => e.type === 'closed' && e.reportedAgainAfterDays !== null);

  const summary = {
    reports: reports.length,
    fromApp: reports.filter((r) => r.source === 'user').length,
    openNow: reports.filter((r) => r.status === 'open').length,
    countyClosures: closed.length,
    administrativeClosures: closed.filter(
      (r) => r.daysToClose !== null && r.daysToClose < ADMIN_CLOSURE_DAYS
    ).length,
    timesClosedThenReportedAgain: reopened.length,
    peerChecks: outcomes.length,
    firstReportedAt: reports.length ? day(Math.min(...reportTimes)) : null,
    lastReportedAt: reports.length ? day(Math.max(...reportTimes)) : null,
    rows: events.length,
  };

  return { summary, events };
}

module.exports = { buildTimeline, ADMIN_CLOSURE_DAYS };
