/**
 * Lightweight geographic context — no large DB. Deterministic stub from lat/lon
 * for ecological sensitivity hints (MPA-style flags are illustrative).
 */

function clamp01(x) {
  return Math.max(0, Math.min(1, x));
}

/**
 * Illustrative “protected” hotspots (rough boxes). True MPA boundaries need authoritative data.
 */
const ILLUSTRATIVE_PROTECTED = [
  { name: 'central_california_coast', lat: [34, 38], lon: [-123, -119] },
  { name: 'hawaii_nearshore', lat: [18, 23], lon: [-162, -154] },
  { name: 'great_barrier_illustrative', lat: [-24, -15], lon: [142, 154] },
];

function inBox(lat, lon, latRange, lonRange) {
  return lat >= latRange[0] && lat <= latRange[1] && lon >= lonRange[0] && lon <= lonRange[1];
}

/**
 * @param {number} lat
 * @param {number} lon
 */
export function getGeoContext(lat, lon) {
  let region_type = 'open_ocean';
  if (Math.abs(lat) < 35 && Math.abs(lon) < 60) region_type = 'coastal';
  if (Math.abs(lat) > 50) region_type = 'high_latitude';

  let protected_area = false;
  let protected_hint = null;
  for (const z of ILLUSTRATIVE_PROTECTED) {
    if (inBox(lat, lon, z.lat, z.lon)) {
      protected_area = true;
      protected_hint = z.name;
      break;
    }
  }

  // Synthetic biodiversity score: higher near equator / known productive zones (stub)
  const latFactor = 1 - Math.min(1, Math.abs(lat) / 70);
  const lonHash = (Math.sin(lat * 0.1) * Math.cos(lon * 0.1) + 1) / 2;
  let biodiversity_score = clamp01(0.35 + 0.45 * latFactor * 0.7 + 0.3 * lonHash);
  if (protected_area) biodiversity_score = clamp01(biodiversity_score + 0.15);

  return {
    region_type,
    protected_area,
    protected_hint,
    biodiversity_score: Math.round(biodiversity_score * 100) / 100,
    source: 'stub_rules_v1',
  };
}
