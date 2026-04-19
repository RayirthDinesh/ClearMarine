const express = require('express');
const cors = require('cors');
const multer = require('multer');
const axios = require('axios');
const FormData = require('form-data');
const dotenv = require('dotenv');
const path = require('path');

// Load root .env first (single-file setup), then optional backend/.env overrides for local.
dotenv.config({ path: path.resolve(__dirname, '../.env') });
dotenv.config({ path: path.join(__dirname, '.env'), override: true });

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

const PORT = Number(process.env.PORT || 8787);
const ROBOFLOW_API_URL = 'https://serverless.roboflow.com';
const MODEL_ID = 'marine-trash-detection/2';
/** Optional ISO language hint for Scribe (e.g. en). Leave unset if your API version ignores it. */
/** Default premade voice (Rachel). Override with ELEVENLABS_VOICE_ID from your ElevenLabs Voices page. */
/** Multilingual v2 works with default premade voices; override if your account requires another model. */

function elevenLabsUpstreamMessage(payload, fallback) {
  if (payload == null || typeof payload !== 'object') return fallback;
  const d = payload.detail;
  if (d && typeof d === 'object' && typeof d.message === 'string') return d.message;
  return fallback;
}

function cfg() {
  return {
    ROBOFLOW_API_KEY: process.env.ROBOFLOW_API_KEY,
    ELEVENLABS_KEY: process.env.ELEVENLABS_KEY,
    ELEVENLABS_STT_MODEL: process.env.ELEVENLABS_STT_MODEL || 'scribe_v2',
    ELEVENLABS_STT_LANGUAGE: (process.env.ELEVENLABS_STT_LANGUAGE || '').trim(),
    ELEVENLABS_VOICE_ID: process.env.ELEVENLABS_VOICE_ID || '21m00TcmT4DvrzdWaoCl6',
    ELEVENLABS_TTS_MODEL: process.env.ELEVENLABS_TTS_MODEL || 'eleven_multilingual_v2',
  };
}

app.use(cors());
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true, limit: '25mb' }));

/** Same routes at `/` (local npm run start:api) and `/api` (Vercel — browser uses same-origin /api/...). */
const routes = express.Router();

routes.get('/health', (_req, res) => {
  const conf = cfg();
  res.json({
    ok: true,
    services: ['roboflow-proxy', 'elevenlabs-stt', 'elevenlabs-tts'],
    elevenlabs_key_configured: Boolean(conf.ELEVENLABS_KEY),
    elevenlabs_tts_voice_id: conf.ELEVENLABS_VOICE_ID,
  });
});

routes.get('/', (_req, res) => {
  res.json({
    ok: true,
    service: 'clearmarine-api',
    message: 'POST /detect (Roboflow), POST /transcribe (multipart file), POST /tts JSON { text } (ElevenLabs TTS). Same paths under /api on Vercel.',
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

routes.post('/detect', upload.single('image'), async (req, res) => {
  try {
    const conf = cfg();
    if (!conf.ROBOFLOW_API_KEY) {
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

    const endpoint = `${ROBOFLOW_API_URL}/${MODEL_ID}?api_key=${encodeURIComponent(conf.ROBOFLOW_API_KEY)}`;
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

/**
 * ElevenLabs Speech-to-Text (Scribe) — multipart field "file".
 * Docs: POST https://api.elevenlabs.io/v1/speech-to-text
 */
routes.post('/transcribe', upload.single('file'), async (req, res) => {
  try {
    const conf = cfg();
    if (!conf.ELEVENLABS_KEY) {
      return res.status(500).json({ error: 'Missing ELEVENLABS_KEY in environment' });
    }
    if (!req.file?.buffer?.length) {
      return res.status(400).json({ error: 'No audio file. Send multipart field "file".' });
    }

    let uploadName = req.file.originalname || 'recording.webm';
    const mime = req.file.mimetype || '';
    if (/mp4|m4a/i.test(mime) && !/\.m4a$/i.test(uploadName)) uploadName = 'recording.m4a';
    else if (/webm/i.test(mime) && !/\.webm$/i.test(uploadName)) uploadName = 'recording.webm';

    const fd = new FormData();
    fd.append('file', req.file.buffer, {
      filename: uploadName,
      contentType: mime || 'application/octet-stream',
    });
    fd.append('model_id', conf.ELEVENLABS_STT_MODEL);
    if (conf.ELEVENLABS_STT_LANGUAGE) {
      fd.append('language_code', conf.ELEVENLABS_STT_LANGUAGE);
    }

    const el = await axios.post('https://api.elevenlabs.io/v1/speech-to-text', fd, {
      headers: {
        ...fd.getHeaders(),
        'xi-api-key': conf.ELEVENLABS_KEY,
      },
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      timeout: 120000,
    });

    const text = typeof el.data?.text === 'string' ? el.data.text.trim() : '';
    if (!text) {
      return res.status(502).json({ error: 'ElevenLabs returned empty transcript', raw: el.data });
    }
    return res.json({ ok: true, text, model_id: conf.ELEVENLABS_STT_MODEL });
  } catch (err) {
    const status = err.response?.status || 500;
    const upstream = err.response?.data;
    const msg = elevenLabsUpstreamMessage(upstream, err.message || 'ElevenLabs transcription failed');
    // eslint-disable-next-line no-console
    console.warn('[elevenlabs-stt] error', status, upstream || err.message);
    return res.status(status).json({
      ok: false,
      error: msg,
    });
  }
});

/**
 * ElevenLabs text-to-speech — JSON body { "text": "..." } returns audio/mpeg.
 * https://elevenlabs.io/docs/api-reference/text-to-speech
 */
routes.post('/tts', async (req, res) => {
  try {
    const conf = cfg();
    if (!conf.ELEVENLABS_KEY) {
      return res.status(500).json({ error: 'Missing ELEVENLABS_KEY in environment' });
    }
    const text = String(req.body?.text || '').trim();
    if (!text) {
      return res.status(400).json({ error: 'Missing JSON body field "text"' });
    }
    if (text.length > 2500) {
      return res.status(400).json({ error: 'Text exceeds 2500 characters' });
    }

    const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(conf.ELEVENLABS_VOICE_ID)}`;
    const el = await axios.post(
      url,
      {
        text,
        model_id: conf.ELEVENLABS_TTS_MODEL,
      },
      {
        headers: {
          'xi-api-key': conf.ELEVENLABS_KEY,
          'Content-Type': 'application/json',
          Accept: 'audio/mpeg',
        },
        responseType: 'arraybuffer',
        timeout: 120000,
        maxBodyLength: Infinity,
      },
    );

    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).send(Buffer.from(el.data));
  } catch (err) {
    const status = err.response?.status || 500;
    const detail = err.response?.data;
    let message = err.message || 'TTS failed';
    if (Buffer.isBuffer(detail)) {
      message = detail.toString('utf8').slice(0, 500);
    } else if (detail && typeof detail === 'object') {
      message = JSON.stringify(detail).slice(0, 500);
    }
    // eslint-disable-next-line no-console
    console.warn('[elevenlabs-tts] error', status, message);
    return res.status(status).json({
      ok: false,
      error: message,
    });
  }
});

app.use('/', routes);
app.use('/api', routes);

module.exports = app;

if (require.main === module) {
  app.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`ClearMarine API listening on http://localhost:${PORT} (Roboflow + ElevenLabs STT/TTS)`);
  });
}
