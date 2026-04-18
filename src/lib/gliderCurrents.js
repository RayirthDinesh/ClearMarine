/**
 * Nearest Spray/CORC glider depth-mean current from prebuilt public index (see scripts/build_corc_glider_json.py).
 */

let indexCache = null;
let indexLoadFailed = false;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Great-circle distance (km); shared with drift / interception logic. */
export function haversineKm(lat1, lon1, lat2, lon2) {
  if (
    !Number.isFinite(lat1) || !Number.isFinite(lon1)
    || !Number.isFinite(lat2) || !Number.isFinite(lon2)
  ) {
    return Infinity;
  }
  const R = 6371;
  const toR = (d) => (d * Math.PI) / 180;
  const dLat = toR(lat2 - lat1);
  const dLon = toR(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toR(lat1)) * Math.cos(toR(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function isValidProfile(p) {
  if (!p || typeof p !== 'object') return false;
  if (!Number.isFinite(p.lat) || !Number.isFinite(p.lon)) return false;
  if (!Number.isFinite(p.speed_knots) || !Number.isFinite(p.bearing_deg)) return false;
  if (p.speed_knots < 0 || p.speed_knots > 1e6) return false;
  return true;
}

async function loadIndexOnce() {
  const base = process.env.PUBLIC_URL || '';
  const res = await fetch(`${base}/data/corc_glider_index.json`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function loadIndex() {
  if (indexCache) return indexCache;
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (attempt > 0) await sleep(100 * attempt);
    try {
      indexCache = await loadIndexOnce();
      indexLoadFailed = false;
      return indexCache;
    } catch (e) {
      lastErr = e;
    }
  }
  console.warn('Glider index not loaded:', lastErr?.message);
  indexLoadFailed = true;
  return null;
}

/** Clear cached index and failure flag (e.g. dev reload or tests). */
export function resetGliderIndexCache() {
  indexCache = null;
  indexLoadFailed = false;
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && indexLoadFailed) {
      indexCache = null;
      indexLoadFailed = false;
    }
  });
}

/** CORC has dense Spray coverage off San Diego / SoCal — allow a wider search than open-ocean defaults. */
function maxKmForLocation(lat, lon) {
  if (lat >= 31.8 && lat <= 33.6 && lon >= -119.0 && lon <= -116.5) {
    return 200;
  }
  return 120;
}

/**
 * If a CORC profile exists within max_km of (lat,lon), return current vector for drift.
 * @returns {Promise<{ speed: number, bearing: number, source: string, distance_km?: number } | null>}
 */
export async function getNearestGliderCurrent(lat, lon) {
  const data = await loadIndex();
  if (!data?.profiles?.length) return null;
  const fromJson = typeof data.max_km_glider_priority === 'number' ? data.max_km_glider_priority : 120;
  const maxKm = Math.max(fromJson, maxKmForLocation(lat, lon));

  const { profiles } = data;

  let best = null;
  let bestD = Infinity;
  for (let i = 0; i < profiles.length; i += 1) {
    const p = profiles[i];
    if (!isValidProfile(p)) continue;
    const d = haversineKm(lat, lon, p.lat, p.lon);
    if (d < bestD) {
      bestD = d;
      best = p;
    }
  }

  if (!best || bestD > maxKm || !Number.isFinite(bestD)) return null;

  return {
    speed: best.speed_knots,
    bearing: best.bearing_deg,
    source: `Spray glider CORC (nearest ~${bestD.toFixed(0)} km; depth-mean u,v)`,
    distance_km: bestD,
  };
}
