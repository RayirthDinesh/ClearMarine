/**
 * MarineTraffic AIS REST — matches OpenAPI operation exportvessel
 * (see reference/marinetraffic-ais-openapi.json, path /exportvessel/{api_key}).
 *
 * The spec does not contain your API key; obtain a 40-character service key from
 * MarineTraffic My Account → API Services. Keys are passed in the URL path as {api_key}.
 */

const DEFAULT_BASE = 'https://services.marinetraffic.com/api';

function num(v) {
  if (v == null || v === '') return null;
  const n = parseFloat(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

function rowGet(row, ...keys) {
  if (!row || typeof row !== 'object') return undefined;
  for (const k of keys) {
    if (row[k] !== undefined && row[k] !== null && row[k] !== '') return row[k];
    const lower = k.toLowerCase();
    const found = Object.keys(row).find((rk) => rk.toLowerCase() === lower);
    if (found != null && row[found] !== undefined && row[found] !== null && row[found] !== '') return row[found];
  }
  return undefined;
}

/**
 * Single-vessel latest position (swagger: Vessel Positions Legacy — exportvessel).
 * Notes in spec: SPEED may be (knots × 10) — we convert to knots when values look scaled.
 */
async function fetchExportVessel(options) {
  const {
    apiKey,
    mmsi,
    imo,
    shipid,
    baseUrl = process.env.MARINETRAFFIC_API_BASE || DEFAULT_BASE,
    version = parseInt(process.env.MARINETRAFFIC_PS07_VERSION || '5', 10) || 5,
  } = options;

  if (!apiKey) throw new Error('Missing apiKey (MARINETRAFFIC_API_KEY)');

  const path = `/exportvessel/${encodeURIComponent(String(apiKey).trim())}`;
  const url = new URL(baseUrl.replace(/\/$/, '') + path);
  url.searchParams.set('v', String(version));
  url.searchParams.set('protocol', 'jsono');
  if (mmsi != null) url.searchParams.set('mmsi', String(mmsi));
  else if (imo != null) url.searchParams.set('imo', String(imo));
  else if (shipid != null) url.searchParams.set('shipid', String(shipid));
  else throw new Error('Provide mmsi, imo, or shipid');

  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`MarineTraffic non-JSON (${res.status}): ${text.slice(0, 250)}`);
  }

  if (json && json.errors) {
    throw new Error(`MarineTraffic: ${JSON.stringify(json.errors)}`);
  }

  const rows = Array.isArray(json) ? json : json && json.DATA ? json.DATA : null;
  const row = rows && rows[0] ? rows[0] : json && typeof json === 'object' ? json : null;
  if (!row) throw new Error(`MarineTraffic unexpected: ${text.slice(0, 300)}`);

  const lat = num(rowGet(row, 'LAT', 'lat'));
  const lon = num(rowGet(row, 'LON', 'lon', 'LNG', 'lng'));
  if (lat == null || lon == null) throw new Error('MarineTraffic: missing LAT/LON');

  /* OpenAPI description for exportvessel: "**SPEED** returned in (knots x10)" */
  let sog = num(rowGet(row, 'SPEED', 'speed'));
  if (sog != null) sog = sog / 10;

  const cog = num(rowGet(row, 'COURSE', 'course', 'COG', 'cog'));
  let aisTime = null;
  const tsRaw = rowGet(row, 'TIMESTAMP', 'timestamp');
  if (tsRaw) {
    const d = new Date(tsRaw);
    if (!Number.isNaN(d.getTime())) aisTime = d.toISOString();
  }

  return {
    lat,
    lon,
    sog,
    cog,
    mmsi: rowGet(row, 'MMSI', 'mmsi') != null ? String(rowGet(row, 'MMSI', 'mmsi')) : String(mmsi),
    imo: rowGet(row, 'IMO', 'imo') != null ? String(rowGet(row, 'IMO', 'imo')) : null,
    ais_timestamp: aisTime,
  };
}

module.exports = { fetchExportVessel, DEFAULT_BASE };
