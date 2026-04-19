/**
 * Tiny waypoint table + routing helper so animated vessels don't slice across
 * continents on the demo map. We don't run a real pathfinder — just check the
 * direct great-circle and, if it hits land, try a handful of well-known
 * canal/strait crossings that are "close enough" for North America-centric ops.
 */

import { greatCircleLatLngs } from './mapPath';
import { firstLandContactFraction } from './globalLandMask';

// [lat, lon] — minimal canal/strait crossings for routing around land.
const PANAMA = [9.1, -79.7];          // Pacific <-> Caribbean shortcut.
const FLORIDA_KEYS = [24.6, -81.8];   // Gulf of Mexico <-> Atlantic.
const STRAIT_OF_MAGELLAN = [-54.0, -71.0]; // Cape Horn fallback.

const WAYPOINTS = [PANAMA, FLORIDA_KEYS, STRAIT_OF_MAGELLAN];

function isWaterOnly(a, b) {
  return firstLandContactFraction(a[0], a[1], b[0], b[1]) == null;
}

function concatPaths(a, b) {
  if (!a || a.length === 0) return b || [];
  if (!b || b.length === 0) return a;
  // Drop the duplicated waypoint vertex between the two legs.
  return a.concat(b.slice(1));
}

/**
 * Build a Leaflet-friendly polyline from `start` to `end` that stays in the water.
 *
 * Returns:
 *   - a [[lat, lon], ...] path if a water-only route exists (direct or single waypoint)
 *   - null if no water-only route is possible (caller should snap the vessel)
 *
 * `start` / `end` are `[lat, lon]` tuples.
 */
export function routeAroundLand(start, end) {
  if (!Array.isArray(start) || !Array.isArray(end)) return null;
  if (!Number.isFinite(start[0]) || !Number.isFinite(start[1])) return null;
  if (!Number.isFinite(end[0]) || !Number.isFinite(end[1])) return null;

  if (isWaterOnly(start, end)) {
    return greatCircleLatLngs(start, end);
  }

  for (const wp of WAYPOINTS) {
    if (isWaterOnly(start, wp) && isWaterOnly(wp, end)) {
      const leg1 = greatCircleLatLngs(start, wp);
      const leg2 = greatCircleLatLngs(wp, end);
      return concatPaths(leg1, leg2);
    }
  }

  return null;
}
