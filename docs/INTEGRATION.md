# Reporting a problem

The photo-to-report flow: the AI reads the photo, the resident approves it, and
either adds their weight to something already on the map or files a new report.

Base `http://localhost:4000`. 🔒 means `Authorization: Bearer <token>` — all
three endpoints need one.

```
1. POST /api/reports/analyze          photo + lat/lng
      ↓  draftId, proposal{}, nearby[]

2. ONE screen shows both:
      • the AI's draft  (editable)
      • "Is it one of these?" cards from nearby[]

3a. they tap a card              3b. they say "it's a new one"
    POST /api/sites/:id              POST /api/reports
         /affects-me                 { draftId, confirmed, consent, ...edits }
    → nothing filed                  → filed, and sent to 311
```

---

## 1. `POST /api/reports/analyze` 🔒

One call returns the AI draft **and** the duplicate candidates. Nothing is on
the map and nothing has reached the county after this.

`multipart/form-data`

| field | required | |
|---|---|---|
| `category` | yes | `pothole` |
| `lat`, `lng` | yes | must be inside Miami-Dade, else `400` |
| `photo` | **yes** | image, max 15MB |
| `address` | no | trimmed to 200 chars |

```js
const form = new FormData();
form.append('category', 'pothole');
form.append('lat', pos.lat);
form.append('lng', pos.lng);
form.append('photo', fileInput.files[0]);

const draft = await fetch(`${BASE_URL}/api/reports/analyze`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}` },
  body: form,
}).then(r => r.json());
```

### Response `201`

```json
{
  "draftId": "6af06c4a0c8425e1fa059ccf",
  "expiresInHours": 24,
  "photo": "https://...presigned...",
  "location": { "lat": 25.7942, "lng": -80.3107 },

  "ai": {
    "available": true,
    "reason": null,
    "model": "claude-opus-5-5",
    "looksLikeCategory": true,
    "confidence": 0.85,
    "rejectionReason": null
  },
  "proposal": {
    "subType": "pothole",
    "severity": 3,
    "description": "Shallow pothole roughly 3 by 2 feet, about 1-2 inches deep, in asphalt along the gutter edge, with raveling edges and loose aggregate.",
    "hazards": ["raveling edges"]
  },
  "subtypeOptions": [
    { "code": "pothole",      "label": "Pothole" },
    { "code": "worn-roadway", "label": "Roadway is worn or has defects" },
    { "code": "cave-in",      "label": "Cave-in or sinkhole" },
    { "code": "guardrail",    "label": "Guardrail or handrail is damaged" },
    { "code": "fence",        "label": "Fence along roadway needs repair" }
  ],

  "nearby": [
    {
      "siteId": "6aefece183feb50b85daad3f",
      "distanceMeters": 14,
      "reportCount": 4,
      "endorsementCount": 1,
      "totalVoices": 5,
      "address": "2200 NW 70TH AVE",
      "statusLabel": "Open 101 days",
      "thumbnail": "https://...presigned...",
      "affectsMeEndpoint": "POST /api/sites/6aefece183feb50b85daad3f/affects-me"
    }
  ],

  "next": "Ask \"is it one of these?\" — yes: POST the site's affectsMeEndpoint..."
}
```

Takes **3–4 seconds**. Put a spinner on the shutter button.

### Rendering the draft

`proposal.description` goes in an **editable** text box, `severity` on a 1–5
control, `subType` on a picker built from `subtypeOptions`. Never present it as
final — the resident approving it is the point of the whole step.

| condition | what to show |
|---|---|
| `ai.looksLikeCategory === false` | `ai.rejectionReason` as a warning. **Let them continue anyway** — the model can be wrong, and blocking a real pothole is worse than one junk report. |
| `ai.confidence < 0.6` | "Please check this before sending" |
| `ai.available === false` | the same form, empty. `ai.reason` says why. Nothing is broken; they type it themselves. |

### Rendering `nearby[]` — "Is it one of these?"

Open problems within **150m**, nearest first, max 3. Each is a card with the
`thumbnail`, `distanceMeters` and `statusLabel`.

The resident decides, not the server. They are standing in front of the pothole
and can answer from a thumbnail instantly. Distance alone gets it wrong both
ways: two different holes 12m apart look like one, and a single hole
photographed from both ends 120m apart looks like two.

`totalVoices` (`reportCount + endorsementCount`) is the number for the card.

Empty `nearby[]` → skip straight to step 3b.

---

## 2. Button state — `GET /api/sites/:id`

Only needed to render "Affects me too" correctly when a site sheet loads.
**Send the token** and the response carries:

```json
"endorsement": {
  "endorsementCount": 1,
  "totalVoices": 5,
  "youEndorsed": true,
  "endpoint": "POST /api/sites/6aefece183feb50b85daad3f/affects-me"
}
```

| field | |
|---|---|
| `youEndorsed` | render the button pressed. `false` when signed out, so the sign-in prompt fires on tap, not on load. |
| `totalVoices` | the number for the button and the pin |

The route is public — no token means `youEndorsed: false` and the page still
loads. An expired token reads as an anonymous visit, never a `401`. Who
endorsed is never returned, only the count.

---

## 3a. `POST /api/sites/:id/affects-me` 🔒

They tapped a card. **This is the common path.**

No body. Idempotent — a double tap is the same as one.

```js
await fetch(`${BASE_URL}/api/sites/${card.siteId}/affects-me`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}` },
});
```

### Response `200`

```json
{
  "siteId": "6aefece183feb50b85daad3f",
  "endorsed": true,
  "alreadyEndorsed": false,
  "endorsementCount": 1,
  "reportCount": 4,
  "totalVoices": 5
}
```

Files nothing. No new pin, no second 311 case, no photo kept. The draft is
simply abandoned and expires after 24 hours.

A second tap returns `alreadyEndorsed: true` with the count unchanged.

---

## 3b. `POST /api/reports` 🔒

They said it is a different problem, or there were no cards.

`application/json`

| field | required | |
|---|---|---|
| `category` | yes | must match the draft's |
| `draftId` | yes | from step 1 |
| `confirmed` | **`true`** | they pressed the button. `400` without it. |
| `consent` | **`true`** | their name, email and phone go on a public county case |
| `forceNewSite` | no | `true` when they said it is a *different* problem — stops the silent 100m geo merge |
| `joinSiteId` | no | they picked a card but want their photo on it too |
| `subType` | no | their edit; omitted keeps the AI's |
| `severity` | no | their edit, 1–5 |
| `description` | no | their edit; omitted keeps the AI's text |
| `address` | no | their edit |
| `preview` | no | **`true` runs everything and saves nothing** — see below |

```js
await fetch(`${BASE_URL}/api/reports`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  },
  body: JSON.stringify({
    category: 'pothole',
    draftId: draft.draftId,
    confirmed: true,
    consent: true,
    forceNewSite: true,      // "no, this is a different one"
    description: editedText, // omit to keep what the AI wrote
    severity: editedSeverity,
  }),
});
```

The photo comes off the draft — **do not upload it again.**

### `preview: true` — for demoing

Runs the whole thing and writes nothing. The eligibility check against the
county's road-maintenance layer is real, the 311 payload is real, the dedupe
decision is real, and a case number comes back — but no report, no pin, no
ticket, no S3 upload, and the draft is **not** consumed, so the same one can be
replayed as many times as you like.

```js
body: JSON.stringify({ ...everythingElse, preview: true })
```

Response is `200` (not `201`), with `wouldCreate` in place of `report`/`site`:

```json
{
  "preview": true,
  "wouldCreate": {
    "report": { "categoryCode": "pothole", "subType": "pothole", "severity": 3,
                "description": "...", "photos": ["https://...presigned..."] },
    "newSite": true,
    "joiningSiteId": null
  },
  "mergedIntoExistingSite": false,
  "distanceToSiteMeters": 0,
  "located": { "municipality": "UNINCORPORATED MIAMI-DADE", "...": "..." },
  "filedWith311": {
    "filed": true,
    "simulated": true,
    "caseNumber": "26-97276647",
    "slaTarget": "90 Business Days",
    "expectedAt": "2027-03-14T...",
    "eligibility": { "eligible": true, "maintLabel": "County maintained", "...": "..." }
  },
  "note": "Nothing was saved. Send without preview to file for real."
}
```

Drop `preview` to file for real.

### Response `201`

```json
{
  "report": {
    "id": "6af0648b69f1d2a291e81c2a",
    "siteId": "6af0648b69f1d2a291e81c30",
    "source": "user",
    "status": "open",
    "severity": 3,
    "aiAssisted": true,
    "aiEdited": false,
    "photos": ["https://...presigned..."]
  },
  "site": { "id": "...", "reportCount": 1, "totalVoices": 1 },
  "mergedIntoExistingSite": false,
  "distanceToSiteMeters": 0,
  "expectedDaysToClose": 20.9,
  "located": {
    "municipality": "UNINCORPORATED MIAMI-DADE",
    "department": "Transportation and Public Works",
    "sla": "90 Business Days"
  },
  "filedWith311": {
    "filed": false,
    "dryRun": true,
    "caseNumber": null,
    "eligibility": {
      "eligible": true,
      "serviceCode": "PWROADWY",
      "street": "SW 106TH AVE",
      "maintCode": "CO",
      "maintLabel": "County maintained",
      "roadOwner": "county",
      "basis": "road_maintenance_layer"
    }
  }
}
```

`aiEdited` is `true` only if they actually changed something — the honest signal
for whether a human reviewed it or tapped through.

`filedWith311.dryRun: true` means the submission was built and stored but never
sent to the county. It is a server setting; just show whatever `dryRun` says.

`eligibility.eligible: false` means the road is not county-maintained — read
`eligibility.reason` and tell them which city to contact.

---

## Errors

| code | where | meaning |
|---|---|---|
| `400` | analyze | coordinates outside Miami-Dade, or no `photo` |
| `400` | reports | `confirmed` was not `true` |
| `401` | any 🔒 | missing, expired or revoked token — sign in again |
| `404` | reports | draft expired (24h) or never existed |
| `409` | reports | that draft was already filed |
| `413` | analyze | photo over 15MB |

Every error is `{ "error": "<message>" }`. Show `error` directly — the messages
are written for residents.

---

## Notes

- Presigned URLs (`photo`, `thumbnail`, `photos[]`) expire after **15 minutes**.
  Re-fetch rather than caching them.
- A draft expires after 24 hours and can be filed once.
- `lat`/`lng` must be within Miami-Dade: lat `25.1`–`26.1`, lng `-80.9`–`-80.0`.
- The backend needs `ANTHROPIC_API_KEY` for step 1. Without it the draft is
  still created with `ai.available: false` and the resident fills the form in.
