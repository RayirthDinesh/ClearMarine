/**
 * Pacific shoreline proxy for California / Baja: piecewise coast longitude by latitude
 * (outer ocean boundary). Paths clip when they cross east of that line, except inside
 * rough SF / Monterey bay water boxes so bay routing isn’t instantly “land”.
 *
 * IMPORTANT: This model only applies to the eastern Pacific (Americas side). If we ran
 * it for Asia (e.g. China ~120°E), every point would look “east of the CA coast” and we’d
 * snap a fake “landfall” to ~−121° at the same latitude — a line to California and a
 * swapped flag. So we gate clipping on `isNortheastPacificShorelineModel`.
 *
 * Anywhere outside that model we fall back to the coarse global land mask so drift
 * forecasts in the Atlantic, Gulf, Indian Ocean, etc. still get clipped at the coast
 * instead of drawing across continents.
 */

import { isOnGlobalLand, firstLandContactFraction } from './globalLandMask';

/**
 * Realistic 24h surface-current displacement cap (km). The Gulf Stream peaks at ~4 kn,
 * which is ~7.4 km/h ≈ 178 km/24h. Anything larger than this in a stored drift_predictions
 * row is almost certainly bad/stale grid data. We rescale the offending leg back along its
 * original bearing so the path direction is preserved but the magnitude is sane.
 */
const MAX_KMH_FOR_DRIFT = 4 * 1.852; // ≈ 7.41 km/h

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const toR = (d) => (d * Math.PI) / 180;
  const dLat = toR(lat2 - lat1);
  const dLon = toR(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toR(lat1)) * Math.cos(toR(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Clamp a forecast leg so it doesn't exceed MAX_KMH_FOR_DRIFT × elapsedHours from the
 * origin. Returns the clamped [lat, lon] (interpolated along the original direction).
 */
function capLegFromOrigin(originLat, originLon, lat, lon, elapsedHours) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return [lat, lon];
  const km = haversineKm(originLat, originLon, lat, lon);
  const maxKm = MAX_KMH_FOR_DRIFT * Math.max(1, elapsedHours);
  if (km <= maxKm) return [lat, lon];
  const t = maxKm / km;
  return [originLat + t * (lat - originLat), originLon + t * (lon - originLon)];
}

/**
 * CA/Baja/OR/WA heuristic coast — only valid for the actual NE Pacific window the
 * COAST_KNOTS arrays describe (roughly Baja → Vancouver Island, west of mainland Mexico).
 *
 * Why the box is tight: the COAST_KNOTS only model the US/Mexico Pacific shoreline. If we
 * accept any "western hemisphere" longitude here, a Gulf-of-Mexico or East-Coast sighting
 * gets fed into the Pacific shoreline knots and the bisection projects a fake "landfall"
 * onto the Baja coast at the same latitude (e.g. a Houston debris report flagged at
 * ~-114° lon). For everything outside this box we fall through to the global polygon
 * mask in `clipDriftPathAgainstGlobalLand`, which knows every continent.
 */
export function isNortheastPacificShorelineModel(lat, lon) {
  if (lat == null || lon == null || !Number.isFinite(lat) || !Number.isFinite(lon)) return false;
  // Latitude band of the Baja + CA + OR + WA knots.
  if (lat < 22 || lat > 50) return false;
  // Longitude band: from offshore California (~ -132°) to just west of the Sierra/Mexican
  // mainland (~ -108°). Anything east of -108 (Gulf, Caribbean, Mississippi basin, FL,
  // East Coast) is not in this model — the global mask handles it.
  return lon >= -132 && lon <= -108;
}

/**
 * Baja / northern mainland Pacific: piecewise coast longitude (replaces a single straight
 * segment in lat–lon from ~22°N to 32°N, which mis-modeled the bend near San Diego).
 */
const COAST_KNOTS_BAJA = [
  [22.0, -110.35],
  [24.0, -111.75],
  [26.0, -113.15],
  [28.0, -114.45],
  [30.0, -115.85],
  [31.5, -116.65],
  [32.0, -117.25],
];

/** [lat°N, coastLon°E] — open Pacific edge (more negative = farther west). */
const COAST_KNOTS = [
  [32.0, -117.25],
  [32.5, -117.5],
  [33.0, -117.9],
  [33.5, -118.45],
  [34.0, -119.2],
  [34.4, -119.55],
  [35.0, -120.95],
  [36.0, -121.8],
  [36.8, -122.35],
  [37.5, -122.75],
  [38.2, -123.15],
  [39.0, -123.85],
  [40.0, -124.2],
  [41.0, -124.5],
  [42.0, -124.7],
  [44.0, -124.85],
  [48.0, -125.0],
];

function interpolateCoastLon(knots, lat) {
  if (lat < knots[0][0] || lat > knots[knots.length - 1][0]) return null;
  for (let i = 0; i < knots.length - 1; i += 1) {
    const [la, lo] = knots[i];
    const [lb, lom] = knots[i + 1];
    if (lat >= la && lat <= lb) {
      const t = (lat - la) / (lb - la);
      return lo + t * (lom - lo);
    }
  }
  return knots[knots.length - 1][1];
}

function outerPacificCoastLon(lat) {
  if (lat >= 22 && lat < 32) {
    return interpolateCoastLon(COAST_KNOTS_BAJA, lat);
  }
  if (lat < COAST_KNOTS[0][0] || lat > COAST_KNOTS[COAST_KNOTS.length - 1][0]) {
    return null;
  }
  for (let i = 0; i < COAST_KNOTS.length - 1; i += 1) {
    const [la, lo] = COAST_KNOTS[i];
    const [lb, lom] = COAST_KNOTS[i + 1];
    if (lat >= la && lat <= lb) {
      const t = (lat - la) / (lb - la);
      return lo + t * (lom - lo);
    }
  }
  return COAST_KNOTS[COAST_KNOTS.length - 1][1];
}

/** Central Valley / Sierra foothills — clearly inland; catches Tracy, Modesto, etc. */
function isCentralCaliforniaInland(lat, lon) {
  if (lat < 35.0 || lat > 41.2) return false;
  if (lon > -117.5) return true;
  return lat >= 35.8 && lat <= 40.8 && lon > -120.15 && lon < -118.0;
}

function isRoughlySFBayWater(lat, lon) {
  return lat >= 37.42 && lat <= 38.18 && lon >= -122.58 && lon <= -122.02;
}

function isRoughlyMontereyBayWater(lat, lon) {
  return lat >= 36.45 && lat <= 36.95 && lon >= -122.12 && lon <= -121.68;
}

/** San Diego / northern Baja nearshore: open water east of the simplified outer-coast lon (bay + inner shelf). */
function isRoughlySanDiegoBightWater(lat, lon) {
  return lat >= 32.35 && lat <= 33.05 && lon >= -118.1 && lon <= -117.0;
}

/**
 * True if we treat the point as open water for drawing drift (west of shoreline,
 * or inside coarse bay boxes — not Central Valley inland).
 */
export function isSeawardOfCoast(lat, lon) {
  if (isCentralCaliforniaInland(lat, lon)) return false;
  if (isRoughlySFBayWater(lat, lon)) return true;
  if (isRoughlyMontereyBayWater(lat, lon)) return true;
  if (isRoughlySanDiegoBightWater(lat, lon)) return true;

  const cl = outerPacificCoastLon(lat);
  if (cl == null) return true;
  return lon < cl - 0.03;
}

/**
 * On-land detection is DISABLED for now — the simple shoreline heuristic produced too many
 * false positives (false "this is on land" calls in nearshore water and bay areas). We keep
 * the coast geometry around for drift-path clipping and the drift→shore landfall flag
 * (`computePacificLandfallDisplay`), but no caller treats a raw point as inland here.
 *
 * Re-enable by restoring the body to:
 *   if (!isNortheastPacificShorelineModel(lat, lon)) return false;
 *   return !isSeawardOfCoast(lat, lon);
 */
// eslint-disable-next-line no-unused-vars
export function isOnLandInPacificModel(_lat, _lon) {
  return false;
}

/**
 * Map / ops queue: shows everything with valid coordinates. The on-land filter is disabled
 * (see `isOnLandInPacificModel`) so that a sighting at the user's reported position is never
 * dropped from the dashboard for being "inland" by the heuristic.
 */
export function shouldShowSightingOnDashboard(lat, lon) {
  if (lat == null || lon == null || !Number.isFinite(Number(lat)) || !Number.isFinite(Number(lon))) {
    return false;
  }
  return true;
}

/**
 * Move landfall marker onto the model shoreline at this latitude (cleaner map than raw bisection point).
 */
function snapLandfallToShoreline([lat, lon]) {
  const cl = outerPacificCoastLon(lat);
  if (cl == null) return [lat, lon];
  return [lat, cl];
}

/** First point along segment A→B (A,B = [lat,lon]) that is no longer seaward. */
function firstShoreContactOnSegment(a, b) {
  const [aLat, aLon] = a;
  const [bLat, bLon] = b;

  const aOk = isSeawardOfCoast(aLat, aLon);
  const bOk = isSeawardOfCoast(bLat, bLon);

  if (!aOk) {
    return a;
  }

  if (bOk) {
    let lo = 0;
    let hi = 1;
    let anyInshore = false;
    for (let i = 0; i < 20; i += 1) {
      const mid = (lo + hi) / 2;
      const lat = aLat + mid * (bLat - aLat);
      const lon = aLon + mid * (bLon - aLon);
      if (!isSeawardOfCoast(lat, lon)) {
        hi = mid;
        anyInshore = true;
      } else {
        lo = mid;
      }
    }
    if (anyInshore && hi < 0.999) {
      const t = hi;
      return [aLat + t * (bLat - aLat), aLon + t * (bLon - aLon)];
    }
    return null;
  }

  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 20; i += 1) {
    const mid = (lo + hi) / 2;
    const lat = aLat + mid * (bLat - aLat);
    const lon = aLon + mid * (bLon - aLon);
    if (!isSeawardOfCoast(lat, lon)) hi = mid;
    else lo = mid;
  }
  const t = hi;
  return [aLat + t * (bLat - aLat), aLon + t * (bLon - aLon)];
}

/**
 * Walk origin → 24h → 48h → 72h; stop at first land / inland contact.
 */
export function clipDriftPathToShore(pts) {
  if (!pts || pts.length < 2) {
    return { pathPoints: pts || [], landfallPoint: null, hitShore: false };
  }

  const out = [pts[0]];
  for (let i = 0; i < pts.length - 1; i += 1) {
    const a = out[out.length - 1];
    const b = pts[i + 1];
    const contact = firstShoreContactOnSegment(a, b);

    if (contact) {
      const snapped = snapLandfallToShoreline(contact);
      const same =
        Math.abs(snapped[0] - a[0]) < 1e-6 && Math.abs(snapped[1] - a[1]) < 1e-6;
      if (!same) {
        out.push(snapped);
      }
      return {
        pathPoints: out,
        landfallPoint: snapped,
        hitShore: true,
      };
    }

    out.push(b);
  }

  return {
    pathPoints: out,
    landfallPoint: null,
    hitShore: false,
  };
}

export const COAST_ALERT_MESSAGE =
  'Coastal alert: track reaches land in this model — notify local coast/beach authority; coordinates flagged on map.';

/**
 * Walk a drift path and stop at the first leg that crosses into the coarse global land
 * mask. Used outside the precise NE Pacific shoreline model so that a forecast in (e.g.)
 * the Atlantic gets clipped at the first continental coast it reaches instead of drawing
 * across the country to the "other coast".
 */
export function clipDriftPathAgainstGlobalLand(pts) {
  if (!pts || pts.length < 2) {
    return { pathPoints: pts || [], landfallPoint: null, hitShore: false };
  }
  if (isOnGlobalLand(pts[0][0], pts[0][1])) {
    return { pathPoints: [pts[0]], landfallPoint: null, hitShore: false };
  }

  const out = [pts[0]];
  for (let i = 0; i < pts.length - 1; i += 1) {
    const a = out[out.length - 1];
    const b = pts[i + 1];
    const t = firstLandContactFraction(a[0], a[1], b[0], b[1]);
    if (t == null) {
      out.push(b);
      continue;
    }
    if (t <= 1e-4) {
      return { pathPoints: out, landfallPoint: a, hitShore: true };
    }
    const contactLat = a[0] + t * (b[0] - a[0]);
    const contactLon = a[1] + t * (b[1] - a[1]);
    out.push([contactLat, contactLon]);
    return { pathPoints: out, landfallPoint: [contactLat, contactLon], hitShore: true };
  }
  return { pathPoints: out, landfallPoint: null, hitShore: false };
}

/**
 * @returns {{
 *   showLandfallFlag: boolean,
 *   landfallPoint: [number, number] | null,
 *   pathPoints: [number, number][],
 *   landfallLabel: string | null,
 *   coastAlert: string | null,
 * }}
 */
export function computePacificLandfallDisplay(originLat, originLon, drift) {
  if (!drift) {
    return {
      showLandfallFlag: false,
      landfallPoint: null,
      pathPoints: [],
      landfallLabel: null,
      coastAlert: null,
    };
  }

  // Build the raw 4-point path, then defensively cap each forecast leg to a realistic
  // 24h-equivalent displacement from the origin. This protects the renderer from old
  // drift_predictions rows that were written before the speed cap landed in predictDrift.
  const cappedLegs = [
    capLegFromOrigin(originLat, originLon, drift.lat_24h, drift.lon_24h, 24),
    capLegFromOrigin(originLat, originLon, drift.lat_48h, drift.lon_48h, 48),
    capLegFromOrigin(originLat, originLon, drift.lat_72h, drift.lon_72h, 72),
  ];

  const pts = [[originLat, originLon], ...cappedLegs].filter(
    ([la, lo]) => Number.isFinite(la) && Number.isFinite(lo),
  );

  if (!isNortheastPacificShorelineModel(originLat, originLon)) {
    // Outside the precise NE Pacific shoreline model: fall back to the coarse global
    // land mask so the path still gets clipped at the first water→continent contact.
    const clipped = clipDriftPathAgainstGlobalLand(pts);
    return {
      showLandfallFlag: clipped.hitShore,
      landfallPoint: clipped.landfallPoint,
      pathPoints: clipped.pathPoints,
      landfallLabel: clipped.hitShore && clipped.landfallPoint
        ? `Coast contact ~${clipped.landfallPoint[0].toFixed(2)}°, ${clipped.landfallPoint[1].toFixed(2)}°`
        : null,
      coastAlert: clipped.hitShore ? COAST_ALERT_MESSAGE : null,
    };
  }

  const { pathPoints, landfallPoint, hitShore } = clipDriftPathToShore(pts);

  return {
    showLandfallFlag: hitShore,
    landfallPoint,
    pathPoints,
    landfallLabel: hitShore && landfallPoint
      ? `Land contact ~${landfallPoint[0].toFixed(3)}°, ${landfallPoint[1].toFixed(3)}°`
      : null,
    coastAlert: hitShore ? COAST_ALERT_MESSAGE : null,
  };
}
