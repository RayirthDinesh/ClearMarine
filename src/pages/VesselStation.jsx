import { useState, useEffect, useCallback } from 'react';
import { useParams } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { formatCoordPair } from '../lib/coords';
import { labelForPickupKey, pickupBadgeClassName } from '../lib/pickupClassification';

const STATUS_OPTIONS = ['available', 'deployed', 'returning', 'maintenance'];

export default function VesselStation() {
  const { vesselId } = useParams();
  const [vessel, setVessel] = useState(null);
  const [supplies, setSupplies] = useState([]);
  const [assignment, setAssignment] = useState(null);
  const [loading, setLoading] = useState(true);
  const [updating, setUpdating] = useState(false);
  const [adjusting, setAdjusting] = useState(null);

  const fetchSupplies = useCallback(async (zone) => {
    const { data } = await supabase.from('supplies').select('*').eq('zone', zone).order('name');
    if (data) setSupplies(data);
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

    const chan = supabase.channel('vessel-' + vesselId)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'vessels', filter: `id=eq.${vesselId}` }, (p) => setVessel(p.new))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'supplies' }, () => fetchAssignment())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'assignments' }, fetchAssignment)
      .subscribe();
    return () => supabase.removeChannel(chan);
  }, [vesselId, fetchSupplies, fetchAssignment]);

  const updateStatus = async (status) => {
    setUpdating(true);
    await supabase.from('vessels').update({ status, updated_at: new Date().toISOString() }).eq('id', vesselId);
    setUpdating(false);
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

  const markIntercepted = async () => {
    if (!assignment) return;
    await Promise.all([
      supabase.from('assignments').update({ status: 'completed' }).eq('id', assignment.id),
      supabase.from('debris_sightings').update({ status: 'intercepted' }).eq('id', assignment.sighting_id),
    ]);
    fetchAssignment();
  };

  if (loading) return (
    <div className="min-h-screen bg-slate-900 flex items-center justify-center">
      <p className="text-slate-400">Loading vessel...</p>
    </div>
  );

  if (!vessel) return (
    <div className="min-h-screen bg-slate-900 flex items-center justify-center">
      <p className="text-slate-400">Vessel not found</p>
    </div>
  );

  const lowSupplies = supplies.filter((s) => s.quantity <= s.low_threshold);
  const fuelLow = vessel.fuel_level <= vessel.fuel_threshold;
  const statusColor = {
    available: 'bg-green-700 text-green-200',
    deployed: 'bg-blue-700 text-blue-200',
    returning: 'bg-cyan-700 text-cyan-200',
    maintenance: 'bg-orange-700 text-orange-200',
  };

  return (
    <div className="min-h-screen bg-slate-900 text-white">
      <header className="bg-slate-800 border-b border-slate-700 px-4 py-3 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="text-2xl">🚢</span>
          <div>
            <h1 className="text-white font-bold">{vessel.name}</h1>
            <p className="text-slate-400 text-xs">{vessel.zone} · {vessel.agency}</p>
          </div>
        </div>
        <a href="/dashboard" className="text-cyan-400 text-sm hover:underline">← Dashboard</a>
      </header>

      <div className="max-w-lg mx-auto p-4 space-y-4">
        {/* Priority alerts */}
        {(lowSupplies.length > 0 || fuelLow) && (
          <div className="bg-red-900 border border-red-600 rounded-xl px-4 py-3">
            <p className="text-red-200 font-bold text-sm">⚠ PRIORITY ALERTS</p>
            {fuelLow && <p className="text-red-300 text-xs mt-0.5">Fuel critically low ({vessel.fuel_level}%) — return to port</p>}
            {lowSupplies.length > 0 && <p className="text-red-300 text-xs mt-0.5">Low supplies: {lowSupplies.map((s) => s.name).join(', ')}</p>}
          </div>
        )}

        {/* Vessel status */}
        <div className="bg-slate-800 rounded-2xl p-5 border border-slate-700">
          <div className="flex items-center justify-between mb-4">
            <div>
              <p className="text-slate-400 text-xs mb-1">Current Status</p>
              <span className={`text-sm font-bold px-3 py-1 rounded-full ${statusColor[vessel.status] || 'bg-slate-700 text-white'}`}>
                {vessel.status.toUpperCase()}
              </span>
            </div>
            <div className="text-right">
              <p className="text-slate-400 text-xs mb-1">Capacity</p>
              <p className="text-white font-bold">{vessel.capacity} m³</p>
            </div>
          </div>

          {/* Status switcher */}
          <div className="grid grid-cols-2 gap-2 mb-4">
            {STATUS_OPTIONS.map((s) => (
              <button
                key={s}
                onClick={() => updateStatus(s)}
                disabled={updating || vessel.status === s}
                className={`py-2 rounded-xl text-xs font-medium transition-colors capitalize disabled:opacity-40 ${vessel.status === s ? 'bg-cyan-700 text-white' : 'bg-slate-700 hover:bg-slate-600 text-slate-300'}`}
              >
                {s}
              </button>
            ))}
          </div>

          {/* Fuel */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <p className="text-slate-400 text-sm">Fuel Level</p>
              <span className={`text-sm font-bold ${fuelLow ? 'text-red-400' : 'text-white'}`}>{vessel.fuel_level}%</span>
            </div>
            <div className="w-full bg-slate-700 rounded-full h-3">
              <div
                className={`h-3 rounded-full transition-all ${fuelLow ? 'bg-red-500' : vessel.fuel_level > 60 ? 'bg-green-500' : 'bg-yellow-500'}`}
                style={{ width: `${vessel.fuel_level}%` }}
              />
            </div>
            <div className="flex gap-2">
              <button onClick={() => updateFuel(-10)} className="flex-1 bg-slate-700 hover:bg-red-900 text-white text-xs py-1.5 rounded-lg transition-colors">− 10% used</button>
              <button onClick={() => updateFuel(+20)} className="flex-1 bg-slate-700 hover:bg-green-900 text-white text-xs py-1.5 rounded-lg transition-colors">+ 20% refuel</button>
            </div>
          </div>
        </div>

        {/* Current assignment */}
        {assignment && (
          <div className="bg-blue-950 border border-blue-700 rounded-2xl p-4">
            <p className="text-blue-300 text-xs font-semibold uppercase tracking-wider mb-2">Active Assignment</p>
            {assignment.debris_sightings && (
              <div className="mb-3">
                <p className="text-white font-semibold text-sm">
                  {assignment.debris_sightings.density_label} {assignment.debris_sightings.debris_type?.replace('_', ' ')} cluster
                </p>
                {assignment.debris_sightings.pickup_mode && (
                  <p className="mt-1.5">
                    <span className={`text-xs font-bold px-2 py-0.5 rounded border ${pickupBadgeClassName(assignment.debris_sightings.pickup_mode)}`}>
                      {labelForPickupKey(assignment.debris_sightings.pickup_mode)}
                    </span>
                  </p>
                )}
                <p className="text-slate-300 text-xs mt-1">{assignment.debris_sightings.gemini_analysis?.slice(0, 100)}...</p>
              </div>
            )}
            <div className="bg-slate-900 rounded-xl p-3 mb-3 text-xs space-y-1">
              <p className="text-slate-400">Intercept point</p>
              <p className="text-cyan-400 font-mono">
                {formatCoordPair(assignment.interception_lat ?? 0, assignment.interception_lon ?? 0)}
              </p>
              <p className="text-slate-400">ETA: {assignment.interception_hours}h from dispatch</p>
            </div>
            {assignment.gemini_brief && (
              <div className="bg-slate-900 rounded-xl p-3 mb-3">
                <p className="text-slate-400 text-xs mb-1 font-medium">Crew Brief</p>
                <p className="text-slate-300 text-xs leading-relaxed whitespace-pre-wrap">{assignment.gemini_brief}</p>
              </div>
            )}
            <button onClick={markIntercepted} className="w-full bg-green-700 hover:bg-green-600 text-white font-semibold py-2.5 rounded-xl transition-colors text-sm">
              ✓ Mark Intercepted
            </button>
          </div>
        )}

        {/* Supplies */}
        <div className="bg-slate-800 rounded-2xl p-4 border border-slate-700">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-slate-300 font-semibold text-sm">Zone Supplies</h2>
            <span className="text-slate-500 text-xs">Tap ± to adjust</span>
          </div>
          {supplies.length === 0 ? (
            <p className="text-slate-500 text-sm">No supplies tracked for this zone</p>
          ) : (
            <div className="space-y-2">
              {supplies.map((s) => {
                const isLow = s.quantity <= s.low_threshold;
                return (
                  <div key={s.id} className={`flex items-center justify-between rounded-xl px-3 py-2.5 ${isLow ? 'bg-red-950 border border-red-700' : 'bg-slate-700'}`}>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-slate-100 text-sm font-medium">{s.name}</span>
                        {isLow && <span className="bg-red-600 text-white text-xs font-bold px-2 py-0.5 rounded-full animate-pulse">PRIORITY</span>}
                      </div>
                      <p className="text-slate-500 text-xs">Min: {s.low_threshold}</p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <button onClick={() => adjustSupply(s, -1)} disabled={s.quantity === 0 || adjusting === s.id}
                        className="w-8 h-8 bg-slate-600 hover:bg-red-800 disabled:opacity-30 text-white rounded-lg font-bold transition-colors flex items-center justify-center">−</button>
                      <span className={`w-8 text-center font-bold ${isLow ? 'text-red-400' : 'text-white'}`}>{s.quantity}</span>
                      <button onClick={() => adjustSupply(s, +1)} disabled={adjusting === s.id}
                        className="w-8 h-8 bg-slate-600 hover:bg-green-800 text-white rounded-lg font-bold transition-colors flex items-center justify-center">+</button>
                    </div>
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
