import { supabase } from './supabase';
import { getNearestGliderCurrent, haversineKm } from './gliderCurrents';
import { normalizeLatLon } from './coords';

function displaceLatLon(lat, lon, km, bearing) {
  const R = 6371;
  const d = km / R;
  const rad = (bearing * Math.PI) / 180;
  const lat1 = (lat * Math.PI) / 180;
  const lon1 = (lon * Math.PI) / 180;
  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(rad));
  const lon2 = lon1 + Math.atan2(Math.sin(rad) * Math.sin(d) * Math.cos(lat1), Math.cos(d) - Math.sin(lat1) * Math.sin(lat2));
  return { lat: (lat2 * 180) / Math.PI, lon: (lon2 * 180) / Math.PI };
}

// Gyre-based fallback used only when HYCOM data isn't seeded yet
function gyroFallback(lat, lon) {
  if (lat > 0) {
    if (lon < -100 && lat < 45) return { speed: 1.8, bearing: 280, source: 'fallback' };
    return { speed: 1.5, bearing: 60, source: 'fallback' };
  }
  return { speed: 1.2, bearing: 200, source: 'fallback' };
}

/** Resolve surface current: prefer nearby Spray/CORC glider observation, else HYCOM grid, else gyre fallback. */
async function resolveCurrentForDrift(lat, lon) {
  const glider = await getNearestGliderCurrent(lat, lon);
  if (glider) {
    return {
      speed: glider.speed,
      bearing: glider.bearing,
      source: glider.source,
    };
  }

  const hycom = await fetchCurrentFromDB(lat, lon);
  if (hycom) {
    return {
      speed: hycom.speed,
      bearing: hycom.bearing,
      source: hycom.source,
    };
  }

  const fb = gyroFallback(lat, lon);
  return {
    speed: fb.speed,
    bearing: fb.bearing,
    source: `${fb.source} (model; seed DB or add CORC index)`,
  };
}

async function fetchCurrentFromDB(lat, lon) {
  const qLat = Math.max(-80, Math.min(80, lat));
  const qLon = lon;

  const { data, error } = await supabase
    .from('ocean_currents')
    .select('lat, lon, speed_knots, bearing, source, recorded_at')
    .gte('lat', qLat - 8)
    .lte('lat', qLat + 8)
    .gte('lon', qLon - 8)
    .lte('lon', qLon + 8)
    .limit(400);

  if (error || !data || data.length === 0) return null;

  let nearest = data[0];
  let nearestKm = haversineKm(lat, lon, data[0].lat, data[0].lon);
  for (let i = 1; i < data.length; i += 1) {
    const d = haversineKm(lat, lon, data[i].lat, data[i].lon);
    if (d < nearestKm) {
      nearestKm = d;
      nearest = data[i];
    }
  }

  if (!Number.isFinite(nearest.speed_knots) || !Number.isFinite(nearest.bearing)) {
    return null;
  }

  return {
    speed: nearest.speed_knots,
    bearing: nearest.bearing,
    source: `NOAA HYCOM (${nearest.recorded_at?.slice(0, 10)})`,
  };
}

export async function predictDrift(lat, lon) {
  const norm = normalizeLatLon(lat, lon);
  if (!norm) {
    throw new Error('Invalid coordinates — use latitude −90…90° and a finite longitude.');
  }
  const { lat: la, lon: lo } = norm;
  const current = await resolveCurrentForDrift(la, lo);
  if (current.source.includes('fallback')) {
    console.warn('Drift using gyre fallback — seed ocean_currents or ensure /data/corc_glider_index.json');
  }

  const speed = Number.isFinite(current.speed) ? Math.max(0, current.speed) : 0;
  const bearing = Number.isFinite(current.bearing) ? current.bearing : 0;

  const speedKmh = speed * 1.852;
  const wobble = (Math.random() - 0.5) * 4; // ±2° — lighter noise so tracks match currents more closely

  const predictions = [24, 48, 72].map((h) => {
    const km = speedKmh * h;
    const br = (bearing + wobble * (h / 24) + 360) % 360;
    return { hours: h, ...displaceLatLon(la, lo, km, br) };
  });

  return { speed, bearing, source: current.source, predictions };
}

export async function getInterceptionPoint(sightingLat, sightingLon, vesselLat, vesselLon) {
  const sighting = normalizeLatLon(sightingLat, sightingLon);
  const vessel = normalizeLatLon(vesselLat, vesselLon);
  if (!sighting || !vessel) return null;

  let drift;
  try {
    drift = await predictDrift(sighting.lat, sighting.lon);
  } catch {
    return null;
  }

  let best = null;
  let bestDist = Infinity;
  for (const pt of drift.predictions) {
    const d = haversineKm(pt.lat, pt.lon, vessel.lat, vessel.lon);
    if (d < bestDist) {
      bestDist = d;
      best = pt;
    }
  }
  return best;
}
