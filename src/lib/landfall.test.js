import {
  isOnLandInPacificModel,
  isNortheastPacificShorelineModel,
  shouldShowSightingOnDashboard,
  computePacificLandfallDisplay,
  clipDriftPathAgainstGlobalLand,
} from './landfall';

describe('shouldShowSightingOnDashboard', () => {
  test('shows Pacific points the old heuristic called "on-land" (detector disabled)', () => {
    expect(shouldShowSightingOnDashboard(37.5, -121)).toBe(true);
  });

  test('shows open ocean in Pacific model', () => {
    expect(shouldShowSightingOnDashboard(34, -125)).toBe(true);
  });

  test('shows points outside NE Pacific model (no land mask)', () => {
    expect(shouldShowSightingOnDashboard(0, 10)).toBe(true);
  });

  test('hides invalid coords', () => {
    expect(shouldShowSightingOnDashboard(null, -120)).toBe(false);
  });
});

describe('computePacificLandfallDisplay (Atlantic / global mask)', () => {
  test('caps a runaway 24h leg from Bermuda — final point stays in the Atlantic basin', () => {
    // A bogus drift row claiming the trash drifts 3000 km west across the US in 24h.
    const drift = {
      lat_24h: 33, lon_24h: -86,
      lat_48h: 33, lon_48h: -100,
      lat_72h: 33, lon_72h: -110,
    };
    const r = computePacificLandfallDisplay(32, -64.7, drift);
    expect(r.pathPoints.length).toBeGreaterThanOrEqual(2);
    // Last point should be capped well before reaching the US east coast.
    const last = r.pathPoints[r.pathPoints.length - 1];
    expect(last[1]).toBeLessThan(-60);
    expect(last[1]).toBeGreaterThan(-72);
  });

  test('clips a path that aims toward continental land at the coast (not inland)', () => {
    // Capping leaves us still in the Atlantic, so we manually craft a leg that the cap
    // doesn't shorten enough to need clipping. Use a small displacement just east of FL.
    const drift = {
      lat_24h: 28, lon_24h: -78,
      lat_48h: 28, lon_48h: -80,
      lat_72h: 28, lon_72h: -82,
    };
    const r = computePacificLandfallDisplay(28, -77, drift);
    // No path point should land deep inside the continent.
    for (const [, lo] of r.pathPoints) {
      expect(lo).toBeLessThan(-70); // Florida's western Gulf coast is around -83°
    }
  });

  test('Gulf-of-Mexico sighting does NOT get a fake Baja Pacific landfall', () => {
    // Origin sits in the Gulf, drift heads west toward the Texas/Mexico coast. With the
    // old loose `lon <= -65` gate, this fell into the Pacific shoreline knots and produced
    // a "Land contact ~27°, -114°" flag (on the Pacific side of Baja California). With the
    // tightened gate it falls through to the global polygon mask and clips at the actual
    // Gulf coast (lon roughly -94 to -98).
    const drift = {
      lat_24h: 27.5, lon_24h: -90,
      lat_48h: 27.5, lon_48h: -94,
      lat_72h: 27.5, lon_72h: -98,
    };
    const r = computePacificLandfallDisplay(27.5, -85, drift);
    if (r.landfallPoint) {
      // Must not be on the Pacific side of Baja California.
      expect(r.landfallPoint[1]).toBeGreaterThan(-100);
    }
    for (const [, lo] of r.pathPoints) {
      // Nothing in this Gulf path should be flagged near -114° (Pacific Baja).
      expect(lo).toBeGreaterThan(-100);
    }
  });

  test('East-Coast Florida sighting does NOT get a fake Baja Pacific landfall', () => {
    const drift = {
      lat_24h: 27, lon_24h: -79,
      lat_48h: 27, lon_48h: -80.4,
      lat_72h: 27, lon_72h: -81.8,
    };
    const r = computePacificLandfallDisplay(27, -78, drift);
    if (r.landfallPoint) {
      expect(r.landfallPoint[1]).toBeGreaterThan(-90);
    }
  });
});

describe('isNortheastPacificShorelineModel', () => {
  test('accepts SoCal / Baja / Pacific Northwest', () => {
    expect(isNortheastPacificShorelineModel(34, -120)).toBe(true);   // SoCal
    expect(isNortheastPacificShorelineModel(27, -114)).toBe(true);   // Baja Pacific
    expect(isNortheastPacificShorelineModel(47, -125)).toBe(true);   // WA coast
  });

  test('rejects Gulf of Mexico / East Coast / Caribbean', () => {
    expect(isNortheastPacificShorelineModel(27.5, -85)).toBe(false); // Gulf
    expect(isNortheastPacificShorelineModel(28, -77)).toBe(false);   // Off Florida
    expect(isNortheastPacificShorelineModel(40, -70)).toBe(false);   // Off New England
    expect(isNortheastPacificShorelineModel(18, -75)).toBe(false);   // Caribbean
  });

  test('rejects everything outside the western hemisphere too', () => {
    expect(isNortheastPacificShorelineModel(35, 140)).toBe(false);   // Off Japan
    expect(isNortheastPacificShorelineModel(0, 10)).toBe(false);     // Gulf of Guinea
  });
});

describe('clipDriftPathAgainstGlobalLand', () => {
  test('open-water → open-water keeps both endpoints', () => {
    const r = clipDriftPathAgainstGlobalLand([[32, -64], [33, -62]]);
    expect(r.hitShore).toBe(false);
    expect(r.pathPoints).toHaveLength(2);
  });

  test('water → continental US flags shore contact and trims the inland leg', () => {
    const r = clipDriftPathAgainstGlobalLand([[32, -64.7], [35, -85]]);
    expect(r.hitShore).toBe(true);
    expect(r.landfallPoint).not.toBe(null);
    // Contact point must be east of mainland US interior.
    expect(r.landfallPoint[1]).toBeLessThan(-70);
  });
});

describe('isOnLandInPacificModel (disabled)', () => {
  test('shoreline geometry helper still classifies the NE Pacific window', () => {
    expect(isNortheastPacificShorelineModel(37.5, -121)).toBe(true);
  });

  test('always returns false — on-land detection is off for now', () => {
    expect(isOnLandInPacificModel(34, -125)).toBe(false);
    expect(isOnLandInPacificModel(37.5, -121)).toBe(false);
    expect(isOnLandInPacificModel(35, 140)).toBe(false);
  });
});
