# Verification of work

Residents answering the one question the county's record cannot: **was it
actually fixed?**

A 311 case closing means the agency considers the ticket done. In the 2026
Miami-Dade export, **25.1% of closed pothole cases were re-reported at the same
spot — 99 of them within a week of closure.** The county closes 99.3% of them
with a single outcome, `"Inspection Completed"`, which does not say whether
anything was repaired. Only the people who walk past it can say which.

Base `http://localhost:4000`. 🔒 means `Authorization: Bearer <token>`.

```
GET  /api/sites/:id              read the state  (token optional)
POST /api/sites/:id/verify  🔒   answer: fixed / not fixed, + optional photo
```

---

## `POST /api/sites/:id/verify` 🔒

`multipart/form-data`, or `application/json` when there is no photo.

| field | required | |
|---|---|---|
| `fixed` | **yes** | `true` or `false` |
| `note` | no | what they can see, 500 chars |
| `photo` | no | proof, max 15MB |

```js
const form = new FormData();
form.append('fixed', 'false');
form.append('note', 'Still there, right lane, deeper than last month');
form.append('photo', fileInput.files[0]);

await fetch(`${BASE_URL}/api/sites/${siteId}/verify`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}` },
  body: form,
});
```

**One answer per resident.** Posting again replaces it rather than voting twice
— `changedYourAnswer` tells you they flipped.

### Response `200`

```json
{
  "siteId": "6aefece183feb50b85daad3f",
  "yourAnswer": "not_fixed",
  "changedYourAnswer": false,
  "fixedCount": 0,
  "notFixedCount": 1,
  "verdict": "not_fixed",
  "countyStatus": "closed",
  "photo": "https://...presigned..."
}
```

`countyStatus` is what Miami-Dade claims. `verdict` is what the neighbourhood
says. Showing them together is the whole feature.

---

## `GET /api/sites/:id`

Public. **Send the token anyway** — a signed-in request also says what the
reader answered, so the buttons render in the right state instead of blank.

```json
"verification": {
  "fixedCount": 2,
  "notFixedCount": 1,
  "verdict": "fixed",
  "yourAnswer": "not_fixed",
  "confirmedBy": ["Ana P", "Maria G"],
  "evidence": [
    {
      "says": "fixed",
      "by": "Luis R",
      "at": "2026-11-08T14:26:25.635Z",
      "note": "Repaved this week",
      "photo": "https://...presigned..."
    },
    {
      "says": "not_fixed",
      "by": "Maria G",
      "at": "2026-11-08T14:26:25.212Z",
      "note": "Still there, right lane, deeper than last month",
      "photo": "https://...presigned..."
    }
  ],
  "endpoint": "POST /api/sites/6aefece183feb50b85daad3f/verify"
}
```

| field | |
|---|---|
| `verdict` | `fixed` · `not_fixed` · `disputed` · `null` |
| `yourAnswer` | `fixed` · `not_fixed` · `null`. `null` when signed out, so the sign-in prompt fires on tap rather than on load. |
| `confirmedBy` | last 3 names who said fixed — for "Confirmed fixed by Maria G." |
| `evidence` | the attached pictures, newest first, up to 6 |

**`disputed` is a real answer, not a failure to decide.** If two say fixed and
two say not, rendering "fixed" would be a lie and rendering nothing would waste
what they told you. Show the disagreement.

Names are denormalised when the answer is written, so they survive a rename or
a deleted account. **Who voted is never returned — only counts and the names of
people who attached their claim to a photo.**

---

## What to build

Show this on a site the county has closed:

> **Miami-Dade: closed — "Inspection Completed"**
> **Is it actually fixed?**  `[ Yes ]`  `[ No, still there ]`

Then, once there are answers:

> **Miami-Dade: closed — "Inspection Completed"**
> **3 neighbours say it's still there**
>
> Maria G · *"Still there, right lane, deeper than last month"* 📷
> Luis R · *"Repaved this week"* 📷

That contradiction is what residents can screenshot and send to a commissioner.
The county's own system cannot produce it.

### Rendering notes

- A photo is **optional**. `evidence.length` against `fixedCount + notFixedCount`
  tells you how many claims are backed by one — *"3 say still there, 2 with
  photos."* Weight them in the UI if you like; the API does not.
- `yourAnswer` drives the pressed state. Re-posting is safe and idempotent in
  effect — it replaces, never double-counts.
- Sort `evidence` as given; it is already newest first.

---

## Errors

| code | meaning |
|---|---|
| `400` | `fixed` was missing or not a boolean |
| `401` | missing, expired or revoked token — sign in again |
| `404` | no site with that id |
| `413` | photo over 15MB |

Every error is `{ "error": "<message>" }`, written to be shown to a resident.

Presigned photo URLs expire after **15 minutes** — re-fetch rather than caching.
