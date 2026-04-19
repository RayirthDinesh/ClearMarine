import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { MapContainer, TileLayer, Marker, Polyline, Popup, Circle, useMapEvents, useMap } from 'react-leaflet';
import L from 'leaflet';
import { supabase } from '../lib/supabase';
import { getCrewSuggestions, generateHandoffBrief, generateAssignmentBrief } from '../lib/gemini';
import { getInterceptionPoint } from '../lib/drift';
import { computePacificLandfallDisplay, shouldShowSightingOnDashboard } from '../lib/landfall';
import { driftSegmentsForMap } from '../lib/mapPath';
import { routeAroundLand } from '../lib/oceanWaypoints';
import { formatCoordPair } from '../lib/coords';
import { classifyPickupMode, pickupBadgeClassName } from '../lib/pickupClassification';
import { rankCrewsForSighting, formatEtaShort } from '../lib/cleanupTime';
import { synthesizeShoreStationForSighting, isSyntheticShoreId } from '../lib/shoreStations';
import {
  applyDeliveredSupplyOrders,
  insertSupplyOrder,
  computeReorderQuantity,
  formatEtaHuman,
  formatCountdownTo,
} from '../lib/supplyOrders';

delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: require('leaflet/dist/images/marker-icon-2x.png'),
  iconUrl: require('leaflet/dist/images/marker-icon.png'),
  shadowUrl: require('leaflet/dist/images/marker-shadow.png'),
});

if (typeof document !== 'undefined' && !document.getElementById('cm-pulse-style')) {
  const style = document.createElement('style');
  style.id = 'cm-pulse-style';
  style.textContent = [
    '@keyframes cm-pulse { 0%,100% { transform: scale(1); opacity: 1; } 50% { transform: scale(1.18); opacity: 0.75; } }',
    '@keyframes cm-pop { 0% { transform: scale(0.85); } 60% { transform: scale(1.4); } 100% { transform: scale(1.25); } }',
    '@keyframes cm-dots { 0%,20% { opacity: 0.2; } 50% { opacity: 1; } 100% { opacity: 0.2; } }',
  ].join('\n');
  document.head.appendChild(style);
}

/** Status indicator color used across markers for the "assigned / dispatched" state. */
const STATUS_BLUE = '#3b82f6';
/** Status indicator color used for shore crews that are idle and ready to dispatch. */
const STATUS_GREEN = '#22c55e';

/** Stable palette used to color-link a sighting and the crew/vessel working it. */
const MISSION_PALETTE = ['#22d3ee', '#a855f7', '#f59e0b', '#10b981', '#f43f5e', '#3b82f6', '#eab308', '#ec4899'];

/** Hash an assignment id to a stable palette index so the same mission always gets the same color. */
function colorForMissionId(missionId) {
  if (!missionId) return null;
  let hash = 0;
  for (let i = 0; i < missionId.length; i += 1) hash = (hash * 31 + missionId.charCodeAt(i)) >>> 0;
  return MISSION_PALETTE[hash % MISSION_PALETTE.length];
}

/**
 * Severity-coloured debris dot.
 * - `assigned` swaps the white outline for a blue ring so an in-progress sighting reads as "claimed".
 * - `selected` triggers a one-shot pop and locks in a larger steady-state size.
 * - `missionColor` (only when a specific mission is selected) layers a coloured pulsing halo for cross-marker linkage.
 */
const debrisIcon = ({ score, assigned = false, selected = false, missionColor = null } = {}) => {
  const fill = score >= 8 ? '#dc2626' : score >= 6 ? '#ea580c' : score >= 3 ? '#ca8a04' : '#16a34a';
  const baseSize = assigned ? 20 : 16;
  const size = selected ? 32 : baseSize;
  const ringColor = assigned ? STATUS_BLUE : (selected ? '#22d3ee' : 'white');
  const ringWidth = assigned ? 3 : selected ? 3 : 2;
  const innerGlow = assigned
    ? `0 0 10px ${STATUS_BLUE}cc`
    : selected
      ? '0 0 10px rgba(34,211,238,0.6)'
      : '0 0 4px rgba(0,0,0,0.5)';
  const popAnim = selected ? 'animation: cm-pop 0.28s ease-out forwards;' : '';
  const dot = `<div style="width:${size}px;height:${size}px;border-radius:50%;background:${fill};border:${ringWidth}px solid ${ringColor};box-shadow:${innerGlow};${popAnim}"></div>`;
  // Mission color halo only when a mission is actively selected — keeps the link readable without overwhelming the assigned blue ring.
  const halo = (selected && missionColor)
    ? `<div style="position:absolute;inset:-6px;border-radius:50%;border:3px solid ${missionColor};box-shadow:0 0 14px ${missionColor}cc;animation:cm-pulse 1.6s ease-in-out infinite;pointer-events:none;"></div>`
    : '';
  const wrap = halo
    ? `<div style="position:relative;width:${size}px;height:${size}px;display:flex;align-items:center;justify-content:center;">${halo}${dot}</div>`
    : dot;
  return L.divIcon({
    className: '',
    html: wrap,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
};

/**
 * Vessel marker.
 * - `state`: 'idle' (gray), 'en_route' (blue, in-flight), 'on_site' (blue + animated `…` loader on top until completed).
 * - `missionColor` + `selected` keeps the existing per-mission ring on top of the blue base.
 */
const vesselIcon = ({ state = 'idle', missionColor = null, selected = false } = {}) => {
  const baseSize = state === 'idle' ? 24 : 28;
  const size = selected ? Math.round(baseSize * 1.3) : baseSize;
  const ringColor = state === 'idle' ? 'rgba(255,255,255,0.5)' : STATUS_BLUE;
  const ringFill = state === 'idle' ? 'rgba(255,255,255,0.08)' : `${STATUS_BLUE}33`;
  const ringGlow = state === 'idle' ? '0 0 4px rgba(0,0,0,0.5)' : `0 0 12px ${STATUS_BLUE}aa`;
  const baseRing = `<div style="position:absolute;inset:0;border-radius:50%;border:2px solid ${ringColor};background:${ringFill};box-shadow:${ringGlow};"></div>`;
  const missionRing = (missionColor && selected)
    ? `<div style="position:absolute;inset:-5px;border-radius:50%;border:3px solid ${missionColor};box-shadow:0 0 14px ${missionColor}cc;animation:cm-pulse 1.6s ease-in-out infinite;pointer-events:none;"></div>`
    : '';
  const popAnim = selected ? 'animation: cm-pop 0.28s ease-out forwards;' : '';
  const hullFilter = state === 'idle'
    ? 'drop-shadow(0 1px 2px rgba(0,0,0,0.8))'
    : `drop-shadow(0 0 6px ${STATUS_BLUE}) drop-shadow(0 1px 2px rgba(0,0,0,0.8))`;
  const dots = state === 'on_site'
    ? `<div style="position:absolute;left:50%;top:-14px;transform:translateX(-50%);display:flex;gap:2px;padding:2px 5px;border-radius:8px;background:rgba(15,23,42,0.85);border:1px solid ${STATUS_BLUE};box-shadow:0 0 8px ${STATUS_BLUE}aa;">
        <span style="width:4px;height:4px;border-radius:50%;background:${STATUS_BLUE};animation:cm-dots 1.2s ease-in-out infinite;"></span>
        <span style="width:4px;height:4px;border-radius:50%;background:${STATUS_BLUE};animation:cm-dots 1.2s ease-in-out 0.2s infinite;"></span>
        <span style="width:4px;height:4px;border-radius:50%;background:${STATUS_BLUE};animation:cm-dots 1.2s ease-in-out 0.4s infinite;"></span>
      </div>`
    : '';
  return L.divIcon({
    className: '',
    html: `<div style="position:relative;width:${size}px;height:${size}px;display:flex;align-items:center;justify-content:center;${popAnim}">${missionRing}${baseRing}${dots}<div style="position:relative;font-size:${Math.round(size * 0.72)}px;line-height:1;filter:${hullFilter};">🚢</div></div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
};

/**
 * Shore-crew marker.
 * - `state`: 'idle' → green outline, 'assigned' → blue outline.
 * - `missionColor` + `selected` keeps the existing per-mission halo for cross-marker linkage when a mission is highlighted.
 */
const landCrewIcon = ({ state = 'idle', missionColor = null, selected = false } = {}) => {
  const baseSize = 26;
  const size = selected ? Math.round(baseSize * 1.3) : baseSize;
  const ringColor = state === 'assigned' ? STATUS_BLUE : STATUS_GREEN;
  const ringFill = state === 'assigned' ? `${STATUS_BLUE}33` : `${STATUS_GREEN}33`;
  const ringGlow = state === 'assigned' ? `0 0 12px ${STATUS_BLUE}aa` : `0 0 8px ${STATUS_GREEN}aa`;
  const baseRing = `<div style="position:absolute;inset:0;border-radius:50%;border:2px solid ${ringColor};background:${ringFill};box-shadow:${ringGlow};"></div>`;
  const missionRing = (missionColor && selected)
    ? `<div style="position:absolute;inset:-5px;border-radius:50%;border:3px solid ${missionColor};box-shadow:0 0 14px ${missionColor}cc;animation:cm-pulse 1.6s ease-in-out infinite;pointer-events:none;"></div>`
    : '';
  const popAnim = selected ? 'animation: cm-pop 0.28s ease-out forwards;' : '';
  return L.divIcon({
    className: '',
    html: `<div style="position:relative;width:${size}px;height:${size}px;display:flex;align-items:center;justify-content:center;${popAnim}">${missionRing}${baseRing}<div style="position:relative;font-size:${Math.round(size * 0.62)}px;line-height:1;">🥾</div></div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
};

const landfallIcon = L.divIcon({
  className: '',
  html: `<div style="font-size:18px;line-height:1;filter:drop-shadow(0 1px 2px rgba(0,0,0,0.8))">⚑</div>`,
  iconSize: [18, 18],
  iconAnchor: [9, 9],
});

/** One ops center; second row is a typical federal partner (hazmat / offshore rules), not a separate product. */
const AGENCIES = ['ClearMarine Operations', 'EPA (partner)'];

const densityBadge = (score, label) => {
  if (label === 'Unverified') return 'bg-slate-600 text-slate-100';
  if (score >= 8) return 'bg-red-600 text-white';
  if (score >= 6) return 'bg-orange-500 text-white';
  if (score >= 3) return 'bg-yellow-500 text-black';
  return 'bg-green-600 text-white';
};

function approxOnPath(lat, lon, pathPoints, eps = 0.025) {
  return pathPoints.some(([la, lo]) => Math.abs(la - lat) < eps && Math.abs(lo - lon) < eps);
}


function CoordTracker({ onMove, onMapClick }) {
  useMapEvents({
    mousemove: (e) => onMove({ lat: e.latlng.lat, lng: e.latlng.lng }),
    mouseout: () => onMove(null),
    click: (e) => { if (onMapClick) onMapClick({ lat: e.latlng.lat, lng: e.latlng.lng }); },
  });
  return null;
}

function MapFlyTo({ target }) {
  const map = useMap();
  useEffect(() => {
    if (!target) return;
    const z = target.zoom ?? 10;
    map.flyTo([target.lat, target.lon], z, { duration: 1.2 });
  }, [target, map]);
  return null;
}

/**
 * Visual demo travel time for an animated vessel — real assignment durations are hours,
 * but for the dashboard we collapse the trip to a few seconds so the operator actually sees motion.
 */
const VESSEL_TRAVEL_MS = 18000;

/**
 * Animate ship vessels along a great-circle from their dispatch origin to the interception point.
 * Returns an array of { assignmentId, vesselId, lat, lon, arrived, mission } updated each animation frame.
 *
 * Pure visual layer — no DB writes, vessel `current_lat/lon` is unchanged.
 *  - The animation start time is anchored to the assignment's persistent `created_at` timestamp,
 *    so a refresh in the middle of the trip resumes from the correct progress (and an old
 *    assignment whose elapsed time already exceeds VESSEL_TRAVEL_MS snaps directly to "on_site"
 *    without re-playing the trip).
 *  - Each frame we linearly interpolate along the densified great-circle polyline by
 *    `(now - startedAtMs) / VESSEL_TRAVEL_MS`.
 *  - When `t >= 1` the vessel "arrives" (locked at destination) and the marker shows the `…` loader
 *    until the assignment moves to `completed`, at which point the entry is dropped.
 */
function useAnimatedVessels(ongoingMissions) {
  const tracksRef = useRef(new Map());
  const [tick, setTick] = useState(0);
  const rafRef = useRef(null);
  const liveIdsRef = useRef(new Set());

  // Reconcile tracks against the current set of open ship missions whenever they change.
  const shipMissionsKey = useMemo(() => {
    return ongoingMissions
      .filter((m) => m.crewType === 'ship' && m.vessel
        && Number.isFinite(m.vessel.current_lat) && Number.isFinite(m.vessel.current_lon)
        && Number.isFinite(m.assignment.interception_lat) && Number.isFinite(m.assignment.interception_lon))
      .map((m) => `${m.id}:${m.assignment.status}`)
      .join('|');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ongoingMissions]);

  useEffect(() => {
    const tracks = tracksRef.current;
    const live = new Set();
    const nowMs = Date.now();
    for (const m of ongoingMissions) {
      if (m.crewType !== 'ship' || !m.vessel) continue;
      const { current_lat: vLat, current_lon: vLon } = m.vessel;
      const { interception_lat: iLat, interception_lon: iLon, status, created_at } = m.assignment;
      if (![vLat, vLon, iLat, iLon].every(Number.isFinite)) continue;
      live.add(m.id);
      const existing = tracks.get(m.id);
      if (!existing) {
        // First time we see this mission — bake a water-only path (using ocean waypoints
        // to detour around continents when needed) and anchor the animation start to the
        // DB `created_at`, falling back to "now" if missing.
        const routed = routeAroundLand([vLat, vLon], [iLat, iLon]);
        const parsed = created_at ? Date.parse(created_at) : NaN;
        const startedAtMs = Number.isFinite(parsed) ? parsed : nowMs;
        const elapsed = nowMs - startedAtMs;
        let path;
        let arrived;
        if (!Array.isArray(routed) || routed.length < 2) {
          // No water-only route exists — teleport the vessel to the destination
          // instead of glitching across continents.
          path = [[iLat, iLon]];
          arrived = true;
        } else {
          path = routed;
          // If the assignment was created long enough ago that the trip would have
          // finished, OR the assignment has already moved past en_route, snap to "on_site".
          arrived = status === 'intercepted' || elapsed >= VESSEL_TRAVEL_MS;
        }
        tracks.set(m.id, {
          assignmentId: m.id,
          vesselId: m.vessel.id,
          path,
          startedAtMs,
          arrived,
        });
      } else if (status === 'intercepted' && !existing.arrived) {
        existing.arrived = true;
      }
    }
    // Drop tracks for missions that have been completed / removed.
    for (const id of Array.from(tracks.keys())) {
      if (!live.has(id)) tracks.delete(id);
    }
    liveIdsRef.current = live;
    setTick((n) => n + 1); // ensure consumers re-render after reconciliation
  }, [shipMissionsKey, ongoingMissions]);

  // Drive the animation frame loop only while at least one vessel is still in flight.
  useEffect(() => {
    const step = () => {
      const tracks = tracksRef.current;
      let anyMoving = false;
      const now = Date.now();
      for (const t of tracks.values()) {
        if (t.arrived) continue;
        const progress = Math.min(1, (now - t.startedAtMs) / VESSEL_TRAVEL_MS);
        if (progress >= 1) t.arrived = true;
        else anyMoving = true;
      }
      setTick((n) => n + 1);
      if (anyMoving) rafRef.current = requestAnimationFrame(step);
      else rafRef.current = null;
    };
    // Kick the loop if we have any in-flight tracks.
    let needsFrame = false;
    for (const t of tracksRef.current.values()) {
      if (!t.arrived) { needsFrame = true; break; }
    }
    if (needsFrame && rafRef.current == null) {
      rafRef.current = requestAnimationFrame(step);
    }
    return () => {
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [tick]);

  // Project tracks to current frame positions for the renderer.
  return useMemo(() => {
    const out = [];
    const now = Date.now();
    for (const m of ongoingMissions) {
      const t = tracksRef.current.get(m.id);
      if (!t || !Array.isArray(t.path) || t.path.length === 0) continue;
      const progress = t.arrived
        ? 1
        : Math.min(1, Math.max(0, (now - t.startedAtMs) / VESSEL_TRAVEL_MS));
      const path = t.path;
      const last = path.length - 1;
      const pos = (progress >= 1 || path.length === 1)
        ? path[last]
        : interpolateAlongPath(path, progress);
      if (!Array.isArray(pos) || pos.length < 2 || !Number.isFinite(pos[0]) || !Number.isFinite(pos[1])) continue;
      out.push({
        assignmentId: t.assignmentId,
        vesselId: t.vesselId,
        lat: pos[0],
        lon: pos[1],
        arrived: progress >= 1,
        mission: m,
      });
    }
    return out;
    // tick is a render trigger — depend on it so the projected positions stay live.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick, ongoingMissions]);
}

/** Linear interpolation along a densified [lat, lon] polyline by normalized progress (0..1). */
function interpolateAlongPath(path, progress) {
  if (!Array.isArray(path) || path.length === 0) return null;
  if (path.length === 1) return path[0];
  const total = path.length - 1;
  const clamped = Math.min(1, Math.max(0, Number.isFinite(progress) ? progress : 0));
  const idx = clamped * total;
  const lo = Math.max(0, Math.min(total - 1, Math.floor(idx)));
  const hi = Math.min(total, lo + 1);
  const a = path[lo];
  const b = path[hi];
  if (!Array.isArray(a) || !Array.isArray(b)) return path[total];
  const frac = idx - lo;
  return [a[0] + (b[0] - a[0]) * frac, a[1] + (b[1] - a[1]) * frac];
}

export default function Dashboard() {
  const [searchParams] = useSearchParams();
  const [sightings, setSightings] = useState([]);
  const [vessels, setVessels] = useState([]);
  const [landCrews, setLandCrews] = useState([]);
  const [drifts, setDrifts] = useState([]);
  const [assignments, setAssignments] = useState([]);
  const [selectedMissionId, setSelectedMissionId] = useState(null);
  const [supplies, setSupplies] = useState([]);
  const [supplyOrders, setSupplyOrders] = useState([]);
  const [supplySubmitId, setSupplySubmitId] = useState(null);
  const [orderBanner, setOrderBanner] = useState(null);
  const [pendingHandoffs, setPendingHandoffs] = useState([]);
  const [aiSuggestions, setAiSuggestions] = useState([]);
  const [newAssignToast, setNewAssignToast] = useState(null);
  const toastTimerRef = useRef(null);

  const showAssignToast = useCallback((label, detail, type = 'assignment') => {
    setNewAssignToast({ label, detail, type });
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setNewAssignToast(null), 5000);
  }, []);
  const [aiLoading, setAiLoading] = useState(false);
  const [executingAction, setExecutingAction] = useState(null);
  const [assignModal, setAssignModal] = useState(null);
  const [handoffModal, setHandoffModal] = useState(null);
  const [briefModal, setBriefModal] = useState(null);
  /** Selected crew option from the assign modal: { type: 'ship'|'land', id, est } where est is a row from cleanupTime.rankCrewsForSighting. */
  const [selectedCrew, setSelectedCrew] = useState(null);
  const [activeTab, setActiveTab] = useState('sightings');
  const [myAgency, setMyAgency] = useState('ClearMarine Operations');
  const [selectedSightingId, setSelectedSightingId] = useState(null);
  const [mapFlyTarget, setMapFlyTarget] = useState(null);
  const [hoverCoords, setHoverCoords] = useState(null);
  const [clickCoords, setClickCoords] = useState(null);
  /** Drives 1s re-renders for live supply arrival countdowns (Supplies tab). */
  const [, setSupplyCountdownTick] = useState(0);

  /** URL params from a just-submitted report: fly map there on load. */
  const focusLat = parseFloat(searchParams.get('lat'));
  const focusLon = parseFloat(searchParams.get('lon'));
  const hasFocusTarget = Number.isFinite(focusLat) && Number.isFinite(focusLon);

  const myAgencyRef = useRef('ClearMarine Operations');
  const sightingRefs = useRef({});
  const sightingsDataRef = useRef([]);
  const vesselsDataRef = useRef([]);
  const landCrewsDataRef = useRef([]);
  const driftsDataRef = useRef([]);
  const assignmentsDataRef = useRef([]);
  const pendingHandoffsRef = useRef([]);
  const suppliesDataRef = useRef([]);
  const aiRefreshTimerRef = useRef(null);
  /** AI suggestion that opened the current assignModal — removed only on confirm, kept on Cancel. */
  const pendingAiSuggestionRef = useRef(null);

  const fetchData = useCallback(async () => {
    // Mark in-transit supply orders as 'delivered' once their ETA passes (idempotent).
    await applyDeliveredSupplyOrders(supabase);
    const [sRes, vRes, lcRes, dRes, aRes, supRes, ordRes] = await Promise.all([
      supabase.from('debris_sightings').select('*').neq('status', 'cleared').order('density_score', { ascending: false }),
      supabase.from('vessels').select('*').order('zone'),
      supabase.from('land_crews').select('*').order('name'),
      supabase.from('drift_predictions').select('*'),
      supabase.from('assignments').select('*').neq('status', 'completed'),
      supabase.from('supplies').select('*').order('zone'),
      supabase.from('supply_orders').select('*').eq('status', 'in_transit').order('expected_arrival_at'),
    ]);
    if (sRes.data) {
      const active = sRes.data.filter((s) =>
        s.handoff_status !== 'pending' && s.jurisdiction === myAgencyRef.current,
      );
      const incoming = sRes.data.filter((s) => (
        s.handoff_status === 'pending'
        && s.jurisdiction === myAgencyRef.current
        && s.source_jurisdiction !== myAgencyRef.current
      ));
      setSightings(active);
      setPendingHandoffs(incoming);
      sightingsDataRef.current = active;
      pendingHandoffsRef.current = incoming;
    }
    if (vRes.data) { setVessels(vRes.data); vesselsDataRef.current = vRes.data; }
    if (lcRes.data) { setLandCrews(lcRes.data); landCrewsDataRef.current = lcRes.data; }
    if (dRes.data) { setDrifts(dRes.data); driftsDataRef.current = dRes.data; }
    if (aRes.data) { setAssignments(aRes.data); assignmentsDataRef.current = aRes.data; }
    if (supRes.data) {
      setSupplies(supRes.data);
      suppliesDataRef.current = supRes.data;
    }
    if (ordRes.error) {
      console.warn('supply_orders:', ordRes.error.message);
      setSupplyOrders([]);
    } else if (ordRes.data) setSupplyOrders(ordRes.data);
  }, []);

  const handlePlaceSupplyOrder = async (supply) => {
    setSupplySubmitId(supply.id);
    try {
      const { error, plan } = await insertSupplyOrder(supabase, supply);
      if (error) throw error;
      setOrderBanner({
        message: `Supplier order: +${plan.quantity} × ${supply.name} (${supply.zone})`,
        detail: `${plan.supplier_name} · ETA ${formatEtaHuman(plan.expected_arrival_at)} · ${plan.fulfillment_note}`,
      });
      await fetchData();
    } catch (e) {
      console.error(e);
      alert(
        `Could not place order (${e.message || 'unknown'}). `
        + 'If this is a fresh database, run the latest supabase_schema.sql (supply_orders table).',
      );
    } finally {
      setSupplySubmitId(null);
    }
  };

  const fireAiSuggestions = useCallback(async () => {
    const liveAssignments = assignmentsDataRef.current || [];
    const liveSupplies = suppliesDataRef.current || [];
    const hasLowSupplies = liveSupplies.some((s) => s.quantity <= s.low_threshold);

    // QUEUE = sightings not yet on an open assignment and not already cleaned up.
    // The AI must only recommend dispatch for items currently in this queue —
    // otherwise it keeps re-recommending hulls for sightings that are already assigned.
    const openSightingIds = new Set(
      liveAssignments
        .filter((a) => a.status !== 'completed')
        .map((a) => a.sighting_id),
    );
    const liveSightings = (sightingsDataRef.current || []).filter((s) => {
      if (openSightingIds.has(s.id)) return false;
      if (s.status === 'assigned' || s.status === 'intercepted') return false;
      return true;
    });
    const livePendingHandoffs = pendingHandoffsRef.current || [];

    if (
      liveSightings.length === 0
      && livePendingHandoffs.length === 0
      && !hasLowSupplies
    ) {
      // Nothing actionable — clear stale suggestions instead of holding them on screen.
      setAiSuggestions([]);
      return;
    }

    setAiLoading(true);
    // Build a fresh ranking map from refs so the AI prompt always sees current state.
    // Hoisted out of the try so the catch fallback can also use it.
    const liveVessels = vesselsDataRef.current || [];
    const liveLandCrews = landCrewsDataRef.current || [];
    const liveDrifts = driftsDataRef.current || [];
    const rankingsForAi = new Map();
    try {
      for (const s of liveSightings) {
        const drift = liveDrifts.find((d) => d.sighting_id === s.id) || null;
        const driftForPickup = drift ? {
          lat_24h: drift.lat_24h, lon_24h: drift.lon_24h,
          lat_48h: drift.lat_48h, lon_48h: drift.lon_48h,
          lat_72h: drift.lat_72h, lon_72h: drift.lon_72h,
        } : null;
        const pickup = classifyPickupMode(s.latitude, s.longitude, driftForPickup);
        const wantsShoreCrew = pickup.key === 'ship_coast' || pickup.key === 'land';
        const syntheticStation = wantsShoreCrew
          ? synthesizeShoreStationForSighting(s, driftForPickup)
          : null;
        const effectiveLandCrews = syntheticStation
          ? [syntheticStation, ...liveLandCrews]
          : liveLandCrews;
        const r = rankCrewsForSighting({
          pickupKey: pickup.key,
          sighting: s,
          vessels: liveVessels,
          landCrews: effectiveLandCrews,
          drift: driftForPickup,
        });
        rankingsForAi.set(s.id, r);
      }
      const result = await getCrewSuggestions({
        sightings: liveSightings,
        vessels: liveVessels,
        landCrews: liveLandCrews,
        assignments: liveAssignments,
        pendingHandoffs: livePendingHandoffs,
        crewRankings: rankingsForAi,
        supplies: liveSupplies,
      });
      let items = Array.isArray(result) ? result : [{ text: result, action_type: 'none' }];

      // Deterministic fallback: if every AI item is non-actionable (action_type "none" /
      // unknown / missing ids), synthesize concrete recommendations from the rankings we
      // already computed. Operators should never sit on a "refreshing…" message while
      // the queue is non-empty just because the LLM returned filler.
      const isActionable = (s) => s && (
        ((s.action_type === 'assign_vessel') && s.vessel_id)
        || ((s.action_type === 'assign_land_crew') && s.land_crew_id)
        || ((s.action_type === 'reorder_supply') && s.supply_id)
        || ((s.action_type === 'accept_handoff') && s.handoff_id)
        || ((s.action_type === 'mark_cleared') && s.sighting_id)
      );
      if (!items.some(isActionable)) {
        const fallback = [];
        const usedSightings = new Set();
        const usedVessels = new Set();
        const usedCrews = new Set();
        // 1) Walk queued sightings sorted by density, take the top-ranked crew per item.
        const sortedQueue = [...liveSightings].sort(
          (a, b) => (b.density_score || 0) - (a.density_score || 0),
        );
        for (const s of sortedQueue) {
          if (fallback.length >= 3) break;
          const r = rankingsForAi.get(s.id);
          if (!r || !Array.isArray(r.ranked) || r.ranked.length === 0) continue;
          const top = r.ranked.find((row) => {
            if (row.crewType === 'ship') return !usedVessels.has(row.crewId);
            return !usedCrews.has(row.crewId);
          }) || r.ranked[0];
          if (!top) continue;
          if (top.crewType === 'ship') {
            fallback.push({
              text: `Send ${top.crewName} to intercept ${s.density_label || 'queued'} ${s.debris_type || 'debris'} (~${Math.round(top.totalMinutes)} min ETA).`,
              action_type: 'assign_vessel',
              sighting_id: s.id,
              vessel_id: top.crewId,
              land_crew_id: null,
              supply_id: null,
              handoff_id: null,
            });
            usedVessels.add(top.crewId);
          } else {
            fallback.push({
              text: `Dispatch shore crew ${top.crewName} to ${s.density_label || 'queued'} ${s.debris_type || 'debris'} (~${Math.round(top.totalMinutes)} min ETA).`,
              action_type: 'assign_land_crew',
              sighting_id: s.id,
              vessel_id: null,
              land_crew_id: top.crewId,
              supply_id: null,
              handoff_id: null,
            });
            usedCrews.add(top.crewId);
          }
          usedSightings.add(s.id);
        }
        // 2) Pending handoffs.
        for (const h of livePendingHandoffs) {
          if (fallback.length >= 3) break;
          fallback.push({
            text: `Accept ${h.debris_type || 'debris'} handoff from ${h.source_jurisdiction || 'partner'}.`,
            action_type: 'accept_handoff',
            sighting_id: null,
            vessel_id: null,
            land_crew_id: null,
            supply_id: null,
            handoff_id: h.id,
          });
        }
        // 3) Low-stock supplies.
        for (const sup of liveSupplies.filter((x) => x.quantity <= x.low_threshold)) {
          if (fallback.length >= 3) break;
          fallback.push({
            text: `Reorder ${sup.name} — stock at ${sup.quantity}/${sup.low_threshold}.`,
            action_type: 'reorder_supply',
            sighting_id: null,
            vessel_id: null,
            land_crew_id: null,
            supply_id: sup.id,
            handoff_id: null,
          });
        }
        if (fallback.length > 0) items = fallback;
      }

      setAiSuggestions(items);
    } catch (e) {
      console.error(e);
      // Network / model failure — don't strand operators with a stale empty card.
      // Build the same deterministic fallback from the ranking refs we captured above.
      const fallback = [];
      const sortedQueue = [...liveSightings].sort(
        (a, b) => (b.density_score || 0) - (a.density_score || 0),
      );
      const usedVessels = new Set();
      const usedCrews = new Set();
      for (const s of sortedQueue) {
        if (fallback.length >= 3) break;
        const r = rankingsForAi.get(s.id);
        if (!r || !Array.isArray(r.ranked) || r.ranked.length === 0) continue;
        const top = r.ranked[0];
        if (top.crewType === 'ship' && !usedVessels.has(top.crewId)) {
          fallback.push({
            text: `Send ${top.crewName} to intercept queued ${s.debris_type || 'debris'} (~${Math.round(top.totalMinutes)} min ETA).`,
            action_type: 'assign_vessel',
            sighting_id: s.id,
            vessel_id: top.crewId,
            land_crew_id: null,
            supply_id: null,
            handoff_id: null,
          });
          usedVessels.add(top.crewId);
        } else if (top.crewType !== 'ship' && !usedCrews.has(top.crewId)) {
          fallback.push({
            text: `Dispatch shore crew ${top.crewName} to ${s.debris_type || 'debris'} (~${Math.round(top.totalMinutes)} min ETA).`,
            action_type: 'assign_land_crew',
            sighting_id: s.id,
            vessel_id: null,
            land_crew_id: top.crewId,
            supply_id: null,
            handoff_id: null,
          });
          usedCrews.add(top.crewId);
        }
      }
      if (fallback.length > 0) setAiSuggestions(fallback);
    }
    finally { setAiLoading(false); }
  }, []);

  const scheduleAiRefresh = useCallback(() => {
    if (aiRefreshTimerRef.current) clearTimeout(aiRefreshTimerRef.current);
    aiRefreshTimerRef.current = setTimeout(() => {
      aiRefreshTimerRef.current = null;
      fireAiSuggestions();
    }, 1100);
  }, [fireAiSuggestions]);

  useEffect(() => () => {
    if (aiRefreshTimerRef.current) clearTimeout(aiRefreshTimerRef.current);
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
  }, []);

  const visibleSightings = useMemo(
    () => sightings.filter((s) => shouldShowSightingOnDashboard(s.latitude, s.longitude)),
    [sightings],
  );

  const visibleHandoffs = useMemo(
    () => pendingHandoffs.filter((s) => shouldShowSightingOnDashboard(s.latitude, s.longitude)),
    [pendingHandoffs],
  );

  /**
   * Ongoing missions = assignments not yet completed.
   * Each mission gets a stable color (via colorForMissionId) so the sighting marker
   * and the ship/land-crew working it match on the map and the sidebar.
   */
  const ongoingMissions = useMemo(() => {
    return (assignments || [])
      .filter((a) => a.status !== 'completed')
      .map((a) => {
        const sighting = sightings.find((s) => s.id === a.sighting_id) || null;
        const vessel = a.vessel_id ? vessels.find((v) => v.id === a.vessel_id) : null;
        let landCrew = a.land_crew_id ? landCrews.find((c) => c.id === a.land_crew_id) : null;
        // Reconstruct a synthetic shore station from the assignment row when the assignment
        // wasn't backed by a DB land_crew (auto-dispatched virtual patrol).
        if (!landCrew
          && a.crew_type === 'land'
          && Number.isFinite(a.shore_station_lat)
          && Number.isFinite(a.shore_station_lon)
        ) {
          landCrew = {
            id: `synthetic-shore:${a.shore_station_lat.toFixed(3)}_${a.shore_station_lon.toFixed(3)}`,
            name: a.shore_station_name || 'Shore patrol',
            base_lat: a.shore_station_lat,
            base_lon: a.shore_station_lon,
            agency: 'ClearMarine Shore Network',
            synthetic: true,
            status: 'deployed',
          };
        }
        return {
          id: a.id,
          color: colorForMissionId(a.id),
          assignment: a,
          sighting,
          vessel,
          landCrew,
          crewType: a.crew_type || (vessel ? 'ship' : 'land'),
          crewName: vessel?.name || landCrew?.name || '—',
        };
      })
      .filter((m) => m.sighting); // only show missions where the sighting still exists
  }, [assignments, sightings, vessels, landCrews]);

  /** Map<sighting.id, mission> — quick lookup for icon coloring. */
  const missionBySighting = useMemo(() => {
    const m = new Map();
    for (const mission of ongoingMissions) m.set(mission.sighting.id, mission);
    return m;
  }, [ongoingMissions]);

  /**
   * Animated ship vessels — for every open `crew_type='ship'` assignment we project the
   * vessel along its great-circle path to the interception point so the operator sees motion.
   * The static vessel marker for the same vessel.id is suppressed in the render block
   * while the animation is in flight or "on site".
   */
  const animatedVessels = useAnimatedVessels(ongoingMissions);
  const animatedVesselIds = useMemo(() => new Set(animatedVessels.map((a) => a.vesselId)), [animatedVessels]);

  /**
   * Map<sighting.id, { ranked, kg, kgSource, pickupKey, syntheticStation }>.
   *
   * For shore-pickup sightings ('ship_coast' or 'land') we synthesize ONE virtual shore
   * station anchored at the predicted landfall point (or nearest shore) and add it to
   * the candidate list. Real DB land_crews still compete on ETA — the synthetic one
   * usually wins because it’s right at the coast next to the debris, satisfying the
   * "pinned to spots close to it" requirement without needing the user to pre-seed crews.
   */
  const crewRankings = useMemo(() => {
    const map = new Map();
    for (const s of visibleSightings) {
      const drift = drifts.find((d) => d.sighting_id === s.id) || null;
      const driftForPickup = drift
        ? {
          lat_24h: drift.lat_24h, lon_24h: drift.lon_24h,
          lat_48h: drift.lat_48h, lon_48h: drift.lon_48h,
          lat_72h: drift.lat_72h, lon_72h: drift.lon_72h,
        }
        : null;
      const pickup = classifyPickupMode(s.latitude, s.longitude, driftForPickup);
      const wantsShoreCrew = pickup.key === 'ship_coast' || pickup.key === 'land';
      const syntheticStation = wantsShoreCrew
        ? synthesizeShoreStationForSighting(s, driftForPickup)
        : null;
      const effectiveLandCrews = syntheticStation
        ? [syntheticStation, ...landCrews]
        : landCrews;
      const { ranked, kg, kgSource } = rankCrewsForSighting({
        pickupKey: pickup.key,
        sighting: s,
        vessels,
        landCrews: effectiveLandCrews,
        drift: driftForPickup,
      });
      map.set(s.id, { ranked, kg, kgSource, pickupKey: pickup.key, syntheticStation });
    }
    return map;
  }, [visibleSightings, vessels, landCrews, drifts]);

  useEffect(() => {
    if (selectedSightingId == null) return;
    if (!visibleSightings.some((s) => s.id === selectedSightingId)) {
      setSelectedSightingId(null);
    }
  }, [visibleSightings, selectedSightingId]);

  useEffect(() => {
    if (!orderBanner) return undefined;
    const t = setTimeout(() => setOrderBanner(null), 12000);
    return () => clearTimeout(t);
  }, [orderBanner]);

  useEffect(() => {
    if (activeTab !== 'supplies' || supplyOrders.length === 0) return undefined;
    const id = setInterval(() => setSupplyCountdownTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [activeTab, supplyOrders.length]);

  useEffect(() => {
    myAgencyRef.current = myAgency;
    void fetchData().then(() => {
      scheduleAiRefresh();
      if (hasFocusTarget) {
        setMapFlyTarget({ lat: focusLat, lon: focusLon, zoom: 11, key: Date.now() });
        const match = sightingsDataRef.current.find(
          (s) => Math.abs(s.latitude - focusLat) < 0.001 && Math.abs(s.longitude - focusLon) < 0.001,
        );
        if (match) {
          setSelectedSightingId(match.id);
          setTimeout(() => {
            sightingRefs.current[match.id]?.scrollIntoView({ behavior: 'smooth', block: 'center' });
          }, 400);
        }
      }
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [myAgency, fetchData, scheduleAiRefresh]);

  // Realtime subscription (stable — uses refs internally)
  useEffect(() => {
    const channel = supabase.channel('clearmarine-realtime')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'debris_sightings' }, (payload) => {
        if (payload.eventType === 'INSERT') {
          const row = payload.new;
          showAssignToast(
            row.reporter_name || 'Field reporter',
            row.debris_type?.replace('_', ' ') || 'debris',
            'sighting',
          );
        }
        void fetchData().then(() => scheduleAiRefresh());
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'vessels' }, () => {
        void fetchData().then(() => scheduleAiRefresh());
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'assignments' }, () => {
        void fetchData().then(() => scheduleAiRefresh());
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'supplies' }, () => {
        void fetchData().then(() => scheduleAiRefresh());
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'supply_orders' }, () => {
        void fetchData().then(() => scheduleAiRefresh());
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'drift_predictions' }, () => {
        void fetchData().then(() => scheduleAiRefresh());
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'land_crews' }, () => {
        void fetchData().then(() => scheduleAiRefresh());
      })
      .subscribe();
    return () => supabase.removeChannel(channel);
    // showAssignToast is intentionally excluded — re-subscribing the realtime channel on every
    // toast change would tear down and rebuild the websocket constantly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchData, scheduleAiRefresh]);

  const handleAssign = async () => {
    if (!assignModal || !selectedCrew) return;
    // Guard: check DB for any active assignment on this sighting before inserting
    const { data: existing } = await supabase
      .from('assignments')
      .select('id')
      .eq('sighting_id', assignModal.id)
      .eq('status', 'assigned')
      .limit(1);
    if (existing?.length > 0) {
      alert('This sighting already has an active assignment. Complete or clear the existing mission first.');
      pendingAiSuggestionRef.current = null;
      setAssignModal(null);
      setSelectedCrew(null);
      await fetchData();
      return;
    }
    const ranking = crewRankings.get(assignModal.id);
    const est = ranking?.ranked.find((r) => r.crewId === selectedCrew.id && r.crewType === selectedCrew.type);

    if (selectedCrew.type === 'ship') {
      const vessel = vessels.find((v) => v.id === selectedCrew.id);
      if (!vessel) return;
      const intercept = await getInterceptionPoint(
        assignModal.latitude, assignModal.longitude, vessel.current_lat, vessel.current_lon,
      );
      if (!intercept) {
        alert('Could not compute interception — check sighting and vessel coordinates.');
        return;
      }
      const brief = await generateAssignmentBrief({
        vesselName: vessel.name,
        debrisType: assignModal.debris_type,
        densityLabel: assignModal.density_label,
        interceptionHours: intercept.hours,
        lat: intercept.lat,
        lon: intercept.lon,
      });
      await Promise.all([
        supabase.from('assignments').insert({
          sighting_id: assignModal.id,
          vessel_id: vessel.id,
          crew_type: 'ship',
          interception_lat: intercept.lat,
          interception_lon: intercept.lon,
          interception_hours: intercept.hours,
          estimated_kg: est?.kg ?? null,
          estimated_trips: est?.trips ?? null,
          total_minutes: est?.totalMinutes ?? null,
          status: 'assigned',
          gemini_brief: brief,
        }),
        supabase.from('debris_sightings').update({ status: 'assigned' }).eq('id', assignModal.id),
        supabase.from('vessels').update({ status: 'deployed', updated_at: new Date().toISOString() }).eq('id', vessel.id),
      ]);
      showAssignToast(vessel.name, assignModal.debris_type?.replace('_', ' ') || 'debris', 'assignment');
      setBriefModal({ brief, crewName: vessel.name, crewType: 'ship', sighting: assignModal, intercept, est });
    } else {
      // Look up the crew either in real DB land crews OR in the synthetic station for this sighting.
      const synthetic = isSyntheticShoreId(selectedCrew.id);
      const crew = synthetic
        ? ranking?.syntheticStation
        : landCrews.find((c) => c.id === selectedCrew.id);
      if (!crew) return;
      const brief = await generateAssignmentBrief({
        vesselName: `${crew.name} (shore crew)`,
        debrisType: assignModal.debris_type,
        densityLabel: assignModal.density_label,
        interceptionHours: 0,
        lat: assignModal.latitude,
        lon: assignModal.longitude,
      });
      const insertPayload = {
        sighting_id: assignModal.id,
        land_crew_id: synthetic ? null : crew.id,
        crew_type: 'land',
        interception_lat: assignModal.latitude,
        interception_lon: assignModal.longitude,
        interception_hours: 0,
        estimated_kg: est?.kg ?? null,
        estimated_trips: est?.trips ?? null,
        total_minutes: est?.totalMinutes ?? null,
        status: 'assigned',
        gemini_brief: brief,
      };
      if (synthetic) {
        insertPayload.shore_station_lat = crew.base_lat;
        insertPayload.shore_station_lon = crew.base_lon;
        insertPayload.shore_station_name = crew.name;
      }
      const followups = [
        supabase.from('assignments').insert(insertPayload),
        supabase.from('debris_sightings').update({ status: 'assigned' }).eq('id', assignModal.id),
      ];
      if (!synthetic) {
        followups.push(
          supabase.from('land_crews').update({ status: 'deployed', updated_at: new Date().toISOString() }).eq('id', crew.id),
        );
      }
      await Promise.all(followups);
      showAssignToast(crew.name, assignModal.debris_type?.replace('_', ' ') || 'debris', 'assignment');
      setBriefModal({ brief, crewName: crew.name, crewType: 'land', sighting: assignModal, intercept: null, est });
    }

    setAssignModal(null);
    setSelectedCrew(null);
    // Assignment created — now remove the AI suggestion that opened this modal (if any).
    const pending = pendingAiSuggestionRef.current;
    if (pending) {
      pendingAiSuggestionRef.current = null;
      setAiSuggestions((prev) => prev.filter((x) => x !== pending));
    }
    await fetchData();
    fireAiSuggestions();
  };

  const handleHandoff = async (sighting, toAgency) => {
    const fromAgency = sighting.jurisdiction;
    const brief = await generateHandoffBrief({
      fromAgency,
      toAgency,
      debrisType: sighting.debris_type,
      densityLabel: sighting.density_label,
      densityScore: sighting.density_score,
      analysis: sighting.gemini_analysis,
      lat: sighting.latitude,
      lon: sighting.longitude,
    });
    const { error } = await supabase.from('debris_sightings').update({
      jurisdiction: toAgency,
      source_jurisdiction: fromAgency,
      handoff_status: 'pending',
    }).eq('id', sighting.id);
    if (error) {
      console.error(error);
      alert(`Handoff failed: ${error.message}`);
      return;
    }
    setHandoffModal({ brief, fromAgency, toAgency, sighting });
    await fetchData();
    fireAiSuggestions();
  };

  const acceptHandoff = async (sighting) => {
    await supabase.from('debris_sightings').update({ handoff_status: 'accepted' }).eq('id', sighting.id);
    await fetchData();
    fireAiSuggestions();
  };

  const markCleared = async (sightingId) => {
    await supabase.from('debris_sightings').update({ status: 'cleared' }).eq('id', sightingId);
    await supabase.from('assignments').update({ status: 'completed' }).eq('sighting_id', sightingId);
    await fetchData();
    fireAiSuggestions();
  };

  /** Click a mission card → highlight on map + scroll its sighting into view. */
  const selectMission = useCallback((mission) => {
    if (!mission) return;
    setSelectedMissionId(mission.id);
    setSelectedSightingId(mission.sighting.id);
    setMapFlyTarget({ lat: mission.sighting.latitude, lon: mission.sighting.longitude, zoom: 9, key: Date.now() });
    setTimeout(() => {
      sightingRefs.current[mission.sighting.id]?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 350);
  }, []);

  /** Mark a mission cleared: sighting cleared, assignment completed, vessel/land crew freed. */
  const completeMission = useCallback(async (mission) => {
    if (!mission) return;
    const tasks = [
      supabase.from('debris_sightings').update({ status: 'cleared' }).eq('id', mission.sighting.id),
      supabase.from('assignments').update({ status: 'completed' }).eq('id', mission.id),
    ];
    if (mission.vessel) {
      tasks.push(
        supabase.from('vessels').update({ status: 'available', updated_at: new Date().toISOString() }).eq('id', mission.vessel.id),
      );
    }
    if (mission.landCrew && !mission.landCrew.synthetic) {
      tasks.push(
        supabase.from('land_crews').update({ status: 'available', updated_at: new Date().toISOString() }).eq('id', mission.landCrew.id),
      );
    }
    await Promise.all(tasks);
    setSelectedMissionId((cur) => (cur === mission.id ? null : cur));
    await fetchData();
    fireAiSuggestions();
  }, [fetchData, fireAiSuggestions]);

  // Drop selectedMissionId if the mission disappeared (cleared, etc.)
  useEffect(() => {
    if (selectedMissionId == null) return;
    if (!ongoingMissions.some((m) => m.id === selectedMissionId)) setSelectedMissionId(null);
  }, [ongoingMissions, selectedMissionId]);

  const executeAction = async (s, idx) => {
    setExecutingAction(idx);
    try {
      // Modal-based actions (assign_*) defer removal until the operator actually confirms
      // — so clicking Cancel on the assign modal preserves the suggestion for retry.
      let removeAfter = true;
      if (s.action_type === 'assign_vessel') {
        const available = vessels.filter((v) => v.status === 'available');
        if (available.length === 0) {
          alert('No cleanup vessels are available right now. Free a hull from deployment or maintenance, then try again.');
          return;
        }
        const sighting = s.sighting_id ? sightings.find((x) => x.id === s.sighting_id) : sightings[0];
        const vessel = s.vessel_id ? vessels.find((v) => v.id === s.vessel_id) : available[0];
        if (sighting && vessel) {
          pendingAiSuggestionRef.current = s;
          setAssignModal(sighting);
          setSelectedCrew({ type: 'ship', id: vessel.id });
        }
        removeAfter = false;
      } else if (s.action_type === 'assign_land_crew') {
        const sighting = s.sighting_id ? sightings.find((x) => x.id === s.sighting_id) : sightings[0];
        if (!sighting) return;
        const ranking = crewRankings.get(sighting.id);
        const landOptions = (ranking?.ranked || []).filter((r) => r.crewType === 'land');
        if (landOptions.length === 0) {
          alert('No shore crews are reachable for this sighting right now.');
          return;
        }
        let crewId = s.land_crew_id;
        if (crewId && !landOptions.some((r) => r.crewId === crewId)) crewId = null;
        if (!crewId) crewId = landOptions[0].crewId;
        pendingAiSuggestionRef.current = s;
        setAssignModal(sighting);
        setSelectedCrew({ type: 'land', id: crewId });
        removeAfter = false;
      } else if (s.action_type === 'accept_handoff') {
        const h = s.handoff_id ? pendingHandoffs.find((x) => x.id === s.handoff_id) : pendingHandoffs[0];
        if (h) await acceptHandoff(h);
      } else if (s.action_type === 'reorder_supply') {
        const sup = s.supply_id ? supplies.find((x) => x.id === s.supply_id) : supplies.find((x) => x.quantity <= x.low_threshold);
        if (sup) {
          const { error } = await insertSupplyOrder(supabase, sup);
          if (error) console.error(error);
          await fetchData();
        }
      } else if (s.action_type === 'mark_cleared') {
        const sighting = s.sighting_id ? sightings.find((x) => x.id === s.sighting_id) : sightings.find((x) => x.status === 'intercepted');
        if (sighting) await markCleared(sighting.id);
      }
      if (removeAfter) {
        // Non-modal actions execute synchronously here — drop the suggestion and refresh.
        setAiSuggestions((prev) => prev.filter((x) => x !== s));
        scheduleAiRefresh();
      }
    } catch (e) { console.error(e); }
    finally { setExecutingAction(null); }
  };

  const flyToSighting = (s, zoom = 11) => {
    setSelectedSightingId(s.id);
    setMapFlyTarget({ lat: s.latitude, lon: s.longitude, zoom, key: Date.now() });
  };

  const selectSighting = (s) => {
    flyToSighting(s, 11);
  };

  const clickMarker = (s) => {
    flyToSighting(s, 11);
    setActiveTab('sightings');
    setTimeout(() => {
      sightingRefs.current[s.id]?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 120);
  };

  const getDrift = (sightingId) => drifts.find((d) => d.sighting_id === sightingId);

  const driftForPickupFromRow = (row) => (row && Number.isFinite(row.lat_24h) ? {
    lat_24h: row.lat_24h, lon_24h: row.lon_24h,
    lat_48h: row.lat_48h, lon_48h: row.lon_48h,
    lat_72h: row.lat_72h, lon_72h: row.lon_72h,
  } : null);

  const shoreMissions = useMemo(() => ongoingMissions.filter((m) => m.crewType === 'land'), [ongoingMissions]);
  const shipMissions = useMemo(() => ongoingMissions.filter((m) => m.crewType === 'ship'), [ongoingMissions]);

  /** Sightings already on an open assignment — excluded from the QUEUE sections. */
  const queueExcludedSightingIds = useMemo(() => {
    const ids = new Set();
    for (const m of ongoingMissions) if (m.sighting?.id) ids.add(m.sighting.id);
    for (const s of visibleSightings) if (s.status === 'assigned' || s.status === 'intercepted') ids.add(s.id);
    return ids;
  }, [ongoingMissions, visibleSightings]);

  const shoreSightings = useMemo(() => visibleSightings.filter((s) => {
    if (queueExcludedSightingIds.has(s.id)) return false;
    const p = classifyPickupMode(s.latitude, s.longitude, driftForPickupFromRow(getDrift(s.id)));
    return p.key === 'land' || p.key === 'ship_coast';
    // getDrift is a stable closure over `drifts`; we depend on `drifts` directly to avoid stale captures.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [visibleSightings, drifts, queueExcludedSightingIds]);

  const shipSightings = useMemo(() => visibleSightings.filter((s) => {
    if (queueExcludedSightingIds.has(s.id)) return false;
    const p = classifyPickupMode(s.latitude, s.longitude, driftForPickupFromRow(getDrift(s.id)));
    return p.key !== 'land' && p.key !== 'ship_coast';
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [visibleSightings, drifts, queueExcludedSightingIds]);

  /**
   * Hide AI suggestions whose target is no longer actionable so the panel never
   * recommends "assign Ocean Guardian" for a sighting that's already been dispatched.
   * Anything stale gets dropped on the next render — `fireAiSuggestions` will
   * backfill with the next queued item or supply task.
   */
  const liveAiSuggestions = useMemo(() => {
    return aiSuggestions.filter((s) => {
      if (!s || s.dismissed || s.completed) return false;
      switch (s.action_type) {
        case 'assign_vessel':
        case 'assign_land_crew': {
          if (s.sighting_id && queueExcludedSightingIds.has(s.sighting_id)) return false;
          return true;
        }
        case 'accept_handoff': {
          if (s.handoff_id && !pendingHandoffs.some((h) => h.id === s.handoff_id)) return false;
          return pendingHandoffs.length > 0;
        }
        case 'reorder_supply': {
          if (s.supply_id) {
            const sup = supplies.find((x) => x.id === s.supply_id);
            if (!sup) return false;
            return sup.quantity <= sup.low_threshold;
          }
          return supplies.some((x) => x.quantity <= x.low_threshold);
        }
        case 'mark_cleared': {
          if (s.sighting_id) {
            const sg = sightings.find((x) => x.id === s.sighting_id);
            return !!sg && sg.status === 'intercepted';
          }
          return sightings.some((x) => x.status === 'intercepted');
        }
        default:
          return true;
      }
    });
  }, [aiSuggestions, queueExcludedSightingIds, pendingHandoffs, supplies, sightings]);

  /**
   * Backstop: whenever there's queued work but the agent panel has nothing live to show,
   * proactively refire AI suggestions so the recommendations card is never empty while
   * operators have something to dispatch.
   *
   * Latency notes:
   *  - We call `fireAiSuggestions` DIRECTLY (no debounce) so the request goes out
   *    immediately when we detect an empty agent + non-empty queue. The 1.1s debounce
   *    inside `scheduleAiRefresh` is for batching event-driven refreshes; here we already
   *    know we want the call right now.
   *  - The cooldown only kicks in if the AI keeps returning suggestions that get filtered
   *    out for the same queue shape — preventing a tight loop while still being short
   *    enough that operators don't sit on a stale "refreshing…" message.
   */
  const lastBackstopFireRef = useRef({ key: '', firedAt: 0 });
  useEffect(() => {
    if (aiLoading) return;
    if (liveAiSuggestions.length > 0) return;

    const lowSupplyIds = supplies
      .filter((x) => x.quantity <= x.low_threshold)
      .map((x) => x.id)
      .sort();
    const shoreIds = shoreSightings.map((s) => s.id).sort();
    const shipIds = shipSightings.map((s) => s.id).sort();
    const handoffIds = pendingHandoffs.map((h) => h.id).sort();
    const interceptedIds = sightings
      .filter((s) => s.status === 'intercepted')
      .map((s) => s.id)
      .sort();

    const hasWork = shoreIds.length > 0 || shipIds.length > 0
      || handoffIds.length > 0 || lowSupplyIds.length > 0 || interceptedIds.length > 0;
    if (!hasWork) return;

    const key = JSON.stringify({ shoreIds, shipIds, handoffIds, lowSupplyIds, interceptedIds });
    const now = Date.now();
    const last = lastBackstopFireRef.current;
    // Short cooldown — if the AI returned filtered-out items, we'll re-ask within ~4s
    // for the same queue shape rather than making operators wait. The cooldown resets
    // immediately on any queue change (new key).
    const COOLDOWN_MS = 4000;
    if (last.key === key && now - last.firedAt < COOLDOWN_MS) return;
    lastBackstopFireRef.current = { key, firedAt: now };
    fireAiSuggestions();
  }, [
    aiLoading,
    liveAiSuggestions.length,
    shoreSightings,
    shipSightings,
    pendingHandoffs,
    supplies,
    sightings,
    fireAiSuggestions,
  ]);

  /** Ship hulls on an active assignment OR listed as a ship candidate for any visible sighting (queued). */
  const vesselIdsInSightingsOrMission = useMemo(() => {
    const ids = new Set();
    for (const m of ongoingMissions) {
      if (m.crewType === 'ship' && m.vessel?.id) ids.add(m.vessel.id);
    }
    for (const s of visibleSightings) {
      const r = crewRankings.get(s.id);
      for (const row of r?.ranked || []) {
        if (row.crewType === 'ship' && row.crewId) ids.add(row.crewId);
      }
    }
    return ids;
  }, [ongoingMissions, visibleSightings, crewRankings]);

  const vesselIdsOnShipMission = useMemo(() => {
    const ids = new Set();
    for (const m of ongoingMissions) {
      if (m.crewType === 'ship' && m.vessel?.id) ids.add(m.vessel.id);
    }
    return ids;
  }, [ongoingMissions]);

  /** In-play hulls first (any agency), then remaining vessels for this command. */
  const vesselsTabList = useMemo(() => {
    const byId = new Map((vessels || []).map((v) => [v.id, v]));
    const seen = new Set();
    const inPlay = [];
    const add = (id) => {
      if (!id || seen.has(id)) return;
      const v = byId.get(id);
      if (!v) return;
      seen.add(id);
      inPlay.push(v);
    };
    for (const m of ongoingMissions) {
      if (m.crewType === 'ship' && m.vessel?.id) add(m.vessel.id);
    }
    for (const s of visibleSightings) {
      const r = crewRankings.get(s.id);
      for (const row of r?.ranked || []) {
        if (row.crewType === 'ship' && row.crewId) add(row.crewId);
      }
    }
    const rest = (vessels || []).filter((v) => !seen.has(v.id) && (!v.agency || v.agency === myAgency));
    rest.sort((a, b) => (a.name || '').localeCompare(b.name || '', undefined, { sensitivity: 'base' }));
    return [...inPlay, ...rest];
  }, [vessels, visibleSightings, ongoingMissions, crewRankings, myAgency]);

  /** Land / shore crews on a mission, every land row in sighting rankings (incl. synthetic), then other DB crews for this agency. */
  const crewsTabList = useMemo(() => {
    const seen = new Set();
    const out = [];
    const add = (c) => {
      if (!c?.id || seen.has(c.id)) return;
      seen.add(c.id);
      out.push(c);
    };
    for (const m of ongoingMissions) {
      if (m.crewType === 'land' && m.landCrew) add(m.landCrew);
    }
    for (const s of visibleSightings) {
      const r = crewRankings.get(s.id);
      for (const row of r?.ranked || []) {
        if (row.crewType === 'land' && row.crew) add(row.crew);
      }
    }
    for (const c of landCrews || []) {
      if (!c?.id) continue;
      if (!c.agency || c.agency === myAgency) add(c);
    }
    return out;
  }, [ongoingMissions, visibleSightings, crewRankings, landCrews, myAgency]);

  const landCrewIdsOnShoreMission = useMemo(() => {
    const ids = new Set();
    for (const m of ongoingMissions) {
      if (m.crewType === 'land' && m.landCrew?.id) ids.add(m.landCrew.id);
    }
    return ids;
  }, [ongoingMissions]);

  const lowSupplies = supplies.filter((s) => s.quantity <= s.low_threshold);
  const availableFleet = vessels.filter((v) => v.status === 'available');

  const actionLabel = (type) => {
    if (type === 'assign_vessel') return 'Assign';
    if (type === 'assign_land_crew') return 'Assign';
    if (type === 'accept_handoff') return 'Accept';
    if (type === 'reorder_supply') return 'Order from supplier';
    if (type === 'mark_cleared') return 'Clear';
    return null;
  };

  /** Active mission row (shared by Shore / Ship collapsibles in Sightings). */
  const renderMissionRow = (m) => {
    const isSelected = selectedMissionId === m.id;
    const eta = Number.isFinite(m.assignment.total_minutes) ? formatEtaShort(m.assignment.total_minutes) : null;
    const kg = Number.isFinite(m.assignment.estimated_kg) ? Math.round(m.assignment.estimated_kg) : null;
    const trips = Number.isFinite(m.assignment.estimated_trips) ? m.assignment.estimated_trips : null;
    return (
      <div
        key={m.id}
        onClick={() => selectMission(m)}
        className={`rounded-lg p-2.5 border-l-4 cursor-pointer transition-all bg-slate-700/60 hover:bg-slate-700 ${isSelected ? 'ring-1 ring-offset-1 ring-offset-slate-900' : ''}`}
        style={{
          borderLeftColor: m.color,
          ...(isSelected ? { boxShadow: `0 0 0 1px ${m.color}55` } : {}),
        }}
      >
        <div className="flex items-center justify-between gap-2 mb-0.5">
          <div className="flex items-center gap-1.5 min-w-0">
            <span className="inline-block w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: m.color, boxShadow: `0 0 4px ${m.color}` }} />
            <span className="text-white text-xs font-semibold truncate">{m.crewName}</span>
            <span className={`text-[9px] font-bold px-1 py-0.5 rounded shrink-0 ${m.crewType === 'ship' ? 'bg-cyan-950 text-cyan-200 border border-cyan-700' : 'bg-amber-950 text-amber-200 border border-amber-700'}`}>
              {m.crewType === 'ship' ? '🚢' : '🥾'}
            </span>
          </div>
          {eta && <span className="text-cyan-300 font-mono text-[10px] shrink-0">{eta}</span>}
        </div>
        <p className="text-slate-300 text-[11px] capitalize truncate">{m.sighting.density_label} {m.sighting.debris_type?.replace('_', ' ')}</p>
        {(kg || trips) && (
          <p className="text-slate-500 text-[10px] mt-0.5">{kg ? `~${kg} kg` : ''}{kg && trips ? ' · ' : ''}{trips ? `${trips} trip${trips === 1 ? '' : 's'}` : ''}</p>
        )}
        <div className="flex gap-1 mt-1.5" onClick={(e) => e.stopPropagation()}>
          <button type="button" onClick={() => completeMission(m)} className="flex-1 bg-green-800 hover:bg-green-700 text-white text-[10px] font-semibold py-1 rounded">✓</button>
          <button type="button" onClick={() => selectMission(m)} className="flex-1 bg-slate-600 hover:bg-slate-500 text-slate-100 text-[10px] py-1 rounded">Map</button>
          {m.crewType === 'ship' && m.vessel?.id && (
            <a href={`/vessel/${m.vessel.id}`} className="flex-1 text-center bg-cyan-900 hover:bg-cyan-800 text-cyan-100 text-[10px] py-1 rounded">Ship</a>
          )}
          {m.crewType === 'land' && m.landCrew?.id && (
            <a href={`/shore/${encodeURIComponent(m.landCrew.id)}`} className="flex-1 text-center bg-emerald-900 hover:bg-emerald-800 text-emerald-100 text-[10px] py-1 rounded">Shore</a>
          )}
        </div>
      </div>
    );
  };

  /** Sighting queue row — `fleetFocus` picks which crew tier to show for ETA / dispatch. */
  const renderSightingRow = (s, fleetFocus) => {
    const drift = getDrift(s.id);
    const driftForPickup = driftForPickupFromRow(drift);
    const pickup = classifyPickupMode(s.latitude, s.longitude, driftForPickup);
    const lfSide = drift ? computePacificLandfallDisplay(s.latitude, s.longitude, drift) : null;
    const isSelected = selectedSightingId === s.id;
    const sightingMission = missionBySighting.get(s.id);
    const r = crewRankings.get(s.id);
    const best = fleetFocus === 'land'
      ? r?.ranked?.find((o) => o.crewType === 'land')
      : fleetFocus === 'ship'
        ? r?.ranked?.find((o) => o.crewType === 'ship')
        : r?.ranked?.[0];
    const hasOptions = fleetFocus === 'land'
      ? (r?.ranked || []).some((o) => o.crewType === 'land')
      : fleetFocus === 'ship'
        ? (r?.ranked || []).some((o) => o.crewType === 'ship')
        : (r?.ranked || []).length > 0;
    const alreadyAssigned = !!sightingMission;

    return (
      <div
        key={s.id}
        ref={(el) => { sightingRefs.current[s.id] = el; }}
        onClick={() => selectSighting(s)}
        className="rounded-lg p-2.5 border-l-4 cursor-pointer transition-all"
        style={{
          borderLeftColor: s.density_score >= 8 ? '#ef4444' : s.density_score >= 6 ? '#f97316' : s.density_score >= 3 ? '#eab308' : '#10b981',
          background: isSelected ? 'rgba(0,212,255,0.06)' : 'var(--navy-surface)',
          border: isSelected ? '1px solid rgba(0,212,255,0.35)' : '1px solid var(--navy-border)',
          borderLeft: `4px solid ${s.density_score >= 8 ? '#ef4444' : s.density_score >= 6 ? '#f97316' : s.density_score >= 3 ? '#eab308' : '#10b981'}`,
        }}
      >
        <div className="flex items-start justify-between gap-2">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1 flex-wrap mb-0.5">
              <span className={`text-[9px] font-bold px-1 py-0.5 rounded border ${pickupBadgeClassName(pickup.key)}`} title={pickup.detail}>{pickup.shortLabel}</span>
              {sightingMission && (
                <span
                  className="text-[9px] font-bold px-1 py-0.5 rounded text-white shrink-0 cursor-pointer"
                  style={{ backgroundColor: sightingMission.color, boxShadow: `0 0 4px ${sightingMission.color}aa` }}
                  title={`Mission · ${sightingMission.crewName}`}
                  onClick={(e) => { e.stopPropagation(); selectMission(sightingMission); }}
                >
                  ● {sightingMission.crewName}
                </span>
              )}
              {best && !sightingMission && (
                <span
                  className="text-[9px] font-semibold px-1 py-0.5 rounded border border-emerald-800 bg-emerald-950/80 text-emerald-200 truncate max-w-[9rem]"
                  title={`${best.crewName} — ${best.trips} trip${best.trips === 1 ? '' : 's'}`}
                >
                  {formatEtaShort(best.totalMinutes)} · {best.crewType === 'ship' ? '🚢' : '🥾'} {best.crewName}
                </span>
              )}
            </div>
            <div className="flex items-center gap-1 flex-wrap">
              <span className={`text-[10px] font-bold px-1 py-0.5 rounded-full ${densityBadge(s.density_score, s.density_label)}`}>{s.density_label} {s.density_score}</span>
              <span className="text-[11px] text-slate-300 capitalize truncate">{s.debris_type?.replace('_', ' ')}</span>
            </div>
            <p className="text-[10px] mt-0.5 truncate" style={{ color: 'var(--text-secondary)' }}>{s.estimated_volume} · {s.reporter_name}</p>
            <p className="mono text-[9px]" style={{ color: 'var(--cyan-dim)' }}>{formatCoordPair(s.latitude, s.longitude)}</p>
            {lfSide?.showLandfallFlag && lfSide.coastAlert && (
              <p className="text-amber-300 text-[10px] mt-0.5 leading-snug border border-amber-700/40 rounded p-1.5 bg-amber-950/30">
                <span className="font-bold">Coast:</span> {lfSide.coastAlert}
              </p>
            )}
            {lfSide?.showLandfallFlag && lfSide.landfallPoint && (
              <p className="text-orange-400 text-[10px] mt-0.5 truncate">⚑ {lfSide.landfallLabel}</p>
            )}
            <span className={`text-[9px] px-1 py-0.5 rounded inline-block mt-0.5 ${s.status === 'assigned' ? 'bg-blue-900 text-blue-200' : s.status === 'intercepted' ? 'bg-purple-900 text-purple-200' : 'bg-slate-700 text-slate-300'}`}>{s.status}</span>
          </div>
          <div className="flex flex-col gap-0.5 shrink-0" onClick={(e) => e.stopPropagation()}>
            <button
              type="button"
              onClick={() => setAssignModal(s)}
              disabled={!hasOptions || alreadyAssigned}
              title={alreadyAssigned ? 'On mission' : !hasOptions ? 'No crew' : ''}
              className="bg-cyan-800 hover:bg-cyan-700 disabled:opacity-40 text-white text-[10px] px-1.5 py-0.5 rounded"
            >
              {alreadyAssigned ? '…' : 'Go'}
            </button>
            {sightingMission?.vessel?.id && (
              <a href={`/vessel/${sightingMission.vessel.id}`} className="text-center bg-cyan-900 text-cyan-100 text-[9px] px-1 py-0.5 rounded">V</a>
            )}
            {sightingMission?.landCrew?.id && (
              <a href={`/shore/${encodeURIComponent(sightingMission.landCrew.id)}`} className="text-center bg-emerald-900 text-emerald-100 text-[9px] px-1 py-0.5 rounded">S</a>
            )}
            <select
              onChange={(e) => e.target.value && handleHandoff(s, e.target.value)}
              value=""
              className="bg-slate-800 text-white text-[9px] rounded px-0.5 py-0.5 border border-slate-600 max-w-[4.5rem]"
            >
              <option value="">Hand…</option>
              {AGENCIES.filter((a) => a !== s.jurisdiction).map((a) => <option key={a} value={a}>{a.slice(0, 12)}</option>)}
            </select>
            <button type="button" onClick={() => markCleared(s.id)} className="bg-slate-700 hover:bg-green-900 text-slate-300 text-[9px] px-1 py-0.5 rounded">Clr</button>
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="h-screen naval-bg text-white flex flex-col" style={{ color: 'var(--text-primary)' }}>
      <header className="px-4 py-2 flex items-center gap-3 flex-wrap shrink-0" style={{ background: 'rgba(7,22,40,0.95)', borderBottom: '1px solid var(--navy-border)' }}>
        <div className="flex items-center gap-2">
          <span className="text-xl">🌊</span>
          <div>
            <h1 className="display text-lg tracking-widest" style={{ color: 'var(--cyan-glow)', textShadow: '0 0 20px rgba(0,212,255,0.4)' }}>CLEARMARINE OPS</h1>
            <p className="mono text-[10px]" style={{ color: 'var(--text-secondary)' }}>REAL-TIME DEBRIS COORDINATION // PACIFIC COMMAND</p>
          </div>
        </div>
        <div className="flex items-center gap-2 ml-auto flex-wrap text-xs">
          <select
            value={myAgency}
            onChange={(e) => setMyAgency(e.target.value)}
            className="text-xs rounded px-2 py-1 focus:outline-none mono"
            style={{ background: 'var(--navy-surface)', border: '1px solid var(--navy-border)', color: 'var(--text-primary)' }}
            title="Same coordination app — switch which incoming handoffs you accept"
          >
            {AGENCIES.map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
          <span className="mono" style={{ color: 'var(--text-secondary)' }}>
            <span style={{ color: 'var(--cyan-glow)' }}>{visibleSightings.length}</span> active
            {sightings.length > visibleSightings.length && (
              <span className="text-slate-500 ml-1" title="Land positions (Pacific model) are hidden from map and queue">
                ({sightings.length - visibleSightings.length} on land hidden)
              </span>
            )}
          </span>
          <span className={`mono font-bold ${availableFleet.length === 0 ? '' : ''}`} style={{ color: availableFleet.length === 0 ? 'var(--red-crit)' : 'var(--green-ok)' }}>
            {availableFleet.length} ready
          </span>
          {visibleHandoffs.length > 0 && (
            <span className="mono font-bold px-2 py-0.5 rounded" style={{ background: 'rgba(245,158,11,0.15)', border: '1px solid var(--amber)', color: 'var(--amber)' }}>
              ⚑ {visibleHandoffs.length} HANDOFF
            </span>
          )}
          {lowSupplies.length > 0 && (
            <span className="mono font-bold px-2 py-0.5 rounded critical-dot" style={{ background: 'rgba(239,68,68,0.15)', border: '1px solid var(--red-crit)', color: 'var(--red-crit)' }}>
              ▲ {lowSupplies.length} SUPPLY
            </span>
          )}
          <a href="/report" className="mono font-bold px-3 py-1 rounded transition-colors" style={{ background: 'rgba(0,212,255,0.12)', border: '1px solid var(--cyan-glow)', color: 'var(--cyan-glow)' }}>+ REPORT</a>
          <div className="flex items-center gap-1.5">
            <div className="w-2 h-2 rounded-full live-dot" style={{ background: 'var(--green-ok)' }} />
            <span className="mono text-[10px]" style={{ color: 'var(--green-ok)' }}>LIVE</span>
          </div>
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">
        {/* Map */}
        <div className="flex-1 relative">
          <MapContainer center={[32, -135]} zoom={5} style={{ height: '100%', width: '100%' }} className="z-0">
            <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" attribution='© OpenStreetMap contributors' />
            <CoordTracker onMove={setHoverCoords} onMapClick={setClickCoords} />
            <MapFlyTo target={mapFlyTarget} />

            {visibleSightings.map((s) => {
              const drift = getDrift(s.id);
              const driftForPickup = drift
                ? {
                  lat_24h: drift.lat_24h,
                  lon_24h: drift.lon_24h,
                  lat_48h: drift.lat_48h,
                  lon_48h: drift.lon_48h,
                  lat_72h: drift.lat_72h,
                  lon_72h: drift.lon_72h,
                }
                : null;
              const pickup = classifyPickupMode(s.latitude, s.longitude, driftForPickup);
              const lf = drift
                ? computePacificLandfallDisplay(s.latitude, s.longitude, drift)
                : {
                  showLandfallFlag: false,
                  landfallPoint: null,
                  pathPoints: [],
                  landfallLabel: null,
                  coastAlert: null,
                };
              const pathPoints = lf.pathPoints.length > 0 ? lf.pathPoints : [];
              const segmentPolylines = pathPoints.length >= 2 ? driftSegmentsForMap(pathPoints) : [];
              const isSelected = selectedSightingId === s.id;
              const landfallCoords = lf.landfallPoint ? formatCoordPair(lf.landfallPoint[0], lf.landfallPoint[1]) : null;

              const sightingMission = missionBySighting.get(s.id) || null;
              const sightingMissionColor = sightingMission?.color || null;
              const sightingMissionSelected = sightingMission && selectedMissionId === sightingMission.id;
              return (
                <div key={s.id}>
                  <Marker
                    position={[s.latitude, s.longitude]}
                    icon={debrisIcon({
                      score: s.density_score,
                      assigned: !!sightingMission,
                      selected: isSelected || !!sightingMissionSelected,
                      missionColor: sightingMissionSelected ? sightingMissionColor : null,
                    })}
                    eventHandlers={{ click: () => clickMarker(s) }}
                  >
                    <Popup>
                      <div className="text-xs space-y-1 min-w-[200px]">
                        <p>
                          <span className={`font-bold px-1.5 py-0.5 rounded ${pickupBadgeClassName(pickup.key)}`}>
                            {pickup.shortLabel}
                          </span>
                          {sightingMission && (
                            <span
                              className="ml-1 inline-block text-[10px] font-bold px-1.5 py-0.5 rounded text-white"
                              style={{ backgroundColor: sightingMission.color }}
                            >
                              ● Mission · {sightingMission.crewName}
                            </span>
                          )}
                        </p>
                        <p className="text-gray-600 leading-snug">{pickup.detail}</p>
                        {(() => {
                          const r = crewRankings.get(s.id);
                          const best = r?.ranked?.[0];
                          if (!best) return null;
                          return (
                            <p className="text-emerald-700 font-semibold">
                              Best ETA: {formatEtaShort(best.totalMinutes)} via {best.crewName}
                              <span className="text-gray-600 font-normal"> ({best.trips} trip{best.trips === 1 ? '' : 's'}, ~{Math.round(best.kg)} kg)</span>
                            </p>
                          );
                        })()}
                        <p className="font-bold">{s.density_label} — {s.debris_type?.replace('_', ' ')}</p>
                        <p className="text-gray-600">{s.gemini_analysis?.slice(0, 120)}...</p>
                        <p className="text-gray-500">By: {s.reporter_name}</p>
                        <p className="text-gray-500">Vol: {s.estimated_volume}</p>
                        <p className="text-gray-400 font-mono text-xs">{formatCoordPair(s.latitude, s.longitude)}</p>
                        {lf.showLandfallFlag && lf.coastAlert && (
                          <p className="text-amber-600 font-semibold text-xs leading-snug border border-amber-700 bg-amber-50 rounded p-2">
                            ⚑ Coast call: {lf.coastAlert}
                          </p>
                        )}
                        {lf.showLandfallFlag && lf.landfallLabel && (
                          <p className="text-orange-600 text-xs">
                            Model contact: {lf.landfallLabel}
                            {landfallCoords ? ` (${landfallCoords})` : ''}. Track is clipped — not drawn inland.
                          </p>
                        )}
                      </div>
                    </Popup>
                  </Marker>

                  {segmentPolylines.map((seg, si) => (
                    <Polyline key={`${s.id}-seg-${si}`} positions={seg.positions} color={seg.color} weight={2} dashArray="6,4" opacity={0.85} smoothFactor={1} />
                  ))}

                  {drift && pathPoints.length > 0 && (
                    <>
                      {approxOnPath(drift.lat_24h, drift.lon_24h, pathPoints) && (
                        <Circle center={[drift.lat_24h, drift.lon_24h]} radius={8000} color="#eab308" fillOpacity={0.1} weight={1} />
                      )}
                      {approxOnPath(drift.lat_48h, drift.lon_48h, pathPoints) && (
                        <Circle center={[drift.lat_48h, drift.lon_48h]} radius={12000} color="#f97316" fillOpacity={0.1} weight={1} />
                      )}
                      {approxOnPath(drift.lat_72h, drift.lon_72h, pathPoints) && (
                        <Circle center={[drift.lat_72h, drift.lon_72h]} radius={16000} color="#ef4444" fillOpacity={0.1} weight={1} />
                      )}
                    </>
                  )}

                  {lf.showLandfallFlag && lf.landfallPoint && (
                    <>
                      <Circle
                        center={lf.landfallPoint}
                        radius={16000}
                        pathOptions={{
                          color: sightingMissionColor || '#ea580c',
                          fillColor: sightingMissionColor || '#f97316',
                          fillOpacity: sightingMission ? 0.45 : 0.38,
                          weight: sightingMission ? 4 : 3,
                        }}
                      />
                      <Marker position={lf.landfallPoint} icon={landfallIcon}>
                        <Popup>
                          <p className="text-xs font-semibold text-orange-600">⚑ Land / coast contact (model)</p>
                          <p className="text-xs text-gray-600">{lf.landfallLabel}</p>
                          <p className="text-xs text-gray-700 font-mono font-bold">{formatCoordPair(lf.landfallPoint[0], lf.landfallPoint[1])}</p>
                          <p className="text-xs text-amber-800 font-medium">{lf.coastAlert}</p>
                          {sightingMission && (
                            <p className="text-xs font-bold mt-1" style={{ color: sightingMission.color }}>
                              ● Shore crew on mission: {sightingMission.crewName}
                            </p>
                          )}
                        </Popup>
                      </Marker>
                    </>
                  )}
                </div>
              );
            })}

            {/* Idle vessels — anything our agency owns that ISN'T currently animating to a sighting. */}
            {vessels
              .filter((v) => v.current_lat && v.current_lon && v.agency === myAgency && !animatedVesselIds.has(v.id))
              .map((v) => (
                <Marker
                  key={v.id}
                  position={[v.current_lat, v.current_lon]}
                  icon={vesselIcon({ state: 'idle' })}
                >
                  <Popup>
                    <div className="text-xs space-y-1">
                      <p className="font-bold">{v.name}</p>
                      <p>{v.zone}</p>
                      <p>Status: {v.status} | Fuel: {v.fuel_level}%</p>
                      <p className="font-mono text-gray-400">{formatCoordPair(v.current_lat, v.current_lon)}</p>
                    </div>
                  </Popup>
                </Marker>
              ))}

            {/* Animated vessels — interpolated along great-circle to the interception, and locked at destination with a `…` loader once on-site. */}
            {animatedVessels.map((av) => {
              const m = av.mission;
              const v = m.vessel;
              const isSelected = selectedMissionId === m.id;
              const state = av.arrived ? 'on_site' : 'en_route';
              return (
                <Marker
                  key={`anim-${av.assignmentId}`}
                  position={[av.lat, av.lon]}
                  icon={vesselIcon({ state, missionColor: m.color, selected: !!isSelected })}
                  eventHandlers={{ click: () => selectMission(m) }}
                  zIndexOffset={500}
                >
                  <Popup>
                    <div className="text-xs space-y-1">
                      <p className="font-bold">{v.name}</p>
                      <p>{v.zone}</p>
                      <p>Status: {v.status} | Fuel: {v.fuel_level}%</p>
                      <p className="font-mono text-gray-400">{formatCoordPair(av.lat, av.lon)}</p>
                      <p className="font-semibold" style={{ color: m.color }}>
                        {av.arrived
                          ? `● On site — cleanup in progress`
                          : `● En route to ${m.sighting?.debris_type?.replace('_', ' ') || 'sighting'}`}
                      </p>
                    </div>
                  </Popup>
                </Marker>
              );
            })}

            {/* Persistent shore crews — every real DB land crew is shown on the map (green idle / blue assigned) so the operator can see the full coastline coverage. */}
            {landCrews
              .filter((c) => Number.isFinite(c.base_lat) && Number.isFinite(c.base_lon) && !isSyntheticShoreId(c.id))
              .map((c) => {
                const onMission = landCrewIdsOnShoreMission.has(c.id);
                const mission = onMission
                  ? ongoingMissions.find((m) => m.landCrew?.id === c.id) || null
                  : null;
                const isSelected = !!(mission && selectedMissionId === mission.id);
                return (
                  <Marker
                    key={`landcrew-${c.id}`}
                    position={[c.base_lat, c.base_lon]}
                    icon={landCrewIcon({
                      state: onMission ? 'assigned' : 'idle',
                      missionColor: mission?.color || null,
                      selected: isSelected,
                    })}
                    eventHandlers={mission ? { click: () => selectMission(mission) } : undefined}
                  >
                    <Popup>
                      <div className="text-xs space-y-1">
                        <p className="font-bold">{c.name}</p>
                        <p className="text-gray-600">{c.agency || 'Shore crew'}</p>
                        {onMission ? (
                          <p className="font-semibold" style={{ color: mission?.color || STATUS_BLUE }}>● Dispatched to active sighting</p>
                        ) : (
                          <p className="font-semibold" style={{ color: STATUS_GREEN }}>● Standing by</p>
                        )}
                      </div>
                    </Popup>
                  </Marker>
                );
              })}

            {/* Mission connector lines + synthetic shore station markers (real land crews are rendered above). */}
            {ongoingMissions.map((m) => {
              const isSelected = selectedMissionId === m.id;
              const weight = isSelected ? 4 : 2;
              const opacity = isSelected ? 1 : 0.55;
              const dash = isSelected ? null : '8,6';
              const elements = [];
              if (m.vessel?.current_lat && m.vessel?.current_lon
                && Number.isFinite(m.assignment.interception_lat)
                && Number.isFinite(m.assignment.interception_lon)) {
                elements.push(
                  <Polyline
                    key={`mission-${m.id}-vessel`}
                    positions={[[m.vessel.current_lat, m.vessel.current_lon], [m.assignment.interception_lat, m.assignment.interception_lon]]}
                    pathOptions={{ color: m.color, weight, opacity, ...(dash ? { dashArray: dash } : {}) }}
                  />
                );
              }
              if (m.landCrew?.base_lat && m.landCrew?.base_lon && m.sighting) {
                elements.push(
                  <Polyline
                    key={`mission-${m.id}-land`}
                    positions={[[m.landCrew.base_lat, m.landCrew.base_lon], [m.sighting.latitude, m.sighting.longitude]]}
                    pathOptions={{ color: m.color, weight, opacity, ...(dash ? { dashArray: dash } : {}) }}
                  />
                );
                // Only synthetic shore stations need a marker here; real crews are already rendered above.
                if (isSyntheticShoreId(m.landCrew.id)) {
                  elements.push(
                    <Marker
                      key={`mission-${m.id}-landbase`}
                      position={[m.landCrew.base_lat, m.landCrew.base_lon]}
                      icon={landCrewIcon({ state: 'assigned', missionColor: m.color, selected: isSelected })}
                      eventHandlers={{ click: () => selectMission(m) }}
                    >
                      <Popup>
                        <div className="text-xs space-y-1">
                          <p className="font-bold">{m.landCrew.name}</p>
                          <p className="text-gray-600">Synthetic shore patrol</p>
                          <p className="font-semibold" style={{ color: m.color }}>● Dispatched to active sighting</p>
                        </div>
                      </Popup>
                    </Marker>
                  );
                }
              }
              return elements;
            })}
          </MapContainer>

          {/* Coordinate display */}
          <div className="absolute bottom-4 left-4 glass rounded-xl p-3 text-xs space-y-1 z-[1000] min-w-[200px] pointer-events-none mono">
            <p className="display tracking-widest text-sm mb-2" style={{ color: 'var(--cyan-glow)' }}>DRIFT FORECAST</p>
            <div className="flex items-center gap-2"><div className="w-6 h-0.5 bg-yellow-400" /><span style={{ color: 'var(--text-secondary)' }}>+24H</span></div>
            <div className="flex items-center gap-2"><div className="w-6 h-0.5 bg-orange-500" /><span style={{ color: 'var(--text-secondary)' }}>+48H</span></div>
            <div className="flex items-center gap-2"><div className="w-6 h-0.5 bg-red-500" /><span style={{ color: 'var(--text-secondary)' }}>+72H</span></div>
            <div className="flex items-center gap-2"><span style={{ color: 'var(--amber)' }}>⚑</span><span style={{ color: 'var(--text-secondary)' }}>COASTAL</span></div>
            {ongoingMissions.length > 0 && (
              <div className="flex items-center gap-2 pt-1 border-t border-slate-700 mt-1">
                <span className="inline-block w-2.5 h-2.5 rounded-full bg-emerald-400 animate-pulse" />
                <span className="text-emerald-300">{ongoingMissions.length} active mission{ongoingMissions.length === 1 ? '' : 's'} — colored rings link sighting ↔ crew</span>
              </div>
            )}
            <div className="pt-1 border-t border-slate-700 mt-1 space-y-0.5">
              <p className="text-slate-500">Hover or click map</p>
              {hoverCoords && (
                <p className="text-cyan-400 font-mono">{formatCoordPair(hoverCoords.lat, hoverCoords.lng)}</p>
              )}
              {clickCoords && (
                <p className="text-amber-300 font-mono">Pinned: {formatCoordPair(clickCoords.lat, clickCoords.lng)}</p>
              )}
            </div>
          </div>
        </div>

        {/* Sidebar */}
        <div className="w-80 flex flex-col overflow-hidden shrink-0" style={{ background: 'var(--navy-mid)', borderLeft: '1px solid var(--navy-border)' }}>
          <div className="flex" style={{ borderBottom: '1px solid var(--navy-border)' }}>
            {['sightings', 'vessels', 'crews', 'supplies'].map((t) => (
              <button key={t} onClick={() => setActiveTab(t)}
                className="flex-1 py-2 text-[10px] font-bold uppercase tracking-widest transition-all mono"
                style={activeTab === t
                  ? { borderBottom: '2px solid var(--cyan-glow)', color: 'var(--cyan-glow)', background: 'rgba(0,212,255,0.05)' }
                  : { color: 'var(--text-dim)', borderBottom: '2px solid transparent' }
                }>
                {t}
                {t === 'sightings' && visibleSightings.length > 0 && (
                  <span className="ml-1 px-1 rounded" style={{ background: 'var(--navy-surface)', color: 'var(--text-secondary)', fontSize: 9 }}>{visibleSightings.length}</span>
                )}
                {t === 'vessels' && vesselIdsInSightingsOrMission.size > 0 && (
                  <span className="ml-1 px-1 rounded" style={{ background: 'rgba(0,212,255,0.2)', color: 'var(--cyan-glow)', fontSize: 9 }}>{vesselIdsInSightingsOrMission.size}</span>
                )}
                {t === 'crews' && crewsTabList.length > 0 && (
                  <span className="ml-1 px-1 rounded" style={{ background: 'var(--amber)', color: '#000', fontSize: 9 }}>{crewsTabList.length}</span>
                )}
                {t === 'supplies' && lowSupplies.length > 0 && <span className="ml-1 px-1 rounded" style={{ background: 'var(--red-crit)', color: '#fff', fontSize: 9 }}>{lowSupplies.length}</span>}
              </button>
            ))}
          </div>

          {/* AI Suggestions */}
          <div className="p-3" style={{ borderBottom: '1px solid var(--navy-border)' }}>
            <div className="flex items-center justify-between mb-2">
              <span className="display tracking-widest text-sm flex items-center gap-1.5" style={{ color: 'var(--cyan-glow)' }}>
                ✦ AI CREW AGENT
              </span>
              <button onClick={fireAiSuggestions} disabled={aiLoading}
                className="mono text-[10px] font-bold px-2 py-0.5 rounded transition-colors"
                style={{ background: 'rgba(0,212,255,0.1)', border: '1px solid var(--cyan-glow)', color: 'var(--cyan-glow)' }}>
                {aiLoading ? '···' : 'REFRESH'}
              </button>
            </div>
            {availableFleet.length === 0 && (
              <p className="mono text-[10px] mb-2 leading-snug" style={{ color: 'var(--amber)' }}>▲ No vessels available — free a hull to enable AI dispatch.</p>
            )}
            {liveAiSuggestions.length === 0 ? (
              (() => {
                // While there's queued work but the agent has nothing live to show, the
                // backstop effect above will be re-asking the AI on a 15s cooldown — surface
                // that to the operator so an empty card looks intentional, not broken.
                const queueCount = shoreSightings.length + shipSightings.length
                  + pendingHandoffs.length
                  + supplies.filter((x) => x.quantity <= x.low_threshold).length;
                if (queueCount > 0) {
                  return (
                    <p className="mono text-[10px]" style={{ color: 'var(--text-dim)' }}>
                      {aiLoading
                        ? `··· generating recommendations for ${queueCount} queued item${queueCount === 1 ? '' : 's'}`
                        : `${queueCount} item${queueCount === 1 ? '' : 's'} queued — refreshing recommendations…`}
                    </p>
                  );
                }
                return (
                  <p className="mono text-[10px]" style={{ color: 'var(--text-dim)' }}>Auto-refreshes after live updates. Hit REFRESH to force.</p>
                );
              })()
            ) : (
              <div className="space-y-1.5">
                {liveAiSuggestions.map((s, i) => {
                  const idx = aiSuggestions.indexOf(s);
                  const label = actionLabel(s.action_type);
                  return (
                    <div key={idx >= 0 ? idx : i} className="rounded-lg p-2 flex items-start gap-2"
                      style={{ background: 'var(--navy-surface)', border: '1px solid var(--navy-border)' }}>
                      <span className="mono text-[10px] shrink-0 mt-0.5" style={{ color: 'var(--text-dim)' }}>{i + 1}.</span>
                      <p className="text-xs flex-1 leading-snug" style={{ color: 'var(--text-primary)' }}>{s.text}</p>
                      <div className="flex items-center gap-1 shrink-0">
                        {label && (
                          <button onClick={() => executeAction(s, idx)} disabled={executingAction === idx}
                            className="mono text-[10px] font-bold px-2 py-0.5 rounded transition-colors whitespace-nowrap"
                            style={{ background: 'rgba(0,212,255,0.12)', border: '1px solid var(--cyan-glow)', color: 'var(--cyan-glow)' }}>
                            {executingAction === idx ? '···' : label.toUpperCase()}
                          </button>
                        )}
                        <button
                          onClick={() => setAiSuggestions((prev) => prev.filter((_, j) => j !== idx))}
                          className="mono text-[10px] font-bold w-5 h-5 flex items-center justify-center rounded transition-colors"
                          style={{ color: 'var(--text-dim)', background: 'transparent' }}
                          title="Dismiss"
                          onMouseEnter={e => e.currentTarget.style.color = 'var(--red-crit)'}
                          onMouseLeave={e => e.currentTarget.style.color = 'var(--text-dim)'}
                        >✕</button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Tab Content */}
          <div className="flex-1 overflow-y-auto p-3 space-y-2 fade-in">
            {activeTab === 'sightings' && (
              <>
                <details className="rounded-lg border border-slate-600/70 bg-slate-900/35 mb-1.5 group">
                  <summary className="cursor-pointer list-none px-2.5 py-2 flex items-center justify-between gap-2 [&::-webkit-details-marker]:hidden">
                    <span className="mono text-[10px] font-bold tracking-widest text-amber-200/90">ACTIVE · SHORE CREW</span>
                    <span className="mono text-[10px] text-slate-400">{shoreMissions.length} mission{shoreMissions.length === 1 ? '' : 's'}</span>
                  </summary>
                  <div className="px-2 pb-2 space-y-1.5 border-t border-slate-700/60 pt-1.5">
                    {shoreMissions.length === 0 ? (
                      <p className="text-[10px] text-slate-500 px-0.5">None</p>
                    ) : (
                      shoreMissions.map((m) => renderMissionRow(m))
                    )}
                  </div>
                </details>

                <details className="rounded-lg border border-slate-600/70 bg-slate-900/35 mb-1.5 group">
                  <summary className="cursor-pointer list-none px-2.5 py-2 flex items-center justify-between gap-2 [&::-webkit-details-marker]:hidden">
                    <span className="mono text-[10px] font-bold tracking-widest text-cyan-200/90">ACTIVE · SHIP</span>
                    <span className="mono text-[10px] text-slate-400">{shipMissions.length} mission{shipMissions.length === 1 ? '' : 's'}</span>
                  </summary>
                  <div className="px-2 pb-2 space-y-1.5 border-t border-slate-700/60 pt-1.5">
                    {shipMissions.length === 0 ? (
                      <p className="text-[10px] text-slate-500 px-0.5">None</p>
                    ) : (
                      shipMissions.map((m) => renderMissionRow(m))
                    )}
                  </div>
                </details>

                {pendingHandoffs.length > 0 && (
                  <div className="space-y-1.5 mb-1.5">
                    <p className="mono text-[10px] font-bold tracking-widest" style={{ color: 'var(--amber)' }}>⚑ HANDOFF → {myAgency.toUpperCase()}</p>
                    {pendingHandoffs.map((s) => (
                      <div key={s.id} className="rounded-lg p-2.5" style={{ border: '1px solid rgba(245,158,11,0.35)', background: 'rgba(245,158,11,0.06)' }}>
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <div className="flex items-center gap-1 flex-wrap">
                              <span className={`text-[10px] font-bold px-1 py-0.5 rounded-full ${densityBadge(s.density_score, s.density_label)}`}>{s.density_label}</span>
                              <span className="text-[11px] text-slate-300 capitalize truncate">{s.debris_type?.replace('_', ' ')}</span>
                            </div>
                            <p className="mono text-[9px] mt-0.5 text-amber-400/90 truncate">FROM {s.source_jurisdiction}</p>
                          </div>
                          <button type="button" onClick={() => acceptHandoff(s)} className="shrink-0 bg-amber-500 hover:bg-amber-400 text-black text-[10px] font-bold px-2 py-1 rounded">
                            Accept
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                <details className="rounded-lg border border-slate-600/70 bg-slate-900/35 mb-1.5 group">
                  <summary className="cursor-pointer list-none px-2.5 py-2 flex items-center justify-between gap-2 [&::-webkit-details-marker]:hidden">
                    <span className="mono text-[10px] font-bold tracking-widest text-amber-100/80">QUEUE · SHORE PICKUP</span>
                    <span className="mono text-[10px] text-slate-400">{shoreSightings.length}</span>
                  </summary>
                  <div className="px-2 pb-2 space-y-1.5 border-t border-slate-700/60 pt-1.5 max-h-64 overflow-y-auto">
                    {shoreSightings.length === 0 ? (
                      <p className="text-[10px] text-slate-500 px-0.5">No shore-classified sightings.</p>
                    ) : (
                      shoreSightings.map((s) => renderSightingRow(s, 'land'))
                    )}
                  </div>
                </details>

                <details className="rounded-lg border border-slate-600/70 bg-slate-900/35 mb-2 group">
                  <summary className="cursor-pointer list-none px-2.5 py-2 flex items-center justify-between gap-2 [&::-webkit-details-marker]:hidden">
                    <span className="mono text-[10px] font-bold tracking-widest text-cyan-100/80">QUEUE · SHIP PICKUP</span>
                    <span className="mono text-[10px] text-slate-400">{shipSightings.length}</span>
                  </summary>
                  <div className="px-2 pb-2 space-y-1.5 border-t border-slate-700/60 pt-1.5 max-h-64 overflow-y-auto">
                    {shipSightings.length === 0 ? (
                      <p className="text-[10px] text-slate-500 px-0.5">No ship-classified sightings.</p>
                    ) : (
                      shipSightings.map((s) => renderSightingRow(s, 'ship'))
                    )}
                  </div>
                </details>
              </>
            )}

            {activeTab === 'vessels' && (
              <>
                <p className="text-slate-500 text-[10px] leading-snug mb-2">
                  <span className="text-cyan-400/90 font-semibold">Mission / queue</span> hulls (any agency) appear first; other <span className="text-slate-400">{myAgency}</span> vessels follow.
                </p>
                {vesselsTabList.map((v) => {
                  const inPlay = vesselIdsInSightingsOrMission.has(v.id);
                  const onMission = vesselIdsOnShipMission.has(v.id);
                  const tag = onMission ? 'Mission' : inPlay ? 'Queued' : null;
                  return (
                    <a key={v.id} href={`/vessel/${v.id}`} className="block rounded-xl p-3 transition-all mb-1.5" style={{ background: 'var(--navy-surface)', border: '1px solid var(--navy-border)' }}
                      onMouseEnter={(e) => { e.currentTarget.style.borderColor = 'var(--cyan-glow)'; }}
                      onMouseLeave={(e) => { e.currentTarget.style.borderColor = 'var(--navy-border)'; }}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <p className="text-sm font-semibold truncate" style={{ color: 'var(--text-primary)' }}>{v.name}</p>
                            {tag && (
                              <span className="mono text-[9px] font-bold px-1 py-0.5 rounded shrink-0" style={{
                                background: onMission ? 'rgba(0,212,255,0.2)' : 'rgba(16,185,129,0.12)',
                                border: `1px solid ${onMission ? 'var(--cyan-glow)' : 'var(--green-ok)'}`,
                                color: onMission ? 'var(--cyan-glow)' : 'var(--green-ok)',
                              }}>{tag}</span>
                            )}
                          </div>
                          <p className="mono text-[10px] mt-0.5 truncate" style={{ color: 'var(--text-dim)' }}>{v.zone}{v.agency && v.agency !== myAgency ? ` · ${v.agency}` : ''}</p>
                          <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                            <span className="mono text-[10px] font-bold px-1.5 py-0.5 rounded"
                              style={{
                                background: v.status === 'available' ? 'rgba(16,185,129,0.15)' : v.status === 'deployed' ? 'rgba(0,212,255,0.15)' : 'rgba(245,158,11,0.15)',
                                border: `1px solid ${v.status === 'available' ? 'var(--green-ok)' : v.status === 'deployed' ? 'var(--cyan-glow)' : 'var(--amber)'}`,
                                color: v.status === 'available' ? 'var(--green-ok)' : v.status === 'deployed' ? 'var(--cyan-glow)' : 'var(--amber)',
                              }}>
                              {v.status.toUpperCase()}
                            </span>
                            <span className="mono text-[10px]" style={{ color: v.fuel_level <= v.fuel_threshold ? 'var(--red-crit)' : 'var(--text-secondary)' }}>
                              ⛽ {v.fuel_level}%
                            </span>
                          </div>
                        </div>
                        <span className="mono text-xs shrink-0" style={{ color: 'var(--cyan-glow)' }}>→</span>
                      </div>
                    </a>
                  );
                })}
              </>
            )}

            {activeTab === 'crews' && (
              <>
                <p className="text-slate-500 text-[10px] leading-snug mb-2">
                  Every shore crew on a mission, in a sighting ranking (incl. synthetic patrols), plus other <span className="text-slate-400">{myAgency}</span> DB crews.
                </p>
                {crewsTabList.length === 0 ? (
                  <div className="rounded-xl border border-dashed border-slate-700 p-3 text-center">
                    <p className="text-slate-500 text-xs">No shore crews in play. Add sightings or seed land_crews.</p>
                  </div>
                ) : (
                  crewsTabList.map((c) => {
                    const statusStyle = c.status === 'available'
                      ? { bg: 'rgba(16,185,129,0.15)', border: 'var(--green-ok)', color: 'var(--green-ok)' }
                      : c.status === 'deployed'
                        ? { bg: 'rgba(0,212,255,0.15)', border: 'var(--cyan-glow)', color: 'var(--cyan-glow)' }
                        : { bg: 'rgba(245,158,11,0.15)', border: 'var(--amber)', color: 'var(--amber)' };
                    const synthetic = isSyntheticShoreId(c.id);
                    const onMission = landCrewIdsOnShoreMission.has(c.id);
                    return (
                      <a key={c.id} href={`/shore/${encodeURIComponent(c.id)}`} className="block rounded-xl p-3 transition-all mb-1.5"
                        style={{ background: 'var(--navy-surface)', border: '1px solid var(--navy-border)' }}
                        onMouseEnter={(e) => (e.currentTarget.style.borderColor = 'var(--green-ok)')}
                        onMouseLeave={(e) => (e.currentTarget.style.borderColor = 'var(--navy-border)')}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <div className="flex items-center gap-1.5 flex-wrap">
                              <span className="text-sm font-semibold truncate" style={{ color: 'var(--text-primary)' }}>🛟 {c.name}</span>
                              {synthetic && (
                                <span className="mono text-[9px] font-bold px-1 py-0.5 rounded shrink-0 bg-amber-950/80 text-amber-200 border border-amber-700/80">Synth</span>
                              )}
                              {onMission && (
                                <span className="mono text-[9px] font-bold px-1 py-0.5 rounded shrink-0 bg-cyan-950/80 text-cyan-200 border border-cyan-700/80">Mission</span>
                              )}
                            </div>
                            <p className="mono text-[10px] mt-0.5 truncate" style={{ color: 'var(--text-dim)' }}>
                              {Number.isFinite(c.base_lat) && Number.isFinite(c.base_lon)
                                ? formatCoordPair(c.base_lat, c.base_lon)
                                : 'no base set'}
                              {c.agency && c.agency !== myAgency ? ` · ${c.agency}` : ''}
                            </p>
                            <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                              <span className="mono text-[10px] font-bold px-1.5 py-0.5 rounded"
                                style={{ background: statusStyle.bg, border: `1px solid ${statusStyle.border}`, color: statusStyle.color }}>
                                {(c.status || 'available').toUpperCase()}
                              </span>
                              <span className="mono text-[10px]" style={{ color: 'var(--text-secondary)' }}>
                                {Math.round(c.capacity_kg || 0)}kg · {c.transport_speed_kmh || 0}km/h
                              </span>
                            </div>
                          </div>
                          <span className="mono text-xs shrink-0" style={{ color: 'var(--green-ok)' }}>→</span>
                        </div>
                      </a>
                    );
                  })
                )}
              </>
            )}

            {activeTab === 'supplies' && (() => {
              const zones = [...new Set(supplies.map((s) => s.zone))];
              const ordersBySupply = supplyOrders.reduce((acc, o) => {
                if (!acc[o.supply_id]) acc[o.supply_id] = [];
                acc[o.supply_id].push(o);
                return acc;
              }, {});
              return (
                <div className="space-y-3">
                  {orderBanner && (
                    <div className="bg-emerald-900/50 border border-emerald-600 rounded-xl p-3 text-xs">
                      <p className="text-emerald-100 font-semibold">{orderBanner.message}</p>
                      <p className="text-emerald-200/90 mt-1 leading-snug">{orderBanner.detail}</p>
                      <button type="button" onClick={() => setOrderBanner(null)} className="text-emerald-300 hover:text-white mt-2 underline">
                        Dismiss
                      </button>
                    </div>
                  )}
                  <p className="text-slate-500 text-xs leading-snug">
                    Orders go to external suppliers; on-hand counts rise only after each line&apos;s ETA (checked whenever this dashboard loads or realtime fires). For demos, set REACT_APP_SUPPLY_LEAD_SCALE to a small fraction (e.g. 0.05) in .env to shorten simulated lead times.
                  </p>
                  {supplyOrders.length > 0 && (
                    <div className="rounded-xl border border-slate-600 bg-slate-800/80 p-3">
                      <p className="text-slate-400 text-xs font-semibold uppercase tracking-wide mb-2">Inbound purchase orders ({supplyOrders.length})</p>
                      <ul className="space-y-2 max-h-44 overflow-y-auto pr-1">
                        {supplyOrders.map((o) => {
                          const sn = supplies.find((x) => x.id === o.supply_id);
                          return (
                            <li key={o.id} className="text-xs text-slate-300 border-b border-slate-700/80 pb-2 last:border-0 last:pb-0">
                              <span className="font-semibold text-white">+{o.quantity}</span>
                              {' '}{sn?.name || 'Item'}
                              {sn?.zone ? <span className="text-slate-500"> · {sn.zone}</span> : null}
                              <span className="block font-mono tabular-nums text-cyan-300 mt-1">
                                Arrives in {formatCountdownTo(o.expected_arrival_at)}
                              </span>
                              <span className="block text-slate-500 text-[10px] mt-0.5">
                                ~ {formatEtaHuman(o.expected_arrival_at)}
                              </span>
                              <span className="block text-slate-500 mt-0.5">{o.supplier_name}</span>
                              {o.fulfillment_note && (
                                <span className="block text-slate-500 mt-1 leading-snug">{o.fulfillment_note}</span>
                              )}
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  )}
                  {zones.map((zone) => (
                    <div key={zone} className="mb-3">
                      <p className="text-slate-400 text-xs font-semibold mb-1.5">{zone}</p>
                      {supplies.filter((s) => s.zone === zone).map((s) => {
                        const isLow = s.quantity <= s.low_threshold;
                        const pending = ordersBySupply[s.id] || [];
                        const nextQty = computeReorderQuantity(s);
                        return (
                          <div key={s.id} className={`rounded-lg px-3 py-2 mb-2 ${isLow ? 'bg-red-950 border border-red-700' : 'bg-slate-700'}`}>
                            <div className="flex items-start justify-between gap-2">
                              <div className="min-w-0">
                                <span className="text-slate-200 text-xs font-medium">{s.name}</span>
                                {isLow && <span className="ml-2 text-xs text-red-400 font-bold">LOW</span>}
                                <p className="text-slate-500 text-[10px] mt-0.5">Reorder batch target ≈ {nextQty} units (covers threshold + headroom)</p>
                              </div>
                              <div className="flex flex-col items-end gap-1 shrink-0">
                                <span className={`text-sm font-bold tabular-nums ${isLow ? 'text-red-400' : 'text-slate-300'}`}>{s.quantity}</span>
                                <button
                                  type="button"
                                  disabled={supplySubmitId === s.id}
                                  onClick={() => handlePlaceSupplyOrder(s)}
                                  className="bg-amber-700 hover:bg-amber-600 disabled:opacity-50 text-white text-[10px] font-semibold px-2 py-1 rounded-lg whitespace-nowrap"
                                  title="Creates a supplier PO; inventory updates when ETA passes"
                                >
                                  {supplySubmitId === s.id ? '…' : `Request ~${nextQty}`}
                                </button>
                              </div>
                            </div>
                            {pending.length > 0 && (
                              <ul className="mt-2 pt-2 border-t border-slate-600/80 space-y-1">
                                {pending.map((o) => (
                                  <li key={o.id} className="text-[10px] text-amber-200/90 leading-snug space-y-0.5">
                                    <span className="block font-mono tabular-nums text-amber-300">
                                      Arrives in {formatCountdownTo(o.expected_arrival_at)}
                                    </span>
                                    <span className="block text-amber-200/80">
                                      PO in transit: +{o.quantity}
                                      {o.stock_profile ? ` · ${o.stock_profile.replace(/_/g, ' ')}` : ''}
                                      {' · '}
                                      ~ {formatEtaHuman(o.expected_arrival_at)}
                                    </span>
                                  </li>
                                ))}
                              </ul>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  ))}
                </div>
              );
            })()}
          </div>
        </div>
      </div>

      {/* Assign Modal */}
      {assignModal && (() => {
        const ranking = crewRankings.get(assignModal.id);
        const ranked = ranking?.ranked || [];
        const kg = ranking?.kg ?? 0;
        const kgSource = ranking?.kgSource;
        const pickupKey = ranking?.pickupKey;
        const noOptions = ranked.length === 0;
        return (
          <div className="fixed inset-0 flex items-center justify-center p-4 z-50" style={{ background: 'rgba(2,12,27,0.85)', backdropFilter: 'blur(8px)' }}>
            <div className="glass rounded-2xl p-6 max-w-lg w-full shadow-2xl max-h-[90vh] overflow-y-auto slide-up">
              <h3 className="display tracking-widest text-xl mb-1" style={{ color: 'var(--cyan-glow)' }}>DISPATCH CREW</h3>
              <p className="text-slate-400 text-sm mb-1">{assignModal.density_label} {assignModal.debris_type?.replace('_', ' ')} cluster</p>
              <p className="text-slate-500 text-xs mb-4">
                Site mass est: <span className="text-slate-300 font-mono">{Math.round(kg)} kg</span>
                <span className="text-slate-600"> ({kgSource === 'string' ? 'from volume string' : kgSource === 'patch' ? 'from patch length' : 'from density × type'})</span>
                {pickupKey && (
                  <span className={`ml-2 inline-block text-[10px] font-semibold px-1.5 py-0.5 rounded ${pickupBadgeClassName(pickupKey)}`}>
                    {pickupKey === 'land' ? 'Land pickup' : pickupKey === 'ship' ? 'Ship pickup' : pickupKey === 'ship_coast' ? 'Ship + coast' : 'Verify'}
                  </span>
                )}
              </p>
              {noOptions ? (
                <p className="text-amber-300 text-sm mb-4 leading-snug">
                  No crews currently available for this pickup mode. Free a vessel/team or wait for a returning crew.
                </p>
              ) : (
                <div className="space-y-2 mb-4">
                  {ranked.slice(0, 5).map((opt, i) => {
                    const isSelected = selectedCrew?.type === opt.crewType && selectedCrew?.id === opt.crewId;
                    const isBest = i === 0;
                    const detail = opt.crewType === 'ship'
                      ? `${opt.breakdown.distanceNm} nm transit · ${opt.breakdown.onsiteMinPerTrip} min on-site/trip`
                      : `${opt.breakdown.distanceKm} km drive · ${opt.breakdown.onsiteMinPerTrip} min on-site/trip · ${opt.breakdown.responseMin} min mobilize`;
                    return (
                      <button
                        key={`${opt.crewType}-${opt.crewId}`}
                        type="button"
                        onClick={() => setSelectedCrew({ type: opt.crewType, id: opt.crewId })}
                        className={`w-full text-left rounded-xl p-3 border transition-colors ${isSelected ? 'border-cyan-500 bg-cyan-950/40' : 'border-slate-600 bg-slate-900 hover:bg-slate-700/50'}`}
                      >
                        <div className="flex items-start justify-between gap-2 mb-1">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded ${opt.crewType === 'ship' ? 'bg-cyan-950 text-cyan-200 border border-cyan-700' : 'bg-amber-950 text-amber-200 border border-amber-700'}`}>
                              {opt.crewType === 'ship' ? 'Ship' : 'Shore'}
                            </span>
                            <span className="text-white text-sm font-semibold">{opt.crewName}</span>
                            {isBest && <span className="text-[10px] bg-emerald-700 text-emerald-100 px-1.5 py-0.5 rounded">Fastest</span>}
                          </div>
                          <span className="text-cyan-300 font-mono text-sm shrink-0">{formatEtaShort(opt.totalMinutes)}</span>
                        </div>
                        <p className="text-slate-400 text-xs leading-snug">
                          {opt.trips} trip{opt.trips === 1 ? '' : 's'} · ~{Math.round(opt.kg)} kg total
                        </p>
                        <p className="text-slate-500 text-[11px] leading-snug mt-0.5">{detail}</p>
                      </button>
                    );
                  })}
                </div>
              )}
              <div className="flex gap-2">
                <button onClick={() => {
                  // Cancel only closes the modal — leave the AI suggestion in place so the operator can retry it.
                  pendingAiSuggestionRef.current = null;
                  setAssignModal(null);
                  setSelectedCrew(null);
                }}
                  className="flex-1 bg-slate-700 hover:bg-slate-600 text-white py-2.5 rounded-xl transition-colors">Cancel</button>
                <button onClick={handleAssign} disabled={!selectedCrew || noOptions}
                  className="flex-1 bg-cyan-600 hover:bg-cyan-700 disabled:opacity-40 text-white font-semibold py-2.5 rounded-xl transition-colors">
                  Dispatch + Generate Brief
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Assignment Brief Modal */}
      {briefModal && (
        <div className="fixed inset-0 flex items-center justify-center p-4 z-50" style={{ background: 'rgba(2,12,27,0.85)', backdropFilter: 'blur(8px)' }}>
          <div className="glass rounded-2xl p-6 max-w-md w-full shadow-2xl slide-up">
            <h3 className="display tracking-widest text-xl mb-1" style={{ color: 'var(--cyan-glow)' }}>CREW BRIEF — {briefModal.crewName?.toUpperCase()}</h3>
            <p className="text-slate-400 text-sm mb-1">
              {briefModal.crewType === 'ship' && briefModal.intercept ? (
                <>
                  Intercept in {briefModal.intercept.hours}h at{' '}
                  <span className="font-mono text-cyan-300">{formatCoordPair(briefModal.intercept.lat, briefModal.intercept.lon)}</span>
                </>
              ) : (
                <>
                  Land pickup at{' '}
                  <span className="font-mono text-cyan-300">{formatCoordPair(briefModal.sighting.latitude, briefModal.sighting.longitude)}</span>
                </>
              )}
            </p>
            {briefModal.est && (
              <p className="text-slate-500 text-xs mb-3">
                Estimate: <span className="text-slate-300 font-mono">~{Math.round(briefModal.est.kg)} kg · {briefModal.est.trips} trip{briefModal.est.trips === 1 ? '' : 's'} · {formatEtaShort(briefModal.est.totalMinutes)}</span>
              </p>
            )}
            <div className="rounded-xl p-4 mb-4" style={{ background: 'var(--navy-deep)', border: '1px solid var(--navy-border)' }}>
              <p className="text-sm leading-relaxed whitespace-pre-wrap" style={{ color: 'var(--text-primary)' }}>{briefModal.brief}</p>
            </div>
            <button onClick={() => setBriefModal(null)} className="w-full mono font-bold py-2.5 rounded-xl transition-colors"
              style={{ background: 'rgba(0,212,255,0.12)', border: '1px solid var(--cyan-glow)', color: 'var(--cyan-glow)' }}>DONE</button>
          </div>
        </div>
      )}

      {/* Toast notification */}
      {newAssignToast && (
        <div
          className="slide-up"
          style={{ position: 'fixed', top: 16, left: '50%', transform: 'translateX(-50%)', zIndex: 9999, minWidth: 300, pointerEvents: 'none' }}
        >
          <div style={{
            background: 'rgba(7,22,40,0.97)',
            border: `1px solid ${newAssignToast.type === 'sighting' ? 'var(--cyan-glow)' : 'var(--green-ok)'}`,
            boxShadow: `0 0 24px ${newAssignToast.type === 'sighting' ? 'rgba(0,212,255,0.35)' : 'rgba(16,185,129,0.35)'}`,
            borderRadius: '0.75rem',
            padding: '10px 16px',
            display: 'flex',
            alignItems: 'center',
            gap: 10,
          }}>
            <div style={{
              width: 10, height: 10, borderRadius: '50%', flexShrink: 0,
              background: newAssignToast.type === 'sighting' ? 'var(--cyan-glow)' : 'var(--green-ok)',
              boxShadow: `0 0 8px ${newAssignToast.type === 'sighting' ? 'var(--cyan-glow)' : 'var(--green-ok)'}`,
            }} />
            <div>
              <p style={{ fontFamily: 'IBM Plex Mono, monospace', fontSize: 11, fontWeight: 700, letterSpacing: '0.1em', color: newAssignToast.type === 'sighting' ? 'var(--cyan-glow)' : 'var(--green-ok)', margin: 0 }}>
                {newAssignToast.type === 'sighting' ? 'NEW SIGHTING REPORTED' : 'ASSIGNMENT DISPATCHED'}
              </p>
              <p style={{ fontFamily: 'IBM Plex Mono, monospace', fontSize: 10, color: 'var(--text-secondary)', margin: '2px 0 0' }}>
                {newAssignToast.type === 'sighting'
                  ? `${newAssignToast.label} filed a ${newAssignToast.detail} report`
                  : `${newAssignToast.label} → ${newAssignToast.detail}`}
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Handoff Brief Modal */}
      {handoffModal && (
        <div className="fixed inset-0 flex items-center justify-center p-4 z-50" style={{ background: 'rgba(2,12,27,0.85)', backdropFilter: 'blur(8px)' }}>
          <div className="glass rounded-2xl p-6 max-w-md w-full shadow-2xl slide-up">
            <h3 className="display tracking-widest text-xl mb-1" style={{ color: 'var(--amber)' }}>⚑ JURISDICTION HANDOFF</h3>
            <p className="mono text-xs mb-4" style={{ color: 'var(--text-secondary)' }}>{handoffModal.fromAgency?.toUpperCase()} → {handoffModal.toAgency?.toUpperCase()}</p>
            <div className="rounded-xl p-4 mb-4" style={{ background: 'var(--navy-deep)', border: '1px solid var(--navy-border)' }}>
              <p className="text-sm leading-relaxed whitespace-pre-wrap" style={{ color: 'var(--text-primary)' }}>{handoffModal.brief}</p>
            </div>
            <p className="mono text-[10px] mb-3" style={{ color: 'var(--text-dim)' }}>Pending acceptance by {handoffModal.toAgency}. Switch role selector to that queue to accept.</p>
            <button onClick={() => setHandoffModal(null)} className="w-full mono font-bold py-2.5 rounded-xl transition-colors"
              style={{ background: 'rgba(0,212,255,0.12)', border: '1px solid var(--cyan-glow)', color: 'var(--cyan-glow)' }}>DONE</button>
          </div>
        </div>
      )}
    </div>
  );
}
