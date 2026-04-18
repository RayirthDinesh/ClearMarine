import {
  isOnLandInPacificModel,
  isNortheastPacificShorelineModel,
  shouldShowSightingOnDashboard,
} from './landfall';

describe('shouldShowSightingOnDashboard', () => {
  test('hides Pacific on-land', () => {
    expect(shouldShowSightingOnDashboard(37.5, -121)).toBe(false);
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

describe('isOnLandInPacificModel', () => {
  test('open ocean west of CA coast is not land', () => {
    expect(isOnLandInPacificModel(34, -125)).toBe(false);
  });

  test('Central Valley inland is land in model', () => {
    expect(isNortheastPacificShorelineModel(37.5, -121)).toBe(true);
    expect(isOnLandInPacificModel(37.5, -121)).toBe(true);
  });

  test('outside NE Pacific model is not flagged as land', () => {
    expect(isOnLandInPacificModel(35, 140)).toBe(false);
  });
});
