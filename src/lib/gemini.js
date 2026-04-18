import Groq from 'groq-sdk';

const groq = new Groq({
  apiKey: process.env.REACT_APP_GROQ_API_KEY,
  dangerouslyAllowBrowser: true,
});

/** Primary text model — default 8B instant (much lower TPD than 70B). Override: REACT_APP_GROQ_TEXT_MODEL */
const TEXT_MODEL_PRIMARY =
  process.env.REACT_APP_GROQ_TEXT_MODEL || 'llama-3.1-8b-instant';

const VISION_MODEL = 'meta-llama/llama-4-scout-17b-16e-instruct';

/** Fallbacks must be current Groq production IDs — see https://console.groq.com/docs/deprecations */
const TEXT_FALLBACK_8B = 'llama-3.1-8b-instant';
const TEXT_FALLBACK_70B = 'llama-3.3-70b-versatile';
const TEXT_FALLBACK_GPT_OSS = 'openai/gpt-oss-120b';

function textModelFallbackChain() {
  const primary = TEXT_MODEL_PRIMARY;
  const rest =
    primary.includes('70b') || primary.includes('gpt-oss')
      ? [TEXT_FALLBACK_8B, TEXT_FALLBACK_GPT_OSS]
      : [TEXT_FALLBACK_70B, TEXT_FALLBACK_8B, TEXT_FALLBACK_GPT_OSS];
  return [primary, ...rest].filter((m, i, a) => m && a.indexOf(m) === i);
}

async function groqTextCompletion(messages) {
  const chain = textModelFallbackChain();
  let lastErr;
  for (let i = 0; i < chain.length; i += 1) {
    const model = chain[i];
    try {
      return await groq.chat.completions.create({
        model,
        messages,
      });
    } catch (e) {
      lastErr = e;
      const code = e?.code || e?.error?.code;
      const status = e?.status;
      const msg = String(e?.message || e?.error?.message || '');
      const isRate = status === 429 || code === 'rate_limit_exceeded';
      const isDeadModel =
        status === 400 &&
        (code === 'model_decommissioned' ||
          /decommissioned|no longer supported/i.test(msg));
      if ((isRate || isDeadModel) && i < chain.length - 1) continue;
      throw e;
    }
  }
  throw lastErr;
}

function extractJSON(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('No JSON found in response');
  return JSON.parse(text.slice(start, end + 1));
}

function extractJSONArray(text) {
  const t = text.trim();
  const start = t.indexOf('[');
  const end = t.lastIndexOf(']');
  if (start === -1 || end === -1 || end <= start) throw new Error('No JSON array found in response');
  return JSON.parse(t.slice(start, end + 1));
}

const DEBRIS_TYPE_ENUM = 'plastic | fishing_gear | organic | chemical | mixed | unknown';

const DEBRIS_JSON_SCHEMA = `{"debris_type":"plastic","approximate_size":"hand-sized to bottle-sized","quantity_estimate":"5-20 visible pieces","spread":"concentrated","density_score":5,"density_label":"Moderate","intensity_rationale":"Score reflects multiple small plastic pieces in one cluster, no chemical release, moderate wildlife entanglement risk.","estimated_volume":"~5-20 items","confidence":"medium","needs_more_info":false,"gemini_analysis":"short factual assessment"}
Rules:
- debris_type: ${DEBRIS_TYPE_ENUM} — must align with what the reporter/photo indicates.
- approximate_size: concise phrase (e.g. "single small item", "cooler-sized clump", "several meters of line", "patch tens of meters").
- quantity_estimate: order-of-magnitude (e.g. "1", "few", "dozens", "100+", "continuous slick/line") — never fake a precise count from a vague photo.
- spread: concentrated | scattered | linear_along_shore | widespread_patch | unknown
- density_score: integer 1–10 = pollution / response intensity. You MUST quantify it from (1) hazard class of waste type, (2) physical scale from size × quantity × spread, (3) certainty of evidence. Examples: one small inert item well described → 1–3; bucket of bottles → 4–6; large ghost net or visible oil/chemical → 8–10.
- density_label: Critical (8-10) | Dense (6-7) | Moderate (3-5) | Sparse (1-2) | Unverified (only when evidence is truly absent)
- intensity_rationale: 1–3 sentences that explicitly cite waste type, size, quantity, spread, and any hazard (wildlife, navigation, chemical) to justify density_score. Do not repeat the label alone — show the reasoning.
- When structured reporter fields are provided, treat them as authoritative for scale; reconcile with photo/text and mention any conflict in gemini_analysis.
- needs_more_info: false if structured form gives type + size + quantity, OR notes give size/material/count, OR the photo is clear. true only when evidence is empty, one vague word, or unusable image.
- estimated_volume: human-readable scale ("~1 item", "small pile", "~10 m patch") or "unknown".
Respond ONLY with the JSON object, no other text.`;

function formatReporterStructuredBlock(s) {
  if (!s || typeof s !== 'object') return '';
  const lines = [];
  if (s.waste_type) lines.push(`Waste type (reporter): ${s.waste_type}`);
  if (s.size_category) lines.push(`Approx. size (reporter): ${s.size_category}`);
  if (s.quantity_band) lines.push(`Amount / count band (reporter): ${s.quantity_band}`);
  if (s.spread_layout) lines.push(`How it is spread (reporter): ${s.spread_layout}`);
  if (s.extra_notes) lines.push(`Extra reporter notes: ${s.extra_notes}`);
  if (lines.length === 0) return '';
  return `Structured reporter input:\n${lines.join('\n')}\n`;
}

// Analyze a debris photo using vision model
export async function analyzeDebrisPhoto(base64Image, mimeType, latitude, longitude, reporterStructured = null) {
  const block = formatReporterStructuredBlock(reporterStructured);
  const prompt = `You are a marine debris assessment AI.
Analyze this ocean debris photo at coordinates ${latitude}, ${longitude}.
${block ? `${block}\nUse the structured fields for scale and hazard; use the image to verify type and visible extent.\n` : ''}${DEBRIS_JSON_SCHEMA}`;

  const response = await groq.chat.completions.create({
    model: VISION_MODEL,
    messages: [{
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64Image}` } },
        { type: 'text', text: prompt },
      ],
    }],
  });
  const parsed = extractJSON(response.choices[0].message.content);
  return normalizeDebrisAnalysis(parsed, reporterStructured);
}

/** True when the structured form has the minimum fields for a text-only report. */
export function structuredReportComplete(s) {
  if (!s || typeof s !== 'object') return false;
  const wt = (s.waste_type || '').trim();
  const sz = (s.size_category || '').trim();
  const qb = (s.quantity_band || '').trim();
  return Boolean(wt && sz && qb);
}

/** Detect when plain-text notes already contain enough structure (size/material/amount) so we don't block the user. */
export function notesLookSufficient(notes) {
  const t = (notes || '').trim();
  if (t.length < 6) return false;
  let hits = 0;
  if (/\bsize\s*[:=]|\b(size|approx\.?|about|diameter|length)\b|(^|[\s,])\s*(tiny|small|medium|large|huge)\b|\d+\s*(cm|m|mm|ft|in|inch|inches|meters?)\b|\d+\s*x\s*\d+/i.test(t)) hits += 1;
  if (/\bmaterial\s*[:=]|\b(plastic|metal|glass|wood|styrofoam|foam|rope|net|nets|fabric|rubber|aluminum|aluminium|paper|cardboard|mixed)\b/i.test(t)) hits += 1;
  if (/\bamount\s*[:=]|\b(amount|quantity|count|pieces?|bottles?|cans?|bags?|items?)\b|\b(one|two|three|four|five|several|many|few|single|couple|\d+)\b/i.test(t)) hits += 1;
  if (hits >= 2) return true;
  if (t.length >= 40 && hits >= 1) return true;
  return false;
}

function applyTextNotesHeuristic(notes, raw, reporterStructured) {
  if (structuredReportComplete(reporterStructured)) {
    return {
      ...raw,
      needs_more_info: false,
      confidence: raw.confidence === 'low' ? 'medium' : (raw.confidence || 'medium'),
    };
  }
  if (!notesLookSufficient(notes)) return raw;
  return {
    ...raw,
    needs_more_info: false,
    confidence: raw.confidence === 'low' ? 'medium' : (raw.confidence || 'medium'),
  };
}

function labelFromScore(score) {
  if (score >= 8) return 'Critical';
  if (score >= 6) return 'Dense';
  if (score >= 3) return 'Moderate';
  return 'Sparse';
}

function normalizeDebrisAnalysis(a, reporterStructured = null) {
  const conf = a.confidence === 'high' || a.confidence === 'medium' || a.confidence === 'low' ? a.confidence : 'medium';
  let score = Number(a.density_score);
  if (!Number.isFinite(score)) score = conf === 'low' ? 3 : 5;
  if (a.needs_more_info === true || conf === 'low') {
    score = Math.min(score, 4);
    if (!a.density_label || a.density_label === 'Critical' || a.density_label === 'Dense') {
      a.density_label = 'Unverified';
    }
  } else {
    const allowed = ['Critical', 'Dense', 'Moderate', 'Sparse', 'Unverified'];
    if (!allowed.includes(a.density_label)) {
      a.density_label = labelFromScore(score);
    }
  }
  if (!a.estimated_volume || String(a.estimated_volume).toLowerCase() === 'null') {
    a.estimated_volume = 'unknown';
  }
  let intensity_rationale = typeof a.intensity_rationale === 'string' ? a.intensity_rationale.trim() : '';
  if (!intensity_rationale && structuredReportComplete(reporterStructured)) {
    intensity_rationale = `Rating ${Math.round(Math.max(1, Math.min(10, score)))}/10 based on reporter: ${reporterStructured.waste_type}, ${reporterStructured.size_category}, ${reporterStructured.quantity_band}${reporterStructured.spread_layout ? `, spread: ${reporterStructured.spread_layout}` : ''}.`;
  }
  let approximate_size = typeof a.approximate_size === 'string' ? a.approximate_size.trim() : '';
  let quantity_estimate = typeof a.quantity_estimate === 'string' ? a.quantity_estimate.trim() : '';
  let spread = typeof a.spread === 'string' ? a.spread.trim() : '';
  if (reporterStructured) {
    if (!approximate_size && reporterStructured.size_category) approximate_size = reporterStructured.size_category;
    if (!quantity_estimate && reporterStructured.quantity_band) quantity_estimate = reporterStructured.quantity_band;
    if (!spread && reporterStructured.spread_layout) spread = reporterStructured.spread_layout;
  }
  return {
    ...a,
    density_score: Math.max(1, Math.min(10, Math.round(score))),
    confidence: conf,
    intensity_rationale: intensity_rationale || a.gemini_analysis?.slice(0, 200) || '',
    approximate_size: approximate_size || 'unknown',
    quantity_estimate: quantity_estimate || 'unknown',
    spread: spread || 'unknown',
  };
}

// Text-only analysis when no photo is available
export async function analyzeDebrisText(notes, latitude, longitude, reporterStructured = null) {
  const raw = (notes || '').trim();
  const block = formatReporterStructuredBlock(reporterStructured);
  const prompt = `You are a marine debris assessment AI.
Location: ${latitude}, ${longitude}
${block || ''}
Free-form description from reporter:
"${raw || 'No additional free-form description.'}"

Quantify intensity (density_score 1–10) using the structured fields as primary evidence when present; use free text for extra detail. intensity_rationale must justify the number using type, size, quantity, and spread.
${DEBRIS_JSON_SCHEMA}`;

  const response = await groqTextCompletion([{ role: 'user', content: prompt }]);
  let parsed = extractJSON(response.choices[0].message.content);
  parsed = applyTextNotesHeuristic(raw, parsed, reporterStructured);
  return normalizeDebrisAnalysis(parsed, reporterStructured);
}

// Crew assignment + interception suggestions
export async function getCrewSuggestions({ sightings, vessels, assignments, pendingHandoffs = [] }) {
  const available = (vessels || []).filter((v) => v.status === 'available');
  const availJson = JSON.stringify(available.map((v) => ({
    id: v.id, name: v.name, zone: v.zone, fuel: v.fuel_level, capacity: v.capacity,
  })));

  const prompt = `You are the AI crew coordinator for ClearMarine (one operations center; vessels below are OUR fleet).
Active debris sightings: ${JSON.stringify(sightings.map(s => ({ id: s.id, type: s.debris_type, density: s.density_label, score: s.density_score, lat: s.latitude, lon: s.longitude, status: s.status })))}
Pending handoffs to accept (this desk): ${JSON.stringify((pendingHandoffs || []).map(s => ({ handoff_id: s.id, id: s.id, from: s.source_jurisdiction, type: s.debris_type, density: s.density_label })))}
AVAILABLE vessels (status=available — ONLY these can be assigned; you MUST pick one by name and id): ${availJson || '[]'}
Other vessels (deployed/maintenance — do NOT assign): ${JSON.stringify((vessels || []).filter(v => v.status !== 'available').map(v => ({ name: v.name, status: v.status })))}
Assignments: ${JSON.stringify(assignments.map(a => ({ vessel_id: a.vessel_id, sighting_id: a.sighting_id, status: a.status })))}

Rules:
- For assign_vessel: text MUST name the exact vessel (e.g. "Send Ocean Guardian I to intercept…") and set vessel_id to that vessel's UUID from AVAILABLE list only.
- If AVAILABLE is empty: do NOT use assign_vessel. Use action_type "none" with text explaining no hulls are ready (suggest freeing a vessel or waiting). Optionally suggest reorder_supply if supplies are low.
- Prioritize highest-density sightings and nearest zone match to the debris lat/lon.

Return ONLY a JSON array of exactly 3 action items, no markdown:
[
  {"text":"Send [VESSEL NAME] to …","action_type":"assign_vessel","sighting_id":null,"vessel_id":null,"supply_id":null,"handoff_id":null},
  {"text":"…","action_type":"accept_handoff","sighting_id":null,"vessel_id":null,"supply_id":null,"handoff_id":null},
  {"text":"…","action_type":"reorder_supply","sighting_id":null,"vessel_id":null,"supply_id":null,"handoff_id":null}
]
action_type: assign_vessel | accept_handoff | reorder_supply | mark_cleared | none
Set sighting_id, vessel_id, handoff_id from the data above when relevant.`;

  const response = await groqTextCompletion([{ role: 'user', content: prompt }]);
  const raw = response.choices[0].message.content.trim();
  let items;
  try {
    items = extractJSONArray(raw);
  } catch {
    try {
      const one = extractJSON(raw);
      items = Array.isArray(one) ? one : [one];
    } catch {
      items = [{ text: raw.slice(0, 120), action_type: 'none', sighting_id: null, vessel_id: null, supply_id: null, handoff_id: null }];
    }
  }

  if (!Array.isArray(items)) items = [items];
  if (available.length === 0) {
    return items.map((row) => {
      if (row && row.action_type === 'assign_vessel') {
        return {
          ...row,
          action_type: 'none',
          vessel_id: null,
          text: 'No cleanup vessels are available — free a hull from deployment/maintenance or wait for a returning crew before assigning.',
        };
      }
      return row;
    });
  }
  return items;
}

// Generate jurisdiction handoff brief
export async function generateHandoffBrief({ fromAgency, toAgency, debrisType, densityLabel, densityScore, analysis, lat, lon }) {
  const prompt = `ClearMarine ops is handing this case from ${fromAgency} to ${toAgency} (partner lane — same incident system).
Location: ${lat}, ${lon}
Type: ${debrisType}, Density: ${densityScore}/10 — ${densityLabel}
Assessment: ${analysis}
Brief for the receiving coordinator: debris, risk, suggested vessel class, priority.
Max 100 words. Professional tone.`;

  const response = await groqTextCompletion([{ role: 'user', content: prompt }]);
  return response.choices[0].message.content;
}

// Crew assignment brief for a specific vessel + sighting intercept
export async function generateAssignmentBrief({ vesselName, debrisType, densityLabel, interceptionHours, lat, lon }) {
  const prompt = `Assignment brief for vessel ${vesselName}.
Intercept ${densityLabel} ${debrisType} debris in ${interceptionHours} hours at approximately ${lat.toFixed(3)}, ${lon.toFixed(3)}.
Write a concise crew briefing: equipment needed, approach instructions, safety considerations.
Max 80 words. Direct operational tone.`;

  const response = await groqTextCompletion([{ role: 'user', content: prompt }]);
  return response.choices[0].message.content;
}
