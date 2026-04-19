import { useState, useEffect, useCallback, useRef } from 'react';
import { useParams } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { formatCoordPair } from '../lib/coords';
import { labelForPickupKey, pickupBadgeClassName } from '../lib/pickupClassification';
import { formatEtaShort } from '../lib/cleanupTime';
import {
  insertSupplyOrder,
  computeReorderQuantity,
  formatEtaHuman,
  formatCountdownTo,
  applyDeliveredSupplyOrders,
} from '../lib/supplyOrders';

const STATUS_OPTIONS = ['available', 'deployed', 'returning', 'maintenance'];

const STATUS_STYLE = {
  available:   { background: 'rgba(16,185,129,0.15)', border: '1px solid var(--green-ok)', color: 'var(--green-ok)' },
  deployed:    { background: 'rgba(0,212,255,0.12)',  border: '1px solid var(--cyan-glow)', color: 'var(--cyan-glow)' },
  returning:   { background: 'rgba(0,137,178,0.15)',  border: '1px solid var(--cyan-dim)',  color: 'var(--cyan-dim)' },
  maintenance: { background: 'rgba(245,158,11,0.12)', border: '1px solid var(--amber)',     color: 'var(--amber)' },
};

/** Scale for demo: set REACT_APP_MAINTENANCE_SCALE=0.05 to shrink durations 20×. */
const MAINT_SCALE = (() => {
  const v = parseFloat(process.env.REACT_APP_MAINTENANCE_SCALE || '1');
  return Number.isFinite(v) && v > 0 ? v : 1;
})();

const MAINTENANCE_OPTIONS = [
  { label: 'Quick Check',   hours: 0.5,  desc: 'Fuel, safety gear & deck check' },
  { label: 'Standard',      hours: 2,    desc: 'Systems, engine & minor repairs' },
  { label: 'Major Refit',   hours: 8,    desc: 'Full maintenance & overhaul cycle' },
];

const pad2 = (n) => String(Math.floor(n)).padStart(2, '0');

function countdown(until) {
  const diff = new Date(until) - Date.now();
  if (diff <= 0) return null;
  const totalSec = Math.floor(diff / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}:${pad2(m)}:${pad2(s)}`;
  return `${pad2(m)}:${pad2(s)}`;
}

export default function VesselStation() {
  const { vesselId } = useParams();
  const [vessel, setVessel] = useState(null);
  const [supplies, setSupplies] = useState([]);
  const [supplyOrders, setSupplyOrders] = useState([]);
  const [assignment, setAssignment] = useState(null);
  const [loading, setLoading] = useState(true);
  const [updating, setUpdating] = useState(false);
  const [adjusting, setAdjusting] = useState(null);
  const [orderingId, setOrderingId] = useState(null);

  /** Maintenance timer stored in localStorage: cm_maint_{vesselId} = ISO string */
  const [maintenanceUntil, setMaintenanceUntil] = useState(null);
  const [tick, setTick] = useState(0);
  const tickRef = useRef(null);

  const fetchSupplies = useCallback(async (zone) => {
    await applyDeliveredSupplyOrders(supabase);
    const [sRes, oRes] = await Promise.all([
      supabase.from('supplies').select('*').eq('zone', zone).order('name'),
      supabase.from('supply_orders').select('*').eq('status', 'in_transit').order('expected_arrival_at'),
    ]);
    if (sRes.data) setSupplies(sRes.data);
    if (oRes.data) setSupplyOrders(oRes.data);
  }, []);

  const fetchAssignment = useCallback(async () => {
    const { data } = await supabase
      .from('assignments')
      .select('*, debris_sightings(*)')
      .eq('vessel_id', vesselId)
      .eq('status', 'assigned')
      .order('created_at', { ascending: false })
      .limit(1)
      .single();
    setAssignment(data);
  }, [vesselId]);

  // Init vessel + maintenance timer from localStorage
  useEffect(() => {
    const init = async () => {
      const { data } = await supabase.from('vessels').select('*').eq('id', vesselId).single();
      setVessel(data);
      setLoading(false);
      if (data) {
        await fetchSupplies(data.zone);
        await fetchAssignment();
      }
    };
    init();

    // Restore maintenance timer
    const stored = localStorage.getItem(`cm_maint_${vesselId}`);
    if (stored && new Date(stored) > new Date()) setMaintenanceUntil(stored);

    // 1s tick for countdowns
    tickRef.current = setInterval(() => setTick((n) => n + 1), 1000);

    const chan = supabase.channel('vessel-' + vesselId)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'vessels', filter: `id=eq.${vesselId}` }, (p) => setVessel(p.new))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'supplies' }, (p) => {
        if (p.new?.zone) fetchSupplies(p.new.zone);
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'supply_orders' }, () => {
        setVessel((v) => { if (v) fetchSupplies(v.zone); return v; });
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'assignments' }, fetchAssignment)
      .subscribe();

    return () => {
      supabase.removeChannel(chan);
      clearInterval(tickRef.current);
    };
  }, [vesselId, fetchSupplies, fetchAssignment]);

  // Auto-complete maintenance when timer expires
  useEffect(() => {
    if (!maintenanceUntil) return;
    if (new Date() >= new Date(maintenanceUntil)) {
      localStorage.removeItem(`cm_maint_${vesselId}`);
      setMaintenanceUntil(null);
      supabase.from('vessels')
        .update({ status: 'available', updated_at: new Date().toISOString() })
        .eq('id', vesselId);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick]);

  const updateStatus = async (status) => {
    setUpdating(true);
    // Clear maintenance timer if manually switching away
    if (status !== 'maintenance') {
      localStorage.removeItem(`cm_maint_${vesselId}`);
      setMaintenanceUntil(null);
    }
    await supabase.from('vessels').update({ status, updated_at: new Date().toISOString() }).eq('id', vesselId);
    setUpdating(false);
  };

  const startMaintenance = async (opt) => {
    const scaledHours = opt.hours * MAINT_SCALE;
    const until = new Date(Date.now() + scaledHours * 3600000).toISOString();
    localStorage.setItem(`cm_maint_${vesselId}`, until);
    setMaintenanceUntil(until);
    await supabase.from('vessels').update({ status: 'maintenance', updated_at: new Date().toISOString() }).eq('id', vesselId);
  };

  const updateFuel = async (delta) => {
    const newLevel = Math.min(100, Math.max(0, vessel.fuel_level + delta));
    await supabase.from('vessels').update({ fuel_level: newLevel, updated_at: new Date().toISOString() }).eq('id', vesselId);
  };

  const adjustSupply = async (supply, delta) => {
    const newQty = Math.max(0, supply.quantity + delta);
    setAdjusting(supply.id);
    await supabase.from('supplies').update({ quantity: newQty, updated_at: new Date().toISOString() }).eq('id', supply.id);
    setSupplies((prev) => prev.map((s) => s.id === supply.id ? { ...s, quantity: newQty } : s));
    setAdjusting(null);
  };

  const requestResupply = async (supply) => {
    setOrderingId(supply.id);
    try {
      const { error } = await insertSupplyOrder(supabase, supply);
      if (error) throw error;
      await fetchSupplies(vessel.zone);
    } catch (e) {
      alert(`Order failed: ${e.message}`);
    } finally {
      setOrderingId(null);
    }
  };

  const markIntercepted = async () => {
    if (!assignment) return;
    const updates = [
      supabase.from('assignments').update({ status: 'completed' }).eq('id', assignment.id),
      supabase.from('debris_sightings').update({ status: 'intercepted' }).eq('id', assignment.sighting_id),
    ];
    if (assignment.vessel_id) {
      updates.push(
        supabase.from('vessels').update({ status: 'available', updated_at: new Date().toISOString() }).eq('id', assignment.vessel_id),
      );
    }
    await Promise.all(updates);
    fetchAssignment();
  };

  if (loading) return (
    <div className="min-h-screen naval-bg flex items-center justify-center">
      <p className="mono text-sm glow-pulse" style={{ color: 'var(--text-secondary)' }}>LOADING VESSEL DATA…</p>
    </div>
  );

  if (!vessel) return (
    <div className="min-h-screen naval-bg flex items-center justify-center">
      <p className="mono text-sm" style={{ color: 'var(--red-crit)' }}>VESSEL NOT FOUND</p>
    </div>
  );

  const lowSupplies = supplies.filter((s) => s.quantity <= s.low_threshold);
  const fuelLow = vessel.fuel_level <= vessel.fuel_threshold;
  const activeStatusStyle = STATUS_STYLE[vessel.status] || STATUS_STYLE.available;
  const inMaintenance = vessel.status === 'maintenance';
  const maintCountdown = maintenanceUntil ? countdown(maintenanceUntil) : null;

  // Map supply_id → pending orders for that supply
  const ordersBySupply = supplyOrders.reduce((acc, o) => {
    if (!acc[o.supply_id]) acc[o.supply_id] = [];
    acc[o.supply_id].push(o);
    return acc;
  }, {});

  return (
    <div className="min-h-screen naval-bg" style={{ color: 'var(--text-primary)' }}>
      <header className="px-4 py-3 flex items-center justify-between" style={{ background: 'rgba(2,12,27,0.9)', borderBottom: '1px solid var(--navy-border)', backdropFilter: 'blur(12px)' }}>
        <div className="flex items-center gap-3">
          <span className="text-2xl">🚢</span>
          <div>
            <h1 className="display text-xl tracking-widest" style={{ color: 'var(--cyan-glow)' }}>{vessel.name.toUpperCase()}</h1>
            <p className="mono text-[10px] tracking-widest" style={{ color: 'var(--text-secondary)' }}>{vessel.zone} · {vessel.agency}</p>
          </div>
        </div>
        <a href="/dashboard" className="mono text-[10px] tracking-widest transition-colors" style={{ color: 'var(--text-dim)' }}
          onMouseEnter={e => e.target.style.color = 'var(--cyan-glow)'}
          onMouseLeave={e => e.target.style.color = 'var(--text-dim)'}
        >← COMMAND</a>
      </header>

      <div className="max-w-lg mx-auto p-4 space-y-4">

        {/* Priority alerts */}
        {(lowSupplies.length > 0 || fuelLow) && (
          <div className="rounded-xl px-4 py-3 slide-up" style={{ background: 'rgba(239,68,68,0.1)', border: '1px solid var(--red-crit)' }}>
            <p className="mono text-xs font-bold tracking-widest mb-1" style={{ color: 'var(--red-crit)' }}>⚠ PRIORITY ALERTS</p>
            {fuelLow && <p className="mono text-xs mt-0.5" style={{ color: '#fca5a5' }}>Fuel critically low ({vessel.fuel_level}%) — return to port</p>}
            {lowSupplies.length > 0 && <p className="mono text-xs mt-0.5" style={{ color: '#fca5a5' }}>Low supplies: {lowSupplies.map((s) => s.name).join(', ')}</p>}
          </div>
        )}

        {/* Vessel status */}
        <div className="glass rounded-2xl p-5">
          <div className="flex items-center justify-between mb-4">
            <div>
              <p className="mono text-[10px] tracking-widest mb-2" style={{ color: 'var(--text-secondary)' }}>CURRENT STATUS</p>
              <span className="mono text-xs font-bold px-3 py-1 rounded tracking-widest" style={activeStatusStyle}>
                {vessel.status.toUpperCase()}
              </span>
            </div>
            <div className="text-right">
              <p className="mono text-[10px] tracking-widest mb-1" style={{ color: 'var(--text-secondary)' }}>CAPACITY</p>
              <p className="mono font-bold" style={{ color: 'var(--text-primary)' }}>{vessel.capacity} m³</p>
            </div>
          </div>

          {/* Status switcher */}
          <div className="grid grid-cols-2 gap-2 mb-5">
            {STATUS_OPTIONS.filter((s) => s !== 'maintenance').map((s) => (
              <button
                key={s}
                onClick={() => updateStatus(s)}
                disabled={updating || vessel.status === s}
                className="py-2 rounded-xl mono text-[10px] font-bold transition-colors disabled:opacity-40 tracking-widest"
                style={vessel.status === s
                  ? activeStatusStyle
                  : { background: 'var(--navy-surface)', border: '1px solid var(--navy-border)', color: 'var(--text-dim)' }}
              >
                {s.toUpperCase()}
              </button>
            ))}
          </div>

          {/* Fuel */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <p className="mono text-xs tracking-widest" style={{ color: 'var(--text-secondary)' }}>FUEL LEVEL</p>
              <span className="mono text-sm font-bold" style={{ color: fuelLow ? 'var(--red-crit)' : 'var(--green-ok)' }}>{vessel.fuel_level}%</span>
            </div>
            <div className="w-full rounded-full h-2" style={{ background: 'var(--navy-deep)', border: '1px solid var(--navy-border)' }}>
              <div className="h-2 rounded-full transition-all" style={{
                width: `${vessel.fuel_level}%`,
                background: fuelLow ? 'var(--red-crit)' : vessel.fuel_level > 60 ? 'var(--green-ok)' : 'var(--amber)',
                boxShadow: fuelLow ? '0 0 8px rgba(239,68,68,0.5)' : vessel.fuel_level > 60 ? '0 0 8px rgba(16,185,129,0.4)' : '0 0 8px rgba(245,158,11,0.4)',
              }} />
            </div>
            <div className="flex gap-2">
              <button onClick={() => updateFuel(-10)} className="flex-1 mono text-[10px] py-1.5 rounded-lg tracking-widest transition-colors"
                style={{ background: 'var(--navy-surface)', border: '1px solid var(--navy-border)', color: 'var(--text-dim)' }}
                onMouseEnter={e => e.currentTarget.style.borderColor = 'var(--red-crit)'}
                onMouseLeave={e => e.currentTarget.style.borderColor = 'var(--navy-border)'}
              >− 10% USED</button>
              <button onClick={() => updateFuel(+20)} className="flex-1 mono text-[10px] py-1.5 rounded-lg tracking-widest transition-colors"
                style={{ background: 'var(--navy-surface)', border: '1px solid var(--navy-border)', color: 'var(--text-dim)' }}
                onMouseEnter={e => e.currentTarget.style.borderColor = 'var(--green-ok)'}
                onMouseLeave={e => e.currentTarget.style.borderColor = 'var(--navy-border)'}
              >+ 20% REFUEL</button>
            </div>
          </div>
        </div>

        {/* Maintenance panel */}
        <div className="glass rounded-2xl p-4" style={inMaintenance ? { borderColor: 'var(--amber)' } : {}}>
          <p className="mono text-xs font-bold tracking-widest mb-3" style={{ color: 'var(--amber)' }}>⚙ MAINTENANCE</p>

          {inMaintenance && maintenanceUntil ? (
            /* Active maintenance countdown */
            <div className="rounded-xl p-4 mb-3 text-center" style={{ background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.4)' }}>
              <p className="mono text-[10px] tracking-widest mb-1" style={{ color: 'var(--amber)' }}>IN MAINTENANCE — RETURNS IN</p>
              {maintCountdown ? (
                <p className="display text-4xl tracking-widest" style={{ color: 'var(--amber)', textShadow: '0 0 20px rgba(245,158,11,0.5)' }}>
                  {maintCountdown}
                </p>
              ) : (
                <p className="mono text-sm" style={{ color: 'var(--green-ok)' }}>Completing…</p>
              )}
              <p className="mono text-[10px] mt-2" style={{ color: 'var(--text-dim)' }}>
                Auto-returns to AVAILABLE when timer expires
              </p>
            </div>
          ) : inMaintenance ? (
            /* In maintenance but no timer set (manually switched) */
            <div className="rounded-xl p-3 mb-3" style={{ background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.3)' }}>
              <p className="mono text-xs" style={{ color: 'var(--amber)' }}>Manual maintenance mode — no timer set.</p>
            </div>
          ) : null}

          {/* Maintenance request buttons */}
          {!inMaintenance && (
            <div className="space-y-2">
              <p className="mono text-[10px] mb-2" style={{ color: 'var(--text-dim)' }}>Request scheduled maintenance:</p>
              {MAINTENANCE_OPTIONS.map((opt) => {
                const scaledHours = opt.hours * MAINT_SCALE;
                const displayTime = scaledHours < 1
                  ? `${Math.round(scaledHours * 60)} min`
                  : `${scaledHours % 1 === 0 ? scaledHours : scaledHours.toFixed(1)} hr`;
                return (
                  <button
                    key={opt.label}
                    onClick={() => startMaintenance(opt)}
                    disabled={updating}
                    className="w-full rounded-xl px-3 py-2.5 text-left transition-colors disabled:opacity-40"
                    style={{ background: 'var(--navy-surface)', border: '1px solid var(--navy-border)' }}
                    onMouseEnter={e => e.currentTarget.style.borderColor = 'var(--amber)'}
                    onMouseLeave={e => e.currentTarget.style.borderColor = 'var(--navy-border)'}
                  >
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="mono text-xs font-bold" style={{ color: 'var(--text-primary)' }}>{opt.label}</p>
                        <p className="mono text-[10px] mt-0.5" style={{ color: 'var(--text-dim)' }}>{opt.desc}</p>
                      </div>
                      <span className="mono text-sm font-bold shrink-0 ml-3" style={{ color: 'var(--amber)' }}>{displayTime}</span>
                    </div>
                  </button>
                );
              })}
            </div>
          )}

          {/* Cancel maintenance */}
          {inMaintenance && (
            <button
              onClick={() => updateStatus('available')}
              className="w-full mono text-[10px] font-bold py-2 rounded-xl tracking-widest mt-2 transition-colors"
              style={{ background: 'var(--navy-surface)', border: '1px solid var(--navy-border)', color: 'var(--text-dim)' }}
              onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--red-crit)'; e.currentTarget.style.color = 'var(--red-crit)'; }}
              onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--navy-border)'; e.currentTarget.style.color = 'var(--text-dim)'; }}
            >
              CANCEL MAINTENANCE
            </button>
          )}
        </div>

        {/* Current assignment */}
        {assignment && (
          <div className="rounded-2xl p-4 slide-up" style={{ background: 'rgba(0,212,255,0.05)', border: '1px solid rgba(0,212,255,0.3)' }}>
            <p className="mono text-[10px] font-bold tracking-widest mb-3" style={{ color: 'var(--cyan-glow)' }}>◈ ACTIVE ASSIGNMENT</p>
            {assignment.debris_sightings && (
              <div className="mb-3">
                <p className="font-semibold text-sm" style={{ color: 'var(--text-primary)' }}>
                  {assignment.debris_sightings.density_label} {assignment.debris_sightings.debris_type?.replace('_', ' ')} cluster
                </p>
                {assignment.debris_sightings.pickup_mode && (
                  <p className="mt-1.5">
                    <span className={`text-xs font-bold px-2 py-0.5 rounded border ${pickupBadgeClassName(assignment.debris_sightings.pickup_mode)}`}>
                      {labelForPickupKey(assignment.debris_sightings.pickup_mode)}
                    </span>
                  </p>
                )}
                <p className="text-xs mt-1 leading-snug" style={{ color: 'var(--text-secondary)' }}>{assignment.debris_sightings.gemini_analysis?.slice(0, 100)}…</p>
              </div>
            )}
            <div className="rounded-xl p-3 mb-3" style={{ background: 'var(--navy-deep)', border: '1px solid var(--navy-border)' }}>
              <p className="mono text-[10px] tracking-widest mb-1" style={{ color: 'var(--text-dim)' }}>INTERCEPT POINT</p>
              <p className="mono text-sm font-bold" style={{ color: 'var(--cyan-glow)' }}>
                {formatCoordPair(assignment.interception_lat ?? 0, assignment.interception_lon ?? 0)}
              </p>
              <p className="mono text-xs mt-1" style={{ color: 'var(--text-dim)' }}>ETA: {assignment.interception_hours}h from dispatch</p>
            </div>
            {(Number.isFinite(assignment.estimated_kg) || Number.isFinite(assignment.estimated_trips) || Number.isFinite(assignment.total_minutes)) && (
              <div className="rounded-xl p-3 mb-3" style={{ background: 'var(--navy-deep)', border: '1px solid rgba(16,185,129,0.3)' }}>
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
                {assignment.crew_type && (
                  <p className="mono text-[10px] mt-1" style={{ color: 'var(--text-dim)' }}>Mode: {assignment.crew_type === 'land' ? 'shore crew' : 'ship vessel'}</p>
                )}
              </div>
            )}
            {assignment.gemini_brief && (
              <div className="rounded-xl p-3 mb-3" style={{ background: 'var(--navy-deep)', border: '1px solid var(--navy-border)' }}>
                <p className="mono text-[10px] tracking-widest mb-1" style={{ color: 'var(--text-secondary)' }}>CREW BRIEF</p>
                <p className="text-xs leading-relaxed whitespace-pre-wrap" style={{ color: 'var(--text-secondary)' }}>{assignment.gemini_brief}</p>
              </div>
            )}
            <button
              onClick={markIntercepted}
              className="w-full display text-lg tracking-widest py-3 rounded-xl transition-colors"
              style={{ background: 'rgba(16,185,129,0.12)', border: '1px solid var(--green-ok)', color: 'var(--green-ok)' }}
              onMouseEnter={e => e.currentTarget.style.background = 'rgba(16,185,129,0.22)'}
              onMouseLeave={e => e.currentTarget.style.background = 'rgba(16,185,129,0.12)'}
            >
              ✓ MARK INTERCEPTED
            </button>
          </div>
        )}

        {/* Supplies + resupply orders */}
        <div className="glass rounded-2xl p-4">
          <div className="flex items-center justify-between mb-3">
            <p className="mono text-xs font-bold tracking-widest" style={{ color: 'var(--text-secondary)' }}>ZONE SUPPLIES</p>
            <span className="mono text-[10px]" style={{ color: 'var(--text-dim)' }}>TAP ± TO ADJUST</span>
          </div>
          {supplies.length === 0 ? (
            <p className="mono text-xs" style={{ color: 'var(--text-dim)' }}>No supplies tracked for this zone</p>
          ) : (
            <div className="space-y-3">
              {supplies.map((s) => {
                const isLow = s.quantity <= s.low_threshold;
                const pendingOrders = ordersBySupply[s.id] || [];
                const nextQty = computeReorderQuantity(s);
                return (
                  <div key={s.id}>
                    <div className="flex items-center justify-between rounded-xl px-3 py-2.5 transition-colors"
                      style={isLow
                        ? { background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.4)' }
                        : { background: 'var(--navy-surface)', border: '1px solid var(--navy-border)' }}
                    >
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>{s.name}</span>
                          {isLow && (
                            <span className="mono text-[9px] font-bold px-1.5 py-0.5 rounded tracking-widest critical-dot"
                              style={{ background: 'rgba(239,68,68,0.2)', border: '1px solid var(--red-crit)', color: 'var(--red-crit)' }}>
                              LOW
                            </span>
                          )}
                        </div>
                        <p className="mono text-[10px] mt-0.5" style={{ color: 'var(--text-dim)' }}>Min: {s.low_threshold}</p>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <button
                          onClick={() => adjustSupply(s, -1)}
                          disabled={s.quantity === 0 || adjusting === s.id}
                          className="w-8 h-8 mono font-bold rounded-lg transition-colors flex items-center justify-center disabled:opacity-30"
                          style={{ background: 'var(--navy-deep)', border: '1px solid var(--navy-border)', color: 'var(--text-secondary)' }}
                          onMouseEnter={e => { if (!e.currentTarget.disabled) e.currentTarget.style.borderColor = 'var(--red-crit)'; }}
                          onMouseLeave={e => e.currentTarget.style.borderColor = 'var(--navy-border)'}
                        >−</button>
                        <span className="w-8 text-center mono font-bold text-sm" style={{ color: isLow ? 'var(--red-crit)' : 'var(--text-primary)' }}>{s.quantity}</span>
                        <button
                          onClick={() => adjustSupply(s, +1)}
                          disabled={adjusting === s.id}
                          className="w-8 h-8 mono font-bold rounded-lg transition-colors flex items-center justify-center disabled:opacity-30"
                          style={{ background: 'var(--navy-deep)', border: '1px solid var(--navy-border)', color: 'var(--text-secondary)' }}
                          onMouseEnter={e => e.currentTarget.style.borderColor = 'var(--green-ok)'}
                          onMouseLeave={e => e.currentTarget.style.borderColor = 'var(--navy-border)'}
                        >+</button>
                      </div>
                    </div>

                    {/* Pending supply orders for this item */}
                    {pendingOrders.length > 0 && (
                      <div className="mt-1 rounded-lg px-3 py-2 space-y-1" style={{ background: 'var(--navy-deep)', border: '1px solid rgba(245,158,11,0.25)' }}>
                        {pendingOrders.map((o) => (
                          <div key={o.id} className="flex items-center justify-between">
                            <p className="mono text-[10px]" style={{ color: 'var(--amber)' }}>
                              +{o.quantity} inbound · {o.supplier_name}
                            </p>
                            <p className="mono text-[10px] font-bold" style={{ color: 'var(--cyan-glow)' }}>
                              {formatCountdownTo(o.expected_arrival_at)}
                            </p>
                          </div>
                        ))}
                      </div>
                    )}

                    {/* Request resupply button */}
                    {pendingOrders.length === 0 && (
                      <button
                        onClick={() => requestResupply(s)}
                        disabled={orderingId === s.id}
                        className="w-full mt-1 mono text-[10px] font-bold py-1.5 rounded-lg tracking-widest transition-colors disabled:opacity-40"
                        style={{ background: 'var(--navy-deep)', border: '1px solid var(--navy-border)', color: 'var(--text-dim)' }}
                        onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--amber)'; e.currentTarget.style.color = 'var(--amber)'; }}
                        onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--navy-border)'; e.currentTarget.style.color = 'var(--text-dim)'; }}
                      >
                        {orderingId === s.id ? 'ORDERING…' : `REQUEST ~${nextQty} UNITS`}
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

      </div>
    </div>
  );
}
