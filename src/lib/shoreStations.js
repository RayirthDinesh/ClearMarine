/**
 * Synthetic shore patrol stations.
 *
 * Premise: the user wants the system to "assume there are multiple shore crews near the
 * shores". Rather than seeding hundreds of land_crews rows, we synthesize ONE virtual
 * shore station per shore-pickup sighting, anchored at the predicted landfall point (the
 * exact spot the debris will hit shore) or — when no landfall is known — the nearest
 * point on the coastline. The station is treated as a regular land_crew for ranking,
 * dispatch, and map display. It always has a stable, deterministic ID derived from its
 * coordinates so re-renders pin to the same spot.
 *
 * Real DB land_crews still participate in ranking; if one of them happens to be closer
 * than the synthetic station for a given sighting, it wins on ETA and is dispatched.
 */

import { computePacificLandfallDisplay } from './landfall';
import { nearestPolygonShorePoint } from './globalLandMask';

const SYNTHETIC_PREFIX = 'synthetic-shore:';

/**
 * Approximate NE Pacific coast (subset of the precise knots used elsewhere). We sample
 * along these to find the nearest US/Mexico Pacific shore point when the global polygon
 * mask resolution would be too coarse.
 */
const NE_PACIFIC_COAST_KNOTS = [
  [22.0, -110.35], [24.0, -111.75], [26.0, -113.15], [28.0, -114.45], [30.0, -115.85],
  [31.5, -116.65], [32.0, -117.25], [32.5, -117.5], [33.0, -117.9], [33.5, -118.45],
  [34.0, -119.2], [34.4, -119.55], [35.0, -120.95], [36.0, -121.8], [36.8, -122.35],
  [37.5, -122.75], [38.2, -123.15], [39.0, -123.85], [40.0, -124.2], [41.0, -124.5],
  [42.0, -124.7], [44.0, -124.85], [48.0, -125.0],
];

function flatDistanceSq(lat1, lon1, lat2, lon2) {
  const dLat = lat1 - lat2;
  const dLon = lon1 - lon2;
  return dLat * dLat + dLon * dLon;
}

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
 * Find the nearest shoreline point to (lat, lon). Tries the NE Pacific knots first
 * (precise, sub-degree), falls back to the global polygon mask. Returns [lat, lon] or
 * null if both inputs are non-finite.
 */
export function nearestShorePoint(lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

  let bestPt = null;
  let bestSq = Infinity;
  for (let i = 0; i < NE_PACIFIC_COAST_KNOTS.length - 1; i += 1) {
    const [aLat, aLon] = NE_PACIFIC_COAST_KNOTS[i];
    const [bLat, bLon] = NE_PACIFIC_COAST_KNOTS[i + 1];
    const dx = bLat - aLat;
    const dy = bLon - aLon;
    const lenSq = dx * dx + dy * dy;
    let t = lenSq === 0 ? 0 : ((lat - aLat) * dx + (lon - aLon) * dy) / lenSq;
    if (t < 0) t = 0;
    else if (t > 1) t = 1;
    const projLat = aLat + t * dx;
    const projLon = aLon + t * dy;
    const sq = flatDistanceSq(lat, lon, projLat, projLon);
    if (sq < bestSq) {
      bestSq = sq;
      bestPt = [projLat, projLon];
    }
  }

  // If the NE Pacific knots are closer than ~6° (≈ 670 km at the equator), use them.
  // Otherwise fall back to the global polygon mask which covers every continent.
  if (bestPt && bestSq < 36) return bestPt;
  return nearestPolygonShorePoint(lat, lon) || bestPt;
}

/**
 * Distance in km from (lat, lon) to the nearest modeled shore point.
 * Returns Infinity if no shore can be found (so callers can compare and gate without null checks).
 */
export function nearestShoreDistanceKm(lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return Infinity;
  const np = nearestShorePoint(lat, lon);
  if (!np) return Infinity;
  return haversineKm(lat, lon, np[0], np[1]);
}

/** Stable synthetic id derived from the station's coordinates so re-renders match. */
export function syntheticShoreId(lat, lon) {
  return `${SYNTHETIC_PREFIX}${lat.toFixed(3)}_${lon.toFixed(3)}`;
}

export function isSyntheticShoreId(id) {
  return typeof id === 'string' && id.startsWith(SYNTHETIC_PREFIX);
}

/**
 * Build a synthetic shore station for a given sighting. Anchors at:
 *  1. the predicted landfall point if drift→shore is detected,
 *  2. otherwise the nearest shore point to the sighting itself.
 *
 * Returns a land_crew-shaped object (so it slots into rankCrewsForSighting unchanged)
 * with a `synthetic: true` marker and a stable id. Returns null if no shore can be found
 * (e.g. mid-ocean far from any modeled coastline).
 */
export function synthesizeShoreStationForSighting(sighting, drift) {
  if (!sighting || !Number.isFinite(sighting.latitude) || !Number.isFinite(sighting.longitude)) {
    return null;
  }

  // Pick whichever shore anchor is geographically closer to the SIGHTING:
  //  a) the predicted drift landfall point, or
  //  b) the nearest modeled shore point to the sighting itself.
  // Real DB shore crews still compete with this synthetic via rankCrewsForSighting.
  let landfallPoint = null;
  if (drift) {
    const lf = computePacificLandfallDisplay(sighting.latitude, sighting.longitude, drift);
    if (lf?.landfallPoint && Number.isFinite(lf.landfallPoint[0]) && Number.isFinite(lf.landfallPoint[1])) {
      landfallPoint = lf.landfallPoint;
    }
  }
  const nearestPoint = nearestShorePoint(sighting.latitude, sighting.longitude);

  const candidates = [];
  if (landfallPoint) {
    candidates.push({
      pt: landfallPoint,
      label: 'Shore patrol (landfall)',
      distKm: haversineKm(sighting.latitude, sighting.longitude, landfallPoint[0], landfallPoint[1]),
    });
  }
  if (nearestPoint) {
    candidates.push({
      pt: nearestPoint,
      label: 'Shore patrol (nearest coast)',
      distKm: haversineKm(sighting.latitude, sighting.longitude, nearestPoint[0], nearestPoint[1]),
    });
  }
  if (candidates.length === 0) return null;

  candidates.sort((a, b) => a.distKm - b.distKm);
  const [stationLat, stationLon] = candidates[0].pt;
  const label = candidates[0].label;

  return {
    id: syntheticShoreId(stationLat, stationLon),
    name: `${label} ${stationLat.toFixed(2)}°, ${stationLon.toFixed(2)}°`,
    agency: 'ClearMarine Shore Network',
    status: 'available',
    base_lat: stationLat,
    base_lon: stationLon,
    capacity_kg: 150,
    transport_speed_kmh: 35,
    response_minutes: 10,
    synthetic: true,
  };
}
