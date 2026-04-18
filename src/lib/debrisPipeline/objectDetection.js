/**
 * Object detection — normalized schema before LLM:
 * { animals, debris, image_width, image_height, detector, cvDetected }
 *
 * Order: Roboflow (optional) → remote YOLO → COCO-SSD.
 * Boxes below MIN_CV_BOX_CONFIDENCE are dropped; empty arrays ≠ “clean ocean”.
 */

import * as tf from '@tensorflow/tfjs';
import * as cocoSsd from '@tensorflow-models/coco-ssd';
import { MIN_CV_BOX_CONFIDENCE } from './cvConstants';
import { runRoboflowDetection } from './roboflowDetect';

let modelPromise = null;

const CV_SERVER = (process.env.REACT_APP_CV_SERVER_URL || '').trim().replace(/\/$/, '');

function getModel() {
  if (!modelPromise) {
    modelPromise = cocoSsd.load({ base: 'mobilenet_v2' });
  }
  return modelPromise;
}

/** COCO class name → standardized debris label */
const COCO_TO_DEBRIS = {
  bottle: 'plastic_bottle',
  'wine glass': 'glass_container',
  cup: 'plastic_cup',
  bowl: 'container',
  fork: 'utensil_fragment',
  knife: 'utensil_fragment',
  spoon: 'utensil_fragment',
  handbag: 'plastic_bag',
  backpack: 'bag_or_gear',
  suitcase: 'large_container',
  umbrella: 'debris_misc',
  'sports ball': 'floating_object',
  frisbee: 'floating_object',
  surfboard: 'large_debris',
  skis: 'debris_misc',
  snowboard: 'debris_misc',
  kite: 'sheet_plastic',
  'baseball bat': 'debris_misc',
  'baseball glove': 'debris_misc',
  skateboard: 'debris_misc',
  'tennis racket': 'debris_misc',
  chair: 'debris_misc',
  couch: 'debris_misc',
  'potted plant': 'debris_misc',
  bed: 'debris_misc',
  'dining table': 'debris_misc',
  toilet: 'debris_misc',
  tv: 'debris_misc',
  laptop: 'debris_misc',
  mouse: 'debris_misc',
  remote: 'debris_misc',
  keyboard: 'debris_misc',
  'cell phone': 'debris_misc',
  microwave: 'debris_misc',
  oven: 'debris_misc',
  toaster: 'debris_misc',
  sink: 'debris_misc',
  refrigerator: 'debris_misc',
  book: 'paper_debris',
  clock: 'debris_misc',
  vase: 'debris_misc',
  scissors: 'debris_misc',
  'teddy bear': 'debris_misc',
  'hair drier': 'debris_misc',
  toothbrush: 'plastic_fragment',
};

const COCO_TO_ANIMAL = {
  bird: 'seabird',
  cat: 'wildlife',
  dog: 'wildlife',
  horse: 'wildlife',
  sheep: 'wildlife',
  cow: 'wildlife',
  elephant: 'wildlife',
  bear: 'wildlife',
  zebra: 'wildlife',
  giraffe: 'wildlife',
  person: 'human',
};

function normalizeBboxPixels(bbox, imgW, imgH) {
  const [x, y, bw, bh] = bbox;
  const x1 = x / imgW;
  const y1 = y / imgH;
  const x2 = (x + bw) / imgW;
  const y2 = (y + bh) / imgH;
  return [
    clamp01(x1),
    clamp01(y1),
    clamp01(x2),
    clamp01(y2),
  ];
}

function clamp01(v) {
  return Math.max(0, Math.min(1, v));
}

function loadImageFromDataUrl(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Image load failed'));
    img.src = dataUrl;
  });
}

/**
 * Drop low-confidence boxes; set cvDetected. Empty lists are not “clean ocean”.
 */
function finalizeDetection(raw) {
  const min = MIN_CV_BOX_CONFIDENCE;
  const animals = (raw.animals || []).filter((e) => (Number(e.confidence) || 0) > min);
  const debris = (raw.debris || []).filter((e) => (Number(e.confidence) || 0) > min);
  const cvDetected = animals.length + debris.length > 0;
  return {
    ...raw,
    animals,
    debris,
    cvDetected,
  };
}

async function runRemoteYolo(dataUrl) {
  if (!CV_SERVER) return null;
  const comma = dataUrl.indexOf(',');
  const b64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
  const mimeType = comma >= 0 ? dataUrl.slice(5, dataUrl.indexOf(';')) : 'image/jpeg';

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120000);
  try {
    const res = await fetch(`${CV_SERVER}/detect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image_b64: b64, mime_type: mimeType }),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data || data.ok !== true) return null;
    return {
      animals: Array.isArray(data.animals) ? data.animals : [],
      debris: Array.isArray(data.debris) ? data.debris : [],
      image_width: Number(data.image_width) || 0,
      image_height: Number(data.image_height) || 0,
      detector: typeof data.detector === 'string' ? data.detector : 'yolov8_remote',
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function runCocoSsd(dataUrl) {
  await tf.ready();
  const model = await getModel();
  const img = await loadImageFromDataUrl(dataUrl);
  const w = img.naturalWidth || img.width;
  const h = img.naturalHeight || img.height;
  const scoreMin = Math.min(MIN_CV_BOX_CONFIDENCE, 0.45);
  const predictions = await model.detect(img, 40, scoreMin);

  const animals = [];
  const debris = [];

  for (const p of predictions) {
    if (p.score <= MIN_CV_BOX_CONFIDENCE) continue;
    if (p.class === 'boat') continue;

    const bbox = normalizeBboxPixels(p.bbox, w, h);
    const entry = {
      class: '',
      bbox,
      confidence: Math.round(p.score * 1000) / 1000,
      coco_label: p.class,
    };

    if (COCO_TO_DEBRIS[p.class] !== undefined) {
      entry.class = COCO_TO_DEBRIS[p.class];
      debris.push(entry);
    } else if (COCO_TO_ANIMAL[p.class] !== undefined) {
      entry.class = COCO_TO_ANIMAL[p.class];
      animals.push(entry);
    }
  }

  return {
    animals,
    debris,
    image_width: w,
    image_height: h,
    detector: 'coco_ssd_mobilenet_v2',
  };
}

/**
 * @param {string} dataUrl
 */
export async function runObjectDetection(dataUrl) {
  // eslint-disable-next-line no-console
  console.log('[ClearMarine] CV pipeline start');
  let raw = await runRoboflowDetection(dataUrl);
  if (raw && raw.image_width > 0 && raw.image_height > 0) {
    // eslint-disable-next-line no-console
    console.log(`[ClearMarine] CV source=Roboflow detector=${raw.detector} animals=${raw.animals?.length ?? 0} debris=${raw.debris?.length ?? 0}`);
    return finalizeDetection(raw);
  }

  if (CV_SERVER) {
    raw = await runRemoteYolo(dataUrl);
    if (raw && raw.image_width > 0 && raw.image_height > 0) {
      // eslint-disable-next-line no-console
      console.log(`[ClearMarine] CV source=YOLO detector=${raw.detector} animals=${raw.animals?.length ?? 0} debris=${raw.debris?.length ?? 0}`);
      return finalizeDetection(raw);
    }
    // eslint-disable-next-line no-console
    console.warn(
      '[ClearMarine] REACT_APP_CV_SERVER_URL set but /detect failed — falling back to COCO-SSD.',
    );
  }

  raw = await runCocoSsd(dataUrl);
  // eslint-disable-next-line no-console
  console.log(`[ClearMarine] CV source=COCO detector=${raw.detector} animals=${raw.animals?.length ?? 0} debris=${raw.debris?.length ?? 0}`);
  return finalizeDetection(raw);
}
