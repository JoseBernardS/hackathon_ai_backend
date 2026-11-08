#!/usr/bin/env node
// One-time setup: creates the Infobip 2FA application and message template,
// then prints the two IDs to paste into .env.
//
//   node scripts/setup-infobip.js
require('dotenv').config();

const infobip = require('../src/services/infobip.client');

const APP_NAME = process.env.INFOBIP_APP_NAME || 'hackathon onboarding 2fa';
const TEXT = 'Your verification code is {{pin}}';

(async () => {
  if (!infobip.isConfigured) {
    console.error('Set INFOBIP_BASE_URL and INFOBIP_API_KEY in .env first.');
    process.exit(1);
  }

  try {
    const existing = await infobip.listApplications();
    const match = Array.isArray(existing) && existing.find((a) => a.name === APP_NAME);

    const app = match || (await infobip.createApplication(APP_NAME));
    console.log(match ? `Reusing application "${APP_NAME}"` : `Created application "${APP_NAME}"`);

    const message = await infobip.createMessageTemplate(app.applicationId, TEXT);
    console.log('Created message template.');

    console.log('\nAdd these to .env:\n');
    console.log(`INFOBIP_APPLICATION_ID=${app.applicationId}`);
    console.log(`INFOBIP_MESSAGE_ID=${message.messageId}`);
  } catch (err) {
    console.error('Setup failed:', err.message);
    process.exit(1);
  }
})();
