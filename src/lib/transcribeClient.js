/**
 * Forwards recorded audio to the Express backend, which calls ElevenLabs STT.
 * If REACT_APP_BACKEND_URL is unset, same-origin /api is used (Vercel single-app mode).
 */
function getBackendBase() {
  const raw = (process.env.REACT_APP_BACKEND_URL || '').trim().replace(/\/$/, '');
  if (raw) return raw;
  return '/api';
}

/** Clear message when fetch fails (often backend not running locally or wrong URL in prod). */
function voiceNetworkErrorHint(path, cause) {
  const base = getBackendBase();
  const host = typeof window !== 'undefined' ? window.location?.hostname : '';
  const isLocalRelative = (host === 'localhost' || host === '127.0.0.1') && base.startsWith('/');
  const bits = [
    `Could not reach voice API (${base}${path}).`,
    isLocalRelative
      ? 'Start the API in another terminal: npm run start:api (listens on port 8787). CRA proxies /api → that server.'
      : 'On Vercel: confirm ELEVENLABS_KEY is set and redeploy; open /api/health to verify.',
  ];
  if (cause && String(cause).trim()) bits.push(String(cause).slice(0, 120));
  return bits.join(' ');
}

/** Filename must match container (ElevenLabs rejects e.g. webm bytes named .webm mismatch with mp4). */
export function guessAudioFilename(blob) {
  const raw = (blob && blob.type ? blob.type : '').split(';')[0].trim().toLowerCase();
  if (raw === 'audio/webm') return 'recording.webm';
  if (raw === 'audio/mp4' || raw === 'audio/x-m4a') return 'recording.m4a';
  if (raw === 'audio/mp3' || raw === 'audio/mpeg') return 'recording.mp3';
  if (raw === 'audio/ogg') return 'recording.ogg';
  if (raw === 'audio/wav') return 'recording.wav';
  if (raw.startsWith('audio/')) return `recording.${raw.replace(/^audio\//, '').split('+')[0]}`;
  return 'recording.webm';
}

function stringifyTranscribeError(err) {
  if (err == null) return '';
  if (typeof err === 'string') return err;
  if (typeof err === 'object') {
    /** ElevenLabs-style: { detail: { message, code } } */
    const det = err.detail;
    if (det && typeof det === 'object' && typeof det.message === 'string') return det.message;
    if (typeof err.message === 'string') return err.message;
    try {
      return JSON.stringify(err);
    } catch {
      return String(err);
    }
  }
  return String(err);
}

/** Browser built-in TTS — works after a user tap; good fallback when ElevenLabs autoplay is blocked. */
export function speakWithWebSpeech(text) {
  return new Promise((resolve, reject) => {
    if (typeof window === 'undefined' || !window.speechSynthesis) {
      reject(new Error('Web Speech API not available in this browser'));
      return;
    }
    const line = String(text || '').trim().slice(0, 500);
    if (!line) {
      resolve();
      return;
    }
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(line);
    u.rate = 1;
    u.onend = () => resolve();
    u.onerror = () => reject(new Error('Web Speech playback failed'));
    window.speechSynthesis.speak(u);
  });
}

/**
 * Speak text: try ElevenLabs (backend /tts), then Web Speech on failure or autoplay block.
 * @param {string} text
 * @param {{ preferElevenLabs?: boolean, webSpeechFallback?: boolean }} [options]
 * @returns {Promise<{ ok: boolean, needsTap?: boolean, objectUrl?: string, usedWebSpeech?: boolean, error?: string }>}
 */
export async function speakAloud(text, options = {}) {
  const { preferElevenLabs = true, webSpeechFallback = true } = options;
  const trimmed = String(text || '').trim().slice(0, 2500);
  if (!trimmed) return { ok: true };

  const base = getBackendBase();
  const tryWeb = async () => {
    if (!webSpeechFallback) return { ok: false, error: 'ElevenLabs unavailable and speech fallback disabled' };
    try {
      await speakWithWebSpeech(trimmed);
      return { ok: true, usedWebSpeech: true };
    } catch (e) {
      return { ok: false, error: String(e?.message || e) };
    }
  };

  if (!preferElevenLabs || !base) {
    return tryWeb();
  }

  try {
    let res;
    try {
      res = await fetch(`${base}/tts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: trimmed }),
      });
    } catch (netErr) {
      return { ok: false, error: voiceNetworkErrorHint('/tts', netErr) };
    }

    const ct = res.headers.get('Content-Type') || '';
    if (!res.ok) {
      let errMsg = `Speech failed (${res.status})`;
      if (ct.includes('application/json')) {
        const j = await res.json().catch(() => ({}));
        errMsg = stringifyTranscribeError(j.error) || errMsg;
      } else {
        const t = await res.text();
        if (t) errMsg = t.slice(0, 400);
      }
      const w = await tryWeb();
      return w.ok ? { ...w, error: errMsg } : { ok: false, error: `${errMsg}; ${w.error || ''}` };
    }

    const blob = await res.blob();
    const blobType = blob.type || '';
    if (blobType.includes('json') || blob.size < 64) {
      const errTxt = await blob.text().catch(() => '');
      const w = await tryWeb();
      return w.ok ? w : { ok: false, error: errTxt.slice(0, 200) || 'Invalid TTS response' };
    }

    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    audio.playsInline = true;
    if (audio.setAttribute) audio.setAttribute('playsinline', 'true');

    try {
      await audio.play();
    } catch (playErr) {
      const name = playErr?.name || '';
      const msg = String(playErr?.message || '');
      if (name === 'NotAllowedError' || /not allowed|user gesture|interact/i.test(msg)) {
        return { ok: false, needsTap: true, objectUrl: url };
      }
      URL.revokeObjectURL(url);
      return tryWeb();
    }

    try {
      await new Promise((resolve, reject) => {
        audio.onended = () => {
          URL.revokeObjectURL(url);
          resolve();
        };
        audio.onerror = () => {
          URL.revokeObjectURL(url);
          reject(new Error('Audio playback failed'));
        };
      });
      return { ok: true };
    } catch {
      return tryWeb();
    }
  } catch (e) {
    const w = await tryWeb();
    return w.ok ? { ...w, error: String(e?.message || e) } : { ok: false, error: String(e?.message || e) };
  }
}

/** @deprecated Use speakAloud — kept for imports; always allows Web Speech fallback. */
export async function speakTextWithElevenLabs(text) {
  return speakAloud(text, { preferElevenLabs: true, webSpeechFallback: true });
}

export async function transcribeAudioBlob(blob, filename) {
  const base = getBackendBase();
  const name = filename || guessAudioFilename(blob);
  const fd = new FormData();
  fd.append('file', blob, name);
  let res;
  try {
    res = await fetch(`${base}/transcribe`, { method: 'POST', body: fd });
  } catch (netErr) {
    throw new Error(voiceNetworkErrorHint('/transcribe', netErr));
  }
  const rawText = await res.text();
  let data = {};
  try {
    data = rawText ? JSON.parse(rawText) : {};
  } catch {
    data = { error: rawText?.slice(0, 500) || 'Invalid JSON from transcribe endpoint' };
  }
  if (!res.ok) {
    const nested = data.error ?? data;
    const msg =
      stringifyTranscribeError(nested)
      || stringifyTranscribeError(data)
      || rawText?.slice(0, 300)
      || `Transcription failed (${res.status})`;
    throw new Error(msg);
  }
  const text = typeof data.text === 'string' ? data.text.trim() : '';
  if (!text) throw new Error('Transcription returned empty text');
  return text;
}
