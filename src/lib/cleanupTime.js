/**
 * Pickup time + trip math for land vs ship cleanup dispatch.
 *
 * Inputs:
 * - Sighting: lat/lon + debris_type + density_score + estimated_volume (free-form string from Gemini)
 * - Drift forecast (optional, ship side): lat/lon at +24/+48/+72h
 * - Vessels: { current_lat, current_lon, vessel_speed_kn, capacity_kg, status }
 * - Land crews: { base_lat, base_lon, transport_speed_kmh, capacity_kg, response_minutes, status }
 *
 * Outputs:
 * - Per-crew estimate { totalMinutes, trips, kg, breakdown }
 * - Sorted ranking with shortest totalMinutes first.
 */

import { haversineKm } from './gliderCurrents';

const KM_PER_NM = 1.852;

/** Density-derived fallback kg per debris_type when the volume string can't be parsed. */
const DENSITY_KG_BASELINE = {
  plastic:      { 1: 5,   2: 15,  3: 40,  4: 90,  5: 180, 6: 320, 7: 520, 8: 800, 9: 1200, 10: 1800 },
  fishing_gear: { 1: 10,  2: 25,  3: 60,  4: 140, 5: 260, 6: 460, 7: 720, 8: 1100, 9: 1600, 10: 2400 },
  organic:      { 1: 4,   2: 12,  3: 30,  4: 70,  5: 150, 6: 280, 7: 460, 8: 700, 9: 1000, 10: 1500 },
  chemical:     { 1: 8,   2: 20,  3: 50,  4: 120, 5: 220, 6: 360, 7: 540, 8: 760, 9: 1050, 10: 1400 },
  mixed:        { 1: 6,   2: 16,  3: 40,  4: 95,  5: 190, 6: 330, 7: 530, 8: 800, 9: 1150, 10: 1700 },
  unknown:      { 1: 5,   2: 15,  3: 35,  4: 80,  5: 160, 6: 290, 7: 480, 8: 750, 9: 1100, 10: 1600 },
};

/** Approx kg per linear meter for "10 m patch"-style strings, by debris_type. */
const KG_PER_LINEAR_METER = {
  plastic: 4,
  fishing_gear: 8,
  organic: 3,
  chemical: 6,
  mixed: 5,
  unknown: 4,
};

function clampDensity(score) {
  if (!Number.isFinite(score)) return 5;
  return Math.max(1, Math.min(10, Math.round(score)));
}

function fallbackKg(debrisType, densityScore) {
  const table = DENSITY_KG_BASELINE[debrisType] || DENSITY_KG_BASELINE.unknown;
  return table[clampDensity(densityScore)];
}

/**
 * Parse the free-form estimated_volume string the AI emits ("~200 kg", "~10 m patch", "small pile", "unknown").
 * Falls back to a density × debris_type table when the string is unparseable.
 *
 * @param {string|null|undefined} volumeString
 * @param {number} densityScore — 1..10
 * @param {string} debrisType — plastic | fishing_gear | organic | chemical | mixed | unknown
 * @returns {{ kg: number, source: 'string' | 'patch' | 'fallback' }}
 */
export function parseEstimatedVolumeKg(volumeString, densityScore, debrisType) {
  const fb = () => ({ kg: fallbackKg(debrisType, densityScore), source: 'fallback' });
  if (!volumeString || typeof volumeString !== 'string') return fb();
  const s = volumeString.trim().toLowerCase();
  if (!s || s === 'unknown' || s === 'null' || s === 'n/a') return fb();

  // tonnes: "~2 t", "2 tonnes", "1.5 ton"
  const tonneMatch = s.match(/(?:~|about\s+)?(\d+(?:\.\d+)?)\s*(?:t|ton|tons|tonne|tonnes)\b/);
  if (tonneMatch) {
    const kg = parseFloat(tonneMatch[1]) * 1000;
    if (Number.isFinite(kg) && kg > 0) return { kg, source: 'string' };
  }

  // kilograms: "~200 kg", "150kg", "2 kilos"
  const kgMatch = s.match(/(?:~|about\s+)?(\d+(?:\.\d+)?)\s*(?:kg|kgs|kilo|kilos|kilogram|kilograms)\b/);
  if (kgMatch) {
    const kg = parseFloat(kgMatch[1]);
    if (Number.isFinite(kg) && kg > 0) return { kg, source: 'string' };
  }

  // patches/lines: "~10 m patch", "20 meter slick", "5m line"
  const patchMatch = s.match(/(?:~|about\s+)?(\d+(?:\.\d+)?)\s*m(?:eter|eters|etres)?\b/);
  if (patchMatch) {
    const meters = parseFloat(patchMatch[1]);
    const perM = KG_PER_LINEAR_METER[debrisType] || KG_PER_LINEAR_METER.unknown;
    if (Number.isFinite(meters) && meters > 0) return { kg: Math.round(meters * perM), source: 'patch' };
  }

  // item count: "5-20 items", "100+ items" — multiply by per-item proxy from density
  const itemsMatch = s.match(/(\d+)(?:\s*(?:-|to)\s*(\d+))?\+?\s*(?:item|items|piece|pieces|bottle|bottles|bag|bags)\b/);
  if (itemsMatch) {
    const lo = parseFloat(itemsMatch[1]);
    const hi = itemsMatch[2] ? parseFloat(itemsMatch[2]) : lo;
    const count = (lo + hi) / 2;
    // Per-item weight scales with debris type; small plastic ~0.2 kg, gear ~3 kg, chemical ~1 kg
    const perItem = debrisType === 'fishing_gear' ? 3
      : debrisType === 'chemical' ? 1
      : debrisType === 'organic' ? 0.5
      : 0.25;
    const kg = Math.max(1, Math.round(count * perItem));
    if (Number.isFinite(kg) && kg > 0) return { kg, source: 'string' };
  }

  return fb();
}

function safeNumber(n, fallback) {
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Land crew time estimate.
 * Trips = ceil(kg / capacity_kg). Each trip = transit out + on-site work + transit back.
 * On-site min per trip = max(15, kgPerTrip * 0.05) — rough 3 min per kg, with a 15 min floor for setup.
 *
 * @returns {{ totalMinutes: number, trips: number, kg: number, breakdown: { transitMinOneWay: number, onsiteMinPerTrip: number, responseMin: number, distanceKm: number } }}
 */
export function estimateLandPickupMinutes({ crew, siteLat, siteLon, kg }) {
  const capacity = safeNumber(crew?.capacity_kg, 100);
  const speedKmh = safeNumber(crew?.transport_speed_kmh, 40);
  const responseMin = Number.isFinite(crew?.response_minutes) ? crew.response_minutes : 15;
  const distanceKm = haversineKm(crew?.base_lat, crew?.base_lon, siteLat, siteLon);
  const transitMinOneWay = (distanceKm / speedKmh) * 60;
  const trips = Math.max(1, Math.ceil(kg / capacity));
  const kgPerTrip = kg / trips;
  const onsiteMinPerTrip = Math.max(15, kgPerTrip * 0.05);
  const totalMinutes = Math.round(responseMin + trips * (2 * transitMinOneWay + onsiteMinPerTrip));
  return {
    totalMinutes,
    trips,
    kg,
    breakdown: {
      transitMinOneWay: Math.round(transitMinOneWay),
      onsiteMinPerTrip: Math.round(onsiteMinPerTrip),
      responseMin,
      distanceKm: Math.round(distanceKm * 10) / 10,
    },
  };
}

/**
 * Pick the closest 24/48/72h drift waypoint to the vessel as the synchronous interception proxy.
 * Mirrors getInterceptionPoint but works off a drift_predictions row (no async fetch).
 */
function syncInterceptPoint({ vesselLat, vesselLon, sightingLat, sightingLon, drift }) {
  if (!drift) return { lat: sightingLat, lon: sightingLon, hours: 0 };
  const candidates = [
    { lat: drift.lat_24h, lon: drift.lon_24h, hours: 24 },
    { lat: drift.lat_48h, lon: drift.lon_48h, hours: 48 },
    { lat: drift.lat_72h, lon: drift.lon_72h, hours: 72 },
  ].filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon));
  if (candidates.length === 0) return { lat: sightingLat, lon: sightingLon, hours: 0 };
  let best = candidates[0];
  let bestKm = haversineKm(vesselLat, vesselLon, best.lat, best.lon);
  for (let i = 1; i < candidates.length; i += 1) {
    const k = haversineKm(vesselLat, vesselLon, candidates[i].lat, candidates[i].lon);
    if (k < bestKm) { bestKm = k; best = candidates[i]; }
  }
  return best;
}

/**
 * Ship vessel time estimate.
 * Transit (vessel→intercept) + per-trip on-site work; trips beyond 1 add 2× transit-to-base proxy
 * (using vessel current pos as base, since we don't model ports here).
 * On-site min per trip = max(45, kgPerTrip * 0.08) — slower at sea than on shore.
 */
export function estimateShipPickupMinutes({ vessel, sightingLat, sightingLon, drift, kg }) {
  const capacity = safeNumber(vessel?.capacity_kg, 1500);
  const speedKn = safeNumber(vessel?.vessel_speed_kn, 12);
  const intercept = syncInterceptPoint({
    vesselLat: vessel?.current_lat,
    vesselLon: vessel?.current_lon,
    sightingLat,
    sightingLon,
    drift,
  });
  const distanceKm = haversineKm(vessel?.current_lat, vessel?.current_lon, intercept.lat, intercept.lon);
  const distanceNm = distanceKm / KM_PER_NM;
  const transitMinOneWay = (distanceNm / speedKn) * 60;
  const trips = Math.max(1, Math.ceil(kg / capacity));
  const kgPerTrip = kg / trips;
  const onsiteMinPerTrip = Math.max(45, kgPerTrip * 0.08);
  // First trip = transit out + onsite. Each extra trip = 2 * transit + onsite.
  const totalMinutes = Math.round(
    transitMinOneWay + onsiteMinPerTrip + Math.max(0, trips - 1) * (2 * transitMinOneWay + onsiteMinPerTrip)
  );
  return {
    totalMinutes,
    trips,
    kg,
    breakdown: {
      transitMinOneWay: Math.round(transitMinOneWay),
      onsiteMinPerTrip: Math.round(onsiteMinPerTrip),
      distanceKm: Math.round(distanceKm * 10) / 10,
      distanceNm: Math.round(distanceNm * 10) / 10,
      interceptHours: intercept.hours,
    },
  };
}

/**
 * Rank land + ship crews by total cleanup time for a sighting.
 *
 * @param {object} args
 * @param {string} args.pickupKey — 'land' | 'ship' | 'ship_coast' | 'unknown' from classifyPickupMode
 * @param {object} args.sighting — { latitude, longitude, debris_type, density_score, estimated_volume }
 * @param {Array} args.vessels — vessel rows
 * @param {Array} args.landCrews — land_crews rows
 * @param {object|null} args.drift — drift_predictions row (or null)
 * @returns {{ ranked: Array, kg: number, kgSource: string }}
 */
export function rankCrewsForSighting({ pickupKey, sighting, vessels = [], landCrews = [], drift = null }) {
  const debrisType = sighting?.debris_type || 'unknown';
  const densityScore = sighting?.density_score;
  const volume = parseEstimatedVolumeKg(sighting?.estimated_volume, densityScore, debrisType);
  const kg = volume.kg;

  // 'ship_coast' = drift forecast reaches land. By policy these are SHORE-crew jobs only;
  // ships are never dispatched to flagged sightings even as a fallback.
  const includeLand = pickupKey === 'land' || pickupKey === 'ship_coast' || pickupKey === 'unknown';
  const includeShip = pickupKey === 'ship' || pickupKey === 'unknown';

  const shipCandidates = [];
  const landCandidates = [];

  if (includeShip) {
    for (const v of vessels) {
      if (v.status !== 'available') continue;
      if (!Number.isFinite(v.current_lat) || !Number.isFinite(v.current_lon)) continue;
      const est = estimateShipPickupMinutes({
        vessel: v,
        sightingLat: sighting?.latitude,
        sightingLon: sighting?.longitude,
        drift,
        kg,
      });
      shipCandidates.push({
        crewType: 'ship',
        crew: v,
        crewId: v.id,
        crewName: v.name,
        ...est,
      });
    }
  }

  if (includeLand) {
    for (const c of landCrews) {
      if (c.status !== 'available') continue;
      if (!Number.isFinite(c.base_lat) || !Number.isFinite(c.base_lon)) continue;
      const est = estimateLandPickupMinutes({
        crew: c,
        siteLat: sighting?.latitude,
        siteLon: sighting?.longitude,
        kg,
      });
      landCandidates.push({
        crewType: 'land',
        crew: c,
        crewId: c.id,
        crewName: c.name,
        ...est,
      });
    }
  }

  shipCandidates.sort((a, b) => a.totalMinutes - b.totalMinutes);
  landCandidates.sort((a, b) => a.totalMinutes - b.totalMinutes);

  // pickupKey filters above already restrict the lists per mode.
  // For 'unknown' (outside the model) we sort the merged list by ETA.
  const candidates = [...landCandidates, ...shipCandidates].sort((a, b) => a.totalMinutes - b.totalMinutes);

  return { ranked: candidates, kg, kgSource: volume.source };
}

/** Format minutes as "1h 15m" / "45 min" / "23 sec" for compact UI display. */
export function formatEtaShort(minutes) {
  if (!Number.isFinite(minutes) || minutes < 0) return '—';
  if (minutes < 1) return '<1 min';
  if (minutes < 60) return `${Math.round(minutes)} min`;
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes - h * 60);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}
