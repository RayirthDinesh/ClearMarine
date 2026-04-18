/**
 * Optional Roboflow detection.
 *
 * Preferred (secure): call the local backend proxy so the API key never reaches the browser:
 * - set REACT_APP_ROBOFLOW_PROXY_URL (e.g. http://localhost:8787)
 * - start backend: npm run start:api
 *
 * Legacy (not recommended): direct browser call to Roboflow Infer
 * - set REACT_APP_ROBOFLOW_DETECT_URL + REACT_APP_ROBOFLOW_API_KEY
 */

import { MIN_CV_BOX_CONFIDENCE } from './cvConstants';

const DEBRIS_CLASS_FRAGMENTS = [
  'plastic', 'bottle', 'bag', 'net', 'trash', 'debris', 'rope', 'styrofoam', 'cup', 'can', 'wrapper',
  'fishing', 'gear', 'balloon', 'cigarette', 'container', 'foam',
];

const ANIMAL_CLASS_FRAGMENTS = [
  'fish', 'turtle', 'shark', 'whale', 'seal', 'dolphin', 'bird', 'seabird', 'jellyfish', 'ray',
  'human', 'person',
];

function classBucket(className) {
  const c = String(className || '').toLowerCase();
  if (ANIMAL_CLASS_FRAGMENTS.some((f) => c.includes(f))) return 'animal';
  if (DEBRIS_CLASS_FRAGMENTS.some((f) => c.includes(f))) return 'debris';
  return 'unknown';
}

function normalizeRoboflowBbox(pred, imgW, imgH) {
  const w = imgW || 1;
  const h = imgH || 1;
  let x1; let y1; let x2; let y2;
  if (pred.x != null && pred.y != null && pred.width != null && pred.height != null) {
    const cx = Number(pred.x);
    const cy = Number(pred.y);
    const bw = Number(pred.width);
    const bh = Number(pred.height);
    if (cx <= 1 && cy <= 1 && bw <= 1 && bh <= 1) {
      x1 = cx - bw / 2;
      y1 = cy - bh / 2;
      x2 = cx + bw / 2;
      y2 = cy + bh / 2;
    } else {
      x1 = (cx - bw / 2) / w;
      y1 = (cy - bh / 2) / h;
      x2 = (cx + bw / 2) / w;
      y2 = (cy + bh / 2) / h;
    }
  } else {
    return [0, 0, 0.01, 0.01];
  }
  const clamp = (v) => Math.max(0, Math.min(1, v));
  return [clamp(x1), clamp(y1), clamp(x2), clamp(y2)];
}

/**
 * @param {string} dataUrl
 * @returns {Promise<null | {
 *   animals: Array<{ class: string, bbox: [number,number,number,number], confidence: number, coco_label?: string }>,
 *   debris: Array<{ class: string, bbox: [number,number,number,number], confidence: number, coco_label?: string }>,
 *   image_width: number,
 *   image_height: number,
 *   detector: string,
 * }>}
 */
export async function runRoboflowDetection(dataUrl) {
  const proxyBase = (process.env.REACT_APP_ROBOFLOW_PROXY_URL || '').trim().replace(/\/$/, '');
  const directBase = (process.env.REACT_APP_ROBOFLOW_DETECT_URL || '').trim().replace(/\/$/, '');
  const apiKey = (process.env.REACT_APP_ROBOFLOW_API_KEY || '').trim();
  const useProxy = Boolean(proxyBase);
  const useDirect = Boolean(directBase && apiKey);
  if (!useProxy && !useDirect) {
    // eslint-disable-next-line no-console
    console.log('[ClearMarine] Roboflow disabled (no proxy/direct env set)');
    return null;
  }

  const img = await loadImageFromDataUrl(dataUrl);
  const iw = img.naturalWidth || img.width;
  const ih = img.naturalHeight || img.height;

  const comma = dataUrl.indexOf(',');
  const imageBase64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;

  try {
    let res;
    if (useProxy) {
      // eslint-disable-next-line no-console
      console.log(`[ClearMarine] Roboflow proxy request → ${proxyBase}/detect (b64=${imageBase64.length})`);
      res = await fetch(`${proxyBase}/detect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ imageBase64 }),
      });
    } else {
      const blob = await fetch(dataUrl).then((r) => r.blob());
      const form = new FormData();
      form.append('file', blob, 'image.jpg');
      const url = `${directBase.includes('?') ? `${directBase}&` : `${directBase}?`}api_key=${encodeURIComponent(apiKey)}`;
      res = await fetch(url, { method: 'POST', body: form });
    }

    if (!res.ok) {
      // eslint-disable-next-line no-console
      console.warn(
        `[ClearMarine] Roboflow ${useProxy ? 'proxy' : 'direct'} failed status=${res.status}`,
      );
      return null;
    }
    const data = await res.json();
    const preds = Array.isArray(data?.predictions) ? data.predictions : (Array.isArray(data?.raw?.predictions) ? data.raw.predictions : []);
    const animals = [];
    const debris = [];

    for (const p of preds) {
      const conf = Number(p.confidence);
      if (!Number.isFinite(conf) || conf <= MIN_CV_BOX_CONFIDENCE) continue;
      const cls = String(p.class || 'object');
      const bucket = classBucket(cls);
      const bbox = normalizeRoboflowBbox(p, iw, ih);
      const entry = {
        class: bucket === 'debris' ? cls.replace(/\s+/g, '_').toLowerCase() : cls.replace(/\s+/g, '_').toLowerCase(),
        bbox,
        confidence: Math.round(conf * 1000) / 1000,
        coco_label: cls,
      };
      if (bucket === 'animal') {
        entry.class = cls.toLowerCase().includes('person') || cls.toLowerCase().includes('human') ? 'human' : 'wildlife';
        animals.push(entry);
      } else if (bucket === 'debris') {
        entry.class = `roboflow_${entry.class.slice(0, 40)}`;
        debris.push(entry);
      }
    }

    return {
      animals,
      debris,
      image_width: iw,
      image_height: ih,
      detector: useProxy ? 'roboflow_proxy' : 'roboflow_remote',
    };
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[ClearMarine] Roboflow request error:', e?.message || e);
    return null;
  }
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
