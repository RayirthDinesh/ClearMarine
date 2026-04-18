/**
 * Marine debris CV + geo pipeline — object-level outputs only (no pixel-density heuristics).
 */

import { runObjectDetection } from './objectDetection';
import { computeSpatialRisk } from './spatialRisk';
import { getGeoContext } from './geoContext';

/**
 * Full structured payload for the LLM reasoning layer (text-only; no raw pixels).
 */
export async function runMarineDebrisPipeline(dataUrl, latitude, longitude) {
  const detection = await runObjectDetection(dataUrl);
  const spatial = computeSpatialRisk(detection);
  const geo = getGeoContext(latitude, longitude);
  const cvDetected = detection.cvDetected === true;

  return {
    detection: {
      animals: detection.animals,
      debris: detection.debris,
      detector: detection.detector,
      image_width: detection.image_width,
      image_height: detection.image_height,
      cvDetected,
    },
    spatial,
    geo,
    cvDetected,
  };
}

export { runObjectDetection } from './objectDetection';
export { computeSpatialRisk } from './spatialRisk';
export { getGeoContext } from './geoContext';
