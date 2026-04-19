/**
 * Debris + ops LLM helpers. Current stack: Gemini text in-process
 * (ElevenLabs STT lives on the backend).
 */
import { GoogleGenerativeAI } from '@google/generative-ai';
import { runMarineDebrisPipeline } from './debrisPipeline';
import { applyLlmFirstSignalFusion } from './reconcileSignals';
import { numericConfidenceToCategory, scoreToDensityLabel } from './severityUtils';
import { getNearestGliderCurrent } from './gliderCurrents';
import {
  WASTE_TYPE_VALUES,
  SIZE_VALUES,
  QUANTITY_VALUES,
  SPREAD_VALUES,
} from '../constants/debrisReportFormOptions';

export function structuredReportComplete(s) {
  if (!s || typeof s !== 'object') return false;
  const wt = (s.waste_type || '').trim();
  const sz = (s.size_category || '').trim();
  const qb = (s.quantity_band || '').trim();
  return Boolean(wt && sz && qb);
}

function formatReporterStructuredBlock(s) {
  if (!s || typeof s !== 'object') return '';
  const lines = [];
  if (s.waste_type) lines.push(`Waste type (reporter): ${s.waste_type}`);
  if (s.size_category) lines.push(`Approx. size (reporter): ${s.size_category}`);
  if (s.quantity_band) lines.push(`Amount / count band (reporter): ${s.quantity_band}`);
  if (s.spread_layout) lines.push(`How it is spread (reporter): ${s.spread_layout}`);
  if (s.extra_notes) lines.push(`Extra reporter notes: ${s.extra_notes}`);
  if (lines.length === 0) return '';
  return `Structured reporter input (form selections — reconcile with CV and any VISION_PRIOR; not ground truth for species or scale if the photo contradicts them):\n${lines.join('\n')}\n`;
}

/** ElevenLabs STT verbatim slice for Gemini prompts (same transcript also merged into impact JSON). */
function formatVoiceTranscriptForPrompt(voiceTranscript) {
  const v = String(voiceTranscript || '').trim().replace(/\s+/g, ' ');
  if (!v) return '';
  const safe = v.replace(/"/g, "'").slice(0, 4000);
  return `
────────────────────────────
VOICE_TRANSCRIPT (ElevenLabs speech-to-text — verbatim)
────────────────────────────
"${safe}"

Treat this as first-class evidence alongside structured fields and typed notes: hazards, wildlife, sheen/smell, timing, landmarks, or quantities may appear only here.
`;
}

const gemini = new GoogleGenerativeAI(process.env.REACT_APP_GEMINI_API_KEY || '');

/** Primary text model override: REACT_APP_GEMINI_TEXT_MODEL */
const TEXT_MODEL_PRIMARY =
  process.env.REACT_APP_GEMINI_TEXT_MODEL || 'gemini-2.5-flash';

/** Fallback chain for Gemini text models (keep to current v1beta IDs). */
const TEXT_FALLBACK_FLASH = 'gemini-2.5-flash';
const TEXT_FALLBACK_FLASH_2_0 = 'gemini-2.0-flash';
const TEXT_FALLBACK_FLASH_LITE_2_0 = 'gemini-2.0-flash-lite';

function textModelFallbackChain() {
  const primary = TEXT_MODEL_PRIMARY;
  const rest = [TEXT_FALLBACK_FLASH, TEXT_FALLBACK_FLASH_2_0, TEXT_FALLBACK_FLASH_LITE_2_0];
  return [primary, ...rest].filter((m, i, a) => m && a.indexOf(m) === i);
}

/** Stronger default chain for voice → form mapping only. Override: REACT_APP_GEMINI_VOICE_INFER_MODEL */
function voiceInferModelFallbackChain() {
  const primary = process.env.REACT_APP_GEMINI_VOICE_INFER_MODEL || TEXT_MODEL_PRIMARY;
  const rest = [TEXT_FALLBACK_FLASH_2_0, TEXT_FALLBACK_FLASH_LITE_2_0];
  return [primary, ...rest].filter((m, i, a) => m && a.indexOf(m) === i);
}

function toGeminiPrompt(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return '';
  return messages
    .map((m) => String(m?.content || '').trim())
    .filter(Boolean)
    .join('\n\n');
}

async function llmTextCompletion(messages, options = {}) {
  const { responseFormatJson, modelChain } = options;
  const chain = Array.isArray(modelChain) && modelChain.length ? modelChain : textModelFallbackChain();
  const prompt = toGeminiPrompt(messages);
  if (!prompt) throw new Error('No prompt content provided');
  let lastErr;
  for (let i = 0; i < chain.length; i += 1) {
    const model = chain[i];
    try {
      const modelClient = gemini.getGenerativeModel({ model });
      const result = await modelClient.generateContent({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: responseFormatJson ? { responseMimeType: 'application/json' } : undefined,
      });
      const content = result?.response?.text?.() || '';
      return { choices: [{ message: { content } }] };
    } catch (e) {
      lastErr = e;
      const msg = String(e?.message || e?.error?.message || '');
      const isRetryable =
        /rate|quota|429|model|not found|unsupported|overloaded|unavailable|500|503/i.test(msg);
      if (isRetryable && i < chain.length - 1) continue;
      throw e;
    }
  }
  throw lastErr;
}

/** Strip ```json fences and parse first JSON object (models often wrap output). */
function parseJSONObjectLoose(raw) {
  let t = String(raw ?? '').trim();
  const fence = /^```(?:json)?\s*\r?\n?([\s\S]*?)\r?\n?```\s*$/i.exec(t);
  if (fence) t = fence[1].trim();
  else if (t.startsWith('```')) {
    t = t.replace(/^```[^\n]*\n?/, '').replace(/\n?```\s*$/, '').trim();
  }
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) throw new Error('No JSON object found in model output');
  return JSON.parse(t.slice(start, end + 1));
}

function extractJSON(text) {
  return parseJSONObjectLoose(text);
}

function extractJSONArray(text) {
  const t = text.trim();
  const start = t.indexOf('[');
  const end = t.lastIndexOf(']');
  if (start === -1 || end === -1 || end <= start) throw new Error('No JSON array found in response');
  return JSON.parse(t.slice(start, end + 1));
}

function pickAllowedFormValue(value, allowed) {
  const s = String(value ?? '').trim();
  if (!s) return '';
  return allowed.includes(s) ? s : '';
}

function inferWasteTypeFromSpeechHint(raw) {
  const s = String(raw ?? '').toLowerCase();
  if (!s) return '';
  if (/fish|net|rope|trap|pot|line|gear|lobster|crab/i.test(s)) return 'fishing_gear';
  if (/oil|sheen|chemical|fuel|diesel|gasoline|slick/i.test(s)) return 'chemical';
  if (/plastic|bottle|bag|foam|straw|cup|wrapper|micro/i.test(s)) return 'plastic';
  if (/wood|kelp|seaweed|palm|leaf|organic/i.test(s)) return 'organic';
  if (/mixed|several type|all kinds/i.test(s)) return 'mixed';
  if (/not sure|unknown|unsure|idk/i.test(s)) return 'unknown';
  return '';
}

function inferQuantityFromSpeechHint(raw) {
  const s = String(raw ?? '').toLowerCase();
  const full = String(raw ?? '');
  if (!s) return '';
  if (/\b(radius|circle|circular|round patch|ring of)\b/i.test(full) && !/\b(many|dozens|hundreds|\d+\s*(separate|different|distinct)|pieces everywhere|lots of pieces)\b/i.test(s)) {
    return '1';
  }
  if (/continuous|slick|line along|band of|sheen/i.test(s)) return 'Continuous line or slick';
  if (/100\s*\+|hundreds|200|300|thousands/i.test(s)) return '100+';
  if (/dozen|10\s*[–-]?\s*100|twenty|thirty|fifty|many pieces/i.test(s)) return '10–100';
  if (/^1\b|one piece|single piece|just one|a piece|one clump|single clump|one patch/i.test(s)) return '1';
  if (/couple|few|several|some|handful|2\s*[–-]?\s*10\b|two pieces|three pieces|four pieces|five pieces|six pieces|seven pieces|eight pieces|nine pieces|ten pieces/i.test(s)) {
    return '2–10';
  }
  if (/\btwo\b|\bfour\b|\bfive\b|\bsix\b|\bseven\b|\beight\b|\bnine\b|\bten\b/i.test(s) && /\bpieces\b|\bitems\b|\bbottles\b/i.test(s)) return '2–10';
  return '';
}

function inferSizeFromSpeechHint(raw) {
  const s = String(raw ?? '').toLowerCase();
  const full = String(raw ?? '');
  if (!s) return '';
  if (/\b(radius|yard\s+radius|meter\s+radius|circle|circular|round\s+patch)\b/i.test(full)) {
    if (/wheelbarrow|large circle|big patch|10\s*(yd|yard|m|meter)|wide\s+circle/i.test(s)) return 'Pile — wheelbarrow or larger';
    if (/three[-\s]?yard|3[-\s]?yard|few yards|small circle|two[-\s]?yard/i.test(s)) return 'Pile — fills a shopping bag';
    return 'Pile — fills a shopping bag';
  }
  if (/widespread|field|patch|everywhere|acres|hectares/i.test(s)) return 'Widespread field / patch';
  if (/tens of meters|100\s*m|long line|kilometers|km of/i.test(s)) return 'Linear debris — tens of meters or more';
  if (/\balong\s+(the\s+)?(shore|shoreline|water|beach|coast)\b|tide\s*line|stretched\s+along|linear\s+debris|line\s+of\s+debris/i.test(s)) {
    return 'Linear debris — a few meters';
  }
  if (/wheelbarrow|truck|dumpster|pallet|huge pile/i.test(s)) return 'Pile — wheelbarrow or larger';
  if (/shopping bag|bucket|armful|garbage bag/i.test(s)) return 'Pile — fills a shopping bag';
  if (/tire|cooler|large item|furniture|drum|big one/i.test(s)) return 'Single large item (bucket to tire-sized)';
  if (/hand|bottle|small|tiny|single small|glove|wrapper/i.test(s)) return 'Single item (hand-sized or smaller)';
  return '';
}

/**
 * Localized circular patch (yard/m radius) is NOT linear along shore; default one clump + spread unknown.
 */
function applyCircularPatchGeometryOverrides(transcript, o) {
  const t = String(transcript || '');
  const tl = t.toLowerCase();
  const circle = /\b(radius|circle|circular|round\s+patch|ring\s+of)\b/i.test(t);
  const alongShore = /\b(along\s+(the\s+)?(shore|shoreline|water|beach|coast)|tide\s*line|stretched\s+along\s+the|linear\s+along|beach\s+line)\b/i.test(tl);
  if (!circle || alongShore) return o;

  const out = { ...o };
  out.spread_layout = '';
  out.quantity_band = '1';
  if (/wheelbarrow|large circle|10\s*(yd|yard|m|meter)|big patch|wide\s+circle/i.test(tl)) {
    out.size_category = 'Pile — wheelbarrow or larger';
  } else {
    out.size_category = 'Pile — fills a shopping bag';
  }
  return out;
}

function transcriptRefusesToQuantify(transcript) {
  const t = String(transcript || '').toLowerCase();
  return /\b(don'?t quantify|do not quantify|don'?t count|do not count|don'?t estimate|no estimate|not quantif|can'?t quantify|won'?t quantify|hard to count|can'?t count|no count|don'?t want to count|skip (the )?count)\b/i.test(t);
}

function hasExplicitSizeLanguageInTranscript(transcript) {
  const t = String(transcript || '');
  return /\b(shopping bag|wheelbarrow|hand-sized|hand size|bucket|meter|metre|yard|yards|foot|feet|\d+\s*(m|meter|metres|yd|yard|yards|ft|foot|feet|cm|km)|\d+\s*x\s*\d+|pile|patch|radius|circle|linear|along\s+the|shoreline|tide\s*line|widespread|single large|tire-sized|cooler)\b/i.test(t);
}

function hasExplicitQuantityLanguageInTranscript(transcript) {
  const t = String(transcript || '').toLowerCase();
  if (/\b(don'?t quantify|do not quantify|don'?t count)\b/i.test(t)) return false;
  return /\b(\d+\s*(pieces?|items?|bottles?|bags?|cups?))|(\b(one|two|three|four|five|six|seven|eight|nine|ten|dozen|hundreds)\s+(pieces?|items?|bottles?|separate|distinct))\b/i.test(t)
    || /\b(about|roughly|at least|over|under|more than|fewer than)\s+\d+/i.test(t);
}

/**
 * When the reporter refuses to quantify/count, do not invent size or amount — leave blank so the voice agent asks.
 */
function applyQuantificationRefusalOverrides(transcript, o) {
  if (!transcriptRefusesToQuantify(transcript)) return o;
  const out = { ...o };
  if (!hasExplicitSizeLanguageInTranscript(transcript)) out.size_category = '';
  if (!hasExplicitQuantityLanguageInTranscript(transcript)) out.quantity_band = '';
  return out;
}

function normalizeConfidenceToken(v) {
  const c = String(v || '').toLowerCase();
  if (c === 'high' || c === 'medium' || c === 'low' || c === 'none') return c;
  return 'medium';
}

function buildVoiceClarificationSpeech(fieldsSet, parsedSpeech) {
  const fromModel = typeof parsedSpeech === 'string' ? parsedSpeech.trim() : '';
  if (fromModel && fieldsSet.size === 0) return fromModel.slice(0, 500);

  const labels = {
    waste_type: 'what kind of debris it is, for example plastic, fishing gear, or oil',
    size_category: 'how big the debris area is compared to a shopping bag, a wheelbarrow, or a long line along the water',
    quantity_band: 'roughly how many separate pieces you see, or say if it is one clump or patch',
    spread_layout: 'whether it is mostly one spot, scattered, along the shore, spread over a wide area, or you are not sure',
  };
  const keys = [...fieldsSet];
  if (keys.length === 0) return fromModel ? fromModel.slice(0, 500) : '';
  const parts = keys.map((k) => labels[k] || k);
  const base = `I need a bit more detail on ${parts.join(', and on ')}.`;
  const tail = ' Please answer in short phrases.';
  const out = `${base}${tail}`.slice(0, 500);
  return fromModel ? `${fromModel.slice(0, 220)} ${out}`.slice(0, 500) : out;
}

/**
 * Map ElevenLabs transcript to strict dropdown values and decide if spoken follow-up is needed.
 * @param {string} transcript
 * @param {{ hasPhoto?: boolean, current?: { waste_type?: string, size_category?: string, quantity_band?: string, spread_layout?: string } }} opts
 */
export async function inferVoiceReportFieldsFromTranscript(transcript, opts = {}) {
  const empty = {
    waste_type: '',
    size_category: '',
    quantity_band: '',
    spread_layout: '',
    supplemental_notes: '',
    report_ready: false,
    clarification_speech: null,
    infer_skipped: null,
    fields_needing_clarification: [],
  };
  if (!process.env.REACT_APP_GEMINI_API_KEY) return { ...empty, infer_skipped: 'no_gemini' };
  const t = String(transcript || '').trim();
  if (!t) return empty;

  const hasPhoto = Boolean(opts.hasPhoto);
  const current = opts.current && typeof opts.current === 'object' ? opts.current : {};

  const prompt = `You parse a marine debris field report from SPEECH-TO-TEXT (may have disfluencies). Reply with ONE JSON object only (no markdown).

Current UI selections (empty string means unset). Prefer clear NEW evidence from the transcript; keep a prior value only if the transcript does not contradict it.
${JSON.stringify({
    waste_type: String(current.waste_type || ''),
    size_category: String(current.size_category || ''),
    quantity_band: String(current.quantity_band || ''),
    spread_layout: String(current.spread_layout ?? ''),
  }, null, 2)}

Reporter already attached a photo: ${hasPhoto ? 'yes' : 'no'}
${hasPhoto ? 'Photo may help downstream CV; still map speech to dropdowns when possible.' : 'Without a photo, waste_type + size_category + quantity_band must all be filled from speech for the report to be complete.'}

TRANSCRIPT:
"""${t.replace(/"/g, "'").slice(0, 8000)}"""

FEW_SHOT (follow this behavior; transcripts will differ):
- Example A: "Don't quantify it. I have plastic cups in the ocean." → waste_type "plastic"; size_category "" and quantity_band "" (speaker refused numbers); spread_layout ""; confidence low for size and quantity; fields_needing_clarification must include size_category and quantity_band; supplemental_notes may mention cups/ocean.
- Example B: "Ghost net maybe twenty meters along the beach, high tide line." → waste_type "fishing_gear"; size_category "Linear debris — tens of meters or more" OR "Linear debris — a few meters" if they said only a few meters; quantity_band "1" or "2–10" if they implied sections; spread_layout "linear_along_shore" when shoreline is explicit.
- Example C: "Sheen on the water, chemical smell, area the size of a car hood." → waste_type "chemical"; size_category "Single large item (bucket to tire-sized)" or "Pile — fills a shopping bag" for hood-sized patch; quantity "1" if one slick; spread "" unless they say scattered.

CRITICAL GEOMETRY (avoid common speech-to-text mistakes):
- Mentions of wildlife, birds, seals, fish, etc. do NOT imply debris shape. Ignore them for size/spread/quantity except in supplemental_notes.
- A "circle", "radius", "round patch", or "X yard/meter radius" describes a **compact PILE or patch**, NOT "linear along shore". Never use size_category containing "Linear debris" unless the speaker clearly describes debris stretched **along the shoreline/water/beach** or a **tide line**.
- A small circular patch (e.g. a few yards across) → size_category **"Pile — fills a shopping bag"** unless clearly wheelbarrow-sized or larger.
- If the speaker does **not** explicitly say scattered vs one spot vs along shore vs wide field, set spread_layout to **""** (empty = not sure). Do NOT guess "concentrated" from vague phrases like "circle of trash".
- If they describe one visible accumulation, patch, or "a circle of debris" **without** an explicit count of many separate items, quantity_band should usually be **"1"** (one coherent patch). Use "2–10" only when they clearly imply several distinct pieces.

REFUSAL:
- If the speaker says they do NOT want to quantify, count, or estimate (e.g. "don't quantify it"), you MUST leave size_category and quantity_band as **empty strings** unless they immediately give explicit size or count language in the same sentence. Set confidence to "low" for those fields and include them in fields_needing_clarification.

CONFIDENCE:
- For each of waste_type, size_category, quantity_band assign confidence "high" | "medium" | "low".
- For spread_layout use "none" when spread_layout is ""; otherwise "high"|"medium"|"low".
- Use "low" whenever you are guessing from vague wording. "medium" when plausible but not explicit.

CLARIFICATION:
- fields_needing_clarification: array of field keys (waste_type, size_category, quantity_band, spread_layout) that are still empty OR you set confidence to "low" OR the transcript does not give enough to choose confidently.
- clarification_speech: one short spoken paragraph (max 55 words), second person, asking ONLY for the items in fields_needing_clarification. If fields_needing_clarification is empty, set clarification_speech to null.

Other rules:
- Map to EXACT allowed strings below only (no shortened labels).
- supplemental_notes: wildlife, odor/sheen, time, landmarks — max 350 chars; "" if none.

ALLOWED waste_type:
${JSON.stringify(WASTE_TYPE_VALUES)}

ALLOWED size_category (copy full string):
${JSON.stringify(SIZE_VALUES)}

ALLOWED quantity_band:
${JSON.stringify(QUANTITY_VALUES)}

ALLOWED spread_layout ("" = not sure / skip — use this when spread is not explicit):
${JSON.stringify(SPREAD_VALUES)}

Return this JSON shape:
{"waste_type":"","size_category":"","quantity_band":"","spread_layout":"","supplemental_notes":"","confidence":{"waste_type":"high","size_category":"high","quantity_band":"high","spread_layout":"none"},"fields_needing_clarification":[],"clarification_speech":null}`;

  try {
    const response = await llmTextCompletion(
      [{ role: 'user', content: prompt }],
      { responseFormatJson: true, modelChain: voiceInferModelFallbackChain() },
    );
    const parsed = parseJSONObjectLoose(response.choices[0].message.content);
    let waste_type = pickAllowedFormValue(parsed.waste_type, WASTE_TYPE_VALUES);
    if (!waste_type) waste_type = inferWasteTypeFromSpeechHint(parsed.waste_type) || inferWasteTypeFromSpeechHint(t);

    let size_category = pickAllowedFormValue(parsed.size_category, SIZE_VALUES);
    if (!size_category) size_category = inferSizeFromSpeechHint(parsed.size_category) || inferSizeFromSpeechHint(t);

    let quantity_band = pickAllowedFormValue(parsed.quantity_band, QUANTITY_VALUES);
    if (!quantity_band && parsed.quantity_band != null) {
      const hyphenToEn = String(parsed.quantity_band).trim().replace(/-/g, '\u2013');
      quantity_band = pickAllowedFormValue(hyphenToEn, QUANTITY_VALUES);
    }
    if (!quantity_band) {
      quantity_band = inferQuantityFromSpeechHint(parsed.quantity_band) || inferQuantityFromSpeechHint(t);
    }

    let spread_layout = pickAllowedFormValue(parsed.spread_layout, SPREAD_VALUES);
    let supplemental_notes = typeof parsed.supplemental_notes === 'string'
      ? parsed.supplemental_notes.trim().slice(0, 400)
      : '';

    let out = {
      waste_type,
      size_category,
      quantity_band,
      spread_layout,
      supplemental_notes,
    };
    out = applyCircularPatchGeometryOverrides(t, out);
    out = applyQuantificationRefusalOverrides(t, out);
    waste_type = out.waste_type;
    size_category = out.size_category;
    quantity_band = out.quantity_band;
    spread_layout = out.spread_layout;
    supplemental_notes = out.supplemental_notes;

    const structuralOk = Boolean(waste_type && size_category && quantity_band);
    const pc = parsed.confidence && typeof parsed.confidence === 'object' ? parsed.confidence : {};
    const confLevel = (key, val) => {
      if (!val) return 'low';
      const raw = pc[key];
      if (raw == null || raw === '') return 'high';
      return normalizeConfidenceToken(raw);
    };
    const conf = {
      waste_type: confLevel('waste_type', waste_type),
      size_category: confLevel('size_category', size_category),
      quantity_band: confLevel('quantity_band', quantity_band),
      spread_layout: spread_layout ? confLevel('spread_layout', spread_layout) : 'none',
    };

    const FIELD_KEYS = ['waste_type', 'size_category', 'quantity_band', 'spread_layout'];
    const fieldsNeed = new Set();
    ['waste_type', 'size_category', 'quantity_band'].forEach((k) => {
      if (!out[k]) fieldsNeed.add(k);
      else if (conf[k] === 'low') fieldsNeed.add(k);
    });
    if (spread_layout && conf.spread_layout === 'low') fieldsNeed.add('spread_layout');

    if (Array.isArray(parsed.fields_needing_clarification)) {
      parsed.fields_needing_clarification.forEach((x) => {
        if (!FIELD_KEYS.includes(x)) return;
        if (x === 'spread_layout' && !out.spread_layout) return;
        if (!out[x] || conf[x] === 'low') fieldsNeed.add(x);
      });
    }

    const report_ready = structuralOk && fieldsNeed.size === 0;

    let clarification_speech = buildVoiceClarificationSpeech(fieldsNeed, parsed.clarification_speech);
    if (!clarification_speech && !report_ready) {
      clarification_speech = 'Please briefly say what kind of debris it is, roughly how large it is compared to something familiar, and about how many pieces or how wide the patch is.';
    }
    if (report_ready) clarification_speech = null;

    return {
      waste_type,
      size_category,
      quantity_band,
      spread_layout,
      supplemental_notes,
      report_ready,
      clarification_speech,
      infer_skipped: null,
      fields_needing_clarification: [...fieldsNeed],
    };
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('Voice form inference skipped:', e?.message || e);
    return { ...empty, infer_skipped: 'parse_error' };
  }
}

const GEMINI_IMPACT_JSON_RULES = `Return ONLY valid JSON (no markdown) with exactly:
{
  "impact_threat_score": <integer 1-10>,
  "impact_threat_label": "Low" | "Moderate" | "High" | "Critical",
  "threat_rationale": "<2-4 sentences>",
  "responder_report": "<4-8 short sentences, plain language, actionable for field teams>"
}
impact_threat_label must align with score (Low 1-3, Moderate 4-5, High 6-7, Critical 8-10).
impact_threat_score must explicitly reflect waste type, scale (structured + notes + voice), location, prior_assessment, and corc_glider_context (spreading / advection) when present.
responder_report must be a single condensed operational brief (not bullet labels in JSON — plain sentences).`;

/**
 * Second-pass Gemini assessment: typed notes + ElevenLabs voice transcript + CORC + prior fused scores
 * → quantified impact_threat_score + responder_report (primary LLM for this step).
 */
async function mergeMarineReportWithGeminiImpact({
  latitude,
  longitude,
  reporterStructured,
  typedNotes,
  voiceTranscript,
  analysis,
  pipeline,
}) {
  if (!process.env.REACT_APP_GEMINI_API_KEY || !analysis) return analysis;

  let corc = null;
  try {
    corc = await getNearestGliderCurrent(latitude, longitude);
  } catch {
    corc = null;
  }

  const payload = {
    location: { latitude, longitude },
    reporter_structured: reporterStructured || {},
    typed_field_notes: String(typedNotes || '').trim(),
    voice_transcription: String(voiceTranscript || '').trim(),
    corc_glider_context: corc || { note: 'No CORC profile within search radius in precomputed index.' },
    prior_assessment: {
      debris_type: analysis.debris_type,
      density_score: analysis.density_score,
      density_label: analysis.density_label,
      intensity_rationale: analysis.intensity_rationale,
      approximate_size: analysis.approximate_size,
      quantity_estimate: analysis.quantity_estimate,
      spread: analysis.spread,
      estimated_volume: analysis.estimated_volume,
      confidence: analysis.confidence,
    },
    cv_pipeline_summary: pipeline
      ? {
        detector: pipeline.detection?.detector,
        debris_bbox_count: pipeline.detection?.debris?.length ?? 0,
        animal_bbox_count: pipeline.detection?.animals?.length ?? 0,
        geo: pipeline.geo || null,
      }
      : null,
  };

  const prompt = `You are ClearMarine's impact and threat assessor for ocean debris and spill response. This pass runs on Gemini (text model).

You receive ONE JSON object with: coordinates, structured reporter fields (waste type, size, quantity, spread), typed_field_notes, voice_transcription (ElevenLabs Scribe STT when the reporter used voice — may duplicate phrases in typed_field_notes), corc_glider_context (nearest precomputed CORC/Spray-style current profile when available), prior_assessment from the first-pass debris model, and optional CV bbox counts (not raw pixels).

Integrate the full payload. When voice_transcription is non-empty, treat it as equally authoritative as typed notes for hazards, wildlife, odor/sheen, timing, and local references.

You must output:
(a) impact_threat_score — single integer 1–10 quantifying operational threat (entanglement, wildlife risk, navigation, chemical/oil severity, spread potential given currents, urgency from voice or notes).
(b) responder_report — condensed plain-language brief for field responders (what to expect, priorities, how currents may move material).

${GEMINI_IMPACT_JSON_RULES}

INPUT JSON:
${JSON.stringify(payload, null, 2)}`;

  try {
    const response = await llmTextCompletion([{ role: 'user', content: prompt }]);
    const parsed = extractJSON(response.choices[0].message.content);
    const score = Number(parsed.impact_threat_score);
    const impact_threat_score = Number.isFinite(score)
      ? Math.max(1, Math.min(10, Math.round(score)))
      : analysis.density_score;
    return {
      ...analysis,
      impact_threat_score,
      impact_threat_label: typeof parsed.impact_threat_label === 'string' ? parsed.impact_threat_label.trim() : '',
      threat_rationale: typeof parsed.threat_rationale === 'string' ? parsed.threat_rationale.trim() : '',
      responder_report: typeof parsed.responder_report === 'string' ? parsed.responder_report.trim() : '',
    };
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('Gemini impact assessment skipped:', e?.message || e);
    return analysis;
  }
}

const DEBRIS_TYPE_ENUM = 'plastic | fishing_gear | organic | chemical | mixed | unknown';

const DEBRIS_JSON_SCHEMA = `{"debris_type":"plastic","approximate_size":"hand-sized to bottle-sized","quantity_estimate":"5-20 visible pieces","spread":"concentrated","density_score":5,"density_label":"Moderate","intensity_rationale":"Score reflects multiple small plastic pieces in one cluster, no chemical release, moderate wildlife entanglement risk.","estimated_volume":"~5-20 items","confidence":"medium","needs_more_info":false,"gemini_analysis":"short factual assessment"}
Rules:
- debris_type: ${DEBRIS_TYPE_ENUM} — must align with what the reporter described.
- approximate_size: concise phrase (e.g. "single small item", "cooler-sized clump", "several meters of line", "patch tens of meters").
- quantity_estimate: order-of-magnitude (e.g. "1", "few", "dozens", "100+", "continuous slick/line") — never fake a precise count from vague text.
- spread: concentrated | scattered | linear_along_shore | widespread_patch | unknown
- density_score: integer 1–10 = pollution / response intensity from (1) hazard class, (2) physical scale from size × quantity × spread, (3) certainty of evidence.
- density_label: Critical (8-10) | Dense (6-7) | Moderate (3-5) | Sparse (1-2) | Unverified (only when evidence is truly absent)
- intensity_rationale: 1–3 sentences citing waste type, size, quantity, spread, and any hazard. Do not repeat the label alone.
- When structured reporter fields are provided, use them for scale unless free text clearly contradicts them.
- needs_more_info: false if structured form gives type + size + quantity, OR notes give size/material/count, OR the description is clearly actionable. true only when evidence is empty, one vague word, or nothing assessable.
- estimated_volume: human-readable scale ("~1 item", "small pile", "~10 m patch") or "unknown".
Respond ONLY with the JSON object, no other text.`;

const RECONCILIATION_OUTPUT_SCHEMA = `Return ONLY valid JSON (no markdown, no code fences):
{
  "final_objects": [
    {"label":"string","role":"debris|animal","source":"cv|expert|reconciled","detail":"optional"}
  ],
  "agreement_level": "high|medium|low",
  "severity": 6,
  "confidence": 0.78,
  "key_factors": ["string"],
  "conflicts": [{"topic":"string","resolution":"string"}],
  "explanation": "string",
  "primary_debris_type": "plastic|fishing_gear|organic|chemical|mixed|unknown",
  "estimated_volume": "qualitative e.g. ~2 items or unknown",
  "approximate_size": "phrase aligned with structured size + CV scale",
  "quantity_estimate": "band aligned with structured quantity + CV object count",
  "spread": "concentrated|scattered|linear_along_shore|widespread_patch|unknown",
  "intensity_rationale": "1–3 sentences: tie severity to CV evidence, structured scale fields, interactions, geo — not pixel guesses",
  "needs_more_info": false
}

Field rules:
- final_objects: reconciled union; use source "cv" ONLY if that row matches a real bbox: role=debris only when detection.debris is non-empty; role=animal only when detection.animals is non-empty. If detection.debris is empty, all debris claims must be source expert or reconciled (never cv). Same for animals when detection.animals is empty. Never invent bbox objects.
- agreement_level / severity / confidence / key_factors / conflicts / explanation: as in reconciliation instructions.
- approximate_size, quantity_estimate, spread: reconcile with CV when lists are non-empty. If CV has ZERO debris and ZERO animals, do NOT claim COCO-SSD "found" bbox objects. If INPUT C (VISION_PRIOR) is present, you MAY use it for visible scale/wildlife — it is not COCO; cite it explicitly. If there is no VISION_PRIOR, set scale from structured reporter + notes and state that the bbox detector returned no hits.
- intensity_rationale: required. If CV has hits, cite CV + structured. If CV has zero hits, cite VISION_PRIOR when present, else structured/expert, and always mention that COCO-style bbox lists were empty.
- needs_more_info: false if structured reporter has waste type + size + quantity, OR CV lists any debris/animal, OR free-text notes are clearly actionable. true only when all are absent/empty.
`;

function buildReconciliationAnalysisText(raw, pipeline) {
  const parts = [];
  if (raw.explanation) parts.push(raw.explanation);
  if (raw.agreement_level) {
    parts.push(`Agreement (CV vs expert hypothesis): ${raw.agreement_level}.`);
  }
  if (Array.isArray(raw.key_factors) && raw.key_factors.length) {
    parts.push(`Factors: ${raw.key_factors.join('; ')}.`);
  }
  if (Array.isArray(raw.conflicts) && raw.conflicts.length) {
    parts.push(
      `Conflicts addressed: ${raw.conflicts.map((c) => `${c.topic} → ${c.resolution}`).join('; ')}.`,
    );
  }
  const det = pipeline?.detection;
  if (det) {
    parts.push(
      `CV detector: ${det.detector}; raw counts — animals ${det.animals?.length ?? 0}, debris ${det.debris?.length ?? 0}.`,
    );
  }
  return parts.join(' ');
}

function mergeVisionWildlifeIntoFinalObjects(finalObjects, vision) {
  const list = Array.isArray(finalObjects) ? [...finalObjects] : [];
  const wv = String(vision?.wildlife_visible || '').toLowerCase();
  if (wv !== 'moderate' && wv !== 'dense_school') return list;
  if (list.some((o) => /fish \/ marine life \(photo\)/i.test(String(o?.label || '')))) return list;
  const note = typeof vision.wildlife_note === 'string' ? vision.wildlife_note.trim() : '';
  const detail = [note || 'Marine life visible in frame', 'COCO-SSD often misses fish underwater — not from bbox detector']
    .filter(Boolean)
    .join(' · ');
  list.push({
    label: 'fish / marine life (photo)',
    role: 'animal',
    source: 'reconciled',
    detail,
  });
  return list;
}

/**
 * Deterministic correction when the photo clearly contradicts undersized reporter fields
 * but COCO returned no boxes.
 */
function applyVisionPriorToReconciliation(parsed, vision, reporterStructured) {
  if (!vision || typeof vision !== 'object') return { parsed: { ...parsed }, applied: false };

  const high = String(vision.confidence || '').toLowerCase() === 'high';
  const undersized = vision.reporter_undersized_vs_scene === true;
  let applied = false;
  let out = { ...parsed };

  if (high && undersized) {
    applied = true;
    if (typeof vision.approximate_size === 'string' && vision.approximate_size.trim()) {
      out.approximate_size = vision.approximate_size.trim();
    }
    if (typeof vision.quantity_estimate === 'string' && vision.quantity_estimate.trim()) {
      out.quantity_estimate = vision.quantity_estimate.trim();
    }
    if (typeof vision.spread === 'string' && vision.spread.trim()) {
      out.spread = vision.spread.trim();
    }
    const sev = Number(vision.suggested_severity);
    if (Number.isFinite(sev)) {
      const cur = Number(out.severity);
      out.severity = Math.max(Number.isFinite(cur) ? cur : 0, Math.min(10, Math.max(1, Math.round(sev))));
    }
    const pdt = String(vision.primary_debris_type || '').toLowerCase();
    const allowed = ['plastic', 'fishing_gear', 'organic', 'chemical', 'mixed', 'unknown'];
    if (allowed.includes(pdt) && pdt !== 'unknown') {
      out.primary_debris_type = pdt;
    }

    const kf = Array.isArray(out.key_factors) ? [...out.key_factors] : [];
    const line = 'Photo vision prior: visible scale exceeds reporter form — scale fields aligned to the prior.';
    if (!kf.some((f) => String(f).includes('Photo vision'))) kf.unshift(line);
    out.key_factors = kf;

    const conflicts = Array.isArray(out.conflicts) ? [...out.conflicts] : [];
    if (!conflicts.some((c) => String(c?.topic || '').includes('Reporter size'))) {
      conflicts.push({
        topic: 'Reporter size/amount vs visible scene',
        resolution:
          'COCO-SSD had no bbox hits in this frame (typical underwater). Used photo vision prior for scale where provided; kept compatible structured fields for type where applicable.',
      });
    }
    out.conflicts = conflicts;
    out.final_objects = mergeVisionWildlifeIntoFinalObjects(out.final_objects, vision);
    out.agreement_level = 'low';
    const c = Number(out.confidence);
    if (Number.isFinite(c)) out.confidence = Math.max(c, 0.62);
    else out.confidence = 0.68;
  } else if (high && (vision.wildlife_visible === 'moderate' || vision.wildlife_visible === 'dense_school')) {
    const kf = Array.isArray(out.key_factors) ? [...out.key_factors] : [];
    const fishLine =
      'Wildlife: fish or other animals are visible in the photo; COCO-SSD is not trained for underwater fish schools (often 0 bbox animals).';
    if (!kf.some((f) => String(f).includes('fish'))) kf.push(fishLine);
    out.key_factors = kf;
    out.final_objects = mergeVisionWildlifeIntoFinalObjects(out.final_objects, vision);
  }

  // Help downstream copy: intensity should mention vision when we used it
  if (applied && reporterStructured && typeof out.intensity_rationale === 'string') {
    if (!/photo vision|vision prior|vision model/i.test(out.intensity_rationale)) {
      out.intensity_rationale = `${out.intensity_rationale.trim()} Photo vision overrode undersized reporter scale.`.trim();
    }
  }

  return { parsed: out, applied };
}

function normalizeAgreementLevel(v) {
  const s = String(v || '').toLowerCase();
  if (s === 'high' || s === 'medium' || s === 'low') return s;
  return 'medium';
}

/** No accepted CV boxes — not “clean ocean”, just no automated detections. */
function cvPipelineIsEmpty(pipeline) {
  if (pipeline?.cvDetected === true) return false;
  if (pipeline?.cvDetected === false) return true;
  const det = pipeline?.detection;
  if (!det) return true;
  return (det.debris || []).length === 0 && (det.animals || []).length === 0;
}

function sourceTokenIsCv(o) {
  const s = String(o?.source || '').toLowerCase();
  return s === 'cv' || s.startsWith('cv');
}

/**
 * CV may find a person while debris list is empty — LLMs still tag plastic as source=cv. Strip that.
 * "High" agreement is invalid for debris when there are zero debris bboxes.
 */
function enforcePerClassCvAttribution(parsed, pipeline) {
  const det = pipeline?.detection;
  const debrisN = (det?.debris || []).length;
  const animalsN = (det?.animals || []).length;
  const p = { ...parsed };
  if (!Array.isArray(p.final_objects)) return p;

  let fixedDebrisCv = false;
  let fixedAnimalCv = false;
  p.final_objects = p.final_objects.map((o) => {
    if (!o || typeof o !== 'object') return o;
    if (!sourceTokenIsCv(o)) return o;
    const role = String(o.role || '').toLowerCase();
    if (role === 'debris' && debrisN === 0) {
      fixedDebrisCv = true;
      return {
        ...o,
        source: 'expert',
        detail: [o.detail, '(no debris bbox in CV — structured reporter / notes)'].filter(Boolean).join(' ').trim(),
      };
    }
    if (role === 'animal' && animalsN === 0) {
      fixedAnimalCv = true;
      return {
        ...o,
        source: 'expert',
        detail: [o.detail, '(no animal bbox in CV — structured reporter / notes)'].filter(Boolean).join(' ').trim(),
      };
    }
    return o;
  });

  if (debrisN === 0 && String(p.agreement_level || '').toLowerCase() === 'high') {
    p.agreement_level = 'medium';
  }
  const conf = Number(p.confidence);
  if (debrisN === 0 && fixedDebrisCv && Number.isFinite(conf)) {
    p.confidence = Math.min(conf, 0.72);
  }

  const conflicts = Array.isArray(p.conflicts) ? [...p.conflicts] : [];
  if (fixedDebrisCv || fixedAnimalCv) {
    const topic = 'CV source used without matching bbox list';
    if (!conflicts.some((c) => String(c?.topic || '').includes(topic))) {
      conflicts.push({
        topic,
        resolution:
          'Debris or animal rows tied to CV must match non-empty detection lists — corrected sources to expert where lists were empty.',
      });
    }
  }
  p.conflicts = conflicts;

  return p;
}

/**
 * LLMs sometimes hallucinate "CV found X" when lists are empty. Fix output deterministically.
 * @param {object} opts
 * @param {boolean} [opts.visualPriorApplied] — Photo vision prior already corrected scale; relax confidence cap slightly.
 */
function enforceEmptyCvConsistency(parsed, pipeline, opts = {}) {
  if (!cvPipelineIsEmpty(pipeline)) return { ...parsed };

  const hadCvSource =
    Array.isArray(parsed.final_objects) &&
    parsed.final_objects.some((o) => {
      const s = String(o?.source || '').toLowerCase();
      return s === 'cv' || s.startsWith('cv');
    });

  const p = { ...parsed };
  const warn = 'CV: 0 objects above model confidence threshold (no bbox hits).';

  if (Array.isArray(p.final_objects)) {
    p.final_objects = p.final_objects.map((o) => {
      if (!o || typeof o !== 'object') return o;
      const src = String(o.source || '').toLowerCase();
      if (src === 'cv' || src.startsWith('cv')) {
        return {
          ...o,
          source: 'expert',
          detail: [o.detail, '(detector returned no boxes; from structured report / notes only)']
            .filter(Boolean)
            .join(' ')
            .trim(),
        };
      }
      return o;
    });
  }

  const existing = Array.isArray(p.key_factors) ? p.key_factors : [];
  p.key_factors = existing.some((f) => String(f).includes('0 objects')) ? existing : [warn, ...existing];

  if (String(p.agreement_level || '').toLowerCase() === 'high') {
    p.agreement_level = 'medium';
  }

  const confCap = opts.visualPriorApplied ? 0.82 : 0.62;
  const conf = Number(p.confidence);
  if (Number.isFinite(conf)) {
    let c = Math.min(conf, confCap);
    if (opts.visualPriorApplied) c = Math.max(c, 0.58);
    p.confidence = c;
  }

  p.explanation = `${warn} ${p.explanation || ''}`.trim();

  const conflicts = Array.isArray(p.conflicts) ? [...p.conflicts] : [];
  if (hadCvSource) {
    const resolution = opts.visualPriorApplied
      ? 'Removed incorrect CV attribution; bbox lists were empty — scale may use a photo vision prior where provided.'
      : 'Corrected: no source=cv objects; narrative reflects structured reporter input only.';
    if (!conflicts.some((c) => c && /implied cv|cv boxes|cited cv objects/i.test(String(c.topic || '')))) {
      conflicts.push({
        topic: 'Output implied CV boxes but pipeline had zero detections',
        resolution,
      });
    }
  }
  p.conflicts = conflicts;

  return p;
}

function mapReconciliationToLegacy(raw, pipeline, reporterStructured = null) {
  const fused = applyLlmFirstSignalFusion(raw, pipeline, reporterStructured);

  let severity = Math.round(Number(fused.severity));
  if (!Number.isFinite(severity)) severity = 5;
  severity = Math.max(1, Math.min(10, severity));

  const confNum = Number(fused.confidence);
  const confCat = numericConfidenceToCategory(confNum);

  const primary = fused.primary_debris_type || fused.debris_type || 'unknown';

  let analysis = {
    debris_type: primary,
    density_score: severity,
    density_label: scoreToDensityLabel(severity),
    estimated_volume: fused.estimated_volume || 'unknown',
    confidence: confCat,
    needs_more_info: fused.needs_more_info === true,
    gemini_analysis: buildReconciliationAnalysisText(fused, pipeline),
    approximate_size: typeof fused.approximate_size === 'string' ? fused.approximate_size.trim() : '',
    quantity_estimate: typeof fused.quantity_estimate === 'string' ? fused.quantity_estimate.trim() : '',
    spread: typeof fused.spread === 'string' ? fused.spread.trim() : '',
    intensity_rationale: typeof fused.intensity_rationale === 'string' ? fused.intensity_rationale.trim() : '',
    severity_assessment: {
      severity,
      confidence: Number.isFinite(confNum) ? Math.round(confNum * 100) / 100 : null,
      key_factors: Array.isArray(fused.key_factors)
        ? fused.key_factors
        : (Array.isArray(fused.factors) ? fused.factors : []),
      agreement_level: normalizeAgreementLevel(fused.agreement_level),
      conflicts: Array.isArray(fused.conflicts) ? fused.conflicts : [],
      final_objects: Array.isArray(fused.final_objects) ? fused.final_objects : [],
      explanation: fused.explanation || '',
    },
    pipeline_evidence: pipeline,
  };

  analysis = normalizeDebrisAnalysis(analysis, reporterStructured);
  if (analysis.severity_assessment) {
    analysis.severity_assessment.severity = analysis.density_score;
  }
  return analysis;
}

/**
 * Photo path: in-browser COCO-SSD pipeline JSON + structured dropdowns + notes → Gemini reconciliation JSON.
 * (No separate vision LLM — empty CV frames rely on reporter fields + notes.)
 */
export async function analyzeDebrisPhoto(
  base64Image,
  mimeType,
  latitude,
  longitude,
  reporterNotes = '',
  reporterStructured = null,
  voiceTranscript = '',
) {
  const dataUrl = `data:${mimeType};base64,${base64Image}`;
  const pipeline = await runMarineDebrisPipeline(dataUrl, latitude, longitude);

  const cvEmpty = cvPipelineIsEmpty(pipeline);
  const visualPrior = null;

  const notes = String(reporterNotes || '').slice(0, 6000).replace(/\s+/g, ' ').trim();
  const structuredBlock = formatReporterStructuredBlock(reporterStructured);
  const notesBlock = notes
    ? `Free-text notes (hypothesis — not ground truth):\n"${notes.replace(/"/g, "'")}"`
    : 'Free-text notes: (none)';

  const expertBlock = `${structuredBlock || 'Structured reporter fields: (none — rely on free-text; CV is supplementary if present)\n'}${notesBlock}`;
  const voicePromptSection = formatVoiceTranscriptForPrompt(voiceTranscript);

  const visionBlock = visualPrior
    ? `
────────────────────────────
INPUT C — VISION_PRIOR (when present: same photo, not COCO bounding boxes)
────────────────────────────
${JSON.stringify(visualPrior)}
If reporter_undersized_vs_scene is true and confidence is "high", treat reporter size/quantity fields as mistaken and align approximate_size, quantity_estimate, spread, severity, and primary_debris_type with this vision JSON. Mention fish/wildlife here when wildlife_visible is not "none" (COCO often misses underwater fish).
`
    : '';

  const zeroCvBlock = cvEmpty
    ? `
ZERO-DETECTION MODE — detection.debris and detection.animals are BOTH empty (no bbox hits this frame; common for underwater nets / diffuse plastic):
- Never claim the bbox detector "found" objects or use source "cv" on final_objects.
- agreement_level must NOT be "high".
${visualPrior
      ? `- Anchor visible scale and wildlife on INPUT C (VISION_PRIOR) when it conflicts with undersized reporter fields; keep reporter waste_type if still compatible.
- Include in key_factors the exact phrase: "CV: 0 objects above detection threshold".`
      : `- PRIMARY: structured reporter size, quantity, spread, and waste type + free-text notes — treat as the operational assessment. Automated bbox CV is unreliable here; do not down-rank a plausible reporter description because bbox lists are empty.
- Include in key_factors the exact phrase: "CV: 0 objects above detection threshold".`}
`
    : '';

  const anchorRule = cvEmpty
    ? visualPrior
      ? 'Bbox lists are empty — do NOT anchor risk on bbox CV. Use VISION_PRIOR for visible scale and wildlife; reporter form is secondary when vision flags undersized_vs_scene.'
      : 'Bbox lists are empty and no VISION_PRIOR — anchor severity and scale primarily on structured reporter fields + notes; bbox CV is supplementary only; keep confidence conservative when evidence is thin.'
    : 'PRIMARY (~0.7): structured reporter fields + free-text notes — debris type, scale, quantity, spread, and operational priority. SUPPORTING (~0.3): bbox CV when present (bottles, bags, birds, people, etc.). CV does not override a coherent reporter narrative for marine-specific debris (nets, slicks, diffuse plastic) unless bbox evidence clearly contradicts; underwater domain mismatch favors reporter.';

  const prompt = `You are a RECONCILIATION engine for marine debris / wildlife risk. You do not see raw pixels yourself — you receive JSON only: reporter fields, COCO-style pipeline output, and sometimes an optional VISION_PRIOR JSON for the same image.

────────────────────────────
INPUT A — EXPERT INPUT (hypothesis: structured + free text + voice when present)
────────────────────────────
${expertBlock}${voicePromptSection}

${cvEmpty && !visualPrior
    ? 'When bbox lists are empty and there is no VISION_PRIOR, structured fields are the main quantitative signal — do not invent CV sightings.'
    : !cvEmpty
      ? 'Reporter structured fields + notes lead (~0.7); CV bbox detections refine or lightly contradict (~0.3) — prefer reporter on marine debris CV often misses.'
      : 'VISION_PRIOR is present — prefer it over clearly undersized reporter scale fields when vision confidence is high.'}
${visionBlock}
────────────────────────────
INPUT B — COMPUTER_VISION_PIPELINE (COCO-SSD + derived features; bbox lists may be empty)
────────────────────────────
${JSON.stringify(pipeline)}
${zeroCvBlock}

CV structure reminder:
- detection.animals / detection.debris: class labels, bbox [xmin,ymin,xmax,ymax] in 0–1, confidence. Mapped from COCO (e.g. plastic_bottle, seabird proxy). Do not treat as species-level ground truth for rare taxa.
- spatial.interactions: pairwise animal–debris distance, IoU, risk.
- geo: lightweight region / protected stub / biodiversity_score (illustrative).

────────────────────────────
CRITICAL RULES
────────────────────────────
1) Expert (structured + typed notes + VOICE_TRANSCRIPT when present) is PRIMARY for response scale and debris narrative. CV bbox lists are SUPPORTING evidence — use them to confirm visible objects when classes match; never let generic COCO detections erase a plausible reporter description of fishing gear, oil, or diffuse plastic.
2) Compare expert claims to CV detections: agreement, partial agreement, or contradiction — weight expert higher when CV is empty or domain-mismatched (underwater, nets).
3) ${anchorRule}
4) Examples: Expert "leatherback turtle" + CV "seabird" or generic wildlife → partial match: accept broad animal presence, reject species precision not in CV. Expert "barbed wire" + CV "plastic_line-like" → uncertain debris class; do not assert barbed wire.
5) FORBIDDEN: treating expert text as absolute truth when VISION_PRIOR high-confidence contradicts it; inventing COCO bbox objects when lists are empty; inventing species beyond evidence.
6) FORBIDDEN: source "cv" on a debris final_objects row when INPUT B detection.debris is empty (person-only frame is not debris evidence). Same: no source "cv" on animal rows when detection.animals is empty. agreement_level must not be "high" if detection.debris is empty but you still infer plastic from reporter text alone.

────────────────────────────
YOUR TASK
────────────────────────────
Produce full reconciliation JSON including approximate_size, quantity_estimate, spread, intensity_rationale.

${RECONCILIATION_OUTPUT_SCHEMA}`;

  const response = await llmTextCompletion([{ role: 'user', content: prompt }]);
  let parsed = extractJSON(response.choices[0].message.content);
  const { parsed: merged, applied: visionApplied } = applyVisionPriorToReconciliation(
    parsed,
    visualPrior,
    reporterStructured,
  );
  parsed = merged;
  parsed = enforcePerClassCvAttribution(parsed, pipeline);
  parsed = enforceEmptyCvConsistency(parsed, pipeline, { visualPriorApplied: visionApplied });
  let legacy = mapReconciliationToLegacy(parsed, pipeline, reporterStructured);
  legacy = await mergeMarineReportWithGeminiImpact({
    latitude,
    longitude,
    reporterStructured,
    typedNotes: notes,
    voiceTranscript: String(voiceTranscript || '').trim(),
    analysis: legacy,
    pipeline,
  });
  return legacy;
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

function normalizeDebrisAnalysis(a, reporterStructured = null) {
  const out = { ...a };
  const conf = out.confidence === 'high' || out.confidence === 'medium' || out.confidence === 'low'
    ? out.confidence
    : 'medium';
  let score = Number(out.density_score);
  if (!Number.isFinite(score)) score = conf === 'low' ? 3 : 5;
  if (out.needs_more_info === true || conf === 'low') {
    score = Math.min(score, 4);
    if (!out.density_label || out.density_label === 'Critical' || out.density_label === 'Dense') {
      out.density_label = 'Unverified';
    }
  } else {
    const allowed = ['Critical', 'Dense', 'Moderate', 'Sparse', 'Unverified'];
    if (!allowed.includes(out.density_label)) {
      out.density_label = scoreToDensityLabel(score);
    }
  }
  if (!out.estimated_volume || String(out.estimated_volume).toLowerCase() === 'null') {
    out.estimated_volume = 'unknown';
  }

  let intensity_rationale = typeof out.intensity_rationale === 'string' ? out.intensity_rationale.trim() : '';
  if (!intensity_rationale && structuredReportComplete(reporterStructured)) {
    const rs = reporterStructured;
    intensity_rationale = `Rating ${Math.round(Math.max(1, Math.min(10, score)))}/10 based on reporter: ${rs.waste_type}, ${rs.size_category}, ${rs.quantity_band}${rs.spread_layout ? `, spread: ${rs.spread_layout}` : ''}.`;
  }

  let approximate_size = typeof out.approximate_size === 'string' ? out.approximate_size.trim() : '';
  let quantity_estimate = typeof out.quantity_estimate === 'string' ? out.quantity_estimate.trim() : '';
  let spread = typeof out.spread === 'string' ? out.spread.trim() : '';
  if (reporterStructured) {
    if (!approximate_size && reporterStructured.size_category) approximate_size = reporterStructured.size_category;
    if (!quantity_estimate && reporterStructured.quantity_band) quantity_estimate = reporterStructured.quantity_band;
    if (!spread && reporterStructured.spread_layout) spread = reporterStructured.spread_layout;
  }

  return {
    ...out,
    density_score: Math.max(1, Math.min(10, Math.round(score))),
    confidence: conf,
    intensity_rationale: intensity_rationale || out.gemini_analysis?.slice(0, 200) || '',
    approximate_size: approximate_size || 'unknown',
    quantity_estimate: quantity_estimate || 'unknown',
    spread: spread || 'unknown',
  };
}

// Text-only analysis when no photo is available
export async function analyzeDebrisText(notes, latitude, longitude, reporterStructured = null, voiceTranscript = '') {
  const raw = (notes || '').trim();
  const voicePromptSection = formatVoiceTranscriptForPrompt(voiceTranscript);
  const block = formatReporterStructuredBlock(reporterStructured);
  const prompt = `You are a marine debris assessment AI.
A reporter at coordinates ${latitude}, ${longitude} described this debris sighting.
${block ? `${block}\n` : ''}Free-text description:
"${raw || 'No description provided'}"
Use every detail they gave — including any VOICE_TRANSCRIPT block below (ElevenLabs STT). If structured fields give type + size + quantity, use them as the default for scale unless the description or voice clearly contradicts them.
${voicePromptSection}
${DEBRIS_JSON_SCHEMA}`;

  const response = await llmTextCompletion([{ role: 'user', content: prompt }]);
  let parsed = extractJSON(response.choices[0].message.content);
  const combinedForHeuristic = `${raw}\n${String(voiceTranscript || '').trim()}`.trim();
  parsed = applyTextNotesHeuristic(combinedForHeuristic, parsed, reporterStructured);
  let out = normalizeDebrisAnalysis(parsed, reporterStructured);
  out = await mergeMarineReportWithGeminiImpact({
    latitude,
    longitude,
    reporterStructured,
    typedNotes: raw,
    voiceTranscript: String(voiceTranscript || '').trim(),
    analysis: out,
    pipeline: null,
  });
  return out;
}

// Crew assignment + interception suggestions
export async function getCrewSuggestions({
  sightings,
  vessels,
  landCrews = [],
  assignments,
  pendingHandoffs = [],
  crewRankings = new Map(),
  supplies = [],
}) {
  const available = (vessels || []).filter((v) => v.status === 'available');
  const availJson = JSON.stringify(available.map((v) => ({
    id: v.id, name: v.name, zone: v.zone, fuel: v.fuel_level, capacity: v.capacity,
  })));
  const shoreCrews = (landCrews || []).filter((c) => c.status === 'available' || c.status === 'standby' || !c.status);
  const shoreJson = JSON.stringify(shoreCrews.map((c) => ({
    id: c.id, name: c.name, lat: c.base_lat, lon: c.base_lon,
  })));
  const lowSupplies = (supplies || []).filter((s) => s.quantity <= s.low_threshold);
  const supplyJson = JSON.stringify(lowSupplies.map((s) => ({
    id: s.id, name: s.name, qty: s.quantity, low_at: s.low_threshold,
  })));

  // Pre-computed rankings let the AI pick the right crew per sighting without re-deriving distance.
  const rankingHints = (sightings || []).map((s) => {
    const r = crewRankings.get?.(s.id);
    if (!r || !Array.isArray(r.ranked) || r.ranked.length === 0) return null;
    const top = r.ranked.slice(0, 3).map((row) => ({
      crew_type: row.crewType,
      crew_id: row.crewId,
      crew_name: row.crewName,
      eta_min: row.totalMinutes,
    }));
    return { sighting_id: s.id, pickup: r.pickupKey, top };
  }).filter(Boolean);

  const prompt = `You are the AI crew coordinator for ClearMarine (one operations center; vessels below are OUR fleet).

QUEUE (sightings NOT yet on any open assignment — these are the ONLY sightings you may dispatch to):
${JSON.stringify((sightings || []).map(s => ({ id: s.id, type: s.debris_type, density: s.density_label, score: s.density_score, lat: s.latitude, lon: s.longitude })))}

Pending handoffs to accept (this desk): ${JSON.stringify((pendingHandoffs || []).map(s => ({ handoff_id: s.id, id: s.id, from: s.source_jurisdiction, type: s.debris_type, density: s.density_label })))}
AVAILABLE vessels (status=available — ONLY these can be assigned; you MUST pick one by name and id): ${availJson || '[]'}
Other vessels (deployed/maintenance — do NOT assign): ${JSON.stringify((vessels || []).filter(v => v.status !== 'available').map(v => ({ name: v.name, status: v.status })))}
Available shore crews (use these for shore / coastal-flagged debris only): ${shoreJson || '[]'}
Pre-ranked crew options per queued sighting (use the top entry for that sighting): ${JSON.stringify(rankingHints)}
Open assignments (context only — DO NOT recommend dispatch for these sighting_ids): ${JSON.stringify((assignments || []).filter(a => a.status !== 'completed').map(a => ({ vessel_id: a.vessel_id, land_crew_id: a.land_crew_id, sighting_id: a.sighting_id, status: a.status })))}
Low-stock supplies that should be reordered: ${supplyJson || '[]'}

Rules:
- ONLY pick sightings from the QUEUE list. Never recommend dispatching to a sighting that already appears in Open assignments.
- Each item must be DIFFERENT — do not repeat the same sighting_id, vessel_id, land_crew_id, supply_id, or handoff_id across items.
- Prefer the top-ranked crew from "Pre-ranked crew options" for each sighting.
- For assign_vessel: text MUST name the exact vessel (e.g. "Send Ocean Guardian I to intercept…") and set vessel_id to that vessel's UUID from AVAILABLE list only.
- For assign_land_crew: text MUST name the exact shore crew and set land_crew_id to that crew's id (use the ranked option for that sighting). Use this for ship_coast / land pickups.
- If AVAILABLE vessels are empty AND no shore crews are usable: do NOT use assign_*. Prefer reorder_supply (when supplies are low) or accept_handoff, otherwise action_type "none" explaining why.
- If the QUEUE is empty AND no handoffs are pending, fill slots with reorder_supply for low-stock items, then "none".
- Prioritize highest-density sightings and shortest ETA from the ranking hints.

Return ONLY a JSON array of up to 3 action items, no markdown. Skip a slot rather than repeat:
[
  {"text":"Send [VESSEL NAME] to …","action_type":"assign_vessel","sighting_id":null,"vessel_id":null,"land_crew_id":null,"supply_id":null,"handoff_id":null},
  {"text":"…","action_type":"assign_land_crew","sighting_id":null,"vessel_id":null,"land_crew_id":null,"supply_id":null,"handoff_id":null},
  {"text":"…","action_type":"reorder_supply","sighting_id":null,"vessel_id":null,"land_crew_id":null,"supply_id":null,"handoff_id":null}
]
action_type: assign_vessel | assign_land_crew | accept_handoff | reorder_supply | mark_cleared | none
Set sighting_id, vessel_id, land_crew_id, supply_id, handoff_id from the data above when relevant.`;

  const response = await llmTextCompletion([{ role: 'user', content: prompt }]);
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

  const response = await llmTextCompletion([{ role: 'user', content: prompt }]);
  return response.choices[0].message.content;
}

// Crew assignment brief for a specific vessel + sighting intercept
export async function generateAssignmentBrief({ vesselName, debrisType, densityLabel, interceptionHours, lat, lon }) {
  const prompt = `Assignment brief for vessel ${vesselName}.
Intercept ${densityLabel} ${debrisType} debris in ${interceptionHours} hours at approximately ${lat.toFixed(3)}, ${lon.toFixed(3)}.
Write a concise crew briefing: equipment needed, approach instructions, safety considerations.
Max 80 words. Direct operational tone.`;

  const response = await llmTextCompletion([{ role: 'user', content: prompt }]);
  return response.choices[0].message.content;
}
