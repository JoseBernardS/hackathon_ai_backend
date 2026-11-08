# hackathon-ai-backend

Express + MongoDB + S3 backend with passwordless phone/OTP auth.

- **[examples/api-client.js](examples/api-client.js)** — drop-in browser client

## Setup

```bash
npm install
cp .env.example .env     # fill in Mongo, AWS and Infobip values
npm run setup:infobip    # creates the 2FA application, prints the two IDs
npm run dev
```

## Endpoints

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| GET | `/health` | — | Liveness |
| POST | `/api/onboarding` | — | Start a sign-up session |
| POST | `/api/onboarding/:id/documents` | — | Upload selfie and ID |
| POST | `/api/onboarding/:id/phone` | — | Set number, send OTP |
| POST | `/api/onboarding/:id/resend` | — | Resend the OTP |
| POST | `/api/onboarding/:id/verify` | — | Verify, create account, return token |
| GET | `/api/onboarding/:id` | — | Session status + presigned doc links |
| POST | `/api/auth/otp/request` | — | Login step 1 |
| POST | `/api/auth/otp/verify` | — | Login step 2, returns token |
| GET | `/api/auth/me` | Bearer | Current user |
| POST | `/api/auth/logout` | Bearer | Revoke all tokens |
| GET | `/api/categories` | — | Reportable categories (potholes only, for now) |
| GET | `/api/categories/:code` | — | One category: subtypes, SLA, endpoints |
| GET | `/api/sites` | — | The map: deduplicated problems for a category |
| GET | `/api/sites/:id` | — | One pin: its reports and county progress |
| POST | `/api/reports` | Bearer | File a report (auto-files with 311) |
| GET | `/api/reports/mine` | Bearer | Your own reports |
| POST | `/api/reports` | Bearer | Submit a report (category in the body) |
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
  models/      File, Onboarding, User, OtpChallenge
  services/
    upload.service.js    S3 put / presign / delete
    token.service.js     JWT sign and verify
    infobip.client.js    Infobip 2FA REST wrapper
    otp/                 provider abstraction (infobip | local fallback)
  controllers/ request handling
  routes/      express routers
  middleware/  auth, async wrapper, error handler
```

S3 holds the bytes, MongoDB holds the metadata. Buckets stay private; files are
served through 15-minute presigned URLs.

## OTP providers

`src/services/otp/` picks a provider at boot:

- **Infobip** when `INFOBIP_API_KEY`, `INFOBIP_APPLICATION_ID` and
  `INFOBIP_MESSAGE_ID` are all set. Infobip generates, delivers, expires and
  verifies the PIN; only its `pinId` is stored.
- **Local fallback** otherwise. The code is logged to the console and returned
  as `devCode`, so the flow stays testable without credentials.

## Known gaps

