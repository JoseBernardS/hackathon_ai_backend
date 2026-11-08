# Parked: phone OTP verification

Removed on request. Sign-up and sign-in no longer send or check a code.

To restore:

    mv _parked/otp/otp                src/services/
    mv _parked/otp/infobip.client.js  src/services/
    mv _parked/otp/OtpChallenge.js    src/models/
    mv _parked/otp/setup-infobip.js   scripts/

...then re-add the `otp*` fields to Onboarding and User, the
`POST /:id/resend` and `/auth/otp/*` routes, and the issue/verify calls in the
onboarding and auth controllers. The Infobip env vars are still in `.env`.
