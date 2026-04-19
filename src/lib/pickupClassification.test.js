import { classifyPickupMode, PICKUP_MODE } from './pickupClassification';

const offshoreDrift = {
  lat_24h: 34.2,
  lon_24h: -125,
  lat_48h: 34.3,
  lon_48h: -126,
  lat_72h: 34.4,
  lon_72h: -127,
};

describe('classifyPickupMode', () => {
  test('on-land detection is disabled — formerly-inland points fall through to drift-based modes', () => {
    const r = classifyPickupMode(37.5, -121, offshoreDrift);
    // No more auto LAND classification from a single point heuristic.
    expect(r.key).not.toBe(PICKUP_MODE.LAND);
  });

  test('offshore Pacific, track stays sea → ship', () => {
    const r = classifyPickupMode(34, -125, offshoreDrift);
    expect(r.key).toBe(PICKUP_MODE.SHIP);
  });

  test('no drift → unknown (everywhere on the globe)', () => {
    expect(classifyPickupMode(34, -125, null).key).toBe(PICKUP_MODE.UNKNOWN);
    expect(classifyPickupMode(28, -85, null).key).toBe(PICKUP_MODE.UNKNOWN); // Gulf
    expect(classifyPickupMode(35, 140, null).key).toBe(PICKUP_MODE.UNKNOWN); // Off Japan
  });

  test('Gulf-of-Mexico debris is now classifiable (drift→Gulf coast = shore lane)', () => {
    // Origin sits ~30 km off the central Gulf coast; drift is short and pushes shoreward.
    // With the global mask in play, this should classify as shore-crew (or at minimum
    // not as UNKNOWN) — the old code returned UNKNOWN here because of the NE-Pacific gate.
    const drift = {
      lat_24h: 28.0, lon_24h: -90.0,
      lat_48h: 28.4, lon_48h: -90.1,
      lat_72h: 28.8, lon_72h: -90.2,
    };
    const r = classifyPickupMode(27.6, -89.95, drift);
    expect(r.key).not.toBe(PICKUP_MODE.UNKNOWN);
  });
});
