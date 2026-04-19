import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { MapContainer, TileLayer, Marker, Polyline, Popup, Circle, useMapEvents, useMap } from 'react-leaflet';
import L from 'leaflet';
import { supabase } from '../lib/supabase';
import { getCrewSuggestions, generateHandoffBrief, generateAssignmentBrief } from '../lib/gemini';
import { getInterceptionPoint } from '../lib/drift';
import { computePacificLandfallDisplay, shouldShowSightingOnDashboard } from '../lib/landfall';
import { driftSegmentsForMap } from '../lib/mapPath';
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
  style.textContent = '@keyframes cm-pulse { 0%,100% { transform: scale(1); opacity: 1; } 50% { transform: scale(1.18); opacity: 0.75; } }';
  document.head.appendChild(style);
}

/** Stable palette used to color-link a sighting and the crew/vessel working it. */
const MISSION_PALETTE = ['#22d3ee', '#a855f7', '#f59e0b', '#10b981', '#f43f5e', '#3b82f6', '#eab308', '#ec4899'];

/** Hash an assignment id to a stable palette index so the same mission always gets the same color. */
function colorForMissionId(missionId) {
  if (!missionId) return null;
  let hash = 0;
  for (let i = 0; i < missionId.length; i += 1) hash = (hash * 31 + missionId.charCodeAt(i)) >>> 0;
  return MISSION_PALETTE[hash % MISSION_PALETTE.length];
}

const debrisIcon = (score, selected = false, missionColor = null) => {
  const fill = score >= 8 ? '#dc2626' : score >= 6 ? '#ea580c' : score >= 3 ? '#ca8a04' : '#16a34a';
  const size = selected ? 26 : missionColor ? 22 : 16;
  const ringWidth = missionColor ? 4 : selected ? 3 : 2;
  const ringColor = missionColor || (selected ? '#22d3ee' : 'white');
  const glow = missionColor
    ? `0 0 12px ${missionColor}cc`
    : selected
      ? '0 0 10px rgba(34,211,238,0.6)'
      : '0 0 4px rgba(0,0,0,0.5)';
  return L.divIcon({
    className: '',
    html: `<div style="width:${size}px;height:${size}px;border-radius:50%;background:${fill};border:${ringWidth}px solid ${ringColor};box-shadow:${glow};${missionColor && selected ? 'animation:cm-pulse 1.6s ease-in-out infinite;' : ''}"></div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
};

const vesselIcon = (missionColor = null, selected = false) => {
  const size = missionColor ? (selected ? 32 : 28) : 24;
  const halo = missionColor
    ? `<div style="position:absolute;inset:0;border-radius:50%;border:${selected ? 3 : 2}px solid ${missionColor};background:${missionColor}33;box-shadow:0 0 ${selected ? 14 : 8}px ${missionColor}cc;${selected ? 'animation:cm-pulse 1.6s ease-in-out infinite;' : ''}"></div>`
    : '';
  return L.divIcon({
    className: '',
    html: `<div style="position:relative;width:${size}px;height:${size}px;display:flex;align-items:center;justify-content:center;">${halo}<div style="position:relative;font-size:20px;line-height:1;filter:drop-shadow(0 1px 2px rgba(0,0,0,0.8))">🚢</div></div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
};

const landCrewIcon = (missionColor, selected = false) => {
  const size = selected ? 30 : 26;
  return L.divIcon({
    className: '',
    html: `<div style="position:relative;width:${size}px;height:${size}px;display:flex;align-items:center;justify-content:center;"><div style="position:absolute;inset:0;border-radius:50%;border:${selected ? 3 : 2}px solid ${missionColor};background:${missionColor}33;box-shadow:0 0 ${selected ? 14 : 8}px ${missionColor}cc;${selected ? 'animation:cm-pulse 1.6s ease-in-out infinite;' : ''}"></div><div style="position:relative;font-size:16px;line-height:1;">🥾</div></div>`,
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
  /** sighting ids currently being auto-dispatched to a shore crew (avoids double-assigning). */
  const autoDispatchInFlightRef = useRef(new Set());

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
      const active = sRes.data.filter((s) => s.handoff_status !== 'pending');
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
    const hasLowSupplies = (suppliesDataRef.current || []).some((s) => s.quantity <= s.low_threshold);
    if (
      sightingsDataRef.current.length === 0
      && vesselsDataRef.current.length === 0
      && assignmentsDataRef.current.length === 0
      && pendingHandoffsRef.current.length === 0
      && !hasLowSupplies
    ) return;
    setAiLoading(true);
    try {
      // Build a fresh ranking map from refs so the AI prompt always sees current state.
      const liveSightings = sightingsDataRef.current;
      const liveVessels = vesselsDataRef.current;
      const liveLandCrews = landCrewsDataRef.current;
      const liveDrifts = driftsDataRef.current;
      const rankingsForAi = new Map();
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
        assignments: assignmentsDataRef.current,
        pendingHandoffs: pendingHandoffsRef.current,
        crewRankings: rankingsForAi,
        supplies: suppliesDataRef.current,
      });
      setAiSuggestions(Array.isArray(result) ? result : [{ text: result, action_type: 'none' }]);
    } catch (e) { console.error(e); }
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

  /** Map<vessel.id, mission> — quick lookup for vessel marker coloring. */
  const missionByVessel = useMemo(() => {
    const m = new Map();
    for (const mission of ongoingMissions) {
      if (mission.vessel) m.set(mission.vessel.id, mission);
    }
    return m;
  }, [ongoingMissions]);

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
      .on('postgres_changes', { event: '*', schema: 'public', table: 'debris_sightings' }, () => {
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
  }, [fetchData, scheduleAiRefresh]);

  const handleAssign = async () => {
    if (!assignModal || !selectedCrew) return;
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
      setBriefModal({ brief, crewName: crew.name, crewType: 'land', sighting: assignModal, intercept: null, est });
    }

    setAssignModal(null);
    setSelectedCrew(null);
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

  /**
   * Auto-dispatch shore-crew missions for sightings whose drift forecast reaches land
   * (pickup mode 'ship_coast') or that are already on land ('land'). The closest available
   * land crew gets assigned automatically the moment the sighting + drift land in the
   * dashboard. Ships are NEVER auto-dispatched — only shore teams get this lane, since
   * the user wants flagged trash handled by ground crews by default.
   */
  useEffect(() => {
    const assignedSightingIds = new Set(
      (assignments || [])
        .filter((a) => a.status !== 'completed')
        .map((a) => a.sighting_id),
    );

    const candidates = visibleSightings.filter((s) => {
      if (s.status !== 'reported') return false;
      if (assignedSightingIds.has(s.id)) return false;
      if (autoDispatchInFlightRef.current.has(s.id)) return false;
      const ranking = crewRankings.get(s.id);
      if (!ranking) return false;
      if (ranking.pickupKey !== 'ship_coast' && ranking.pickupKey !== 'land') return false;
      // Pick the best LAND option (rankings already put land first for ship_coast).
      const bestLand = ranking.ranked.find((r) => r.crewType === 'land');
      if (!bestLand) return false;
      return true;
    });

    if (candidates.length === 0) return;

    (async () => {
      for (const sighting of candidates) {
        autoDispatchInFlightRef.current.add(sighting.id);
        try {
          const ranking = crewRankings.get(sighting.id);
          const bestLand = ranking?.ranked.find((r) => r.crewType === 'land');
          if (!bestLand) continue;
          const crew = bestLand.crew;
          const synthetic = isSyntheticShoreId(crew.id);
          // Real crews need to be available; synthetic stations are always on-call.
          if (!synthetic && crew.status !== 'available') continue;

          let brief = '';
          try {
            brief = await generateAssignmentBrief({
              vesselName: `${crew.name} (shore crew, auto-dispatched)`,
              debrisType: sighting.debris_type,
              densityLabel: sighting.density_label,
              interceptionHours: 0,
              lat: sighting.latitude,
              lon: sighting.longitude,
            });
          } catch (e) {
            console.warn('Auto-dispatch brief generation failed; continuing without brief.', e);
          }

          const insertPayload = {
            sighting_id: sighting.id,
            land_crew_id: synthetic ? null : crew.id,
            crew_type: 'land',
            interception_lat: sighting.latitude,
            interception_lon: sighting.longitude,
            interception_hours: 0,
            estimated_kg: bestLand.kg ?? null,
            estimated_trips: bestLand.trips ?? null,
            total_minutes: bestLand.totalMinutes ?? null,
            status: 'assigned',
            gemini_brief: brief || `Auto-dispatched: ${crew.name} → ${sighting.debris_type} cleanup.`,
          };
          if (synthetic) {
            insertPayload.shore_station_lat = crew.base_lat;
            insertPayload.shore_station_lon = crew.base_lon;
            insertPayload.shore_station_name = crew.name;
          }
          const { error: insertErr } = await supabase.from('assignments').insert(insertPayload);
          if (insertErr) {
            console.error('Auto-dispatch insert failed', insertErr);
            continue;
          }
          const followups = [
            supabase.from('debris_sightings').update({ status: 'assigned' }).eq('id', sighting.id),
          ];
          if (!synthetic) {
            followups.push(
              supabase.from('land_crews').update({ status: 'deployed', updated_at: new Date().toISOString() }).eq('id', crew.id),
            );
          }
          await Promise.all(followups);
        } catch (e) {
          console.error('Auto-dispatch failed for sighting', sighting.id, e);
        } finally {
          autoDispatchInFlightRef.current.delete(sighting.id);
        }
      }
      await fetchData();
      fireAiSuggestions();
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleSightings, crewRankings, assignments, landCrews]);

  const executeAction = async (s, idx) => {
    setExecutingAction(idx);
    try {
      if (s.action_type === 'assign_vessel') {
        const available = vessels.filter((v) => v.status === 'available');
        if (available.length === 0) {
          alert('No cleanup vessels are available right now. Free a hull from deployment or maintenance, then try again.');
          return;
        }
        const sighting = s.sighting_id ? sightings.find((x) => x.id === s.sighting_id) : sightings[0];
        const vessel = s.vessel_id ? vessels.find((v) => v.id === s.vessel_id) : available[0];
        if (sighting && vessel) { setAssignModal(sighting); setSelectedCrew({ type: 'ship', id: vessel.id }); }
      } else if (s.action_type === 'assign_land_crew') {
        const available = landCrews.filter((c) => c.status === 'available');
        if (available.length === 0) {
          alert('No land crews available right now. Free a team from deployment or wait for one returning.');
          return;
        }
        const sighting = s.sighting_id ? sightings.find((x) => x.id === s.sighting_id) : sightings[0];
        const crew = s.land_crew_id ? landCrews.find((c) => c.id === s.land_crew_id) : available[0];
        if (sighting && crew) { setAssignModal(sighting); setSelectedCrew({ type: 'land', id: crew.id }); }
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
      setAiSuggestions((prev) => prev.map((x, i) => i === idx ? { ...x, completed: true } : x));
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
  const lowSupplies = supplies.filter((s) => s.quantity <= s.low_threshold);
  const availableFleet = vessels.filter((v) => v.status === 'available');

  const actionLabel = (type) => {
    if (type === 'assign_vessel') return 'Assign';
    if (type === 'accept_handoff') return 'Accept';
    if (type === 'reorder_supply') return 'Order from supplier';
    if (type === 'mark_cleared') return 'Clear';
    return null;
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
                    icon={debrisIcon(s.density_score, isSelected || sightingMissionSelected, sightingMissionColor)}
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

            {vessels.filter((v) => v.current_lat && v.current_lon).map((v) => {
              const vesselMission = missionByVessel.get(v.id) || null;
              const vesselMissionColor = vesselMission?.color || null;
              const vesselMissionSelected = vesselMission && selectedMissionId === vesselMission.id;
              return (
                <Marker
                  key={v.id}
                  position={[v.current_lat, v.current_lon]}
                  icon={vesselIcon(vesselMissionColor, !!vesselMissionSelected)}
                  eventHandlers={vesselMission ? { click: () => selectMission(vesselMission) } : undefined}
                >
                  <Popup>
                    <div className="text-xs space-y-1">
                      <p className="font-bold">{v.name}</p>
                      <p>{v.zone}</p>
                      <p>Status: {v.status} | Fuel: {v.fuel_level}%</p>
                      <p className="font-mono text-gray-400">{formatCoordPair(v.current_lat, v.current_lon)}</p>
                      {vesselMission && (
                        <p className="font-semibold" style={{ color: vesselMission.color }}>
                          ● On mission to {vesselMission.sighting?.debris_type?.replace('_', ' ')}
                        </p>
                      )}
                    </div>
                  </Popup>
                </Marker>
              );
            })}

            {/* Mission connector lines + land crew base markers */}
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
                  />,
                  <Marker
                    key={`mission-${m.id}-landbase`}
                    position={[m.landCrew.base_lat, m.landCrew.base_lon]}
                    icon={landCrewIcon(m.color, isSelected)}
                    eventHandlers={{ click: () => selectMission(m) }}
                  >
                    <Popup>
                      <div className="text-xs space-y-1">
                        <p className="font-bold">{m.landCrew.name}</p>
                        <p className="text-gray-600">Land crew base</p>
                        <p className="font-semibold" style={{ color: m.color }}>● Dispatched to active sighting</p>
                      </div>
                    </Popup>
                  </Marker>
                );
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
            {['missions', 'sightings', 'vessels', 'supplies'].map((t) => (
              <button key={t} onClick={() => setActiveTab(t)}
                className="flex-1 py-2 text-[10px] font-bold uppercase tracking-widest transition-all mono"
                style={activeTab === t
                  ? { borderBottom: '2px solid var(--cyan-glow)', color: 'var(--cyan-glow)', background: 'rgba(0,212,255,0.05)' }
                  : { color: 'var(--text-dim)', borderBottom: '2px solid transparent' }
                }>
                {t}
                {t === 'missions' && ongoingMissions.length > 0 && <span className="ml-1 px-1 rounded" style={{ background: 'var(--green-ok)', color: '#000', fontSize: 9 }}>{ongoingMissions.length}</span>}
                {t === 'sightings' && visibleSightings.length > 0 && <span className="ml-1 px-1 rounded" style={{ background: 'var(--navy-surface)', color: 'var(--text-secondary)', fontSize: 9 }}>{visibleSightings.length}</span>}
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
            {aiSuggestions.length === 0 ? (
              <p className="mono text-[10px]" style={{ color: 'var(--text-dim)' }}>Auto-refreshes after live updates. Hit REFRESH to force.</p>
            ) : (
              <div className="space-y-1.5">
                {aiSuggestions.map((s, i) => {
                  const label = actionLabel(s.action_type);
                  return (
                    <div key={i} className="rounded-lg p-2 flex items-start gap-2"
                      style={s.completed
                        ? { background: 'rgba(16,185,129,0.08)', border: '1px solid rgba(16,185,129,0.3)' }
                        : { background: 'var(--navy-surface)', border: '1px solid var(--navy-border)' }
                      }>
                      <span className="mono text-[10px] shrink-0" style={{ color: 'var(--text-dim)' }}>{i + 1}.</span>
                      <p className="text-xs flex-1 leading-snug" style={{ color: 'var(--text-primary)' }}>{s.text}</p>
                      {s.completed ? (
                        <span className="text-xs shrink-0" style={{ color: 'var(--green-ok)' }}>✓</span>
                      ) : label ? (
                        <button onClick={() => executeAction(s, i)} disabled={executingAction === i}
                          className="shrink-0 mono text-[10px] font-bold px-2 py-0.5 rounded transition-colors whitespace-nowrap"
                          style={{ background: 'rgba(0,212,255,0.12)', border: '1px solid var(--cyan-glow)', color: 'var(--cyan-glow)' }}>
                          {executingAction === i ? '···' : label.toUpperCase()}
                        </button>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Tab Content */}
          <div className="flex-1 overflow-y-auto p-3 space-y-2 fade-in">
            {activeTab === 'missions' && (
              <>
                {ongoingMissions.length === 0 ? (
                  <div className="rounded-xl border border-dashed border-slate-700 p-4 text-center">
                    <p className="text-slate-400 text-sm font-semibold">No ongoing missions</p>
                    <p className="text-slate-500 text-xs mt-1 leading-snug">Dispatch a crew from the Sightings tab to start a mission. Active missions show here with a color-coded link to their crew on the map.</p>
                  </div>
                ) : (
                  <>
                    <p className="text-emerald-400 text-xs font-semibold uppercase tracking-wider mb-1 flex items-center gap-1.5">
                      <span className="w-1.5 h-1.5 bg-emerald-400 rounded-full animate-pulse" />
                      Active Missions ({ongoingMissions.length})
                    </p>
                    {ongoingMissions.map((m) => {
                      const isSelected = selectedMissionId === m.id;
                      const eta = Number.isFinite(m.assignment.total_minutes) ? formatEtaShort(m.assignment.total_minutes) : null;
                      const kg = Number.isFinite(m.assignment.estimated_kg) ? Math.round(m.assignment.estimated_kg) : null;
                      const trips = Number.isFinite(m.assignment.estimated_trips) ? m.assignment.estimated_trips : null;
                      return (
                        <div
                          key={m.id}
                          onClick={() => selectMission(m)}
                          className={`rounded-xl p-3 border-l-4 cursor-pointer transition-all bg-slate-700/60 hover:bg-slate-700 ${isSelected ? 'ring-2 ring-offset-2 ring-offset-slate-800' : ''}`}
                          style={{
                            borderLeftColor: m.color,
                            ...(isSelected ? { '--tw-ring-color': m.color, boxShadow: `0 0 0 1px ${m.color}66, 0 0 18px ${m.color}55` } : {}),
                          }}
                        >
                          <div className="flex items-center justify-between gap-2 mb-1">
                            <div className="flex items-center gap-1.5 min-w-0">
                              <span
                                className="inline-block w-2.5 h-2.5 rounded-full shrink-0"
                                style={{ backgroundColor: m.color, boxShadow: `0 0 6px ${m.color}` }}
                              />
                              <span className="text-white text-sm font-semibold truncate">{m.crewName}</span>
                              <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded shrink-0 ${m.crewType === 'ship' ? 'bg-cyan-950 text-cyan-200 border border-cyan-700' : 'bg-amber-950 text-amber-200 border border-amber-700'}`}>
                                {m.crewType === 'ship' ? '🚢 Ship' : '🥾 Shore'}
                              </span>
                            </div>
                            {eta && <span className="text-cyan-300 font-mono text-xs shrink-0">{eta}</span>}
                          </div>
                          <p className="text-slate-300 text-xs capitalize">
                            {m.sighting.density_label} {m.sighting.debris_type?.replace('_', ' ')}
                          </p>
                          <p className="text-slate-500 text-[11px] font-mono">
                            {formatCoordPair(m.sighting.latitude, m.sighting.longitude)}
                          </p>
                          {(kg || trips) && (
                            <p className="text-slate-400 text-[11px] mt-0.5">
                              {kg ? `~${kg} kg` : ''}
                              {kg && trips ? ' · ' : ''}
                              {trips ? `${trips} trip${trips === 1 ? '' : 's'}` : ''}
                            </p>
                          )}
                          <div className="flex gap-1 mt-2" onClick={(e) => e.stopPropagation()}>
                            <button
                              onClick={() => completeMission(m)}
                              className="flex-1 bg-green-700 hover:bg-green-600 text-white text-xs font-semibold py-1 rounded-lg transition-colors"
                            >
                              ✓ Complete
                            </button>
                            <button
                              onClick={() => selectMission(m)}
                              className="flex-1 bg-slate-600 hover:bg-slate-500 text-slate-100 text-xs py-1 rounded-lg transition-colors"
                            >
                              Focus map
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </>
                )}
              </>
            )}

            {activeTab === 'sightings' && pendingHandoffs.length > 0 && (
              <div className="space-y-2 mb-2">
                <p className="display tracking-widest text-sm" style={{ color: 'var(--amber)' }}>⚑ INCOMING → {myAgency.toUpperCase()}</p>
                {pendingHandoffs.map((s) => (
                  <div key={s.id} className="rounded-xl p-3" style={{ border: '1px solid rgba(245,158,11,0.4)', background: 'rgba(245,158,11,0.06)' }}>
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <span className={`text-xs font-bold px-1.5 py-0.5 rounded-full ${densityBadge(s.density_score, s.density_label)}`}>{s.density_label}</span>
                          <span className="text-xs text-slate-300 capitalize">{s.debris_type?.replace('_', ' ')}</span>
                        </div>
                        <p className="mono text-[10px] mt-0.5" style={{ color: 'var(--amber)' }}>FROM: {s.source_jurisdiction}</p>
                        <p className="text-xs mt-0.5" style={{ color: 'var(--text-secondary)' }}>{s.gemini_analysis?.slice(0, 80)}...</p>
                      </div>
                      <button onClick={() => acceptHandoff(s)}
                        className="shrink-0 bg-yellow-500 hover:bg-yellow-400 text-black text-xs font-bold px-2 py-1 rounded-lg">
                        Accept
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {activeTab === 'sightings' && visibleSightings.map((s) => {
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
              const lfSide = drift ? computePacificLandfallDisplay(s.latitude, s.longitude, drift) : null;
              const isSelected = selectedSightingId === s.id;
              return (
                <div
                  key={s.id}
                  ref={(el) => { sightingRefs.current[s.id] = el; }}
                  onClick={() => selectSighting(s)}
                  className="rounded-xl p-3 border-l-4 cursor-pointer transition-all"
                  style={{
                    borderLeftColor: s.density_score >= 8 ? '#ef4444' : s.density_score >= 6 ? '#f97316' : s.density_score >= 3 ? '#eab308' : '#10b981',
                    background: isSelected ? 'rgba(0,212,255,0.06)' : 'var(--navy-surface)',
                    border: isSelected ? '1px solid rgba(0,212,255,0.4)' : '1px solid var(--navy-border)',
                    borderLeft: `4px solid ${s.density_score >= 8 ? '#ef4444' : s.density_score >= 6 ? '#f97316' : s.density_score >= 3 ? '#eab308' : '#10b981'}`,
                    boxShadow: isSelected ? '0 0 16px rgba(0,212,255,0.1)' : 'none',
                  }}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5 flex-wrap mb-1">
                        <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded border ${pickupBadgeClassName(pickup.key)}`} title={pickup.detail}>
                          {pickup.shortLabel}
                        </span>
                        {(() => {
                          const mission = missionBySighting.get(s.id);
                          if (!mission) return null;
                          return (
                            <span
                              className="text-[10px] font-bold px-1.5 py-0.5 rounded text-white shrink-0 cursor-pointer"
                              style={{ backgroundColor: mission.color, boxShadow: `0 0 6px ${mission.color}aa` }}
                              title={`Mission · ${mission.crewName}`}
                              onClick={(e) => { e.stopPropagation(); selectMission(mission); }}
                            >
                              ● Mission · {mission.crewName}
                            </span>
                          );
                        })()}
                        {(() => {
                          const r = crewRankings.get(s.id);
                          const best = r?.ranked?.[0];
                          if (!best || missionBySighting.has(s.id)) return null;
                          return (
                            <span
                              className="text-[10px] font-semibold px-1.5 py-0.5 rounded border border-emerald-700 bg-emerald-950 text-emerald-200"
                              title={`${best.crewName} (${best.crewType}) — ${best.trips} trip${best.trips === 1 ? '' : 's'}, ~${Math.round(best.kg)} kg`}
                            >
                              ETA {formatEtaShort(best.totalMinutes)} · {best.crewType === 'ship' ? '🚢' : '🥾'} {best.crewName}
                            </span>
                          );
                        })()}
                      </div>
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className={`text-xs font-bold px-1.5 py-0.5 rounded-full ${densityBadge(s.density_score, s.density_label)}`}>
                          {s.density_label} {s.density_score}/10
                        </span>
                        <span className="text-xs text-slate-300 capitalize">{s.debris_type?.replace('_', ' ')}</span>
                      </div>
                      <p className="text-xs mt-1" style={{ color: 'var(--text-secondary)' }}>{s.estimated_volume} · {s.reporter_name}</p>
                      <p className="mono text-[10px]" style={{ color: 'var(--cyan-dim)' }}>{formatCoordPair(s.latitude, s.longitude)}</p>
                      {lfSide?.showLandfallFlag && lfSide.coastAlert && (
                        <p className="text-amber-300 text-xs mt-1 leading-snug border border-amber-600/50 rounded-lg p-2 bg-amber-950/40">
                          <span className="font-bold">Coast call:</span> {lfSide.coastAlert}
                        </p>
                      )}
                      {lfSide?.showLandfallFlag && lfSide.landfallPoint && (
                        <p className="text-orange-400 text-xs mt-0.5">
                          ⚑ {lfSide.landfallLabel} — line stops at shore (not inland).
                        </p>
                      )}
                      <div className="flex gap-1 mt-1.5 flex-wrap">
                        <span className={`text-xs px-1.5 py-0.5 rounded ${s.status === 'assigned' ? 'bg-blue-800 text-blue-200' : s.status === 'intercepted' ? 'bg-purple-800 text-purple-200' : 'bg-slate-700 text-slate-300'}`}>
                          {s.status}
                        </span>
                      </div>
                    </div>
                    <div className="flex flex-col gap-1 shrink-0" onClick={(e) => e.stopPropagation()}>
                      {(() => {
                        const r = crewRankings.get(s.id);
                        const hasOptions = (r?.ranked?.length || 0) > 0;
                        return (
                          <button
                            onClick={() => setAssignModal(s)}
                            disabled={!hasOptions}
                            title={!hasOptions ? 'No crew available for this pickup mode' : ''}
                            className="bg-cyan-700 hover:bg-cyan-600 disabled:opacity-40 disabled:cursor-not-allowed text-white text-xs px-2 py-1 rounded-lg"
                          >
                            Dispatch
                          </button>
                        );
                      })()}
                      <select
                        onChange={(e) => e.target.value && handleHandoff(s, e.target.value)}
                        value=""
                        className="bg-slate-700 text-white text-xs rounded-lg px-1 py-1 border border-slate-600 focus:outline-none"
                      >
                        <option value="">Handoff →</option>
                        {AGENCIES.filter((a) => a !== s.jurisdiction).map((a) => <option key={a} value={a}>{a}</option>)}
                      </select>
                      <button onClick={() => markCleared(s.id)} className="bg-slate-700 hover:bg-green-800 text-slate-300 text-xs px-2 py-1 rounded-lg">Clear</button>
                    </div>
                  </div>
                </div>
              );
            })}

            {activeTab === 'vessels' && vessels.map((v) => (
              <a key={v.id} href={`/vessel/${v.id}`} className="block rounded-xl p-3 transition-all" style={{ background: 'var(--navy-surface)', border: '1px solid var(--navy-border)' }}
                onMouseEnter={e => e.currentTarget.style.borderColor = 'var(--cyan-glow)'}
                onMouseLeave={e => e.currentTarget.style.borderColor = 'var(--navy-border)'}
              >
                <div className="flex items-start justify-between">
                  <div>
                    <p className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{v.name}</p>
                    <p className="mono text-[10px] mt-0.5" style={{ color: 'var(--text-dim)' }}>{v.zone}</p>
                    <div className="flex items-center gap-2 mt-1.5">
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
                  <span className="mono text-xs" style={{ color: 'var(--cyan-glow)' }}>→</span>
                </div>
              </a>
            ))}

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
                <button onClick={() => { setAssignModal(null); setSelectedCrew(null); }}
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
