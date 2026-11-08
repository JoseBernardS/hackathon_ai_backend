/**
 * Miami-Dade 311 client.
 *
 * The portal is a Salesforce Experience Cloud site, so every call is the same
 * POST to the Aura endpoint with an Apex action envelope. Only the inner
 * `method` and `params` change.
 *
 * VERIFIED against the live endpoint (2026-11-08):
 *   - the envelope, namespace, classname and `handleRemoteWithoutCache` path
 *     are correct — the server echoes our fwuid back and returns typed Apex
 *     exceptions rather than wiring errors
 *   - `getServiceTypes` works and returns the 62-service catalog
 *   - `getServiceDefinition` DOES NOT EXIST — the server answers
 *     "Unknown method getServiceDefinition"
 *
 * UNVERIFIED: the method names for fetching one service's form schema, for
 * creating a request and for looking one up. They are config, not constants —
 * set them from MDC311_METHOD_* once captured from the portal's own network
 * traffic. Everything else here is ready.
 */
const FWUID =
  process.env.MDC311_FWUID ||
  'NjZ1S2dpaDFCTURrSEliQmh0ZXRhZ2tVMjdnTGFERUU2S3FfSVdrcU92bkExNS4zLjE2MDEw';
const APP_ID =
  process.env.MDC311_APP_ID || '1913_ebdeTt9njw4JArw_mL8PvA';

const BASE = 'https://311.miamidade.gov';
const AURA_PATH = '/311/s/sfsites/aura?r=1&aura.ApexAction.execute=1';

// Only `serviceTypes` is confirmed. Override the rest via env once known.
const METHODS = {
  serviceTypes: process.env.MDC311_METHOD_SERVICE_TYPES || 'getServiceTypes',
  serviceDefinition: process.env.MDC311_METHOD_SERVICE_DEFINITION || null,
  createRequest: process.env.MDC311_METHOD_CREATE_REQUEST || null,
  getRequest: process.env.MDC311_METHOD_GET_REQUEST || null,
};

const DRY_RUN = process.env.MDC311_DRY_RUN !== 'false'; // safe by default

class Mdc311Error extends Error {
  constructor(message, { kind = 'error', method, raw } = {}) {
    super(message);
    this.name = 'Mdc311Error';
    this.kind = kind; // 'unknown_method' | 'session' | 'stale_fwuid' | 'rate_limit' | 'error'
    this.method = method;
    this.raw = raw;
  }
}

function auraContext() {
  return JSON.stringify({
    mode: 'PROD',
    fwuid: FWUID,
    app: 'siteforce:communityApp',
    loaded: { 'APPLICATION@markup://siteforce:communityApp': APP_ID },
    dn: [],
    globals: {},
    uad: true,
  });
}

function envelope(method, params) {
  return JSON.stringify({
    actions: [
      {
        id: '1;a',
        descriptor: 'aura://ApexActionController/ACTION$execute',
        callingDescriptor: 'UNKNOWN',
        params: {
          namespace: 'Incap311CZ',
          classname: 'Base311CZ_Service_Wrapper',
          method: 'handleRemoteWithoutCache',
          // The inner params are a JSON *string*, not an object. The portal
          // double-encodes here; sending an object is silently rejected.
          params: { method, params: JSON.stringify(params) },
          cacheable: false,
          isContinuation: false,
        },
      },
    ],
  });
}

// The portal hands out a guest session cookie; some methods need one.
let cookieJar = '';

async function primeSession() {
  const res = await fetch(`${BASE}/311/s/`, {
    headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'text/html' },
  });
  const set = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  if (set.length) cookieJar = set.map((c) => c.split(';')[0]).join('; ');
  return Boolean(cookieJar);
}

async function rawCall(method, params) {
  const body = new URLSearchParams({
    message: envelope(method, params),
    'aura.context': auraContext(),
    'aura.pageURI': '/311/s/',
    'aura.token': 'null',
  });

  const res = await fetch(`${BASE}${AURA_PATH}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
      Origin: BASE,
      Referer: `${BASE}/311/s/`,
      'User-Agent': 'Mozilla/5.0',
      ...(cookieJar ? { Cookie: cookieJar } : {}),
    },
    body,
  });

  if (res.status === 429) {
    throw new Mdc311Error('Rate limited by 311', { kind: 'rate_limit', method });
  }

  const text = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    // A redirect to the login page comes back as HTML, not JSON.
    throw new Mdc311Error('311 returned a non-JSON response', {
      kind: 'session',
      method,
      raw: text.slice(0, 300),
    });
  }

  const action = parsed.actions && parsed.actions[0];
  if (!action) {
    throw new Mdc311Error('No action in the 311 response', { kind: 'error', method, raw: parsed });
  }

  if (action.state !== 'SUCCESS') {
    const err = (action.error && action.error[0]) || {};
    const message = err.message || 'Unknown 311 error';

    if (/Unknown method/i.test(message)) {
      throw new Mdc311Error(message, { kind: 'unknown_method', method, raw: err });
    }
    // Aura reports a stale framework version as an event, not a message.
    if (parsed.exceptionEvent || /fwuid|framework/i.test(message)) {
      throw new Mdc311Error(`Stale fwuid — refresh MDC311_FWUID. (${message})`, {
        kind: 'stale_fwuid',
        method,
        raw: err,
      });
    }
    throw new Mdc311Error(message, { kind: 'error', method, raw: err });
  }

  const rv = action.returnValue && action.returnValue.returnValue;
  if (rv === undefined || rv === null) return null;
  // Payloads come back as a JSON string.
  return typeof rv === 'string' ? JSON.parse(rv) : rv;
}

/** One retry after priming a session, for the 401/403/session-error case. */
async function call(method, params) {
  if (!method) {
    throw new Mdc311Error(
      'Method name not configured — set the matching MDC311_METHOD_* env var',
      { kind: 'unknown_method' }
    );
  }
  try {
    return await rawCall(method, params);
  } catch (err) {
    if (err.kind === 'session') {
      await primeSession();
      return rawCall(method, params);
    }
    throw err;
  }
}

/* ----------------------------- the four calls ---------------------------- */

/** The full service catalog. CONFIRMED WORKING. */
function getServiceTypes(language = 'EN') {
  return call(METHODS.serviceTypes, [{ language }]);
}

/** One service's form schema: attributes[], activities[], SLA. Method name TBC. */
function getServiceDefinition(serviceCode, language = 'EN') {
  return call(METHODS.serviceDefinition, [{ language, serviceCode }]);
}

/**
 * Submit a ticket. Honours MDC311_DRY_RUN (default true), which builds and
 * returns the payload without POSTing — so nothing reaches the county until
 * that is explicitly turned off.
 */
async function createServiceRequest(payload) {
  if (DRY_RUN) {
    return { dryRun: true, wouldSend: { method: METHODS.createRequest, params: [payload] } };
  }
  const out = await call(METHODS.createRequest, [payload]);
  return { dryRun: false, response: out };
}

/** Look up one ticket by its county number. Method name TBC. */
function getServiceRequest(serviceRequestId, language = 'EN') {
  return call(METHODS.getRequest, [{ language, serviceRequestId }]);
}

module.exports = {
  getServiceTypes,
  getServiceDefinition,
  createServiceRequest,
  getServiceRequest,
  primeSession,
  Mdc311Error,
  METHODS,
  DRY_RUN,
  FWUID,
};
