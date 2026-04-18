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
  test('inland CA → land', () => {
    const r = classifyPickupMode(37.5, -121, offshoreDrift);
    expect(r.key).toBe(PICKUP_MODE.LAND);
  });

  test('offshore Pacific, track stays sea → ship', () => {
    const r = classifyPickupMode(34, -125, offshoreDrift);
    expect(r.key).toBe(PICKUP_MODE.SHIP);
  });

  test('outside NE Pacific model → unknown', () => {
    const r = classifyPickupMode(5, 40, offshoreDrift);
    expect(r.key).toBe(PICKUP_MODE.UNKNOWN);
  });

  test('no drift → unknown', () => {
    const r = classifyPickupMode(34, -125, null);
    expect(r.key).toBe(PICKUP_MODE.UNKNOWN);
  });
});
