import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { MapContainer, TileLayer, Marker, Polyline, Popup, Circle, useMapEvents, useMap } from 'react-leaflet';
import L from 'leaflet';
import { supabase } from '../lib/supabase';
import { getCrewSuggestions, generateHandoffBrief, generateAssignmentBrief } from '../lib/gemini';
import { getInterceptionPoint } from '../lib/drift';
import { computePacificLandfallDisplay, shouldShowSightingOnDashboard } from '../lib/landfall';
import { driftSegmentsForMap } from '../lib/mapPath';
import { formatCoordPair } from '../lib/coords';
import { classifyPickupMode, pickupBadgeClassName } from '../lib/pickupClassification';

delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: require('leaflet/dist/images/marker-icon-2x.png'),
  iconUrl: require('leaflet/dist/images/marker-icon.png'),
  shadowUrl: require('leaflet/dist/images/marker-shadow.png'),
});

const debrisIcon = (score, selected = false) => L.divIcon({
  className: '',
  html: `<div style="width:${selected ? 22 : 16}px;height:${selected ? 22 : 16}px;border-radius:50%;background:${score >= 8 ? '#dc2626' : score >= 6 ? '#ea580c' : score >= 3 ? '#ca8a04' : '#16a34a'};border:${selected ? '3px solid #22d3ee' : '2px solid white'};box-shadow:0 0 ${selected ? 10 : 4}px ${selected ? 'rgba(34,211,238,0.6)' : 'rgba(0,0,0,0.5)'}"></div>`,
  iconSize: [selected ? 22 : 16, selected ? 22 : 16],
  iconAnchor: [selected ? 11 : 8, selected ? 11 : 8],
});

const vesselIcon = L.divIcon({
  className: '',
  html: `<div style="font-size:20px;line-height:1;filter:drop-shadow(0 1px 2px rgba(0,0,0,0.8))">🚢</div>`,
  iconSize: [24, 24],
  iconAnchor: [12, 12],
});

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
  const [sightings, setSightings] = useState([]);
  const [vessels, setVessels] = useState([]);
  const [drifts, setDrifts] = useState([]);
  const [, setAssignments] = useState([]);
  const [supplies, setSupplies] = useState([]);
  const [pendingHandoffs, setPendingHandoffs] = useState([]);
  const [aiSuggestions, setAiSuggestions] = useState([]);
  const [aiLoading, setAiLoading] = useState(false);
  const [executingAction, setExecutingAction] = useState(null);
  const [assignModal, setAssignModal] = useState(null);
  const [handoffModal, setHandoffModal] = useState(null);
  const [briefModal, setBriefModal] = useState(null);
  const [selectedVessel, setSelectedVessel] = useState('');
  const [activeTab, setActiveTab] = useState('sightings');
  const [myAgency, setMyAgency] = useState('ClearMarine Operations');
  const [selectedSightingId, setSelectedSightingId] = useState(null);
  const [mapFlyTarget, setMapFlyTarget] = useState(null);
  const [hoverCoords, setHoverCoords] = useState(null);
  const [clickCoords, setClickCoords] = useState(null);

  const myAgencyRef = useRef('ClearMarine Operations');
  const sightingRefs = useRef({});
  const sightingsDataRef = useRef([]);
  const vesselsDataRef = useRef([]);
  const assignmentsDataRef = useRef([]);
  const pendingHandoffsRef = useRef([]);
  const aiRefreshTimerRef = useRef(null);

  const fetchData = useCallback(async () => {
    const [sRes, vRes, dRes, aRes, supRes] = await Promise.all([
      supabase.from('debris_sightings').select('*').neq('status', 'cleared').order('density_score', { ascending: false }),
      supabase.from('vessels').select('*').order('zone'),
      supabase.from('drift_predictions').select('*'),
      supabase.from('assignments').select('*').neq('status', 'completed'),
      supabase.from('supplies').select('*').order('zone'),
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
    if (dRes.data) setDrifts(dRes.data);
    if (aRes.data) { setAssignments(aRes.data); assignmentsDataRef.current = aRes.data; }
    if (supRes.data) setSupplies(supRes.data);
  }, []);

  const fireAiSuggestions = useCallback(async () => {
    if (
      sightingsDataRef.current.length === 0
      && vesselsDataRef.current.length === 0
      && assignmentsDataRef.current.length === 0
      && pendingHandoffsRef.current.length === 0
    ) return;
    setAiLoading(true);
    try {
      const result = await getCrewSuggestions({
        sightings: sightingsDataRef.current,
        vessels: vesselsDataRef.current,
        assignments: assignmentsDataRef.current,
        pendingHandoffs: pendingHandoffsRef.current,
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

  useEffect(() => {
    if (selectedSightingId == null) return;
    if (!visibleSightings.some((s) => s.id === selectedSightingId)) {
      setSelectedSightingId(null);
    }
  }, [visibleSightings, selectedSightingId]);

  useEffect(() => {
    myAgencyRef.current = myAgency;
    void fetchData().then(() => scheduleAiRefresh());
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
      .on('postgres_changes', { event: '*', schema: 'public', table: 'drift_predictions' }, () => {
        void fetchData().then(() => scheduleAiRefresh());
      })
      .subscribe();
    return () => supabase.removeChannel(channel);
  }, [fetchData, scheduleAiRefresh]);

  const handleAssign = async () => {
    if (!assignModal || !selectedVessel) return;
    const vessel = vessels.find((v) => v.id === selectedVessel);
    const intercept = await getInterceptionPoint(assignModal.latitude, assignModal.longitude, vessel.current_lat, vessel.current_lon);
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
        vessel_id: selectedVessel,
        interception_lat: intercept.lat,
        interception_lon: intercept.lon,
        interception_hours: intercept.hours,
        status: 'assigned',
        gemini_brief: brief,
      }),
      supabase.from('debris_sightings').update({ status: 'assigned' }).eq('id', assignModal.id),
      supabase.from('vessels').update({ status: 'deployed', updated_at: new Date().toISOString() }).eq('id', selectedVessel),
    ]);
    setBriefModal({ brief, vessel: vessel.name, sighting: assignModal, intercept });
    setAssignModal(null);
    setSelectedVessel('');
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
        if (sighting && vessel) { setAssignModal(sighting); setSelectedVessel(vessel.id); }
      } else if (s.action_type === 'accept_handoff') {
        const h = s.handoff_id ? pendingHandoffs.find((x) => x.id === s.handoff_id) : pendingHandoffs[0];
        if (h) await acceptHandoff(h);
      } else if (s.action_type === 'reorder_supply') {
        const sup = s.supply_id ? supplies.find((x) => x.id === s.supply_id) : supplies.find((x) => x.quantity <= x.low_threshold);
        if (sup) { await supabase.from('supplies').update({ quantity: sup.quantity + 10 }).eq('id', sup.id); await fetchData(); }
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
    if (type === 'reorder_supply') return 'Reorder +10';
    if (type === 'mark_cleared') return 'Clear';
    return null;
  };

  return (
    <div className="h-screen bg-slate-900 text-white flex flex-col">
      <header className="bg-slate-800 border-b border-slate-700 px-4 py-2 flex items-center gap-3 flex-wrap shrink-0">
        <span className="text-xl">🌊</span>
        <div>
          <h1 className="text-base font-bold text-white">ClearMarine — Coordination Center</h1>
          <p className="text-slate-400 text-xs">ClearMarine fleet — one desk; hand off to EPA partner when needed</p>
        </div>
        <div className="flex items-center gap-2 ml-auto flex-wrap text-xs">
          {/* Role / partner lane (same app, different queue filter) */}
          <select
            value={myAgency}
            onChange={(e) => setMyAgency(e.target.value)}
            className="bg-slate-700 text-slate-200 text-xs rounded-lg px-2 py-1 border border-slate-600 focus:outline-none"
            title="Same coordination app — switch which incoming handoffs you accept"
          >
            {AGENCIES.map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
          <span className="text-slate-300">
            {visibleSightings.length} active
            {sightings.length > visibleSightings.length && (
              <span className="text-slate-500 ml-1" title="Land positions (Pacific model) are hidden from map and queue">
                ({sightings.length - visibleSightings.length} on land hidden)
              </span>
            )}
          </span>
          <span className={availableFleet.length === 0 ? 'text-red-400 font-bold' : 'text-cyan-400'}>
            {availableFleet.length} vessel{availableFleet.length === 1 ? '' : 's'} ready
          </span>
          {visibleHandoffs.length > 0 && (
            <span className="bg-yellow-700 text-yellow-200 px-2 py-0.5 rounded-full font-bold">
              {visibleHandoffs.length} handoff{visibleHandoffs.length > 1 ? 's' : ''}
            </span>
          )}
          {lowSupplies.length > 0 && (
            <span className="bg-red-700 text-white px-2 py-0.5 rounded-full font-bold animate-pulse">
              ⚠ {lowSupplies.length} supply alert{lowSupplies.length > 1 ? 's' : ''}
            </span>
          )}
          <a href="/report" className="bg-cyan-700 hover:bg-cyan-600 text-white px-3 py-1 rounded-lg transition-colors">+ Report</a>
          <div className="flex items-center gap-1">
            <div className="w-2 h-2 bg-green-400 rounded-full animate-pulse" />
            <span className="text-green-400">Live</span>
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

              return (
                <div key={s.id}>
                  <Marker
                    position={[s.latitude, s.longitude]}
                    icon={debrisIcon(s.density_score, isSelected)}
                    eventHandlers={{ click: () => clickMarker(s) }}
                  >
                    <Popup>
                      <div className="text-xs space-y-1 min-w-[200px]">
                        <p>
                          <span className={`font-bold px-1.5 py-0.5 rounded ${pickupBadgeClassName(pickup.key)}`}>
                            {pickup.shortLabel}
                          </span>
                        </p>
                        <p className="text-gray-600 leading-snug">{pickup.detail}</p>
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
                          color: '#ea580c',
                          fillColor: '#f97316',
                          fillOpacity: 0.38,
                          weight: 3,
                        }}
                      />
                      <Marker position={lf.landfallPoint} icon={landfallIcon}>
                        <Popup>
                          <p className="text-xs font-semibold text-orange-600">⚑ Land / coast contact (model)</p>
                          <p className="text-xs text-gray-600">{lf.landfallLabel}</p>
                          <p className="text-xs text-gray-700 font-mono font-bold">{formatCoordPair(lf.landfallPoint[0], lf.landfallPoint[1])}</p>
                          <p className="text-xs text-amber-800 font-medium">{lf.coastAlert}</p>
                        </Popup>
                      </Marker>
                    </>
                  )}
                </div>
              );
            })}

            {vessels.filter((v) => v.current_lat && v.current_lon).map((v) => (
              <Marker key={v.id} position={[v.current_lat, v.current_lon]} icon={vesselIcon}>
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
          </MapContainer>

          {/* Coordinate display */}
          <div className="absolute bottom-4 left-4 bg-slate-900 bg-opacity-90 rounded-xl p-3 text-xs space-y-1 z-[1000] min-w-[200px] pointer-events-none">
            <p className="text-slate-400 font-semibold mb-1">Drift forecast</p>
            <p className="text-slate-500 leading-snug mb-1">Track follows surface current; clipped at shore — not inland.</p>
            <p className="text-slate-500 leading-snug mb-1">Sightings on land (Pacific model) are hidden from the map.</p>
            <p className="text-slate-500 leading-snug mb-1">Badges: Land / Ship / Ship+coast use drift + shoreline (same as report pipeline).</p>
            <div className="flex items-center gap-2"><div className="w-6 h-0.5 bg-yellow-400" /><span className="text-slate-300">24h</span></div>
            <div className="flex items-center gap-2"><div className="w-6 h-0.5 bg-orange-500" /><span className="text-slate-300">48h</span></div>
            <div className="flex items-center gap-2"><div className="w-6 h-0.5 bg-red-500" /><span className="text-slate-300">72h</span></div>
            <div className="flex items-center gap-2"><span className="text-orange-400">⚑</span><span className="text-slate-300">Shore only if track reaches coast</span></div>
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
        <div className="w-80 bg-slate-800 border-l border-slate-700 flex flex-col overflow-hidden shrink-0">
          <div className="flex border-b border-slate-700">
            {['sightings', 'vessels', 'supplies'].map((t) => (
              <button key={t} onClick={() => setActiveTab(t)}
                className={`flex-1 py-2 text-xs font-medium capitalize transition-colors ${activeTab === t ? 'border-b-2 border-cyan-500 text-cyan-400' : 'text-slate-400 hover:text-slate-200'}`}>
                {t}
                {t === 'sightings' && visibleSightings.length > 0 && <span className="ml-1 bg-slate-700 px-1 rounded">{visibleSightings.length}</span>}
                {t === 'supplies' && lowSupplies.length > 0 && <span className="ml-1 bg-red-700 text-white px-1 rounded">{lowSupplies.length}</span>}
              </button>
            ))}
          </div>

          {/* AI Suggestions */}
          <div className="p-3 border-b border-slate-700">
            <div className="flex items-center justify-between mb-2">
              <span className="text-slate-400 text-xs font-semibold uppercase tracking-wider flex items-center gap-1">
                <span className="text-cyan-400">✦</span> AI Crew Agent
              </span>
              <button onClick={fireAiSuggestions} disabled={aiLoading}
                className="text-xs bg-cyan-800 hover:bg-cyan-700 disabled:opacity-40 text-white px-2 py-0.5 rounded-lg">
                {aiLoading ? '...' : 'Refresh'}
              </button>
            </div>
            {availableFleet.length === 0 && (
              <p className="text-amber-400 text-xs mb-2 leading-snug">No vessels available — AI cannot assign a hull until one is free.</p>
            )}
            {aiSuggestions.length === 0 ? (
              <p className="text-slate-500 text-xs">Suggestions refresh after loads and live updates (~1s). Use Refresh to run again.</p>
            ) : (
              <div className="space-y-1.5">
                {aiSuggestions.map((s, i) => {
                  const label = actionLabel(s.action_type);
                  return (
                    <div key={i} className={`rounded-lg p-2 flex items-start gap-2 ${s.completed ? 'bg-green-950 border border-green-800' : 'bg-slate-700'}`}>
                      <span className="text-slate-500 text-xs shrink-0">{i + 1}.</span>
                      <p className="text-slate-200 text-xs flex-1 leading-snug">{s.text}</p>
                      {s.completed ? (
                        <span className="text-green-400 text-xs shrink-0">✓</span>
                      ) : label ? (
                        <button onClick={() => executeAction(s, i)} disabled={executingAction === i}
                          className="shrink-0 bg-cyan-700 hover:bg-cyan-600 disabled:opacity-40 text-white text-xs px-2 py-0.5 rounded-lg transition-colors whitespace-nowrap">
                          {executingAction === i ? '...' : label}
                        </button>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Tab Content */}
          <div className="flex-1 overflow-y-auto p-3 space-y-2">
            {activeTab === 'sightings' && pendingHandoffs.length > 0 && (
              <div className="space-y-2 mb-2">
                <p className="text-yellow-400 text-xs font-semibold uppercase tracking-wider">Incoming Handoffs → {myAgency}</p>
                {pendingHandoffs.map((s) => (
                  <div key={s.id} className="border border-yellow-600 bg-yellow-950 rounded-xl p-3">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <span className={`text-xs font-bold px-1.5 py-0.5 rounded-full ${densityBadge(s.density_score, s.density_label)}`}>{s.density_label}</span>
                          <span className="text-xs text-slate-300 capitalize">{s.debris_type?.replace('_', ' ')}</span>
                        </div>
                        <p className="text-yellow-300 text-xs mt-0.5">From: {s.source_jurisdiction}</p>
                        <p className="text-slate-400 text-xs mt-0.5">{s.gemini_analysis?.slice(0, 80)}...</p>
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
                  className={`rounded-xl p-3 border-l-4 cursor-pointer transition-all ${isSelected ? 'ring-2 ring-cyan-500' : ''} ${s.density_score >= 8 ? 'border-red-500 bg-red-950' : s.density_score >= 6 ? 'border-orange-500 bg-orange-950' : s.density_score >= 3 ? 'border-yellow-500 bg-yellow-950' : 'border-green-500 bg-green-950'}`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5 flex-wrap mb-1">
                        <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded border ${pickupBadgeClassName(pickup.key)}`} title={pickup.detail}>
                          {pickup.shortLabel}
                        </span>
                      </div>
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className={`text-xs font-bold px-1.5 py-0.5 rounded-full ${densityBadge(s.density_score, s.density_label)}`}>
                          {s.density_label} {s.density_score}/10
                        </span>
                        <span className="text-xs text-slate-300 capitalize">{s.debris_type?.replace('_', ' ')}</span>
                      </div>
                      <p className="text-slate-400 text-xs mt-1">{s.estimated_volume} · {s.reporter_name}</p>
                      <p className="text-slate-500 text-xs font-mono">{formatCoordPair(s.latitude, s.longitude)}</p>
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
                      <button
                        onClick={() => setAssignModal(s)}
                        disabled={availableFleet.length === 0}
                        title={availableFleet.length === 0 ? 'No vessel available' : ''}
                        className="bg-cyan-700 hover:bg-cyan-600 disabled:opacity-40 disabled:cursor-not-allowed text-white text-xs px-2 py-1 rounded-lg"
                      >
                        Assign
                      </button>
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
              <a key={v.id} href={`/vessel/${v.id}`} className="block rounded-xl p-3 bg-slate-700 hover:bg-slate-600 transition-colors">
                <div className="flex items-start justify-between">
                  <div>
                    <p className="text-white text-sm font-medium">{v.name}</p>
                    <p className="text-slate-400 text-xs">{v.zone}</p>
                    <div className="flex items-center gap-2 mt-1">
                      <span className={`text-xs px-1.5 py-0.5 rounded font-bold ${v.status === 'available' ? 'bg-green-700 text-green-200' : v.status === 'deployed' ? 'bg-blue-700 text-blue-200' : 'bg-orange-700 text-orange-200'}`}>
                        {v.status}
                      </span>
                      <span className={`text-xs ${v.fuel_level <= v.fuel_threshold ? 'text-red-400 font-bold' : 'text-slate-400'}`}>
                        ⛽ {v.fuel_level}%
                      </span>
                    </div>
                  </div>
                  <span className="text-slate-400 text-xs">→</span>
                </div>
              </a>
            ))}

            {activeTab === 'supplies' && (() => {
              const zones = [...new Set(supplies.map((s) => s.zone))];
              return zones.map((zone) => (
                <div key={zone} className="mb-3">
                  <p className="text-slate-400 text-xs font-semibold mb-1.5">{zone}</p>
                  {supplies.filter((s) => s.zone === zone).map((s) => {
                    const isLow = s.quantity <= s.low_threshold;
                    return (
                      <div key={s.id} className={`flex items-center justify-between rounded-lg px-3 py-2 mb-1 ${isLow ? 'bg-red-950 border border-red-700' : 'bg-slate-700'}`}>
                        <div>
                          <span className="text-slate-200 text-xs">{s.name}</span>
                          {isLow && <span className="ml-2 text-xs text-red-400 font-bold">PRIORITY</span>}
                        </div>
                        <span className={`text-sm font-bold ${isLow ? 'text-red-400' : 'text-slate-300'}`}>{s.quantity}</span>
                      </div>
                    );
                  })}
                </div>
              ));
            })()}
          </div>
        </div>
      </div>

      {/* Assign Modal */}
      {assignModal && (
        <div className="fixed inset-0 bg-black bg-opacity-70 flex items-center justify-center p-4 z-50">
          <div className="bg-slate-800 rounded-2xl p-6 max-w-md w-full border border-slate-600 shadow-2xl">
            <h3 className="text-white font-bold text-lg mb-1">Assign Cleanup Crew</h3>
            <p className="text-slate-400 text-sm mb-4">{assignModal.density_label} {assignModal.debris_type?.replace('_', ' ')} cluster</p>
            {availableFleet.length === 0 ? (
              <p className="text-amber-300 text-sm mb-4">No vessels in &quot;available&quot; status. Mark a crew as available or wait for a returning hull.</p>
            ) : (
              <select value={selectedVessel} onChange={(e) => setSelectedVessel(e.target.value)}
                className="w-full bg-slate-700 text-white rounded-xl px-4 py-3 mb-4 focus:outline-none focus:ring-2 focus:ring-cyan-500">
                <option value="">Select vessel...</option>
                {availableFleet.map((v) => (
                  <option key={v.id} value={v.id}>{v.name} — {v.zone} (⛽ {v.fuel_level}%)</option>
                ))}
              </select>
            )}
            <div className="flex gap-2">
              <button onClick={() => { setAssignModal(null); setSelectedVessel(''); }}
                className="flex-1 bg-slate-700 hover:bg-slate-600 text-white py-2.5 rounded-xl transition-colors">Cancel</button>
              <button onClick={handleAssign} disabled={!selectedVessel || availableFleet.length === 0}
                className="flex-1 bg-cyan-600 hover:bg-cyan-700 disabled:opacity-40 text-white font-semibold py-2.5 rounded-xl transition-colors">
                Assign + Generate Brief
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Assignment Brief Modal */}
      {briefModal && (
        <div className="fixed inset-0 bg-black bg-opacity-70 flex items-center justify-center p-4 z-50">
          <div className="bg-slate-800 rounded-2xl p-6 max-w-md w-full border border-slate-600 shadow-2xl">
            <h3 className="text-white font-bold text-lg mb-1">Crew Brief — {briefModal.vessel}</h3>
            <p className="text-slate-400 text-sm mb-3">
              Intercept in {briefModal.intercept.hours}h at{' '}
              <span className="font-mono text-cyan-300">{formatCoordPair(briefModal.intercept.lat, briefModal.intercept.lon)}</span>
            </p>
            <div className="bg-slate-900 rounded-xl p-4 mb-4">
              <p className="text-slate-300 text-sm leading-relaxed whitespace-pre-wrap">{briefModal.brief}</p>
            </div>
            <button onClick={() => setBriefModal(null)} className="w-full bg-cyan-600 hover:bg-cyan-700 text-white font-semibold py-2.5 rounded-xl transition-colors">Done</button>
          </div>
        </div>
      )}

      {/* Handoff Brief Modal */}
      {handoffModal && (
        <div className="fixed inset-0 bg-black bg-opacity-70 flex items-center justify-center p-4 z-50">
          <div className="bg-slate-800 rounded-2xl p-6 max-w-md w-full border border-slate-600 shadow-2xl">
            <h3 className="text-white font-bold text-lg mb-1">Jurisdiction Handoff — Sent</h3>
            <p className="text-slate-400 text-sm mb-4">{handoffModal.fromAgency} → {handoffModal.toAgency}</p>
            <div className="bg-slate-900 rounded-xl p-4 mb-4">
              <p className="text-slate-300 text-sm leading-relaxed whitespace-pre-wrap">{handoffModal.brief}</p>
            </div>
            <p className="text-slate-500 text-xs mb-3">Pending acceptance by {handoffModal.toAgency}. Use the role selector at the top (same app) to switch to that partner queue and accept.</p>
            <button onClick={() => setHandoffModal(null)} className="w-full bg-cyan-600 hover:bg-cyan-700 text-white font-semibold py-2.5 rounded-xl transition-colors">Done</button>
          </div>
        </div>
      )}
    </div>
  );
}
