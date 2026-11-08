# Integration guide

Everything needed to sign a user in, show them problems, and let them report one.

Base `http://localhost:4000`. JSON throughout. 🔒 means
`Authorization: Bearer <token>`.

```
POST /api/onboarding                    open a sign-up session
POST /api/onboarding/:id/documents      selfie + ID photo
POST /api/onboarding/:id/phone          finish -> account + token
POST /api/auth/login                    returning user -> token
GET  /api/auth/me                 🔒    current user
POST /api/auth/logout             🔒    revoke every token

GET  /api/categories                    what can be reported
GET  /api/sites?category=pothole        the map
GET  /api/sites/:id                     one pin: reports + county progress
POST /api/reports                 🔒    file one (auto-files with 311)
GET  /api/reports/mine            🔒    the caller's reports
```

A drop-in client is in `examples/api-client.js`:

```js
import api, { onboarding, login, session, categories, sites, reports,
               getPosition, inMiamiDade, ApiError } from './api-client';
```

```
VITE_API_URL=http://localhost:4000
```

---

# Part 1 — Sign up and sign in

## What is actually required

**Sign up — three calls.**

| # | call | required |
|---|---|---|
| 1 | `POST /api/onboarding` | nothing |
| 2 | `POST /api/onboarding/:id/documents` | `selfie` **and** `idDocument` |
| 3 | `POST /api/onboarding/:id/phone` | `phone` |

**Sign in — one call.**

| call | required |
|---|---|
| `POST /api/auth/login` | `phone` |

That is the whole of it. No password, no code to type.

**Collect these at step 3 too** — optional for sign-up, but **311 will not
accept a report without them**:

```
firstName     goes to the county on every filed ticket
lastName
email
displayName   optional, cosmetic
```

Tokens are JWTs, last 7 days, and go in `Authorization: Bearer <token>`.
`POST /api/auth/logout` revokes every token for that user, so a 401 on any 🔒
call means the session is gone — clear it and send them to login.

---

## `POST /api/onboarding`

No body. **201**

```json
{ "sessionId": "6af021d93864c985b9fe26d2", "status": "documents_pending" }
```

## `POST /api/onboarding/:id/documents`

`multipart/form-data`, fields **`selfie`** and **`idDocument`**. Images only,
15MB each. Send both at once or one per call.

**200**

```json
{ "sessionId": "6af021d9...", "status": "documents_uploaded",
  "selfie": { "key": "onboarding/.../selfie/....jpg", "uploadedAt": "..." },
  "idDocument": { "key": "onboarding/.../id/....jpg", "uploadedAt": "..." } }
```

| code | |
|---|---|
| 400 | a non-image file |
| 404 | unknown session |
| 413 | over 15MB |

## `POST /api/onboarding/:id/phone`

The last step. Creates the account and signs the user in.

```json
{ "phone": "+13055550101",
  "displayName": "Ada L",
  "firstName": "Ada",
  "lastName": "Lovelace",
  "email": "ada@example.com" }
```

`phone` must be E.164 — leading `+`, country code, no spaces or dashes. Use
`toE164()` from the client. Everything else is optional.

**200**

```json
{
  "sessionId": "6af021d9...",
  "status": "verified",
  "verifiedAt": "2026-11-08T08:14:02.118Z",
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "tokenType": "Bearer",
  "expiresIn": "7d",
  "user": {
    "_id": "6af021da3864c985b9fe26d5",
    "phone": "+13055550101",
    "status": "active",
    "displayName": "Ada L",
    "firstName": "Ada",
    "lastName": "Lovelace",
    "email": "ada@example.com",
    "selfieKey": "onboarding/.../selfie/....jpg",
    "idDocumentKey": "onboarding/.../id/....jpg",
    "verifiedAt": "2026-11-08T08:14:02.118Z",
    "lastLoginAt": "2026-11-08T08:14:02.118Z"
  }
}
```

| code | |
|---|---|
| 400 | `phone` missing or not E.164, or `displayName` over 50 chars |
| 409 | documents not uploaded yet, or the session is already complete |
| 404 | unknown session |

One account per phone number — signing up again with the same number updates
the existing account rather than creating a second.

```js
const { sessionId } = await onboarding.start();
await onboarding.uploadDocuments(sessionId, { selfie, idDocument });
await onboarding.finish(sessionId, {
  phone: toE164('305 555 0101'),
  firstName: 'Ada', lastName: 'Lovelace', email: 'ada@example.com',
});
// token is stored; the user is signed in
```

## `POST /api/auth/login`

```json
{ "phone": "+13055550101" }
```

**200** — the same `{ token, tokenType, expiresIn, user }` block as above.

| code | |
|---|---|
| 400 | phone missing or not E.164 |
| 404 | no account for that number — send them to sign-up |
| 403 | account is suspended |

```js
await login.withPhone(toE164('305 555 0101'));
```

## `GET /api/auth/me` 🔒

The `user` object above.

## `POST /api/auth/logout` 🔒

`{ "loggedOut": true }`. Revokes **every** token for that user.

> **This is not real authentication.** Anyone who knows a phone number can sign
> in as that person. It is fine for a demo; re-adding a one-time code is the fix,
> and the code for it is parked in `_parked/otp/`.

---

# Part 2 — Getting and displaying problems

## `GET /api/categories`

Fetch once on launch and build the UI from it. Do not hardcode a category, a
subtype list or a URL.

```json
{
  "count": 1,
  "categories": [{
    "code": "pothole",
    "label": "Pothole or roadway defect",
    "group": "roads",
    "enabled": true,
    "dedupeRadiusMeters": 100,
    "departments": ["Transportation and Public Works", "City of Miami Public Works"],
    "sla": { "Transportation and Public Works": "90 Business Days",
             "City of Miami Public Works": "30 Business Days" },
    "subtypes": [
      { "code": "pothole", "label": "Pothole" },
      { "code": "worn-roadway", "label": "Roadway is worn or has defects" },
      { "code": "cave-in", "label": "Cave-in or sinkhole" },
      { "code": "guardrail", "label": "Guardrail or handrail is damaged" },
      { "code": "fence", "label": "Fence along roadway needs repair" }
    ],
    "baseline": { "reports": 6104, "open": 2709, "openRate": 0.44, "duplicates": 1463,
                  "meanDaysToClose": 37.7, "medianDaysToClose": 20.9, "p90DaysToClose": 98 },
    "stats": { "reports": 334, "userReports": 0, "sites": 40, "openSites": 34 },
    "endpoints": { "list": "/api/sites?category=pothole", "detail": "/api/sites/:id",
                   "submitReport": "/api/reports", "mine": "/api/reports/mine?category=pothole" }
  }]
}
```

`?includeBacklog=1` adds `backlog[]` — the 53 categories not built yet, as
`{ code, label, group, enabled: false, reports2026 }`.
`?stats=0` omits the live `stats` block.

`subtypes[].code` is what `POST /api/reports` accepts as `subType`.
`baseline` is the whole 6,104-report corpus; `stats` is what is in the database
right now.

## `GET /api/sites?category=pothole`

| param | default | |
|---|---|---|
| `category` | **required** | a code from `/api/categories` |
| `lat`, `lng` | — | adds `distanceMeters` to every row, nearest first |
| `radius` | 3000 | metres, max 20000. Only with `lat`/`lng` |
| `status` | `open` | `open` · `closed` · `all` |
| `minReports` | — | only sites with at least this many reports |
| `limit` | 200 | max 1000 |

A **site** is one deduplicated problem location. Many reports collapse into one,
so this is what you put pins on.

```json
{
  "count": 34,
  "radiusMeters": 600,
  "sites": [{
    "id": "6aefece183feb50b85daaee0",
    "categoryCode": "pothole",
    "location": { "type": "Point", "coordinates": [-80.33127, 25.65139] },
    "distanceMeters": 1,

    "status": "open",
    "reportCount": 28,
    "openCount": 28,
    "userReportCount": 0,
    "daysOpen": 275,
    "firstReportedAt": "2026-02-05T18:55:38.000Z",
    "lastReportedAt": "2026-07-29T12:38:16.000Z",
    "oldestOpenAt": "2026-02-05T18:55:38.000Z",
    "avgDaysToClose": null,

    "address": "12800 SW 84TH AVE",
    "municipality": "UNINCORPORATED MIAMI-DADE",
    "department": "Transportation and Public Works",
    "sla": "90 Business Days",
    "canFileWith311": null,

    "latestCaseNumber": "26-00247866",
    "caseNumbers": ["26-00247866", "26-00242655", "..."],
    "subtypes": ["pothole", "worn-roadway"],

    "photos": ["https://...presigned..."],
    "thumbnails": ["https://...presigned..."],
    "photoKeys": ["potholes/seed/14_Bache_ENP_1.jpg"],
    "thumbKeys": ["potholes/seed/thumb/14_Bache_ENP_1.jpg"],

    "display": {
      "title": "Pothole or roadway defect",
      "subtitle": "12800 SW 84TH AVE, Unincorporated Miami-Dade",
      "statusLabel": "Assigned to a crew",
      "tone": "warn",
      "detail": "Reported 28 times since Feb 5",
      "caseNumber": "26-00247866",
      "overdue": { "days": 59, "targetDays": null, "sla": "90 Business Days",
                   "expectedAt": "2026-09-10T12:38:18.000Z" },
      "action": { "kind": "report_too", "label": "I see it too" },
      "thumbnail": "https://...presigned 13KB..."
    }
  }]
}
```

### Render `display` — eight fields, no decisions left

| field | type | |
|---|---|---|
| `title` | string | heading |
| `subtitle` | string | location line |
| `statusLabel` | string | already worded |
| `tone` | `ok` · `warn` · `critical` · `done` | colour only |
| `detail` | string | one line of evidence |
| `caseNumber` | string \| null | the county's reference |
| `overdue` | object \| null | `{ days, targetDays, sla, expectedAt }` |
| `action` | `{ kind, label }` | `report_too` while open; `report_again` once something claims it is fixed |
| `thumbnail` | string \| null | 13KB; falls back to the full photo |

`tone` is measured against the county's **own** published target, per site — a
City of Miami pothole (30 business days) crosses sooner than a county one (90).

### The rest of the site object

| field | type | note |
|---|---|---|
| `location.coordinates` | `[lng, lat]` | GeoJSON order. Leaflet and Google Maps want `(lat, lng)` — swap it |
| `distanceMeters` | number | **only when `lat`/`lng` given** |
| `radiusMeters` | number \| null | echoes the radius used |
| `daysOpen` | number \| null | age of the oldest still-open report |
| `reportCount` | number | how many complaints collapsed into this pin |
| `canFileWith311` | null | on the list feed; the detail call does the real lookup |
| `caseNumbers` | string[] | newest first, up to 30 |
| `photos` / `thumbnails` | string[] | presigned, **expire in 15 minutes** |

Swap the coordinates:

```js
const latLng = [pin.location.coordinates[1], pin.location.coordinates[0]];
```

Size pins by `reportCount`, colour by `display.tone`. Across the 40 demo sites
that lands at 7 critical, 18 warn, 9 ok, 6 done.

**Don't cache presigned URLs in app state** — they expire in 15 minutes.
`photoKeys` / `thumbKeys` are the stable identities.

## `GET /api/sites/:id`

Every site field above, plus `reports[]` and `progress`.

```json
{
  "...": "all site fields",

  "reports": [{
    "id": "6aefecd683feb50b85da9555",
    "source": "311",
    "sourceId": "26-00247866",
    "status": "open",
    "subType": "pothole",
    "description": null,
    "reportedAt": "2026-07-29T12:38:16.000Z",
    "closedAt": null,
    "daysToClose": null,
    "address": "12800 SW 84TH AVE",
    "department": "Transportation and Public Works",
    "photoKeys": ["..."], "thumbKeys": ["..."]
  }],

  "progress": {
    "caseNumber": "26-00247866",
    "status": "acknowledged",
    "outcome": null,
    "statusBecause": "assigned to Road, Bridges and Canals",
    "stage":  { "index": 0, "code": "SUBMITTED", "name": "Submitted", "kind": "submitted", "of": 2 },
    "stages": [
      { "index": 0, "code": "SUBMITTED", "name": "Submitted", "kind": "submitted" },
      { "index": 1, "code": "02AC-INSPECTRESULT", "name": "Inspection", "kind": "activity" },
      { "index": 2, "code": "CLOSED", "name": "Closed", "kind": "closed" }
    ],
    "owner": "Road, Bridges and Canals",
    "slaTarget": "90 Business Days",
    "sla": { "expectedAt": "2026-09-10T12:38:18.000Z", "metOnTime": null,
             "daysRemaining": -59, "overdue": true },
    "lastUpdatedAt": "2026-07-29T12:38:17.000Z",
    "countyPhotos": [],
    "events": [
      { "at": "2026-07-29T12:38:16.000Z", "kind": "submitted",
        "label": "Reported to 311", "caseNumber": "26-00247866" }
    ],
    "checkedAt": "2026-11-08T06:12:04.118Z"
  }
}
```

`reports[]` is the complaint history — `source` is `311` or `user`, `sourceId`
is the county case number. `daysToClose` is computed from the two dates.

### `progress` — the county's own view. `null` when no ticket exists.

| field | type | |
|---|---|---|
| `caseNumber` | string | |
| `status` | `reported` · `acknowledged` · `in_progress` · `fixed` · `closed_unresolved` | |
| `outcome` | string \| null | the county's own words: `"Completed"`, `"No Problem Found"` |
| `statusBecause` | string | why that status |
| `stage` | `{ index, code, name, kind, of }` | render `index / of` |
| `stages` | array | the whole ladder, known upfront |
| `owner` | string \| null | the county work queue |
| `slaTarget` | string \| null | `"90 Business Days"` |
| `sla` | object \| null | below |
| `lastUpdatedAt` | ISO 8601 \| null | for "updated 2 days ago" |
| `countyPhotos` | `{ url, mimeType, createdAt }[]` | the original reporter's photos, hosted by the county |
| `events` | array | below |
| `checkedAt` | ISO 8601 \| null | when we last pulled from the county |

**Progress bar:** `stages` is the full path; `stage.index / stage.of` is where it
is now. For potholes the county runs two steps — `Submitted → Inspection →
Closed` — so the bar is three dots, not five. That is their real workflow.

`progress.sla`

| field | type | |
|---|---|---|
| `expectedAt` | ISO 8601 | the county's target date |
| `metOnTime` | boolean \| null | **null while open** |
| `daysRemaining` | number \| null | **negative when late**; null once closed |
| `overdue` | boolean | open: `now > expectedAt`. closed: `closedAt > expectedAt` |

`progress.events[]`

| field | type | on which `kind` |
|---|---|---|
| `at` | ISO 8601 | all |
| `kind` | `submitted` · `activity` · `event` · `closed` · `canceled` | |
| `label` | string | all |
| `caseNumber` | string | `submitted` |
| `code` | string | `activity` |
| `outcome` | string \| null | `activity`, `closed` |
| `comment` | string \| null | `activity` — the county's resident-facing note |
| `because` | string | `closed` |
| `reason` | string \| null | `canceled` |

**`fixed` and `closed_unresolved` both sit at the last stage.** The outcome is
the difference: `"Completed"` → `fixed`, `"No Problem Found"` →
`closed_unresolved`. Never render `closed_unresolved` as repaired — the county
closed the case without fixing the road.

`countyPhotos` are Salesforce URLs we do not host or presign. Test whether they
load for an anonymous browser before rendering them.

---

# Part 3 — Reporting a problem

## Step 1 — get a location

```js
let pos;
try {
  pos = await getPosition();            // { lat, lng, accuracy }
} catch (err) {
  // Permission denied is the common case. Fall back to dropping a map pin.
}
if (!inMiamiDade(pos)) {
  // The API returns 400 for anything outside the county.
}
```

## Step 2 — check for a duplicate first

In the real 311 data **46% of pothole reports sit within 50m of another one** —
people re-report because nothing tells them it is already known.

```js
const dupe = await sites.list({ category: 'pothole', lat: pos.lat, lng: pos.lng, radius: 100, status: 'all' });

if (dupe.count > 0) {
  const s = dupe.sites[0];
  // "28 people already reported this, 1m away. Open 275 days."
  //   [ I see it too ]        -> submit anyway, it joins this pin
  //   [ Report something else ] -> carry on to the form
}
```

Each row carries `distanceMeters`, `reportCount`, `daysOpen` and
`display.statusLabel`. Prefer **I see it too** — it adds weight to the existing
pin rather than creating a near-duplicate.

## Step 3 — `POST /api/reports` 🔒

`multipart/form-data`.

| field | required | |
|---|---|---|
| `category` | yes | a code from `/api/categories` |
| `lat`, `lng` | yes | must be inside Miami-Dade |
| `subType` | no | a subtype code; defaults to the category's first |
| `description` | no | trimmed to 1000 chars |
| `address` | no | trimmed to 200 chars |
| `photo` | no | image, max 15MB |

```js
const r = await reports.create({
  category: 'pothole',
  lat: pos.lat, lng: pos.lng,
  subType: 'pothole',
  description: 'Deep hole in the right lane',
  photo: fileFromCamera,
});
```

**201**

```json
{
  "report": { "id": "...", "siteId": "...", "source": "user", "status": "open",
              "photos": ["https://...presigned..."] },
  "site": { "id": "...", "reportCount": 29, "userReportCount": 1 },
  "mergedIntoExistingSite": true,
  "distanceToSiteMeters": 13,
  "expectedDaysToClose": 20.9,
  "located": {
    "municipality": "UNINCORPORATED MIAMI-DADE",
    "department": "Transportation and Public Works",
    "sla": "90 Business Days",
    "method": "nearest_311_record",
    "distanceMeters": 3,
    "confident": true
  },
  "filedWith311": {
    "filed": false,
    "dryRun": true,
    "alreadyFiled": false,
    "reason": null,
    "caseNumber": null,
    "eligibility": { "eligible": true, "municipality": "UNINCORPORATED MIAMI-DADE",
                     "reason": "...", "basis": "municipality",
                     "authoritativeCheckAvailable": false }
  }
}
```

**`mergedIntoExistingSite`**

- `true` — the report joined an existing pin. Say *"added to an existing report —
  29 people have now reported this"* and **do not add a marker**.
- `false` — a new site exists. Add one.

Either way the report is recorded. A duplicate is evidence the hole was never
fixed, so nothing is rejected.

Show `expectedDaysToClose` on the confirmation — *"typically fixed in about 21
days"*. It comes from 6,104 real records.

**`filedWith311`** — the county filing happens in this same call. There is no
separate submit step.

| field | |
|---|---|
| `filed` | true when a ticket was created at the county |
| `dryRun` | true while `MDC311_DRY_RUN=true` — the payload is built and stored, not sent. Say "ready to file", not "filed" |
| `alreadyFiled` | this report already had a ticket |
| `caseNumber` | the county case number once filed |
| `reason` | `null`, `"not_county_maintained"`, or the error |
| `eligibility.eligible` | false where the city maintains the road |

A 311 failure never fails the report — it comes back in `reason`.

`GET /api/sites/:id` carries `roadOwnership` — the authoritative answer from
the county's own Road Maintenance layer:

```json
"roadOwnership": {
  "eligible": true,
  "serviceCode": "PWROADWY",
  "street": "SW 128TH ST",
  "maintCode": "CO",
  "maintLabel": "County maintained",
  "roadOwner": "county",
  "municipality": "UNINCORPORATED MIAMI-DADE",
  "municipalities": ["UNINCORPORATED MIAMI-DADE"],
  "reason": "SW 128TH ST is county maintained — filed under PWROADWY",
  "basis": "road_maintenance_layer",
  "authoritativeCheckAvailable": true
}
```

`maintCode` decides everything: `CO` / `CM` / `CC` are county-maintained and
file under `PWROADWY`; `CI` is city-maintained and only City of Miami has a
service code here (`COMPWPH`); `SR` is state (FDOT) and 311 does not take it.

`basis` is `road_maintenance_layer` when the lookup succeeded, or
`municipality_fallback` when the map service was unreachable.

`located.method` is `nearest_311_record` or `none`; `confident` is true within
200m. The county will not accept a ticket without a municipality.

## `GET /api/reports/mine` 🔒

`?category=<code>` to narrow; omit for every category.

```json
{ "category": "all", "count": 1,
  "reports": [{ "id": "...", "source": "user", "status": "open",
                "sourceId": null, "description": "Deep hole in the right lane",
                "photos": ["https://...presigned..."] }] }
```

---

# Errors

The client throws `ApiError` with `.status` and `.message`; the message is
display-ready.

| code | body |
|---|---|
| 400 | `{ "error": "category is required — currently available: pothole" }` |
| 400 | `{ "error": "Coordinates are outside Miami-Dade County" }` |
| 400 | `{ "error": "subType must be one of: pothole, worn-roadway, cave-in, guardrail, fence" }` |
| 400 | `{ "error": "311 requires firstName, lastName, email on the account before a ticket can be filed" }` |
| 401 | `{ "error": "Missing or invalid Authorization header" }` — clear the token, go to login |
| 404 | `{ "error": "Unknown category \"nonsense\"" }` |
| 404 | `{ "error": "Category \"graffiti\" exists in the 311 data but is not enabled yet" }` |
| 404 | `{ "error": "Site not found" }` |
| 404 | `{ "error": "No account for that number — sign up first" }` |
| 409 | `{ "error": "Upload the selfie and the ID photo first" }` |
| 413 | photo over 15MB |

The two 404s differ on purpose: the second means *coming soon*, not a typo.

---

# Notes

**Photos.** Yours live in S3 and come back presigned for 15 minutes. The
county's `createServiceRequest` does **not** accept images, so a photo never
reaches 311 — show yours alongside their record. 208 of the 334 seeded reports
have one.

**Descriptions** also do not reach the county — the 311 payload has no free-text
field. A resident's note stays in your database.

**County progress is read from the database**, so no endpoint waits on 311.
Scripts keep it fresh:

```bash
node scripts/backfill-311.js --apply    # pull progress for tracked cases
node scripts/sync-311.js --apply        # reconcile status against the county
```

**Current data.** 40 sites, 334 reports behind them, 34 tracked county cases
(32 acknowledged, 1 fixed, 1 closed without a repair). One category enabled:
`pothole`.
