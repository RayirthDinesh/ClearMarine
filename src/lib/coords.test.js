import { normalizeLongitude, normalizeLatLon, parseManualLongitudeWest, coordsNearlyEqual } from './coords';

describe('normalizeLongitude', () => {
  test('wraps 200° to -160°', () => {
    expect(normalizeLongitude(200)).toBeCloseTo(-160, 5);
  });

  test('leaves -117° unchanged', () => {
    expect(normalizeLongitude(-117)).toBeCloseTo(-117, 5);
  });

  test('non-finite returns NaN', () => {
    expect(Number.isNaN(normalizeLongitude(NaN))).toBe(true);
  });
});

describe('normalizeLatLon', () => {
  test('accepts valid pair and normalizes longitude', () => {
    const p = normalizeLatLon(32, 200);
    expect(p).not.toBeNull();
    expect(p.lat).toBe(32);
    expect(p.lon).toBeCloseTo(-160, 5);
  });

  test('rejects out-of-range latitude', () => {
    expect(normalizeLatLon(91, 0)).toBeNull();
    expect(normalizeLatLon(-91, 0)).toBeNull();
  });

  test('rejects non-finite values', () => {
    expect(normalizeLatLon(NaN, 0)).toBeNull();
    expect(normalizeLatLon(0, Infinity)).toBeNull();
  });
});

describe('parseManualLongitudeWest', () => {
  test('unsigned value is degrees west (negative)', () => {
    expect(parseManualLongitudeWest('120.4')).toBeCloseTo(-120.4, 5);
  });

  test('leading minus passes through', () => {
    expect(parseManualLongitudeWest('-117.16')).toBeCloseTo(-117.16, 5);
  });

  test('leading plus treated as west magnitude', () => {
    expect(parseManualLongitudeWest('+118')).toBeCloseTo(-118, 5);
  });
});

describe('coordsNearlyEqual', () => {
  test('same point is equal', () => {
    expect(coordsNearlyEqual({ lat: 32, lon: -117 }, { lat: 32, lon: -117 })).toBe(true);
  });

  test('tiny difference within epsilon', () => {
    expect(coordsNearlyEqual({ lat: 32, lon: -117 }, { lat: 32.0003, lon: -117.0003 })).toBe(true);
  });

  test('larger difference is not equal', () => {
    expect(coordsNearlyEqual({ lat: 32, lon: -117 }, { lat: 32.1, lon: -117 })).toBe(false);
  });
});
