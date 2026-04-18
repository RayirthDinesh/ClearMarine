/**
 * Display and parse lat/lon with correct N/S and E/W hemispheres.
 */

/** Longitude in degrees → [-180, 180). */
export function normalizeLongitude(lon) {
  if (!Number.isFinite(lon)) return NaN;
  return ((lon + 180) % 360 + 360) % 360 - 180;
}

/**
 * Valid finite lat/lon with longitude normalized (handles 0–360° and +E input).
 * @returns {{ lat: number, lon: number } | null}
 */
export function normalizeLatLon(lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat < -90 || lat > 90) return null;
  const lo = normalizeLongitude(lon);
  if (!Number.isFinite(lo)) return null;
  return { lat, lon: lo };
}

/**
 * True if two normalized { lat, lon } points are within ~epsDeg degrees (~55 m at mid-lat for 0.0005).
 */
export function coordsNearlyEqual(a, b, epsDeg = 0.0005) {
  if (!a || !b) return false;
  if (!Number.isFinite(a.lat) || !Number.isFinite(a.lon) || !Number.isFinite(b.lat) || !Number.isFinite(b.lon)) {
    return false;
  }
  return Math.abs(a.lat - b.lat) < epsDeg && Math.abs(a.lon - b.lon) < epsDeg;
}

export function formatCoordPair(lat, lng) {
  if (lat == null || lng == null || !Number.isFinite(lat) || !Number.isFinite(lng)) return '—';
  const ns = lat >= 0 ? `${lat.toFixed(4)}°N` : `${Math.abs(lat).toFixed(4)}°S`;
  const ew = lng >= 0 ? `${lng.toFixed(4)}°E` : `${Math.abs(lng).toFixed(4)}°W`;
  return `${ns}, ${ew}`;
}

/**
 * Manual longitude in **west** convention only: unsigned values are degrees west
 * (stored as negative decimal degrees). A leading `-` is passed through as signed.
 * Leading `+` is treated as a west magnitude (same as unsigned).
 * @param {string} str - user input
 */
export function parseManualLongitudeWest(str) {
  const t = (str || '').trim();
  const v = parseFloat(t);
  if (!Number.isFinite(v)) return NaN;
  if (t.startsWith('-')) return v;
  return -Math.abs(v);
}
