jest.mock('./supabase', () => ({
  supabase: {
    from: () => ({
      select: () => ({
        gte: () => ({
          lte: () => ({
            gte: () => ({
              lte: () => ({
                limit: () => Promise.resolve({ data: [], error: null }),
              }),
            }),
          }),
        }),
      }),
    }),
  },
}));

jest.mock('./gliderCurrents', () => ({
  getNearestGliderCurrent: () => Promise.resolve(null),
  haversineKm: jest.requireActual('./gliderCurrents').haversineKm,
}));

import { predictDrift, getInterceptionPoint } from './drift';

beforeAll(() => {
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterAll(() => {
  console.warn.mockRestore();
});

describe('predictDrift', () => {
  test('throws on invalid coordinates', async () => {
    await expect(predictDrift(NaN, 0)).rejects.toThrow(/Invalid coordinates/);
    await expect(predictDrift(0, NaN)).rejects.toThrow(/Invalid coordinates/);
    await expect(predictDrift(91, 0)).rejects.toThrow(/Invalid coordinates/);
  });

  test('returns fallback when no HYCOM and no glider', async () => {
    const r = await predictDrift(32, -117);
    expect(r.predictions).toHaveLength(3);
    expect(r.source).toMatch(/fallback/);
  });
});

describe('getInterceptionPoint', () => {
  test('returns null when vessel coords invalid', async () => {
    const r = await getInterceptionPoint(32, -117, NaN, -117);
    expect(r).toBeNull();
  });

  test('returns null when sighting coords invalid', async () => {
    const r = await getInterceptionPoint(91, 0, 32, -117);
    expect(r).toBeNull();
  });
});
