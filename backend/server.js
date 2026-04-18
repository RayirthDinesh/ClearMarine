const express = require('express');
const cors = require('cors');
const multer = require('multer');
const axios = require('axios');
const dotenv = require('dotenv');
const path = require('path');

// Load backend-specific env (do not rely on CRA's .env)
dotenv.config({ path: path.join(__dirname, '.env') });

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

const PORT = Number(process.env.PORT || 8787);
const ROBOFLOW_API_KEY = process.env.ROBOFLOW_API_KEY;
const ROBOFLOW_API_URL = 'https://serverless.roboflow.com';
const MODEL_ID = 'marine-trash-detection/2';

app.use(cors());
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true, limit: '25mb' }));

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'roboflow-proxy' });
});

app.get('/', (_req, res) => {
  res.json({
    ok: true,
    service: 'roboflow-proxy',
    message: 'Use POST /detect with image file or imageBase64.',
  });
});

function stripDataUrlPrefix(input) {
  const s = String(input || '').trim();
  const comma = s.indexOf(',');
  if (s.startsWith('data:') && comma > -1) return s.slice(comma + 1);
  return s;
}

function getBase64FromRequest(req) {
  if (req.file && req.file.buffer) {
    return req.file.buffer.toString('base64');
  }
  if (req.body && (req.body.imageBase64 || req.body.image)) {
    return stripDataUrlPrefix(req.body.imageBase64 || req.body.image);
  }
  return '';
}

app.post('/detect', upload.single('image'), async (req, res) => {
  try {
    if (!ROBOFLOW_API_KEY) {
      return res.status(500).json({ error: 'Missing ROBOFLOW_API_KEY in environment' });
    }

    const imageBase64 = getBase64FromRequest(req);
    if (!imageBase64) {
      return res.status(400).json({
        error: 'No image provided. Send multipart file field "image" or JSON { imageBase64 }',
      });
    }
    // eslint-disable-next-line no-console
    console.log(`[roboflow-proxy] /detect image bytes(base64)=${imageBase64.length}`);

    const endpoint = `${ROBOFLOW_API_URL}/${MODEL_ID}?api_key=${encodeURIComponent(ROBOFLOW_API_KEY)}`;
    // Roboflow serverless expects base64 as the request body (x-www-form-urlencoded)
    // See: detect.roboflow.com examples (same payload style).
    const body = imageBase64;

    const rf = await axios.post(endpoint, body, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 30000,
      maxBodyLength: Infinity,
    });
    // eslint-disable-next-line no-console
    console.log(`[roboflow-proxy] roboflow status=${rf.status} predictions=${rf.data?.predictions?.length ?? 0}`);

    return res.json({
      ok: true,
      model: MODEL_ID,
      predictions: rf.data?.predictions || [],
      raw: rf.data,
    });
  } catch (err) {
    const status = err.response?.status || 500;
    // eslint-disable-next-line no-console
    console.warn('[roboflow-proxy] error', status, err.response?.data || err.message);
    return res.status(status).json({
      ok: false,
      error: err.response?.data || err.message || 'Roboflow request failed',
    });
  }
});

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Roboflow proxy listening on http://localhost:${PORT}`);
});
