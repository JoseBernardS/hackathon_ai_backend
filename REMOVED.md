# Removed: peer review / resolution tracking

Stripped back to basics on request. **Nothing was deleted** — the files are in
`_parked/peer-review/`. This is the list of what came out and how to put it back.

Current state: sites, reports, categories, photos, dedupe. No resident reports.

---

## Files moved (not deleted)

| from | to |
|---|---|
| `src/models/Outcome.js` | `_parked/peer-review/src-models/` |
| `src/services/reconcile.service.js` | `_parked/peer-review/src-services/` |
| `src/services/proof.service.js` | `_parked/peer-review/src-services/` |
| `src/services/timeline.service.js` | `_parked/peer-review/src-services/` |
| `scripts/seed-outcomes.js` | `_parked/peer-review/scripts/` |
| `scripts/lib/exif-inject.js` | `_parked/peer-review/scripts-lib/` |
| `docs/RESOLUTION.md` | `_parked/peer-review/docs/` |

## Endpoints removed

```
POST /api/sites/:id/outcome       submit "fixed" / "still there"
GET  /api/sites/:id/outcomes      the peer record for a site
```

Also gone: `/api/potholes/:id/outcome(s)` on the deprecated alias.

## Query params removed

```
GET /api/sites?disputed=1
GET /api/sites?effectiveStatus=<state>
```

`category`, `lat`, `lng`, `radius`, `status`, `minReports`, `limit` all still work.

## Response fields removed

**`GET /api/sites` and `/api/sites/:id`** no longer return:

- `county` — status, closedAt, reportCount, openCount, department, sla, daysToClose
- `peer` — observations, stillThere, fixed, evidenceWeight, geoVerified, strongestProof, verdict
- `reconciliation` — effectiveStatus, label, agreement, confidence, disputed, needsVerification
- `countyClosedAt`
- `timeline` — the grouped `{ summary, events }` history on site detail

Still there: `status`, `reportCount`, `openCount`, `userReportCount`, `daysOpen`,
`firstReportedAt`, `lastReportedAt`, `oldestOpenAt`, `avgDaysToClose`,
`photos`, `thumbnails`, and `reports[]` on detail.

**`GET /api/categories/:code`** → `endpoints` no longer lists `outcomes` or
`submitOutcome`.

## Client (`examples/api-client.js`)

Removed `sites.outcomes()` and `sites.submitOutcome()`. `sites` now exposes
`list, nearby, stats, hotspots, get`.

## Database

- Dropped the **`outcomes` collection** — 30 synthetic resident checks.
- `$unset` of `county`, `peer`, `reconciliation`, `countyClosedAt` on all 40 sites.
- Also dropped a leftover `_smoke` test collection.

Untouched: `reports` (334), `sites` (40), `users`, `onboardings`, `otpchallenges`, `files`.

## S3

The outcome photos under `outcomes/seed/` are still in the bucket but nothing
references them. To remove:

```bash
aws s3 rm s3://umiamihack2026/outcomes/ --recursive
```

`potholes/seed/` is still in use — leave it.

---

## To restore

```bash
mv _parked/peer-review/src-models/Outcome.js      src/models/
mv _parked/peer-review/src-services/*.js          src/services/
mkdir -p scripts/lib
mv _parked/peer-review/scripts/seed-outcomes.js   scripts/
mv _parked/peer-review/scripts-lib/exif-inject.js scripts/lib/
mv _parked/peer-review/docs/RESOLUTION.md         docs/
```

Then re-apply the wiring:

1. **`src/models/Site.js`** — add back the `county`, `peer` and `reconciliation`
   subdocuments and `countyClosedAt`, plus the index
   `siteSchema.index({ categoryCode: 1, 'reconciliation.disputed': 1 })`.
2. **`src/services/dedupe.service.js`** — `summarise()` must emit the `county`
   block again (status, closedAt, reportCount, openCount, lastReportedAt,
   department, sla, daysToClose) and `countyClosedAt`.
3. **`src/services/site.service.js`** — `compose(reports, outcomes, now)` takes
   the outcomes again and runs them through `reconcile()`; `rebuildSite` loads
   `Outcome.find({ siteId })` alongside the reports.
4. **`src/controllers/site.controller.js`** — re-add the `submitOutcome` and
   `listOutcomes` handlers, the `disputed` / `effectiveStatus` filters in
   `listSites`, and the `timeline` on `getSite`.
5. **`src/routes/site.routes.js`** — re-add:
   ```js
   router.get('/:id/outcomes', asyncHandler(ctrl.listOutcomes));
   router.post('/:id/outcome', requireAuth, upload.single('photo'), asyncHandler(ctrl.submitOutcome));
   ```
6. **`src/services/categories.service.js`** — add `outcomes` and `submitOutcome`
   back to the `endpoints()` map.
7. **`examples/api-client.js`** — re-add `sites.outcomes()` and
   `sites.submitOutcome()`.
8. Re-seed to repopulate:
   ```bash
   node scripts/seed-outcomes.js --dir <pics folder> --apply
   ```

`scripts/seed-311.js` calls `compose(c)` with one argument now — it was
`compose(c, [])`. Change it back if you restore step 3.
