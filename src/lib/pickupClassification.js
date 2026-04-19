/**
 * Pickup routing (land vs ship) from the same inputs as the rest of ClearMarine:
 * - Origin lat/lon + `computePacificLandfallDisplay` / shoreline heuristic (landfall.js)
 * - Drift 24/48/72h from `predictDrift` — CORC index → HYCOM → fallback (drift.js + gliderCurrents.js)
 *
 * Outside the NE Pacific shoreline model we cannot classify; callers should show "verify locally".
 */

import { computePacificLandfallDisplay } from './landfall';
import { nearestShoreDistanceKm } from './shoreStations';

/**
 * Maximum distance (km) the debris itself can be from the nearest shore for the
 * `ship_coast` (shore-crew) lane to apply. Beyond this a beach team can't reach the
 * water in time even if drift will eventually carry the debris ashore — fall back to
 * a ship recovery instead.
 */
export const MAX_SHORE_PICKUP_KM = 75;

/** @typedef {{ key: string, shortLabel: string, detail: string }} PickupClassification */

export const PICKUP_MODE = {
  LAND: 'land',
  SHIP: 'ship',
  SHIP_AND_COAST: 'ship_coast',
  UNKNOWN: 'unknown',
};

/** Short labels for DB-backed `pickup_mode` column */
export const PICKUP_MODE_LABELS = {
  [PICKUP_MODE.LAND]: 'Land crew',
  [PICKUP_MODE.SHIP]: 'Ship crew',
  // ship_coast = drift forecast reaches shore → handled by SHORE crew (auto-dispatched).
  [PICKUP_MODE.SHIP_AND_COAST]: 'Shore crew (drift→land)',
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
      // Drift will hit shore — treat as a land-team job (amber, like LAND) but with a stronger ring.
      return 'bg-amber-900/80 text-amber-100 border border-amber-500';
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

  // If debris is already on or very near shore, land crew takes priority regardless of drift.
  const distanceToShoreKm = nearestShoreDistanceKm(originLat, originLon);
  if (Number.isFinite(distanceToShoreKm) && distanceToShoreKm <= 15) {
    return {
      key: PICKUP_MODE.LAND,
      shortLabel: 'Land crew',
      detail: `Debris is ~${Math.round(distanceToShoreKm * 10) / 10} km from shore — assign the nearest land crew.`,
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
    // Beach crews can only handle debris that's actually nearshore. If the drift will
    // reach land but the debris itself is currently far offshore, recover by ship instead.
    if (Number.isFinite(distanceToShoreKm) && distanceToShoreKm > MAX_SHORE_PICKUP_KM) {
      return {
        key: PICKUP_MODE.SHIP,
        shortLabel: 'Ship pickup',
        detail:
          `Drift forecast reaches land in 24–72h, but the debris is ~${Math.round(distanceToShoreKm)} km offshore — too far for a beach crew. Recover by ship before it strands.`,
      };
    }
    return {
      key: PICKUP_MODE.SHIP_AND_COAST,
      shortLabel: 'Shore crew',
      detail:
        'Drift forecast reaches land within 24–72h and the debris is nearshore — assign the closest shore crew.',
    };
  }

  return {
    key: PICKUP_MODE.SHIP,
    shortLabel: 'Ship pickup',
    detail:
      'Track stays seaward within 72h in this model — prioritize vessel recovery offshore.',
  };
}
