import { haversineKm, resetGliderIndexCache, getNearestGliderCurrent } from './gliderCurrents';

describe('haversineKm', () => {
  test('distance along equator ~111 km per degree', () => {
    const km = haversineKm(0, 0, 0, 1);
    expect(km).toBeGreaterThan(110);
    expect(km).toBeLessThan(112);
  });

  test('same point is ~0', () => {
    expect(haversineKm(10, -100, 10, -100)).toBeLessThan(1e-6);
  });

  test('non-finite inputs yield Infinity', () => {
    expect(haversineKm(NaN, 0, 0, 0)).toBe(Infinity);
    expect(haversineKm(0, 0, 0, NaN)).toBe(Infinity);
  });
});

describe('getNearestGliderCurrent', () => {
  beforeEach(() => {
    resetGliderIndexCache();
    global.fetch = jest.fn();
  });

  afterEach(() => {
    resetGliderIndexCache();
  });

  test('global nearest wins over distant profile', async () => {
    global.fetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        max_km_glider_priority: 500,
        profiles: [
          { lat: 10, lon: -100, speed_knots: 1, bearing_deg: 0 },
          { lat: 50, lon: -100, speed_knots: 99, bearing_deg: 90 },
        ],
      }),
    });

    const r = await getNearestGliderCurrent(10, -100);
    expect(r).not.toBeNull();
    expect(r.speed).toBe(1);
  });

  test('skips invalid profiles and uses next nearest', async () => {
    global.fetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        max_km_glider_priority: 500,
        profiles: [
          { lat: 10, lon: -100, speed_knots: NaN, bearing_deg: 0 },
          { lat: 10.02, lon: -100, speed_knots: 2, bearing_deg: 180 },
        ],
      }),
    });

    const r = await getNearestGliderCurrent(10, -100);
    expect(r).not.toBeNull();
    expect(r.speed).toBe(2);
  });
});
