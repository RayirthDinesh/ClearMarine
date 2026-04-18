/**
 * LLM-first signal fusion for marine debris reconciliation.
 * CV is optional; empty CV does not penalize the fused score.
 */

/**
 * @typedef {{
 *   llm: number,
 *   cv: number,
 *   report: number,
 *   cvDetected: boolean,
 * }} Signals
 */

/**
 * @param {Signals} signals
 * @returns {{ score: number, label: string, sourceOfTruth: 'llm'|'cv' }}
 */
/** @param {Signals} signals */
export function reconcileSignals({ llm, cv, report, cvDetected }) {
  const llmN = clamp01(Number(llm) || 0);
  const cvN = clamp01(Number(cv) || 0);
  const reportN = clamp01(Number(report) || 0);
  const cvWeight = cvDetected ? 0.2 : 0;

  const score = clamp01(0.7 * llmN + cvWeight * cvN + 0.1 * reportN);

  let label = 'uncertain';
  if (score > 0.75) label = 'high confidence';
  else if (score > 0.5) label = 'moderate confidence';

  const sourceOfTruth = llmN >= cvN ? 'llm' : 'cv';

  return { score, label, sourceOfTruth };
}

function clamp01(x) {
  return Math.max(0, Math.min(1, x));
}

/**
 * Mean confidence of bbox entries (animals + debris arrays).
 * @param {{ animals?: Array<{confidence?: number}>, debris?: Array<{confidence?: number}> }} detection
 * @returns {number}
 */
export function meanCvConfidence(detection) {
  const rows = [...(detection?.animals || []), ...(detection?.debris || [])];
  if (rows.length === 0) return 0;
  const sum = rows.reduce((s, r) => s + (Number(r.confidence) || 0), 0);
  return sum / rows.length;
}

/**
 * Reporter form completeness → 0–1.
 * @param {Record<string, string>|null|undefined} reporterStructured
 */
export function reportSignalStrength(reporterStructured) {
  if (!reporterStructured || typeof reporterStructured !== 'object') return 0.25;
  const wt = String(reporterStructured.waste_type || '').trim();
  const sz = String(reporterStructured.size_category || '').trim();
  const qb = String(reporterStructured.quantity_band || '').trim();
  if (wt && sz && qb) return 0.9;
  if ((wt && sz) || (wt && qb) || (sz && qb)) return 0.55;
  if (wt || sz || qb) return 0.35;
  return 0.25;
}

/**
 * Apply LLM-first fusion to Groq reconciliation output. Does not reduce severity when CV is empty.
 * @param {object} raw - parsed JSON from Groq
 * @param {object} pipeline - runMarineDebrisPipeline result (must include detection + cvDetected)
 * @param {object|null} reporterStructured
 * @returns {object} patched raw with confidence + agreement_level adjusted
 */
export function applyLlmFirstSignalFusion(raw, pipeline, reporterStructured) {
  const det = pipeline?.detection;
  const cvDetected = pipeline?.cvDetected === true
    || (((det?.animals || []).length + (det?.debris || []).length) > 0);

  const llm = Number(raw.confidence);
  const llmN = Number.isFinite(llm) ? llm : 0.55;
  const cvSig = cvDetected ? meanCvConfidence(det) : 0;
  const reportSig = reportSignalStrength(reporterStructured);

  const { score, label, sourceOfTruth } = reconcileSignals({
    llm: llmN,
    cv: cvSig,
    report: reportSig,
    cvDetected,
  });

  const out = { ...raw };
  out.confidence = Math.round(score * 1000) / 1000;

  let ag = String(raw.agreement_level || '').toLowerCase();
  if (ag === 'high') {
    if (!cvDetected) {
      ag = 'medium';
    } else {
      const debrisEmpty = (det?.debris || []).length === 0;
      const expertClaimsDebris = Boolean(
        String(raw.primary_debris_type || raw.debris_type || '').match(/plastic|fishing|organic|chemical|mixed/i),
      );
      if (debrisEmpty && expertClaimsDebris) {
        ag = 'medium';
      }
    }
  }
  out.agreement_level = ag === 'high' || ag === 'medium' || ag === 'low' ? ag : 'medium';

  const kf = Array.isArray(out.key_factors) ? [...out.key_factors] : [];
  const fusionLine = `Signal fusion (${label}, primary: ${sourceOfTruth}) — CV ${cvDetected ? 'contributed' : 'did not contribute'} to confidence; empty CV is not treated as “clean ocean”.`;
  if (!kf.some((f) => String(f).includes('Signal fusion'))) {
    kf.push(fusionLine);
  }
  out.key_factors = kf;

  return out;
}
