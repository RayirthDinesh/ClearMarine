/** Map 1–10 score to dashboard density label */
export function scoreToDensityLabel(score) {
  const s = Math.max(1, Math.min(10, Math.round(Number(score) || 5)));
  if (s >= 8) return 'Critical';
  if (s >= 6) return 'Dense';
  if (s >= 3) return 'Moderate';
  return 'Sparse';
}

/** Map numeric confidence to legacy categorical */
export function numericConfidenceToCategory(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 'medium';
  if (x >= 0.72) return 'high';
  if (x >= 0.45) return 'medium';
  return 'low';
}
