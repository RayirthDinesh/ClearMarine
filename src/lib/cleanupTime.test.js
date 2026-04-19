import {
  parseEstimatedVolumeKg,
  estimateLandPickupMinutes,
  estimateShipPickupMinutes,
  rankCrewsForSighting,
  formatEtaShort,
} from './cleanupTime';

describe('parseEstimatedVolumeKg', () => {
  test('parses "~200 kg"', () => {
    expect(parseEstimatedVolumeKg('~200 kg', 6, 'plastic')).toEqual({ kg: 200, source: 'string' });
  });

  test('parses tonnes', () => {
    expect(parseEstimatedVolumeKg('~2 t', 7, 'fishing_gear')).toEqual({ kg: 2000, source: 'string' });
    expect(parseEstimatedVolumeKg('1.5 tonnes', 5, 'mixed')).toEqual({ kg: 1500, source: 'string' });
  });

  test('parses linear patches', () => {
    const result = parseEstimatedVolumeKg('~10 m patch', 5, 'plastic');
    expect(result.source).toBe('patch');
    expect(result.kg).toBe(40); // 10 m × 4 kg/m for plastic
  });

  test('parses item counts', () => {
    const result = parseEstimatedVolumeKg('5-20 items', 4, 'plastic');
    expect(result.source).toBe('string');
    expect(result.kg).toBeGreaterThan(0);
    expect(result.kg).toBeLessThan(20);
  });

  test('falls back when string is unknown', () => {
    expect(parseEstimatedVolumeKg('unknown', 8, 'plastic')).toEqual({ kg: 800, source: 'fallback' });
    expect(parseEstimatedVolumeKg(null, 5, 'plastic')).toEqual({ kg: 180, source: 'fallback' });
    expect(parseEstimatedVolumeKg('', 3, 'organic')).toEqual({ kg: 30, source: 'fallback' });
  });

  test('falls back on garbled string', () => {
    const result = parseEstimatedVolumeKg('lots and lots of trash', 7, 'plastic');
    expect(result.source).toBe('fallback');
    expect(result.kg).toBe(520);
  });
});

describe('estimateLandPickupMinutes', () => {
  const crew = {
    base_lat: 32.72, base_lon: -117.16,
    capacity_kg: 100, transport_speed_kmh: 50, response_minutes: 15,
  };

  test('quick local pickup is small minutes', () => {
    // ~5 km from base
    const est = estimateLandPickupMinutes({
      crew, siteLat: 32.76, siteLon: -117.18, kg: 80,
    });
    expect(est.trips).toBe(1);
    expect(est.totalMinutes).toBeGreaterThan(15);
    expect(est.totalMinutes).toBeLessThan(45);
  });

  test('multiple trips when over capacity', () => {
    const est = estimateLandPickupMinutes({
      crew, siteLat: 32.76, siteLon: -117.18, kg: 350,
    });
    expect(est.trips).toBe(4); // ceil(350/100)
    expect(est.kg).toBe(350);
  });

  test('distant site adds transit time', () => {
    const local = estimateLandPickupMinutes({ crew, siteLat: 32.73, siteLon: -117.17, kg: 50 });
    const far = estimateLandPickupMinutes({ crew, siteLat: 33.95, siteLon: -119.20, kg: 50 });
    expect(far.totalMinutes).toBeGreaterThan(local.totalMinutes);
  });
});

describe('estimateShipPickupMinutes', () => {
  const vessel = {
    current_lat: 34.05, current_lon: -120.42,
    capacity_kg: 1500, vessel_speed_kn: 12,
  };
  const drift = { lat_24h: 33.9, lon_24h: -119.0, lat_48h: 33.7, lon_48h: -118.5, lat_72h: 33.5, lon_72h: -118.0 };

  test('single-trip ship intercept on offshore plastic', () => {
    const est = estimateShipPickupMinutes({
      vessel, sightingLat: 33.95, sightingLon: -119.20, drift, kg: 800,
    });
    expect(est.trips).toBe(1);
    expect(est.totalMinutes).toBeGreaterThan(45); // at least one onsite cycle
  });

  test('large site forces multiple trips', () => {
    const est = estimateShipPickupMinutes({
      vessel, sightingLat: 33.95, sightingLon: -119.20, drift, kg: 5000,
    });
    expect(est.trips).toBeGreaterThan(2);
  });
});

describe('rankCrewsForSighting', () => {
  // Sighting and vessels are positioned offshore (west of the coastal land polygon)
  // so the new water-only path filter doesn't reject every candidate. The new
  // `firstLandContactFraction`-based filter in rankCrewsForSighting drops vessels
  // whose straight-line route to the sighting touches a continent polygon — keep
  // these test fixtures in the open ocean to exercise the ranking behavior itself.
  const sighting = {
    latitude: 32.50, longitude: -118.00,
    debris_type: 'plastic', density_score: 5, estimated_volume: '~120 kg',
  };
  const vessels = [
    { id: 'v1', name: 'Far Vessel',  status: 'available', current_lat: 21.30, current_lon: -157.82, capacity_kg: 1500, vessel_speed_kn: 12 },
    { id: 'v2', name: 'Local Vessel', status: 'available', current_lat: 32.85, current_lon: -119.40, capacity_kg: 1500, vessel_speed_kn: 14 },
    { id: 'v3', name: 'Maint Vessel', status: 'maintenance', current_lat: 32.80, current_lon: -119.45, capacity_kg: 1500, vessel_speed_kn: 14 },
  ];
  const landCrews = [
    { id: 'l1', name: 'SD Beach', status: 'available', base_lat: 32.72, base_lon: -117.16, capacity_kg: 100, transport_speed_kmh: 50, response_minutes: 12 },
    { id: 'l2', name: 'OC Crew',  status: 'available', base_lat: 33.66, base_lon: -117.93, capacity_kg: 100, transport_speed_kmh: 45, response_minutes: 15 },
  ];

  test('land mode returns only land crews, sorted by ETA', () => {
    const { ranked, kg } = rankCrewsForSighting({
      pickupKey: 'land', sighting, vessels, landCrews,
    });
    expect(kg).toBe(120);
    expect(ranked.length).toBe(2);
    expect(ranked.every((r) => r.crewType === 'land')).toBe(true);
    expect(ranked[0].totalMinutes).toBeLessThanOrEqual(ranked[1].totalMinutes);
    expect(ranked[0].crewName).toBe('SD Beach'); // closer
  });

  test('ship mode returns only available vessels, sorted by ETA', () => {
    const { ranked } = rankCrewsForSighting({
      pickupKey: 'ship', sighting, vessels, landCrews,
    });
    expect(ranked.every((r) => r.crewType === 'ship')).toBe(true);
    expect(ranked.length).toBe(2); // maint vessel excluded
    expect(ranked[0].crewName).toBe('Local Vessel');
  });

  test('ship_coast (flagged drift→shore) returns SHORE crews only — ships never appear', () => {
    const { ranked } = rankCrewsForSighting({
      pickupKey: 'ship_coast', sighting, vessels, landCrews,
    });
    expect(ranked.length).toBe(2);
    expect(ranked.every((r) => r.crewType === 'land')).toBe(true);
    expect(ranked[0].totalMinutes).toBeLessThanOrEqual(ranked[1].totalMinutes);
  });
});

describe('formatEtaShort', () => {
  test('formats correctly', () => {
    expect(formatEtaShort(0.5)).toBe('<1 min');
    expect(formatEtaShort(45)).toBe('45 min');
    expect(formatEtaShort(60)).toBe('1h');
    expect(formatEtaShort(75)).toBe('1h 15m');
    expect(formatEtaShort(NaN)).toBe('—');
  });
});
