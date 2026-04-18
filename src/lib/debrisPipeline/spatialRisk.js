/**
 * Spatial risk from detected objects: distances, relative size, overlap / proximity.
 * Uses normalized image coordinates [0,1] for bboxes [xmin, ymin, xmax, ymax].
 */

function boxCenter(bbox) {
  const [x1, y1, x2, y2] = bbox;
  return [(x1 + x2) / 2, (y1 + y2) / 2];
}

function boxArea(bbox) {
  const [x1, y1, x2, y2] = bbox;
  return Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
}

/** IoU for axis-aligned boxes in same coordinate space */
function intersectionOverUnion(a, b) {
  const [ax1, ay1, ax2, ay2] = a;
  const [bx1, by1, bx2, by2] = b;
  const ix1 = Math.max(ax1, bx1);
  const iy1 = Math.max(ay1, by1);
  const ix2 = Math.min(ax2, bx2);
  const iy2 = Math.min(ay2, by2);
  const iw = Math.max(0, ix2 - ix1);
  const ih = Math.max(0, iy2 - iy1);
  const inter = iw * ih;
  const ua = boxArea(a) + boxArea(b) - inter;
  if (ua <= 0) return 0;
  return inter / ua;
}

/** Euclidean distance between centers, normalized by image diagonal (max ~1) */
function normalizedCenterDistance(bboxA, bboxB) {
  const [cx1, cy1] = boxCenter(bboxA);
  const [cx2, cy2] = boxCenter(bboxB);
  const d = Math.hypot(cx1 - cx2, cy1 - cy2);
  return Math.min(1, d / Math.SQRT2);
}

function riskFromDistanceAndIou(distance01, iou, relDebrisArea) {
  if (iou >= 0.08) return 'high';
  if (iou >= 0.02) return 'medium';
  if (distance01 < 0.12 && relDebrisArea > 0.02) return 'high';
  if (distance01 < 0.22) return 'medium';
  if (distance01 < 0.38) return 'low';
  return 'low';
}

/**
 * @param {{ animals: Array, debris: Array }} detection
 */
export function computeSpatialRisk(detection) {
  const { animals, debris } = detection;
  const frameArea = 1;
  const interactions = [];

  for (const a of animals) {
    for (const d of debris) {
      const dist = normalizedCenterDistance(a.bbox, d.bbox);
      const iou = intersectionOverUnion(a.bbox, d.bbox);
      const relSize = boxArea(d.bbox) / frameArea;
      const risk = riskFromDistanceAndIou(dist, iou, relSize);
      interactions.push({
        animal: a.class,
        debris: d.class,
        distance: Math.round(dist * 1000) / 1000,
        iou: Math.round(iou * 1000) / 1000,
        debris_relative_area: Math.round(relSize * 1000) / 1000,
        overlaps: iou > 0.01,
        risk,
      });
    }
  }

  const debrisSizes = debris.map((d) => ({
    class: d.class,
    relative_area: Math.round(boxArea(d.bbox) * 1000) / 1000,
    confidence: d.confidence,
  }));

  return {
    interactions,
    debris_relative_sizes: debrisSizes,
    summary: {
      animal_count: animals.length,
      debris_count: debris.length,
      close_pairs: interactions.filter((i) => i.risk === 'high' || i.risk === 'medium').length,
    },
  };
}
