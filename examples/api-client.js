// Drop-in API client for the frontend. Framework agnostic, works in React,
// Vue, Svelte or plain JS. Uses the browser fetch API.
//
//   import { api, auth } from './api-client';

const BASE_URL = import.meta?.env?.VITE_API_URL || 'http://localhost:4000';
const TOKEN_KEY = 'auth_token';

// --- token storage ----------------------------------------------------------
// localStorage is readable by any script on the page. It is the pragmatic
// choice for a hackathon; a production app should prefer an httpOnly cookie.

export const auth = {
  get: () => localStorage.getItem(TOKEN_KEY),
  set: (token) => localStorage.setItem(TOKEN_KEY, token),
  clear: () => localStorage.removeItem(TOKEN_KEY),
  isSignedIn: () => Boolean(localStorage.getItem(TOKEN_KEY)),
};

// --- core request helper ----------------------------------------------------

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function request(path, { method = 'GET', body, form, authed = false } = {}) {
  const headers = {};
  if (authed) {
    const token = auth.get();
    if (!token) throw new ApiError(401, 'Not signed in');
    headers.Authorization = `Bearer ${token}`;
  }

  // Let the browser set the multipart boundary; never set Content-Type for FormData.
  if (body && !form) headers['Content-Type'] = 'application/json';

  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: form || (body ? JSON.stringify(body) : undefined),
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    // A revoked or expired token should drop the session immediately.
    if (res.status === 401 && authed) auth.clear();
    throw new ApiError(res.status, data.error || res.statusText);
  }

  return data;
}

// --- onboarding (sign-up) ---------------------------------------------------

export const onboarding = {
  start: () => request('/api/onboarding', { method: 'POST' }),

  // selfie and idDocument are File objects from an <input type="file">.
  uploadDocuments: (sessionId, { selfie, idDocument }) => {
    const form = new FormData();
    if (selfie) form.append('selfie', selfie);
    if (idDocument) form.append('idDocument', idDocument);
    return request(`/api/onboarding/${sessionId}/documents`, { method: 'POST', form });
  },

  /**
   * The last step: the phone number finishes the sign-up and returns a token.
   * `firstName`, `lastName` and `email` are optional here but required before
   * a report can be filed with 311, so collect them now if you can.
   */
  finish: async (sessionId, { phone, displayName, firstName, lastName, email } = {}) => {
    const data = await request(`/api/onboarding/${sessionId}/phone`, {
      method: 'POST',
      body: { phone, displayName, firstName, lastName, email },
    });
    auth.set(data.token);
    return data;
  },

  status: (sessionId) => request(`/api/onboarding/${sessionId}`),
};

// --- login (returning users) ------------------------------------------------

export const login = {
  // Stores the token on success: the user is signed in from here.
  withPhone: async (phone) => {
    const data = await request('/api/auth/login', { method: 'POST', body: { phone } });
    auth.set(data.token);
    return data;
  },
};

// --- session ----------------------------------------------------------------

export const session = {
  me: () => request('/api/auth/me', { authed: true }),

  logout: async () => {
    try {
      await request('/api/auth/logout', { method: 'POST', authed: true });
    } finally {
      auth.clear();
    }
  },
};

// --- categories -------------------------------------------------------------
// Fetch this once on launch and build your UI from it. Do not hardcode category
// codes, subtype lists or endpoint paths — they come from here.

export const categories = {
  list: ({ includeBacklog = false, stats = true } = {}) => {
    const q = new URLSearchParams();
    if (includeBacklog) q.set('includeBacklog', '1');
    if (!stats) q.set('stats', '0');
    const qs = q.toString();
    return request(`/api/categories${qs ? `?${qs}` : ''}`);
  },

  get: (code) => request(`/api/categories/${code}`),
};

// --- sites (the map) --------------------------------------------------------
// A "site" is one deduplicated problem location. Many reports collapse into
// one site, so this is what you put pins on.

function qs(params) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') q.set(k, String(v));
  }
  return q.toString();
}

export const sites = {
  /**
   * The map feed. Defaults to open sites only — pass status:'all' for
   * everything including resolved.
   *   list({ category:'pothole', lat, lng, radius: 3000, minReports: 3 })
   */
  list: ({ category, lat, lng, radius, status, minReports, limit } = {}) =>
    request(`/api/sites?${qs({ category, lat, lng, radius, status, minReports, limit })}`),

  /** Call before submitting. If `duplicateLikely`, show the existing site. */
  nearby: ({ category, lat, lng, radius } = {}) =>
    request(`/api/sites/nearby?${qs({ category, lat, lng, radius })}`),

  /** Countywide baseline, plus local numbers when lat/lng are given. */
  stats: ({ category, lat, lng, radius } = {}) =>
    request(`/api/sites/stats?${qs({ category, lat, lng, radius })}`),

  /** Worst repeat-report locations. */
  hotspots: ({ category, minReports, limit, lat, lng, radius, status } = {}) =>
    request(`/api/sites/hotspots?${qs({ category, minReports, limit, lat, lng, radius, status })}`),

  /** One site plus every report behind it. No category needed — ids are unique. */
  get: (siteId) => request(`/api/sites/${siteId}`),
};

// --- reports ----------------------------------------------------------------

export const reports = {
  /**
   * File a new report. If a site already exists within the category's dedupe
   * radius the report joins it and the map gains no new pin — check
   * `mergedIntoExistingSite` in the response.
   */
  create: ({ category, lat, lng, subType, description, address, photo } = {}) => {
    const form = new FormData();
    form.append('category', category);
    form.append('lat', lat);
    form.append('lng', lng);
    if (subType) form.append('subType', subType);
    if (description) form.append('description', description);
    if (address) form.append('address', address);
    if (photo) form.append('photo', photo);
    return request('/api/reports', { method: 'POST', form, authed: true });
  },

  /** The signed-in user's reports. Omit category for all of them. */
  mine: ({ category } = {}) => request(`/api/reports/mine?${qs({ category })}`, { authed: true }),
};

// --- Miami-Dade 311 ---------------------------------------------------------
// Filing with the county and tracking what they do about it. A report lives in
// our database; a ticket is the county's own case. They are separate on
// purpose, so the county's record never overwrites the resident's.

export const mdc311 = {
  /**
   * Integration health. Check `dryRun` before showing any "file it" UI — while
   * it is true, submissions are built and stored but never sent to the county.
   */
  status: () => request('/api/311/status'),

  /** Would the county accept a ticket for this location? Call before offering to file. */
  eligibility: (siteId) => request(`/api/311/eligibility/${siteId}`),

  /**
   * File a report with 311. Needs the REPORT id, not the site id.
   * 409 means the road is not county-maintained — read `eligibility.reason`.
   */
  submit: (reportId) => request(`/api/311/reports/${reportId}/submit`, { method: 'POST', authed: true }),

  /** Tickets we have filed or adopted. Optional { status, siteId }. */
  tickets: ({ status, siteId } = {}) => request(`/api/311/tickets?${qs({ status, siteId })}`),

  /** One ticket: the county's status, stage ladder, timeline and our status history. */
  ticket: (ticketId) => request(`/api/311/tickets/${ticketId}`),

  /** Pull the county's record now. `force` skips the 10-minute cache. */
  refresh: (ticketId, { force = false } = {}) =>
    request(`/api/311/tickets/${ticketId}/refresh${force ? '?force=1' : ''}`, {
      method: 'POST',
      authed: true,
    }),
};

// --- helpers ----------------------------------------------------------------

// Turns loose user input into E.164. Defaults to +1 for 10-digit US numbers.
export function toE164(input, defaultCountryCode = '1') {
  const digits = String(input).replace(/\D/g, '');
  if (String(input).trim().startsWith('+')) return `+${digits}`;
  if (digits.length === 10) return `+${defaultCountryCode}${digits}`;
  return `+${digits}`;
}

// Reads the browser's GPS. Reports need coordinates, so call this before
// opening the report form and handle refusal — permission is often denied.
export function getPosition({ timeout = 10000, highAccuracy = true } = {}) {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('Geolocation is not available'));
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy }),
      (err) => reject(new Error(err.code === 1 ? 'Location permission denied' : 'Could not get your location')),
      { timeout, enableHighAccuracy: highAccuracy }
    );
  });
}

// Miami-Dade bounds. The API rejects anything outside with a 400, so check
// before you let the user submit.
export function inMiamiDade({ lat, lng }) {
  return lat >= 25.1 && lat <= 26.1 && lng >= -80.9 && lng <= -80.0;
}

export const api = { onboarding, login, session, categories, sites, reports, mdc311, auth, toE164, getPosition, inMiamiDade };
export default api;
