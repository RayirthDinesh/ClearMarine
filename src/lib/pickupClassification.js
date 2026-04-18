/**
 * Pickup routing (land vs ship) from the same inputs as the rest of ClearMarine:
 * - Origin lat/lon + `computePacificLandfallDisplay` / shoreline heuristic (landfall.js)
 * - Drift 24/48/72h from `predictDrift` — CORC index → HYCOM → fallback (drift.js + gliderCurrents.js)
 *
 * Outside the NE Pacific shoreline model we cannot classify; callers should show "verify locally".
 */

import {
  computePacificLandfallDisplay,
  isNortheastPacificShorelineModel,
  isOnLandInPacificModel,
} from './landfall';

/** @typedef {{ key: string, shortLabel: string, detail: string }} PickupClassification */

export const PICKUP_MODE = {
  LAND: 'land',
  SHIP: 'ship',
  SHIP_AND_COAST: 'ship_coast',
  UNKNOWN: 'unknown',
};

/** Short labels for DB-backed `pickup_mode` column */
export const PICKUP_MODE_LABELS = {
  [PICKUP_MODE.LAND]: 'Land pickup',
  [PICKUP_MODE.SHIP]: 'Ship pickup',
  [PICKUP_MODE.SHIP_AND_COAST]: 'Ship + coast',
  [PICKUP_MODE.UNKNOWN]: 'Verify',
};

export function labelForPickupKey(key) {
  return PICKUP_MODE_LABELS[key] || PICKUP_MODE_LABELS[PICKUP_MODE.UNKNOWN];
}

/** Tailwind-friendly classes for badges */
export function pickupBadgeClassName(key) {
  switch (key) {
    case PICKUP_MODE.LAND:
      return 'bg-amber-900/80 text-amber-100 border border-amber-600/80';
    case PICKUP_MODE.SHIP:
      return 'bg-cyan-950 text-cyan-200 border border-cyan-600/80';
    case PICKUP_MODE.SHIP_AND_COAST:
      return 'bg-violet-950 text-violet-200 border border-violet-600/80';
    default:
      return 'bg-slate-700 text-slate-300 border border-slate-600';
  }
}

/**
 * @param {number} originLat
 * @param {number} originLon
 * @param {null|{ lat_24h: number, lon_24h: number, lat_48h: number, lon_48h: number, lat_72h: number, lon_72h: number }} drift — same shape as drift_predictions / predictDrift output
 * @returns {PickupClassification}
 */
export function classifyPickupMode(originLat, originLon, drift) {
  if (!Number.isFinite(originLat) || !Number.isFinite(originLon)) {
    return {
      key: PICKUP_MODE.UNKNOWN,
      shortLabel: 'Unknown',
      detail: 'Invalid coordinates — cannot classify pickup.',
    };
  }

  if (isOnLandInPacificModel(originLat, originLon)) {
    return {
      key: PICKUP_MODE.LAND,
      shortLabel: 'Land pickup',
      detail:
        'Position is inland or onshore in the Pacific coastal model — prioritize beach, shore, or land-based cleanup.',
    };
  }

  if (!isNortheastPacificShorelineModel(originLat, originLon)) {
    return {
      key: PICKUP_MODE.UNKNOWN,
      shortLabel: 'Verify locally',
      detail:
        'Outside the NE Pacific drift and shoreline model — use local charts; vessel vs land routing is not auto-classified here.',
    };
  }

  if (
    !drift
    || !Number.isFinite(drift.lat_24h)
    || !Number.isFinite(drift.lon_24h)
  ) {
    return {
      key: PICKUP_MODE.UNKNOWN,
      shortLabel: 'Unknown',
      detail: 'No drift forecast — cannot classify.',
    };
  }

  const lf = computePacificLandfallDisplay(originLat, originLon, drift);

  if (lf.showLandfallFlag) {
    return {
      key: PICKUP_MODE.SHIP_AND_COAST,
      shortLabel: 'Ship + coast',
      detail:
        'Offshore in the model, but the 24–72h track reaches land — send a vessel if intercept is feasible; coordinate coastal/beach teams for landfall.',
    };
  }

  return {
    key: PICKUP_MODE.SHIP,
    shortLabel: 'Ship pickup',
    detail:
      'Track stays seaward within 72h in this model — prioritize vessel recovery offshore.',
  };
}
