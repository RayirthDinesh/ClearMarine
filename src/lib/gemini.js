import Groq from 'groq-sdk';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { runMarineDebrisPipeline } from './debrisPipeline';
import { applyLlmFirstSignalFusion } from './reconcileSignals';
import { numericConfidenceToCategory, scoreToDensityLabel } from './severityUtils';

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

const groq = new Groq({
  apiKey: process.env.REACT_APP_GROQ_API_KEY,
  dangerouslyAllowBrowser: true,
});

/** Primary text model — default 8B instant (much lower TPD than 70B). Override: REACT_APP_GROQ_TEXT_MODEL */
const TEXT_MODEL_PRIMARY =
  process.env.REACT_APP_GROQ_TEXT_MODEL || 'llama-3.1-8b-instant';

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

const GEMINI_VISION_MODEL =
  process.env.REACT_APP_GEMINI_VISION_MODEL || 'gemini-2.0-flash';

/**
 * When COCO-SSD returns no boxes (common underwater), Gemini still sees the photo.
 * Returns null if no API key or the call fails.
 */
async function runGeminiPhotoVisionPrior(base64Image, mimeType, reporterStructured) {
  const key = process.env.REACT_APP_GEMINI_API_KEY;
  if (!key || !base64Image) return null;

  const reporterJson = JSON.stringify(reporterStructured || {}, null, 0);
  const instruction = `You are looking at ONE photo for marine debris / response triage.
A separate in-browser model (COCO-SSD) often returns ZERO bounding boxes on underwater shots, nets, and fish schools. Your job is to describe what is actually visible.

Reporter form (may be wrong — compare to the image):
${reporterJson}

Return ONLY a JSON object (no markdown) with these keys:
- confidence: "high" | "medium" | "low" — how sure you are about visible scale and debris type.
- reporter_undersized_vs_scene: boolean — true if the visible debris is clearly much larger / more massive than the reporter size + quantity fields imply (e.g. huge ghost net but form says hand-sized / 1 piece).
- reporter_oversized_vs_scene: boolean — true only if the form clearly exaggerates vs the image.
- approximate_size: short English phrase for ops (e.g. "large derelict net spanning several meters in the water column").
- quantity_estimate: band (e.g. "1 massive entangled structure", "2–10", "dozens of pieces", "100+").
- spread: one of concentrated | scattered | linear_along_shore | widespread_patch | unknown
- wildlife_visible: "none" | "few" | "moderate" | "dense_school"
- wildlife_note: short phrase if any animals visible
- primary_debris_type: plastic | fishing_gear | organic | chemical | mixed | unknown
- scene_one_liner: one sentence
- suggested_severity: integer 1–10 (entanglement hazard, scale, wildlife interaction — be conservative if unsure)`;

  try {
    const genAI = new GoogleGenerativeAI(key);
    const model = genAI.getGenerativeModel({
      model: GEMINI_VISION_MODEL,
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: 1024,
        responseMimeType: 'application/json',
      },
    });

    const result = await model.generateContent([
      { inlineData: { mimeType: mimeType || 'image/jpeg', data: base64Image } },
      { text: instruction },
    ]);

    const text = result.response.text();
    if (!text || !text.trim()) return null;
    const vision = extractJSON(text);
    if (!vision || typeof vision !== 'object') return null;
    return vision;
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('Gemini vision prior failed:', e?.message || e);
    return null;
  }
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
    const line = 'Photo vision (Gemini): visible scale exceeds reporter form — scale fields aligned to the image.';
    if (!kf.some((f) => String(f).includes('Photo vision'))) kf.unshift(line);
    out.key_factors = kf;

    const conflicts = Array.isArray(out.conflicts) ? [...out.conflicts] : [];
    if (!conflicts.some((c) => String(c?.topic || '').includes('Reporter size'))) {
      conflicts.push({
        topic: 'Reporter size/amount vs visible scene',
        resolution:
          'COCO-SSD had no bbox hits in this frame (typical underwater). Used Gemini photo assessment for scale; kept compatible structured fields for type where applicable.',
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
    if (!/gemini|photo vision|vision model/i.test(out.intensity_rationale)) {
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
 * @param {boolean} [opts.visualPriorApplied] — Gemini vision already corrected scale; relax confidence cap slightly.
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
      ? 'Removed incorrect CV attribution; bbox lists were empty — scale may use Gemini photo vision where provided.'
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
 * Photo path: in-browser COCO-SSD pipeline JSON + optional Gemini photo pass (when COCO is empty)
 * + structured dropdowns + notes → Groq reconciliation JSON.
 */
export async function analyzeDebrisPhoto(
  base64Image,
  mimeType,
  latitude,
  longitude,
  reporterNotes = '',
  reporterStructured = null,
) {
  const dataUrl = `data:${mimeType};base64,${base64Image}`;
  const pipeline = await runMarineDebrisPipeline(dataUrl, latitude, longitude);

  const cvEmpty = cvPipelineIsEmpty(pipeline);
  let visualPrior = null;
  if (cvEmpty && process.env.REACT_APP_GEMINI_API_KEY) {
    visualPrior = await runGeminiPhotoVisionPrior(base64Image, mimeType, reporterStructured);
  }

  const notes = String(reporterNotes || '').slice(0, 6000).replace(/\s+/g, ' ').trim();
  const structuredBlock = formatReporterStructuredBlock(reporterStructured);
  const notesBlock = notes
    ? `Free-text notes (hypothesis — not ground truth):\n"${notes.replace(/"/g, "'")}"`
    : 'Free-text notes: (none)';

  const expertBlock = `${structuredBlock || 'Structured reporter fields: (none — rely on free-text; CV is supplementary if present)\n'}${notesBlock}`;

  const visionBlock = visualPrior
    ? `
────────────────────────────
INPUT C — VISION_PRIOR (Gemini — looks at the same photo; NOT COCO bounding boxes)
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

  const prompt = `You are a RECONCILIATION engine for marine debris / wildlife risk. You do not see raw pixels yourself — you receive JSON only: reporter fields, COCO-style pipeline output, and sometimes VISION_PRIOR from Gemini on the same image.

────────────────────────────
INPUT A — EXPERT INPUT (hypothesis: structured + free text)
────────────────────────────
${expertBlock}

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
1) Expert (structured + notes) is PRIMARY for response scale and debris narrative. CV bbox lists are SUPPORTING evidence — use them to confirm visible objects when classes match; never let generic COCO detections erase a plausible reporter description of fishing gear, oil, or diffuse plastic.
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

  const response = await groqTextCompletion([{ role: 'user', content: prompt }]);
  let parsed = extractJSON(response.choices[0].message.content);
  const { parsed: merged, applied: visionApplied } = applyVisionPriorToReconciliation(
    parsed,
    visualPrior,
    reporterStructured,
  );
  parsed = merged;
  parsed = enforcePerClassCvAttribution(parsed, pipeline);
  parsed = enforceEmptyCvConsistency(parsed, pipeline, { visualPriorApplied: visionApplied });
  return mapReconciliationToLegacy(parsed, pipeline, reporterStructured);
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
export async function analyzeDebrisText(notes, latitude, longitude, reporterStructured = null) {
  const raw = (notes || '').trim();
  const block = formatReporterStructuredBlock(reporterStructured);
  const prompt = `You are a marine debris assessment AI.
A reporter at coordinates ${latitude}, ${longitude} described this debris sighting.
${block ? `${block}\n` : ''}Free-text description:
"${raw || 'No description provided'}"
Use every detail they gave. If structured fields give type + size + quantity, use them as the default for scale unless the description clearly contradicts them.
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
