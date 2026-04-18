/**
 * Pacific shoreline proxy for California / Baja: piecewise coast longitude by latitude
 * (outer ocean boundary). Paths clip when they cross east of that line, except inside
 * rough SF / Monterey bay water boxes so bay routing isn’t instantly “land”.
 *
 * IMPORTANT: This model only applies to the eastern Pacific (Americas side). If we ran
 * it for Asia (e.g. China ~120°E), every point would look “east of the CA coast” and we’d
 * snap a fake “landfall” to ~−121° at the same latitude — a line to California and a
 * swapped flag. So we gate clipping on `isNortheastPacificShorelineModel`.
 */

/**
 * CA/OR/WA heuristic coast — only valid where lon is west of ~65°W (eastern Pacific).
 * Reports in Asia, Europe, Indian Ocean, Australia: no clip, no fake US landfall flag.
 */
export function isNortheastPacificShorelineModel(lat, lon) {
  if (lat == null || lon == null || !Number.isFinite(lat) || !Number.isFinite(lon)) return false;
  if (lat < 8 || lat > 55) return false;
  return lon <= -65;
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
 * True if the point is inland / onshore in the NE Pacific shoreline heuristic (not open water).
 * Outside that model (e.g. Asia, Atlantic), returns false — we do not block those reports here.
 */
export function isOnLandInPacificModel(lat, lon) {
  if (!isNortheastPacificShorelineModel(lat, lon)) return false;
  return !isSeawardOfCoast(lat, lon);
}

/**
 * Map / ops queue: show only water positions in the NE Pacific coastal model.
 * On-land or invalid coordinates are omitted from the dashboard map and list.
 */
export function shouldShowSightingOnDashboard(lat, lon) {
  if (lat == null || lon == null || !Number.isFinite(Number(lat)) || !Number.isFinite(Number(lon))) {
    return false;
  }
  return !isOnLandInPacificModel(Number(lat), Number(lon));
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

  const pts = [
    [originLat, originLon],
    [drift.lat_24h, drift.lon_24h],
    [drift.lat_48h, drift.lon_48h],
    [drift.lat_72h, drift.lon_72h],
  ];

  if (!isNortheastPacificShorelineModel(originLat, originLon)) {
    return {
      showLandfallFlag: false,
      landfallPoint: null,
      pathPoints: pts,
      landfallLabel: null,
      coastAlert: null,
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
