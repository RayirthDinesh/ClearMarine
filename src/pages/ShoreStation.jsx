import { useState, useEffect, useCallback, useMemo } from 'react';
import { useParams } from 'react-router-dom';
import L from 'leaflet';
import { MapContainer, TileLayer, Marker, Polyline, Popup } from 'react-leaflet';
import { supabase } from '../lib/supabase';
import { formatCoordPair } from '../lib/coords';
import { labelForPickupKey, pickupBadgeClassName } from '../lib/pickupClassification';
import { formatEtaShort } from '../lib/cleanupTime';
import { computePacificLandfallDisplay } from '../lib/landfall';
import { driftSegmentsForMap } from '../lib/mapPath';
import { isSyntheticShoreId } from '../lib/shoreStations';

const STATUS_OPTIONS = ['available', 'deployed', 'returning', 'off_shift'];

const STATUS_STYLE = {
  available:  { background: 'rgba(16,185,129,0.15)', border: '1px solid var(--green-ok)',  color: 'var(--green-ok)'  },
  deployed:   { background: 'rgba(0,212,255,0.12)',  border: '1px solid var(--cyan-glow)', color: 'var(--cyan-glow)' },
  returning:  { background: 'rgba(0,137,178,0.15)',  border: '1px solid var(--cyan-dim)',  color: 'var(--cyan-dim)'  },
  off_shift:  { background: 'rgba(245,158,11,0.12)', border: '1px solid var(--amber)',     color: 'var(--amber)'     },
};

const stationDivIcon = L.divIcon({
  className: 'shore-station-icon',
  html: `<div style="width:18px;height:18px;border-radius:50%;background:#10b981;border:2px solid #042f2e;box-shadow:0 0 10px rgba(16,185,129,0.7)"></div>`,
  iconSize: [18, 18],
  iconAnchor: [9, 9],
});

const debrisDivIcon = L.divIcon({
  className: 'debris-icon',
  html: `<div style="width:14px;height:14px;border-radius:50%;background:#f97316;border:2px solid #7c2d12;box-shadow:0 0 8px rgba(249,115,22,0.6)"></div>`,
  iconSize: [14, 14],
  iconAnchor: [7, 7],
});

const landfallDivIcon = L.divIcon({
  className: 'landfall-icon',
  html: `<div style="width:12px;height:12px;border-radius:2px;background:#facc15;border:1.5px solid #713f12;box-shadow:0 0 6px rgba(250,204,21,0.6)"></div>`,
  iconSize: [12, 12],
  iconAnchor: [6, 6],
});

/** Build a virtual crew object from the assignment row's shore_station_* columns. */
function syntheticCrewFromAssignment(landCrewId, assignment) {
  if (!assignment) return null;
  const lat = Number(assignment.shore_station_lat);
  const lon = Number(assignment.shore_station_lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return {
    id: landCrewId,
    name: assignment.shore_station_name || 'Synthetic shore patrol',
    agency: 'ClearMarine Shore Network',
    status: 'deployed',
    base_lat: lat,
    base_lon: lon,
    capacity_kg: 150,
    transport_speed_kmh: 35,
    response_minutes: 10,
    synthetic: true,
  };
}

export default function ShoreStation() {
  const { landCrewId } = useParams();
  const synthetic = isSyntheticShoreId(landCrewId);
  const [crew, setCrew] = useState(null);
  const [assignment, setAssignment] = useState(null);
  const [drift, setDrift] = useState(null);
  const [loading, setLoading] = useState(true);
  const [updating, setUpdating] = useState(false);

  const fetchAssignment = useCallback(async () => {
    let query = supabase
      .from('assignments')
      .select('*, debris_sightings(*)')
      .neq('status', 'completed')
      .order('created_at', { ascending: false })
      .limit(1);
    if (synthetic) {
      query = query
        .is('land_crew_id', null)
        .eq('shore_station_name', '___'); // placeholder — overridden below
    } else {
      query = query.eq('land_crew_id', landCrewId);
    }
    if (synthetic) {
      // For synthetic ids the row is identified by its shore_station_lat/lon (id encodes them).
      const m = landCrewId.match(/^synthetic-shore:(-?\d+(?:\.\d+)?)_(-?\d+(?:\.\d+)?)$/);
      if (!m) {
        setAssignment(null);
        return;
      }
      const lat = parseFloat(m[1]);
      const lon = parseFloat(m[2]);
      const { data } = await supabase
        .from('assignments')
        .select('*, debris_sightings(*)')
        .neq('status', 'completed')
        .is('land_crew_id', null)
        .gte('shore_station_lat', lat - 0.01)
        .lte('shore_station_lat', lat + 0.01)
        .gte('shore_station_lon', lon - 0.01)
        .lte('shore_station_lon', lon + 0.01)
        .order('created_at', { ascending: false })
        .limit(1);
      setAssignment((data && data[0]) || null);
      return;
    }
    const { data } = await query;
    setAssignment((data && data[0]) || null);
  }, [landCrewId, synthetic]);

  const fetchDriftFor = useCallback(async (sightingId) => {
    if (!sightingId) { setDrift(null); return; }
    const { data } = await supabase
      .from('drift_predictions')
      .select('*')
      .eq('sighting_id', sightingId)
      .order('created_at', { ascending: false })
      .limit(1);
    setDrift((data && data[0]) || null);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const init = async () => {
      if (synthetic) {
        await fetchAssignment();
        if (cancelled) return;
        setLoading(false);
        return;
      }
      const { data } = await supabase.from('land_crews').select('*').eq('id', landCrewId).single();
      if (cancelled) return;
      setCrew(data);
      setLoading(false);
      if (data) await fetchAssignment();
    };
    init();

    const chan = supabase.channel('shore-' + landCrewId)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'land_crews', filter: `id=eq.${landCrewId}` }, (p) => setCrew(p.new))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'assignments' }, fetchAssignment)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'drift_predictions' }, () => {
        if (assignment?.sighting_id) fetchDriftFor(assignment.sighting_id);
      })
      .subscribe();
    return () => { cancelled = true; supabase.removeChannel(chan); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [landCrewId, synthetic]);

  // For synthetic ids, hydrate the crew object from the assignment row.
  useEffect(() => {
    if (synthetic) setCrew(syntheticCrewFromAssignment(landCrewId, assignment));
  }, [synthetic, landCrewId, assignment]);

  // Refresh drift whenever assignment's sighting changes.
  useEffect(() => {
    if (assignment?.sighting_id) fetchDriftFor(assignment.sighting_id);
    else setDrift(null);
  }, [assignment, fetchDriftFor]);

  const updateStatus = async (status) => {
    if (synthetic || !crew) return;
    setUpdating(true);
    await supabase.from('land_crews').update({ status, updated_at: new Date().toISOString() }).eq('id', landCrewId);
    setUpdating(false);
  };

  /** Move the crew to "deployed" and mark the assignment in_transit. Used when the
   *  debris arrives at shore and a real ground team needs to roll out. */
  const dispatchCrew = async () => {
    if (!assignment) return;
    setUpdating(true);
    const updates = [
      supabase.from('assignments').update({ status: 'en_route' }).eq('id', assignment.id),
    ];
    if (!synthetic) {
      updates.push(
        supabase.from('land_crews').update({ status: 'deployed', updated_at: new Date().toISOString() }).eq('id', landCrewId),
      );
    }
    await Promise.all(updates);
    await fetchAssignment();
    setUpdating(false);
  };

  /** Final cleanup confirmation: sighting intercepted, assignment completed, crew freed. */
  const markCleanupComplete = async () => {
    if (!assignment) return;
    setUpdating(true);
    const updates = [
      supabase.from('assignments').update({ status: 'completed' }).eq('id', assignment.id),
      supabase.from('debris_sightings').update({ status: 'intercepted' }).eq('id', assignment.sighting_id),
    ];
    if (!synthetic) {
      updates.push(
        supabase.from('land_crews').update({ status: 'available', updated_at: new Date().toISOString() }).eq('id', landCrewId),
      );
    }
    await Promise.all(updates);
    await fetchAssignment();
    setUpdating(false);
  };

  // ── Map data: drift trajectory + landfall ──
  const sighting = assignment?.debris_sightings || null;

  const lf = useMemo(() => {
    if (!sighting || !drift) return { pathPoints: [], landfallPoint: null, showLandfallFlag: false, coastAlert: null, landfallLabel: null };
    return computePacificLandfallDisplay(sighting.latitude, sighting.longitude, drift) || { pathPoints: [], landfallPoint: null, showLandfallFlag: false, coastAlert: null, landfallLabel: null };
  }, [sighting, drift]);

  const segmentPolylines = useMemo(
    () => (lf.pathPoints && lf.pathPoints.length >= 2 ? driftSegmentsForMap(lf.pathPoints) : []),
    [lf.pathPoints],
  );

  // The connector line from the synthetic / real shore station to either the landfall
  // point (if drift will reach shore) or directly to the sighting otherwise. Helps the
  // operator visualize where the crew will physically have to go.
  const connectorPositions = useMemo(() => {
    if (!crew) return null;
    const target = lf.landfallPoint
      ? lf.landfallPoint
      : sighting ? [sighting.latitude, sighting.longitude] : null;
    if (!target) return null;
    return [[crew.base_lat, crew.base_lon], target];
  }, [crew, sighting, lf.landfallPoint]);

  const mapBounds = useMemo(() => {
    if (!crew) return null;
    const pts = [[crew.base_lat, crew.base_lon]];
    if (sighting) pts.push([sighting.latitude, sighting.longitude]);
    if (lf.landfallPoint) pts.push(lf.landfallPoint);
    if (lf.pathPoints) lf.pathPoints.forEach((p) => pts.push(p));
    return pts.length >= 2 ? pts : null;
  }, [crew, sighting, lf]);

  const debrisHasArrived = (() => {
    if (!sighting || !lf.landfallPoint || !crew) return false;
    // If the sighting is essentially at the landfall point already, treat it as arrived.
    const dLat = Math.abs(sighting.latitude - lf.landfallPoint[0]);
    const dLon = Math.abs(sighting.longitude - lf.landfallPoint[1]);
    return dLat < 0.05 && dLon < 0.05;
  })();

  if (loading) return (
    <div className="min-h-screen naval-bg flex items-center justify-center">
      <p className="mono text-sm glow-pulse" style={{ color: 'var(--text-secondary)' }}>LOADING SHORE CREW…</p>
    </div>
  );

  if (!crew) return (
    <div className="min-h-screen naval-bg flex items-center justify-center text-center px-6">
      <div>
        <p className="mono text-sm" style={{ color: 'var(--red-crit)' }}>SHORE CREW NOT FOUND</p>
        {synthetic && (
          <p className="mono text-[11px] mt-2" style={{ color: 'var(--text-dim)' }}>
            This synthetic shore patrol has no active assignment. Open it from a mission card on the dashboard.
          </p>
        )}
        <a href="/dashboard" className="mono text-[10px] tracking-widest mt-4 inline-block" style={{ color: 'var(--cyan-glow)' }}>← COMMAND</a>
      </div>
    </div>
  );

  const activeStatusStyle = STATUS_STYLE[crew.status] || STATUS_STYLE.available;

  return (
    <div className="min-h-screen naval-bg" style={{ color: 'var(--text-primary)' }}>
      <header className="px-4 py-3 flex items-center justify-between" style={{ background: 'rgba(2,12,27,0.9)', borderBottom: '1px solid var(--navy-border)', backdropFilter: 'blur(12px)' }}>
        <div className="flex items-center gap-3">
          <span className="text-2xl">🛟</span>
          <div>
            <h1 className="display text-xl tracking-widest" style={{ color: 'var(--green-ok)' }}>{(crew.name || 'SHORE CREW').toUpperCase()}</h1>
            <p className="mono text-[10px] tracking-widest" style={{ color: 'var(--text-secondary)' }}>
              {crew.agency || 'Shore Network'}{synthetic ? ' · SYNTHETIC PATROL' : ''}
            </p>
          </div>
        </div>
        <a href="/dashboard" className="mono text-[10px] tracking-widest transition-colors" style={{ color: 'var(--text-dim)' }}
          onMouseEnter={(e) => (e.target.style.color = 'var(--cyan-glow)')}
          onMouseLeave={(e) => (e.target.style.color = 'var(--text-dim)')}
        >← COMMAND</a>
      </header>

      <div className="max-w-2xl mx-auto p-4 space-y-4">
        {/* Crew status */}
        <div className="glass rounded-2xl p-5">
          <div className="flex items-center justify-between mb-4">
            <div>
              <p className="mono text-[10px] tracking-widest mb-2" style={{ color: 'var(--text-secondary)' }}>CURRENT STATUS</p>
              <span className="mono text-xs font-bold px-3 py-1 rounded tracking-widest" style={activeStatusStyle}>
                {(crew.status || 'available').toUpperCase()}
              </span>
            </div>
            <div className="text-right">
              <p className="mono text-[10px] tracking-widest mb-1" style={{ color: 'var(--text-secondary)' }}>BASE</p>
              <p className="mono text-xs" style={{ color: 'var(--text-primary)' }}>{formatCoordPair(crew.base_lat, crew.base_lon)}</p>
              <p className="mono text-[10px] mt-0.5" style={{ color: 'var(--text-dim)' }}>
                {Math.round(crew.capacity_kg || 0)} kg/trip · {crew.transport_speed_kmh || 0} km/h · resp {crew.response_minutes || 0} min
              </p>
            </div>
          </div>

          {!synthetic && (
            <div className="grid grid-cols-2 gap-2">
              {STATUS_OPTIONS.map((s) => (
                <button
                  key={s}
                  onClick={() => updateStatus(s)}
                  disabled={updating || crew.status === s}
                  className="py-2 rounded-xl mono text-[10px] font-bold transition-colors capitalize disabled:opacity-40 tracking-widest"
                  style={crew.status === s
                    ? activeStatusStyle
                    : { background: 'var(--navy-surface)', border: '1px solid var(--navy-border)', color: 'var(--text-dim)' }}
                >
                  {s.replace('_', ' ').toUpperCase()}
                </button>
              ))}
            </div>
          )}
          {synthetic && (
            <p className="mono text-[10px] leading-snug" style={{ color: 'var(--text-dim)' }}>
              Synthetic patrols are virtual coast points — they don&apos;t hold persistent status. Use the actions below to roll out and confirm cleanup.
            </p>
          )}
        </div>

        {/* Active assignment + drift trajectory */}
        {assignment && sighting ? (
          <div className="rounded-2xl p-4 slide-up" style={{ background: 'rgba(16,185,129,0.05)', border: '1px solid rgba(16,185,129,0.3)' }}>
            <p className="mono text-[10px] font-bold tracking-widest mb-3" style={{ color: 'var(--green-ok)' }}>◈ ACTIVE ASSIGNMENT</p>

            <div className="mb-3">
              <p className="font-semibold text-sm" style={{ color: 'var(--text-primary)' }}>
                {sighting.density_label} {sighting.debris_type?.replace('_', ' ')} cluster
              </p>
              {sighting.pickup_mode && (
                <p className="mt-1.5">
                  <span className={`text-xs font-bold px-2 py-0.5 rounded border ${pickupBadgeClassName(sighting.pickup_mode)}`}>
                    {labelForPickupKey(sighting.pickup_mode)}
                  </span>
                </p>
              )}
              {sighting.gemini_analysis && (
                <p className="text-xs mt-2 leading-snug" style={{ color: 'var(--text-secondary)' }}>{sighting.gemini_analysis.slice(0, 160)}{sighting.gemini_analysis.length > 160 ? '…' : ''}</p>
              )}
            </div>

            {/* Mini map: shore station + sighting + drift trajectory */}
            <div className="rounded-xl overflow-hidden mb-3" style={{ border: '1px solid var(--navy-border)', height: 280 }}>
              <MapContainer
                bounds={mapBounds || [[crew.base_lat, crew.base_lon]]}
                boundsOptions={{ padding: [30, 30] }}
                center={[crew.base_lat, crew.base_lon]}
                zoom={mapBounds ? undefined : 8}
                scrollWheelZoom
                style={{ width: '100%', height: '100%', background: '#02101e' }}
              >
                <TileLayer
                  url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
                  attribution='&copy; OSM &copy; CARTO'
                />
                <Marker position={[crew.base_lat, crew.base_lon]} icon={stationDivIcon}>
                  <Popup><strong>{crew.name}</strong><br />Shore station base</Popup>
                </Marker>
                <Marker position={[sighting.latitude, sighting.longitude]} icon={debrisDivIcon}>
                  <Popup>
                    <strong>{sighting.debris_type?.replace('_', ' ')}</strong><br />
                    {sighting.density_label}<br />
                    {formatCoordPair(sighting.latitude, sighting.longitude)}
                  </Popup>
                </Marker>
                {lf.landfallPoint && (
                  <Marker position={lf.landfallPoint} icon={landfallDivIcon}>
                    <Popup>
                      <strong>Predicted landfall</strong><br />
                      {lf.landfallLabel || 'Coast contact'}<br />
                      {formatCoordPair(lf.landfallPoint[0], lf.landfallPoint[1])}
                    </Popup>
                  </Marker>
                )}
                {segmentPolylines.map((seg, si) => (
                  <Polyline
                    key={`drift-${si}`}
                    positions={seg.positions}
                    color={seg.color}
                    weight={3}
                    dashArray="6,4"
                    opacity={0.9}
                  />
                ))}
                {connectorPositions && (
                  <Polyline
                    positions={connectorPositions}
                    color="#10b981"
                    weight={2}
                    opacity={0.7}
                  />
                )}
              </MapContainer>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mb-3">
              <div className="rounded-xl p-3" style={{ background: 'var(--navy-deep)', border: '1px solid var(--navy-border)' }}>
                <p className="mono text-[10px] tracking-widest mb-1" style={{ color: 'var(--text-dim)' }}>DEBRIS POSITION</p>
                <p className="mono text-xs font-bold" style={{ color: 'var(--text-primary)' }}>
                  {formatCoordPair(sighting.latitude, sighting.longitude)}
                </p>
                {lf.landfallPoint && (
                  <>
                    <p className="mono text-[10px] tracking-widest mt-2 mb-1" style={{ color: 'var(--text-dim)' }}>FORECAST LANDFALL</p>
                    <p className="mono text-xs font-bold" style={{ color: 'var(--amber)' }}>
                      {formatCoordPair(lf.landfallPoint[0], lf.landfallPoint[1])}
                    </p>
                  </>
                )}
                {lf.coastAlert && (
                  <p className="text-[11px] mt-2 leading-snug" style={{ color: 'var(--amber)' }}>⚑ {lf.coastAlert}</p>
                )}
              </div>
              <div className="rounded-xl p-3" style={{ background: 'var(--navy-deep)', border: '1px solid rgba(16,185,129,0.3)' }}>
                <p className="mono text-[10px] tracking-widest mb-2" style={{ color: 'var(--green-ok)' }}>CLEANUP ESTIMATE</p>
                <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs mono" style={{ color: 'var(--text-secondary)' }}>
                  {Number.isFinite(assignment.estimated_kg) && (
                    <span>~<span className="font-bold" style={{ color: 'var(--text-primary)' }}>{Math.round(assignment.estimated_kg)} kg</span></span>
                  )}
                  {Number.isFinite(assignment.estimated_trips) && (
                    <span><span className="font-bold" style={{ color: 'var(--text-primary)' }}>{assignment.estimated_trips}</span> trip{assignment.estimated_trips === 1 ? '' : 's'}</span>
                  )}
                  {Number.isFinite(assignment.total_minutes) && (
                    <span>total <span className="font-bold" style={{ color: 'var(--text-primary)' }}>{formatEtaShort(assignment.total_minutes)}</span></span>
                  )}
                </div>
                <p className="mono text-[10px] mt-2" style={{ color: 'var(--text-dim)' }}>
                  Mode: shore crew · Status: {(assignment.status || 'assigned').toUpperCase()}
                </p>
              </div>
            </div>

            {assignment.gemini_brief && (
              <div className="rounded-xl p-3 mb-3" style={{ background: 'var(--navy-deep)', border: '1px solid var(--navy-border)' }}>
                <p className="mono text-[10px] tracking-widest mb-1" style={{ color: 'var(--text-secondary)' }}>CREW BRIEF</p>
                <p className="text-xs leading-relaxed whitespace-pre-wrap" style={{ color: 'var(--text-secondary)' }}>{assignment.gemini_brief}</p>
              </div>
            )}

            <div className="flex flex-col sm:flex-row gap-2">
              {assignment.status !== 'en_route' && (
                <button
                  onClick={dispatchCrew}
                  disabled={updating}
                  className="flex-1 display text-base tracking-widest py-3 rounded-xl transition-colors disabled:opacity-40"
                  style={{ background: 'rgba(0,212,255,0.12)', border: '1px solid var(--cyan-glow)', color: 'var(--cyan-glow)' }}
                  title={debrisHasArrived ? 'Debris is at the landfall point — roll the crew' : 'Send the crew to the landfall point'}
                  onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(0,212,255,0.22)')}
                  onMouseLeave={(e) => (e.currentTarget.style.background = 'rgba(0,212,255,0.12)')}
                >
                  ▶ DISPATCH CREW
                </button>
              )}
              <button
                onClick={markCleanupComplete}
                disabled={updating}
                className="flex-1 display text-base tracking-widest py-3 rounded-xl transition-colors disabled:opacity-40"
                style={{ background: 'rgba(16,185,129,0.12)', border: '1px solid var(--green-ok)', color: 'var(--green-ok)' }}
                title="Mark debris cleared once the crew has finished pickup"
                onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(16,185,129,0.22)')}
                onMouseLeave={(e) => (e.currentTarget.style.background = 'rgba(16,185,129,0.12)')}
              >
                ✓ MARK CLEANUP COMPLETE
              </button>
            </div>
            {!debrisHasArrived && lf.landfallPoint && (
              <p className="mono text-[10px] mt-2 leading-snug" style={{ color: 'var(--text-dim)' }}>
                Debris hasn&apos;t reached the coast yet — the trajectory above shows where it&apos;s drifting. Dispatch when you want the crew at the landfall point.
              </p>
            )}
          </div>
        ) : (
          <div className="rounded-2xl p-6 text-center" style={{ background: 'var(--navy-surface)', border: '1px dashed var(--navy-border)' }}>
            <p className="mono text-xs tracking-widest" style={{ color: 'var(--text-dim)' }}>NO ACTIVE ASSIGNMENT</p>
            <p className="text-xs mt-2" style={{ color: 'var(--text-secondary)' }}>
              Dispatch this crew from the command dashboard when a shore-pickup mission appears.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
