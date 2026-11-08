# County resolution vs. peer-reported outcome

Two independent records of whether a pothole is actually fixed. Neither overrides
the other; both are published, and the verdict says whether they agree.

| | county | peer |
|---|---|---|
| source | 311 case status | a verified resident at the spot |
| authority | official | unofficial |
| what it means | the **ticket** is done | the **road** is or isn't fixed |
| volume | 6,104 reports | 30 observations |
| failure mode | closes on paperwork, not repair | low volume, forgeable, self-selected |

The 311 data is full of cases that closed and were re-reported weeks later, and
whole categories that close same-day as an administrative disposition. A closed
case is evidence about process, not pavement. That gap is the product.

---

## The verdict

Seven states, from `src/services/reconcile.service.js`. Counts are the current
40-site demo data.

| effectiveStatus | county | peers | n | meaning |
|---|---|---|---|---|
| `open_unverified` | open | — | 23 | nobody has checked |
| `open_confirmed` | open | still there | 8 | corroborated open |
| `fixed_unrecorded` | open | fixed | 3 | repaired, paperwork lagging |
| `closed_unverified` | closed | — | 1 | closed, unchecked |
| `fixed_confirmed` | closed | fixed | 1 | both agree it's done |
| **`disputed_closure`** | closed | still there | **3** | **closed on paper, not on the road** |
| `contested` | closed | both | 1 | residents disagree |

`disputed_closure` is the headline. Filter for it with `?disputed=1`, which also
includes `contested`. Outcome endpoints take a site id and need no `category` —
the category is read off the site.

### Two rules that keep it honest

**Pre-closure observations are discarded.** If the county closed the case on
Sept 1, a "still there" from July describes the road *before* the repair — that
is what got fixed. Only what was seen after the closure can dispute it. Counted
in `peer.ignoredAsPreClosure`.

**One observer, one vote.** The latest observation per person wins. Someone who
said "still there" in March and "fixed" in June counts once, as fixed.

### Confidence

`0..1`, from evidence weight and recency, not headcount:

```
confidence = min(Σ proof_weight / 3, 1) × 0.5 ^ (days_since_newest / 60)
```

Weighting by proof means eight unevidenced claims cannot outrank three
GPS-verified photos. The 60-day half-life means a year-old observation decays
toward irrelevance rather than standing forever — in the demo data two sites
have identical evidence weight (3.0) and confidences of **0.98** and **0.16**,
purely because one was last seen in November and the other in May.

---

## Photo proof

Every submitted photo is graded on what can be checked from its bytes
(`src/services/proof.service.js`). The grade sets the claim's weight.

| grade | weight | earned by |
|---|---|---|
| `geo_verified` | 1.0 | EXIF GPS within 150m of the site, plausible timestamp, after any closure |
| `time_verified` | 0.6 | usable EXIF timestamp after the closure, no GPS |
| `photo_only` | 0.35 | a photo, but no usable metadata |
| `none` | 0.2 | a bare claim, no photo |
| `geo_mismatch` | 0.1 | EXIF GPS puts the photo somewhere else |
| `duplicate` | 0.0 | byte-identical to a photo already used at another site — **does not vote** |

Checks run on upload and are stored on the outcome: `sha256`, `bytes`,
`hasGps`, `gpsDistanceMeters`, `gpsMatchesSite`, `takenAt`, `ageDays`,
`timestampPlausible`, `takenAfterCountyClosure`, `camera`, `isDuplicate`. The
`checks` object always has the same shape, so a client never branches on whether
a photo was attached.

Order of evaluation matters:

- A **duplicate** is caught before anything else and scores zero.
- A **GPS mismatch** is demoted below a photo with no GPS at all. A file whose
  own metadata contradicts the claim is weaker evidence than one that simply
  says nothing.
- A photo that **predates the county's closure** cannot earn `geo_verified`
  however good its GPS is — it shows the road before the work.
- A **future or implausibly old** timestamp (>365 days) is not usable.

The EXIF reader is a focused JPEG APP1/TIFF parser (no dependency) that pulls
`DateTimeOriginal`, `GPSLatitude/Longitude` and `Make`/`Model`. It returns `{}`
rather than throwing on a malformed, truncated, or non-JPEG file.

### What this does not claim

- **EXIF is forgeable.** `geo_verified` means *consistent with the claim*, not
  *proven*. It raises the cost of a false report; it does not eliminate it.
  `scripts/lib/exif-inject.js` forges it in about 90 lines, which is the point.
  Cryptographic capture attestation (Play Integrity, App Attest) is the next
  rung and is not implemented.
- **Duplicate detection is exact-match only.** SHA-256 catches a literal
  re-upload. A re-encoded or cropped copy needs a perceptual hash, which needs
  pixel decoding, which needs an image codec this project does not depend on.
- **Nothing here judges whether the photo shows a road.** That is a vision
  question, not a metadata question.

### It caught something unprompted

One of the 21 stock photos, `13_Bache_en_una_banqueta.jpg`, carries genuine EXIF
GPS at **19.2768, -99.1218** — Milpa Alta, Mexico City, from a *motorola moto
g24*. Submitted as proof for a Miami site it grades `geo_mismatch` at 2,022km,
and its claim drops to weight 0.1. Nobody configured that; the grader read the
file. It is kept in the demo data as the worked example.

---

## API

### `POST /api/sites/:id/outcome` — auth required

`multipart/form-data`, photo field **`photo`**.

| field | required | notes |
|---|---|---|
| `kind` | yes | `still_there` or `fixed` |
| `photo` | no | graded as above |
| `note` | no | trimmed to 500 chars |
| `lat`, `lng` | no | where the observer stood |

```json
{
  "outcome": {
    "id": "...", "kind": "still_there", "reporterName": "Jordan S.",
    "observedAt": "2026-11-08T...", "origin": "user",
    "photos": ["https://...presigned..."], "thumbnails": ["https://...presigned..."]
  },
  "proof": {
    "grade": "geo_verified", "weight": 1,
    "label": "Photo GPS matches this location",
    "checks": { "hasGps": true, "gpsDistanceMeters": 0, "gpsMatchesSite": true,
                "gpsToleranceMeters": 150, "takenAt": "2026-11-08T...", "ageDays": 0,
                "timestampPlausible": true, "takenAfterCountyClosure": true,
                "camera": "iPhone 17", "sha256": "fd175d32...", "isDuplicate": false }
  },
  "site": { "county": { "...": "" }, "peer": { "...": "" }, "reconciliation": { "...": "" } },
  "countedTowardVerdict": true
}
```

`reporterName` is the submitter's `displayName`, denormalised at write time so
*"Reported fixed by Jordan S."* survives a later rename or account deletion.

### `GET /api/sites/:id/outcomes`

The peer record for one site: `county`, `peer`, `reconciliation`, and every
observation with its proof grade, newest first.

### Feed filters

```
GET /api/sites?category=pothole&disputed=1&status=all             # the two disagree
GET /api/sites?category=pothole&effectiveStatus=disputed_closure  # one specific state
```

Every site in the feed and detail payloads carries `county`, `peer` and
`reconciliation`.

---

## Seed data

The 30 peer observations are **synthetic**, written with `origin: 'seed'` and
removable on that basis. Real submissions arrive as `origin: 'user'`.

What is *not* synthetic is the grading. Photos destined for a GPS-verified
outcome get real EXIF written at the site's own coordinates and then go through
the same grader as a live upload — the grades are earned by the bytes, not
assigned. That is why one of them comes out `geo_mismatch`.

```bash
node scripts/seed-photos.js   --dir <pics>            # upload photos, attach to reports
node scripts/seed-outcomes.js --dir <pics>            # dry run, prints the plan
node scripts/seed-outcomes.js --dir <pics> --apply    # write and rebuild
```

Both default to a dry run. `<pics>` needs `full/` and `thumb/` subfolders with
matching filenames.

### Photos

21 pothole photos, compressed hard from 21MB to **2.4MB** (116KB average, 900px)
plus **268KB** of thumbnails (13KB average, 320px), under
`s3://umiamihack2026/potholes/seed/` and `outcomes/seed/`. Keys are derived from
the filename, so re-running overwrites rather than duplicating. 208 of 334
reports carry a photo and all 40 sites have at least one.

`photoKeys` and `thumbKeys` are stored separately and both come back presigned,
as `photos` and `thumbnails`. Map pins should pull the 13KB thumbnail.
