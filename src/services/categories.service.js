/**
 * Category registry.
 *
 * The app asks "what can I report?" and gets this list. Only potholes are live
 * right now; the remaining 53 categories seen in the Miami-Dade 311 data sit in
 * categories.all.json as a backlog and can be switched on by adding an entry
 * here with its own model, config and routes.
 */
const Report = require('../models/Report');
const Site = require('../models/Site');
const { SITE_RADIUS_M } = require('./dedupe.service');

const potholeConfig = require('../data/pothole.json');
const { categories: allCategories } = require('../data/categories.all.json');

const REGISTRY = [
  {
    code: 'pothole',
    label: potholeConfig.label,
    group: 'roads',
    basePath: '/api/sites',
    // Reports within this many metres are treated as the same physical problem.
    // Defined once, in dedupe.service.js — the clustering and the API agree by construction.
    dedupeRadiusMeters: SITE_RADIUS_M,
    subtypes: potholeConfig.subtypes.map(({ code, label }) => ({ code, label })),
    // Primary first: a report with no resolved agency falls back to departments[0].
    departments: potholeConfig.departments || Object.keys(potholeConfig.sla || {}),
    sla: potholeConfig.sla,
    baseline: potholeConfig.stats,
    source: potholeConfig.source,
    models: { report: Report, site: Site },
  },
];

const byCode = new Map(REGISTRY.map((c) => [c.code, c]));

// Everything seen in the 311 data that we have not built yet, so the client can
// show a roadmap instead of a dead end.
const BACKLOG = allCategories
  .filter((c) => !byCode.has(c.code))
  .map((c) => ({
    code: c.code,
    label: c.label,
    group: c.group,
    enabled: false,
    reports2026: c.stats.reports2026,
  }));

// Live counts, so a category card can say "40 locations, 34 still open".
async function liveStats(entry) {
  const { report, site } = entry.models;
  const [reports, userReports, sites, openSites] = await Promise.all([
    report.countDocuments({ categoryCode: entry.code }),
    report.countDocuments({ categoryCode: entry.code, source: 'user' }),
    site ? site.countDocuments() : null,
    site ? site.countDocuments({ status: 'open' }) : null,
  ]);
  return { reports, userReports, sites, openSites };
}

/**
 * The URLs a client should call for this category. Collection endpoints carry
 * ?category=<code>; item endpoints take a globally unique id and do not.
 */
function endpoints(entry) {
  const q = `?category=${entry.code}`;
  return {
    list: `/api/sites${q}`,
    nearby: `/api/sites/nearby${q}`,
    stats: `/api/sites/stats${q}`,
    hotspots: `/api/sites/hotspots${q}`,
    config: `/api/sites/config${q}`,
    detail: '/api/sites/:id',
    submitReport: '/api/reports',
    mine: `/api/reports/mine${q}`,
  };
}

async function describe(entry, { withStats = true } = {}) {
  return {
    code: entry.code,
    label: entry.label,
    group: entry.group,
    enabled: true,
    source: entry.source,
    departments: entry.departments,
    dedupeRadiusMeters: entry.dedupeRadiusMeters,
    subtypes: entry.subtypes,
    sla: entry.sla,
    baseline: entry.baseline,
    endpoints: endpoints(entry),
    ...(withStats ? { stats: await liveStats(entry) } : {}),
  };
}

function get(code) {
  return byCode.get(String(code || '').toLowerCase()) || null;
}

// A code we recognise from the 311 data but have not implemented.
function isBacklog(code) {
  return BACKLOG.some((c) => c.code === String(code || '').toLowerCase());
}

async function list({ withStats = true } = {}) {
  return Promise.all(REGISTRY.map((e) => describe(e, { withStats })));
}

module.exports = { REGISTRY, BACKLOG, list, get, describe, isBacklog, liveStats, endpoints };
