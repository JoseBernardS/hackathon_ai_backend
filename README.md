# hackathon-ai-backend

Express + MongoDB + S3 backend for civic problem reporting in Miami-Dade,
with Claude-assisted photo triage and real 311 filing.

- **[examples/api-client.js](examples/api-client.js)** — drop-in browser client

## Setup

```bash
npm install
cp .env.example .env     # Mongo, AWS, JWT, ANTHROPIC_API_KEY
npm run dev
```

## Endpoints

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| GET | `/health` | — | Liveness |
| POST | `/api/onboarding` | — | Start a sign-up session |
| POST | `/api/onboarding/:id/documents` | — | Upload selfie and ID |
| POST | `/api/onboarding/:id/phone` | — | Finish sign-up, returns token |
| GET | `/api/onboarding/:id` | — | Session status + presigned doc links |
| POST | `/api/auth/login` | — | Sign in with the phone number, returns token |
| GET | `/api/auth/me` | Bearer | Current user |
| POST | `/api/auth/logout` | Bearer | Revoke all tokens |
| GET | `/api/categories` | — | Reportable categories (potholes only, for now) |
| GET | `/api/categories/:code` | — | One category: subtypes, SLA, endpoints |
| GET | `/api/sites` | — | The map: deduplicated problems for a category |
| GET | `/api/sites/:id` | — | One pin: its reports and county progress |
| POST | `/api/reports/analyze` | Bearer | Read the photo, return a draft + nearby matches |
| POST | `/api/sites/:id/affects-me` | Bearer | "It affects me too" on an existing problem |
| POST | `/api/reports` | Bearer | File a report (auto-files with 311) |
| GET | `/api/reports/mine` | Bearer | Your own reports |
| POST | `/api/files` | — | Upload a file |
| GET | `/api/files` | — | List recent files |
| GET | `/api/files/:id` | — | Metadata + presigned URL |
| DELETE | `/api/files/:id` | — | Delete from S3 and Mongo |

**One doc for the whole integration: [docs/INTEGRATION.md](docs/INTEGRATION.md)** —
sign-up, login, the map, reporting and county progress. Drop-in client:
`examples/api-client.js`.

## Architecture

```
src/
  config/      mongo connection, S3 client
  data/        category registry (pothole.json, mdc311-pothole.json)
  models/      File, Onboarding, User, Report, ReportDraft, Site, ExternalTicket
  services/
    upload.service.js    S3 put / presign / delete
    token.service.js     JWT sign and verify
    vision.service.js    Claude reads the photo, proposes the report
    dedupe.service.js    leader clustering, reports -> sites
    locate.service.js    coordinate -> municipality / department / SLA
    roadmaint.service.js MAINTCODE lookup: who maintains this road
    mdc311.service.js    eligibility, payload, filing
    mdc311.status.js     the county's reply -> our status ladder
    display.service.js   the render block for a map pin
  controllers/ request handling
  routes/      express routers
  middleware/  auth, async wrapper, error handler, category resolver
```

S3 holds the bytes, MongoDB holds the metadata. Buckets stay private; files are
served through 15-minute presigned URLs.

## Photo triage

`src/services/vision.service.js` sends the uploaded photo to Claude Opus 5.5 and
gets back `{ matchesCategory, confidence, subType, severity, description,
hazards }`. The resident confirms or edits it before anything is written — see
Part 3 of the integration guide.

Without `ANTHROPIC_API_KEY` the draft is still created with
`ai.available: false`, and the resident fills the form in by hand.

## Parked

`_parked/otp/` — the OTP login step (Infobip + local provider), removed on
request. `_parked/peer-review/` — resident-confirmed outcomes and photo proof.
Each has a README with restore steps.
