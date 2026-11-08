/**
 * Reads a photo and proposes a report.
 *
 * The resident is never asked to write anything: of 334 reports in the seed,
 * zero carry a description, so the only real signal in a report is the image.
 * This turns that image into the four fields a 311 case actually needs, and
 * the resident then confirms or edits them before anything is filed.
 *
 * Nothing here decides anything on its own. The verdict is a proposal stored on
 * a draft; `report.controller` only ever writes what the resident confirmed.
 */
const Anthropic = require('@anthropic-ai/sdk');

const MODEL = 'claude-opus-5-5';

// A photo plus a small JSON object. Thinking is always on for this model and
// draws from the same ceiling, so leave headroom rather than truncate mid-object.
const MAX_TOKENS = 8000;

// A resident is watching a spinner on the submit screen. At 'medium' this ran
// ~8s; 'low' is the right trade for a one-sentence extraction. Raise it if the
// descriptions start coming back thin.
const EFFORT = 'low';

const ACCEPTED = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

let client = null;
function getClient() {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  if (!client) client = new Anthropic();
  return client;
}

function isConfigured() {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

/** The schema the model must answer in. Subtypes come from the category registry. */
function schemaFor(entry) {
  const codes = entry.subtypes.map((t) => t.code);
  return {
    type: 'object',
    properties: {
      matchesCategory: {
        type: 'boolean',
        description: `True only if the photo shows a real ${entry.label.toLowerCase()} on a road or sidewalk.`,
      },
      confidence: {
        type: 'number',
        description: 'Confidence in matchesCategory, 0 to 1.',
      },
      // An enum cannot sit on a union type — the validator rejects
      // `type: ['string','null']` with string enum values. anyOf instead.
      subType: {
        anyOf: [{ type: 'string', enum: codes }, { type: 'null' }],
        description: 'The closest subtype code, or null if the photo does not match.',
      },
      severity: {
        type: ['integer', 'null'],
        description:
          '1 = cosmetic surface wear. 3 = a driver would feel it. 5 = immediate hazard, could damage a wheel or throw a cyclist. Null if it does not match.',
      },
      description: {
        type: ['string', 'null'],
        description:
          'ONE sentence, 40 words maximum, for the repair crew. Say only: approximate size, approximate depth, where it sits in the roadway, the surface material, and anything that makes it worse (standing water, exposed base, raveling edges). Nothing else — no landmarks, no signage or text visible in the photo, no buildings, no vehicles, no weather, no blame.',
      },
      hazards: {
            type: 'array',
            items: { type: 'string' },
            description: 'Short phrases for anything in the photo that raises urgency. Empty if none.',
      },
      rejectionReason: {
        type: ['string', 'null'],
        description:
          'If matchesCategory is false, one short sentence a resident can read explaining what the photo shows instead. Null otherwise.',
      },
    },
    required: [
      'matchesCategory',
      'confidence',
      'subType',
      'severity',
      'description',
      'hazards',
      'rejectionReason',
    ],
    additionalProperties: false,
  };
}

function systemPrompt(entry) {
  const list = entry.subtypes.map((t) => `  ${t.code} — ${t.label}`).join('\n');
  return [
    `You are triaging a resident's photo for a Miami-Dade County 311 ${entry.label.toLowerCase()} report.`,
    '',
    'The description you write is sent verbatim to the county and read by the crew',
    'that gets dispatched. A vague description is why cases come back marked',
    '"No Problem Found" — be specific enough that someone standing on that street',
    'can tell whether they are looking at the right defect.',
    '',
    'Describe the defect and the road surface, nothing else. The county already',
    'has the GPS coordinate, so landmarks, shop names, murals and any text you can',
    'read in the photo are noise that pushes the useful detail out of view.',
    '',
    `Subtype codes, pick the closest one:\n${list}`,
    '',
    'Set matchesCategory false for anything that is not this kind of defect —',
    'a person, a vehicle, litter, a photo too dark or blurred to judge, a screenshot.',
    'Be honest rather than generous: a filed report is a real case in a government',
    'system, and a wrong one wastes a crew visit.',
  ].join('\n');
}

/**
 * Looks at one photo.
 *
 * Returns `{ available: false, reason }` rather than throwing, for the same
 * reason the road-maintenance lookup does: a resident's report must survive a
 * missing key, a refusal or an outage. The caller falls back to asking them to
 * fill the form themselves.
 */
async function analysePhoto({ buffer, mimeType, entry }) {
  const anthropic = getClient();
  if (!anthropic) return { available: false, reason: 'ANTHROPIC_API_KEY is not set' };
  if (!ACCEPTED.has(mimeType)) {
    return { available: false, reason: `unsupported image type ${mimeType}` };
  }

  try {
    const res = await anthropic.beta.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      // Rescues the call if a safety classifier declines it. Drop `betas` and
      // `fallbacks` together to turn it off.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: {
        effort: EFFORT,
        format: { type: 'json_schema', schema: schemaFor(entry) },
      },
      system: systemPrompt(entry),
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: mimeType, data: buffer.toString('base64') },
            },
            { type: 'text', text: 'Triage this photo and answer in the required format.' },
          ],
        },
      ],
    });

    // Always check before reading content — a decline is an HTTP 200.
    if (res.stop_reason === 'refusal') {
      return { available: false, reason: 'declined by safety classifier' };
    }
    if (res.stop_reason === 'max_tokens') {
      return { available: false, reason: 'response hit the token ceiling' };
    }

    const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { available: false, reason: 'model did not return parseable JSON' };
    }

    const codes = new Set(entry.subtypes.map((t) => t.code));
    return {
      available: true,
      model: res.model,
      usage: {
        inputTokens: res.usage.input_tokens,
        outputTokens: res.usage.output_tokens,
      },
      analysis: {
        matchesCategory: Boolean(parsed.matchesCategory),
        confidence: typeof parsed.confidence === 'number'
          ? Math.min(1, Math.max(0, parsed.confidence))
          : null,
        // Never trust the enum blindly — an unknown code would fail validation
        // later, inside the report write, where it is much harder to explain.
        subType: codes.has(parsed.subType) ? parsed.subType : null,
        severity: Number.isInteger(parsed.severity)
          ? Math.min(5, Math.max(1, parsed.severity))
          : null,
        description: parsed.description ? String(parsed.description).trim().slice(0, 1000) : null,
        hazards: Array.isArray(parsed.hazards)
          ? parsed.hazards.map((h) => String(h).trim()).filter(Boolean).slice(0, 8)
          : [],
        rejectionReason: parsed.rejectionReason ? String(parsed.rejectionReason).trim() : null,
      },
    };
  } catch (err) {
    // Surface the API's own message; the caller degrades rather than failing.
    const status = err instanceof Anthropic.APIError ? ` (HTTP ${err.status})` : '';
    return { available: false, reason: `${err.message}${status}` };
  }
}

module.exports = { analysePhoto, isConfigured, MODEL, ACCEPTED };
