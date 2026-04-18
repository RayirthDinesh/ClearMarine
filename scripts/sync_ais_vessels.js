/**
 * AIS → Supabase for Plastic Odyssey
 *
 *   AIS_BACKEND=marinetraffic  — REST `GET /exportvessel/{api_key}` per
 *     reference/marinetraffic-ais-openapi.json (MarineTraffic; key from account, not from the spec).
 *   AIS_BACKEND=aisstream (default) — websocket aisstream.io (see their docs).
 *
 *   npm run sync-ais
 *   npm run aisstream   (AISSTREAM_DAEMON / --daemon, only for aisstream backend)
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const WebSocket = require('ws');
const { createClient } = require('@supabase/supabase-js');
const { fetchExportVessel } = require('./marinetraffic_export_vessel');

const BACKEND = (process.env.AIS_BACKEND || 'aisstream').toLowerCase();

const AISSTREAM_URL = 'wss://stream.aisstream.io/v0/stream';
const MMSI = String(process.env.PLASTIC_ODYSSEY_MMSI || '228379700').trim();
const IMO = String(process.env.PLASTIC_ODYSSEY_IMO || '7360655').trim();

const AISSTREAM_KEY = String(
  process.env.AISSTREAM_API_KEY || process.env.AIS_API_KEY || '',
).trim();

const MARINETRAFFIC_KEY = String(
  process.env.MARINETRAFFIC_API_KEY || process.env.AIS_API_KEY || '',
).trim();

const SUPABASE_URL = process.env.REACT_APP_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.REACT_APP_SUPABASE_ANON_KEY;

const DAEMON =
  process.argv.includes('--daemon')
  || process.env.AISSTREAM_DAEMON === '1'
  || process.env.AISSTREAM_DAEMON === 'true';

const ONCE_TIMEOUT_MS = Math.max(
  15000,
  parseInt(process.env.AISSTREAM_ONCE_TIMEOUT_MS || '120000', 10) || 120000,
);

const DEBOUNCE_MS = parseInt(process.env.AISSTREAM_DEBOUNCE_MS || '8000', 10) || 8000;

const POSITION_MESSAGE_TYPES = [
  'PositionReport',
  'StandardClassBPositionReport',
  'ExtendedClassBPositionReport',
];

/** AIS docs: pair with PositionReport for labeled markers (names from static + cache on position metadata). */
const STATIC_MESSAGE_TYPES = ['ShipStaticData'];

function subscriptionPayload(key) {
  return {
    APIKey: key,
    BoundingBoxes: [[[-90, -180], [90, 180]]],
    FiltersShipMMSI: [MMSI],
    FilterMessageTypes: [...POSITION_MESSAGE_TYPES, ...STATIC_MESSAGE_TYPES],
  };
}

function parseAisUtc(meta) {
  if (!meta || !meta.time_utc) return new Date().toISOString();
  const raw = String(meta.time_utc);
  const d = new Date(raw.replace(' ', 'T').replace(' +0000 UTC', 'Z'));
  return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

function extractPosition(msg) {
  const t = msg.MessageType;
  if (!t || !POSITION_MESSAGE_TYPES.includes(t)) return null;
  const body = msg.Message && msg.Message[t];
  if (!body || body.Latitude == null || body.Longitude == null) return null;
  const uid = body.UserID != null ? String(body.UserID) : null;
  if (!uid || uid !== MMSI) return null;

  return {
    lat: Number(body.Latitude),
    lon: Number(body.Longitude),
    sog: body.Sog != null ? Number(body.Sog) : null,
    cog: body.Cog != null ? Number(body.Cog) : null,
    ais_timestamp: parseAisUtc(msg.MetaData || msg.Metadata),
  };
}

/** Ship name from AIS message 5 — trim AIS padding (`@`). */
function extractStaticShipName(msg) {
  if (msg.MessageType !== 'ShipStaticData') return null;
  const body = msg.Message && msg.Message.ShipStaticData;
  const meta = msg.MetaData || msg.Metadata;
  const uid = body && body.UserID != null ? String(body.UserID) : null;
  if (!uid || uid !== MMSI) return null;
  const raw =
    (body.Name && String(body.Name).trim())
    || (meta && meta.ShipName && String(meta.ShipName).trim())
    || '';
  const name = raw.replace(/@+$/g, '').trim();
  return name.length > 0 ? name : null;
}

async function updateSupabase(supabase, data) {
  const update = { updated_at: new Date().toISOString() };
  if (data.name) update.name = data.name;
  if (data.imo != null && String(data.imo) !== '0') update.imo = String(data.imo);
  if (data.lat != null && data.lon != null) {
    update.current_lat = data.lat;
    update.current_lon = data.lon;
    update.sog = data.sog;
    update.cog = data.cog;
    update.ais_timestamp = data.ais_timestamp;
    if (update.imo == null) update.imo = IMO;
  }

  const { data: existing, error: selErr } = await supabase
    .from('vessels')
    .select('id')
    .eq('mmsi', MMSI)
    .maybeSingle();

  if (selErr) {
    const msg = selErr.message || '';
    if (/column .*mmsi|does not exist/i.test(msg)) {
      throw new Error(
        `${msg} — run the ALTER statements in README (Database Schema) or re-apply supabase_schema.sql so vessels has mmsi.`,
      );
    }
    throw new Error(msg);
  }
  if (!existing) throw new Error(`No vessel row with mmsi=${MMSI}. Run supabase_schema.sql seed.`);

  const { error: upErr } = await supabase.from('vessels').update(update).eq('id', existing.id);
  if (upErr) throw new Error(upErr.message);
}

async function runMarineTrafficOnce() {
  if (!MARINETRAFFIC_KEY) {
    console.error(
      'Missing MARINETRAFFIC_API_KEY (or AIS_API_KEY). '
      + 'The OpenAPI file does not contain secrets — copy your 40-character service key from '
      + 'MarineTraffic My Account → API Services.',
    );
    process.exit(1);
  }
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error('Missing REACT_APP_SUPABASE_URL or Supabase key.');
    process.exit(1);
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
  console.log('MarineTraffic exportvessel — fetching latest position…');
  const pos = await fetchExportVessel({
    apiKey: MARINETRAFFIC_KEY,
    mmsi: MMSI,
  });
  await updateSupabase(supabase, pos);
  console.log(
    `Supabase ← MarineTraffic MMSI ${MMSI}: ${pos.lat.toFixed(5)}, ${pos.lon.toFixed(5)}`
    + (pos.sog != null ? ` · ${pos.sog.toFixed(1)} kn` : ''),
  );
}

async function runAisstream() {
  if (!AISSTREAM_KEY) {
    console.error(
      'Missing AISSTREAM_API_KEY or AIS_API_KEY for AISStream. '
      + 'Or set AIS_BACKEND=marinetraffic and MARINETRAFFIC_API_KEY for REST per reference/marinetraffic-ais-openapi.json.',
    );
    process.exit(1);
  }
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error('Missing REACT_APP_SUPABASE_URL or Supabase key.');
    process.exit(1);
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
  const ws = new WebSocket(AISSTREAM_URL);

  let finished = false;
  let lastPush = 0;
  let onceTimer = null;

  const doneOnce = (err) => {
    if (finished) return;
    finished = true;
    if (onceTimer) clearTimeout(onceTimer);
    try {
      ws.close();
    } catch (_) { /* noop */ }
    if (err) {
      console.error(err.message || err);
      process.exit(1);
    }
    process.exit(0);
  };

  if (!DAEMON) {
    onceTimer = setTimeout(() => {
      doneOnce(new Error(
        `No AIS position for MMSI ${MMSI} within ${ONCE_TIMEOUT_MS / 1000}s. `
        + 'Ship may be out of terrestrial AIS range, or MMSI/bbox filters need review.',
      ));
    }, ONCE_TIMEOUT_MS);
  }

  ws.on('open', () => {
    ws.send(JSON.stringify(subscriptionPayload(AISSTREAM_KEY)));
    console.log(DAEMON ? 'AISStream connected — streaming (Ctrl+C to stop)…' : 'AISStream connected — waiting for first position…');
  });

  ws.on('message', async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (msg.error) {
      console.error('AISStream error:', msg.error);
      if (!DAEMON) doneOnce(new Error(msg.error));
      return;
    }

    const staticName = extractStaticShipName(msg);
    if (staticName) {
      const body = msg.Message && msg.Message.ShipStaticData;
      const imoFromAis = body && body.ImoNumber != null ? String(body.ImoNumber) : null;
      try {
        await updateSupabase(supabase, {
          name: staticName,
          imo: imoFromAis || undefined,
        });
        console.log(`Supabase ← AISStream static MMSI ${MMSI}: name "${staticName}"`);
      } catch (e) {
        if (!DAEMON) doneOnce(e);
        else console.error(e.message || e);
      }
    }

    const pos = extractPosition(msg);
    if (!pos) return;

    const now = Date.now();
    if (DAEMON && now - lastPush < DEBOUNCE_MS) return;
    lastPush = now;

    try {
      await updateSupabase(supabase, pos);
      console.log(`Supabase ← AISStream MMSI ${MMSI}: ${pos.lat.toFixed(5)}, ${pos.lon.toFixed(5)}`);
      if (!DAEMON) doneOnce(null);
    } catch (e) {
      if (!DAEMON) doneOnce(e);
      else console.error(e.message || e);
    }
  });

  ws.on('error', (e) => {
    console.error('WebSocket error:', e.message || e);
    if (!DAEMON) doneOnce(e);
  });

  ws.on('close', () => {
    if (DAEMON && !finished) {
      console.log('AISStream connection closed.');
      process.exit(0);
    }
  });

  if (DAEMON) {
    process.on('SIGINT', () => {
      finished = true;
      ws.close();
      process.exit(0);
    });
  }
}

async function main() {
  if (BACKEND === 'marinetraffic') {
    await runMarineTrafficOnce();
    return;
  }
  if (BACKEND !== 'aisstream') {
    console.error(`Unknown AIS_BACKEND "${BACKEND}". Use "aisstream" or "marinetraffic".`);
    process.exit(1);
  }
  await runAisstream();
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
