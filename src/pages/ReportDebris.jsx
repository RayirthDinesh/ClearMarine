import { useState, useRef, useEffect, useCallback } from 'react';
import {
  analyzeDebrisPhoto,
  analyzeDebrisText,
  notesLookSufficient,
  structuredReportComplete,
} from '../lib/gemini';
import { supabase } from '../lib/supabase';
import { predictDrift } from '../lib/drift';
import { formatCoordPair, parseManualLongitudeWest } from '../lib/coords';

const WASTE_TYPE_OPTIONS = [
  { value: 'plastic', label: 'Plastic / foam / bottles' },
  { value: 'fishing_gear', label: 'Fishing gear / nets / rope' },
  { value: 'organic', label: 'Organic / wood / vegetation' },
  { value: 'chemical', label: 'Oil / chemical / hazardous sheen' },
  { value: 'mixed', label: 'Mixed types' },
  { value: 'unknown', label: 'Not sure' },
];

const SIZE_OPTIONS = [
  { value: 'Single item (hand-sized or smaller)', label: 'One small item (hand-sized or smaller)' },
  { value: 'Single large item (bucket to tire-sized)', label: 'One large item (bucket to tire-sized)' },
  { value: 'Pile — fills a shopping bag', label: 'Pile — about a shopping bag' },
  { value: 'Pile — wheelbarrow or larger', label: 'Pile — wheelbarrow-sized or larger' },
  { value: 'Linear debris — a few meters', label: 'Stretched along shore/water — a few meters' },
  { value: 'Linear debris — tens of meters or more', label: 'Line or slick — tens of meters or more' },
  { value: 'Widespread field / patch', label: 'Widespread patch or field of debris' },
];

const QUANTITY_OPTIONS = [
  { value: '1', label: '1 piece' },
  { value: '2–10', label: '2–10 pieces' },
  { value: '10–100', label: '10–100 pieces' },
  { value: '100+', label: 'More than 100 pieces' },
  { value: 'Continuous line or slick', label: 'Continuous line or slick (no clear count)' },
];

const SPREAD_OPTIONS = [
  { value: '', label: 'Not sure / skip' },
  { value: 'concentrated', label: 'Mostly one spot' },
  { value: 'scattered', label: 'Scattered pieces' },
  { value: 'linear_along_shore', label: 'Along a shoreline or track' },
  { value: 'widespread_patch', label: 'Spread over a wide area' },
];

export default function ReportDebris() {
  const [step, setStep] = useState('name'); // name | report | done
  const [name, setName] = useState('');
  const [photo, setPhoto] = useState(null);       // { base64, mimeType, preview }
  const [location, setLocation] = useState(null); // { lat, lon }
  const [manualLat, setManualLat] = useState('');
  const [manualLon, setManualLon] = useState('');
  /** Unsigned manual lon uses this (default W — Pacific Americas). */
  const [manualLonHemisphere, setManualLonHemisphere] = useState('W');
  const [locMode, setLocMode] = useState('auto'); // auto | manual
  const [loading, setLoading] = useState(false);
  const [locLoading, setLocLoading] = useState(false);
  const [locError, setLocError] = useState(null);
  const [result, setResult] = useState(null);
  const [listening, setListening] = useState(false);
  const [notes, setNotes] = useState('');
  const [wasteType, setWasteType] = useState('');
  const [sizeCategory, setSizeCategory] = useState('');
  const [quantityBand, setQuantityBand] = useState('');
  const [spreadLayout, setSpreadLayout] = useState('');
  const fileRef = useRef(null);
  const recognitionRef = useRef(null);

  const retryLowAccuracy = useCallback(() => {
    if (!navigator.geolocation) {
      setLocMode('manual');
      setLocLoading(false);
      setLocError('Unable to retrieve location');
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocation({ lat: pos.coords.latitude, lon: pos.coords.longitude });
        setLocLoading(false);
        setLocError(null);
      },
      () => {
        setLocMode('manual');
        setLocLoading(false);
        setLocError('Unable to retrieve location — enter coordinates manually.');
      },
      { enableHighAccuracy: false, maximumAge: 60000, timeout: 15000 },
    );
  }, []);

  const requestLocation = useCallback(() => {
    if (locMode !== 'auto') return;
    if (!navigator.geolocation) {
      setLocMode('manual');
      setLocError('Geolocation not supported in this browser.');
      return;
    }
    const host = window.location.hostname;
    const secureOk = window.isSecureContext || host === 'localhost' || host === '127.0.0.1';
    if (!secureOk) {
      setLocMode('manual');
      setLocError('GPS needs HTTPS (or localhost). Use manual coordinates.');
      return;
    }
    setLocLoading(true);
    setLocError(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocation({ lat: pos.coords.latitude, lon: pos.coords.longitude });
        setLocLoading(false);
        setLocError(null);
      },
      (err) => {
        if (err.code === 1) {
          setLocMode('manual');
          setLocLoading(false);
          setLocError('Permission denied — enable location for this site or enter coordinates manually.');
          return;
        }
        retryLowAccuracy();
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: 5000 },
    );
  }, [locMode, retryLowAccuracy]);

  /** GPS only after the report step loads — permission prompt is in context. */
  useEffect(() => {
    if (step !== 'report' || locMode !== 'auto') return;
    requestLocation();
  }, [step, locMode, requestLocation]);

  const handlePhoto = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const dataUrl = ev.target.result;
      const base64 = dataUrl.split(',')[1];
      setPhoto({ base64, mimeType: file.type, preview: dataUrl });
    };
    reader.readAsDataURL(file);
  };

  const startVoice = () => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { alert('Voice not supported — try Chrome.'); return; }
    const rec = new SR();
    rec.continuous = false;
    rec.interimResults = true;
    rec.lang = 'en-US';
    rec.onstart = () => setListening(true);
    rec.onend = () => setListening(false);
    rec.onresult = (e) => {
      const t = Array.from(e.results).map((r) => r[0].transcript).join('');
      setNotes(t);
    };
    rec.onerror = () => setListening(false);
    recognitionRef.current = rec;
    rec.start();
  };

  const stopVoice = () => { recognitionRef.current?.stop(); setListening(false); };

  const handleSubmit = async (e) => {
    e.preventDefault();
    const lat = locMode === 'manual' ? parseFloat(manualLat) : location?.lat;
    const lon = locMode === 'manual'
      ? (manualLonHemisphere === 'E' ? Math.abs(parseFloat(manualLon)) : parseManualLongitudeWest(manualLon))
      : location?.lon;
    if (lat == null || lon == null || !Number.isFinite(lat) || !Number.isFinite(lon)) {
      alert('Location required — enter valid latitude and longitude.');
      return;
    }

    const reporterStructured = {
      waste_type: wasteType.trim(),
      size_category: sizeCategory.trim(),
      quantity_band: quantityBand.trim(),
      spread_layout: spreadLayout.trim(),
    };

    if (!photo && !structuredReportComplete(reporterStructured)) {
      alert(
        'Without a photo, please complete: type of waste, approximate size, and how much you see. '
        + 'That lets the AI reconcile intensity with your description.',
      );
      return;
    }

    setLoading(true);
    try {
      let analysis = photo
        ? await analyzeDebrisPhoto(photo.base64, photo.mimeType, lat, lon, notes, reporterStructured)
        : await analyzeDebrisText(notes, lat, lon, reporterStructured);

      if (photo && (notesLookSufficient(notes) || structuredReportComplete(reporterStructured))) {
        analysis = {
          ...analysis,
          needs_more_info: false,
          confidence: analysis.confidence === 'low' ? 'medium' : analysis.confidence,
        };
      }

      if (analysis.needs_more_info === true) {
        const proceed = window.confirm(
          'The AI could not fully verify details from this report (photo or notes may be vague).\n\n'
          + 'Are you sure you want to submit this sighting anyway?\n\n'
          + 'OK = save to the system. Cancel = go back and add more detail.',
        );
        if (!proceed) {
          setLoading(false);
          return;
        }
      }

      const drift = await predictDrift(lat, lon);

      const structuredSummary = structuredReportComplete(reporterStructured)
        ? `[Reporter: type=${reporterStructured.waste_type}; size=${reporterStructured.size_category}; amount=${reporterStructured.quantity_band}${reporterStructured.spread_layout ? `; spread=${reporterStructured.spread_layout}` : ''}]\n\n`
        : '';
      const intensityBlock = analysis.intensity_rationale
        ? `\n\nIntensity rating (${analysis.density_score}/10 — ${analysis.density_label}): ${analysis.intensity_rationale}`
        : '';
      const scaleBlock = (analysis.approximate_size && analysis.approximate_size !== 'unknown')
        || (analysis.quantity_estimate && analysis.quantity_estimate !== 'unknown')
        ? `\n\nScale summary — size: ${analysis.approximate_size}; quantity: ${analysis.quantity_estimate}; spread: ${analysis.spread || 'unknown'}`
        : '';
      const geminiAnalysisStored = [
        structuredSummary + analysis.gemini_analysis + scaleBlock + intensityBlock,
        notes.trim() && `Reporter notes: ${notes.trim()}`,
      ].filter(Boolean).join('\n\n');

      const { data: sighting, error } = await supabase
        .from('debris_sightings')
        .insert({
          reporter_name: name,
          latitude: lat,
          longitude: lon,
          debris_type: analysis.debris_type,
          density_score: analysis.density_score,
          density_label: analysis.density_label,
          estimated_volume: analysis.estimated_volume,
          gemini_analysis: geminiAnalysisStored,
          status: 'reported',
          jurisdiction: 'ClearMarine Operations',
          source_jurisdiction: 'public',
          handoff_status: 'none',
        })
        .select()
        .single();

      if (error) throw error;

      await supabase.from('drift_predictions').insert({
        sighting_id: sighting.id,
        lat_24h: drift.predictions[0].lat,
        lon_24h: drift.predictions[0].lon,
        lat_48h: drift.predictions[1].lat,
        lon_48h: drift.predictions[1].lon,
        lat_72h: drift.predictions[2].lat,
        lon_72h: drift.predictions[2].lon,
        current_speed: drift.speed,
        current_bearing: drift.bearing,
      });

      setResult({ analysis, drift, lat, lon });
      setStep('done');
    } catch (err) {
      console.error(err);
      alert(`Error: ${err.message || 'Submission failed — check console for details.'}`);
    } finally {
      setLoading(false);
    }
  };

  if (step === 'name') {
    return (
      <div className="min-h-screen naval-bg flex items-center justify-center p-4">
        <div className="glass rounded-2xl p-8 w-full max-w-md shadow-2xl slide-up">
          <div className="text-center mb-8">
            <div className="text-5xl mb-4">🌊</div>
            <h1 className="display text-4xl tracking-widest" style={{ color: 'var(--cyan-glow)', textShadow: '0 0 30px rgba(0,212,255,0.4)' }}>CLEARMARINE</h1>
            <p className="mono text-xs mt-2 tracking-widest" style={{ color: 'var(--text-secondary)' }}>OCEAN DEBRIS FIELD REPORT SYSTEM</p>
          </div>
          <form onSubmit={(e) => { e.preventDefault(); if (name.trim()) setStep('report'); }} className="space-y-4">
            <div>
              <label className="block mono text-xs font-bold mb-2 tracking-widest" style={{ color: 'var(--text-secondary)' }}>REPORTER ID / VESSEL CALL SIGN</label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Patrol Officer Chen / MV Seabird"
                className="w-full rounded-xl px-4 py-3 text-sm focus:outline-none mono"
                style={{ background: 'var(--navy-deep)', border: '1px solid var(--navy-border)', color: 'var(--text-primary)' }}
                onFocus={e => e.target.style.borderColor = 'var(--cyan-glow)'}
                onBlur={e => e.target.style.borderColor = 'var(--navy-border)'}
                autoFocus
              />
            </div>
            <button type="submit" className="w-full mono font-bold py-3 rounded-xl transition-colors tracking-widest"
              style={{ background: 'rgba(0,212,255,0.12)', border: '1px solid var(--cyan-glow)', color: 'var(--cyan-glow)' }}>
              INITIATE REPORT →
            </button>
          </form>
          <div className="mt-6 pt-4 text-center" style={{ borderTop: '1px solid var(--navy-border)' }}>
            <a href="/dashboard" className="mono text-[10px] tracking-widest transition-colors" style={{ color: 'var(--text-dim)' }}>
              COORDINATOR ACCESS → DASHBOARD
            </a>
          </div>
        </div>
      </div>
    );
  }

  if (step === 'done' && result) {
    const dLabel = result.analysis.density_label;
    const densityStyle = dLabel === 'Critical'
      ? { background: 'rgba(239,68,68,0.15)', border: '1px solid var(--red-crit)', color: 'var(--red-crit)' }
      : dLabel === 'Dense'
        ? { background: 'rgba(245,158,11,0.15)', border: '1px solid var(--amber)', color: 'var(--amber)' }
        : dLabel === 'Moderate'
          ? { background: 'rgba(245,158,11,0.1)', border: '1px solid rgba(245,158,11,0.5)', color: '#fbbf24' }
          : { background: 'rgba(16,185,129,0.1)', border: '1px solid var(--green-ok)', color: 'var(--green-ok)' };

    return (
      <div className="min-h-screen naval-bg flex flex-col items-center justify-center p-4">
        <div className="glass rounded-2xl p-6 w-full max-w-md shadow-2xl slide-up">
          <div className="text-center mb-5">
            <div className="text-4xl mb-3">✦</div>
            <h2 className="display text-3xl tracking-widest" style={{ color: 'var(--green-ok)' }}>SIGHTING LOGGED</h2>
            <p className="mono text-xs mt-1 tracking-widest" style={{ color: 'var(--text-secondary)' }}>FIELD REPORT TRANSMITTED TO COMMAND</p>
          </div>

          <div className="rounded-xl p-4 mb-4 space-y-3" style={{ background: 'var(--navy-surface)', border: '1px solid var(--navy-border)' }}>
            <div className="flex items-center gap-2 flex-wrap">
              <span className="mono text-xs font-bold px-2 py-0.5 rounded" style={densityStyle}>
                {result.analysis.density_label} — {result.analysis.density_score}/10
              </span>
              <span className="mono text-xs px-2 py-0.5 rounded capitalize" style={{ background: 'var(--navy-deep)', border: '1px solid var(--navy-border)', color: 'var(--text-secondary)' }}>
                {result.analysis.debris_type.replace('_', ' ')}
              </span>
              {result.analysis.estimated_volume !== 'unknown' && (
                <span className="mono text-xs" style={{ color: 'var(--text-secondary)' }}>{result.analysis.estimated_volume}</span>
              )}
            </div>
            {(result.analysis.approximate_size || result.analysis.quantity_estimate) && (
              <p className="mono text-xs" style={{ color: 'var(--text-secondary)' }}>
                Scale: {result.analysis.approximate_size}
                {result.analysis.quantity_estimate ? ` · ${result.analysis.quantity_estimate}` : ''}
                {result.analysis.spread && result.analysis.spread !== 'unknown'
                  ? ` · ${String(result.analysis.spread).replace(/_/g, ' ')}`
                  : ''}
              </p>
            )}
            {result.analysis.intensity_rationale && (
              <p className="text-xs italic leading-snug pl-2" style={{ borderLeft: '2px solid var(--cyan-glow)', color: 'var(--text-secondary)' }}>
                {result.analysis.intensity_rationale}
              </p>
            )}
            {result.analysis.severity_assessment && (
              <div className="rounded-lg p-3 space-y-2" style={{ background: 'var(--navy-deep)', border: '1px solid rgba(0,212,255,0.2)' }}>
                <p className="mono text-[10px] tracking-widest" style={{ color: 'var(--cyan-glow)' }}>RECONCILED RISK · CV + AI HYPOTHESIS</p>
                <div className="flex flex-wrap items-center gap-2 text-xs mono">
                  <span style={{ color: 'var(--text-primary)' }}>
                    Severity <span style={{ color: 'var(--cyan-glow)' }}>{result.analysis.severity_assessment.severity}/10</span>
                  </span>
                  <span style={{ color: 'var(--text-dim)' }}>·</span>
                  <span style={{ color: 'var(--text-secondary)' }}>
                    conf <span style={{ color: 'var(--text-primary)' }}>{result.analysis.severity_assessment.confidence ?? '—'}</span>
                  </span>
                  {result.analysis.severity_assessment.agreement_level && (
                    <span className="px-1.5 py-0.5 rounded text-[10px] font-bold uppercase" style={
                      result.analysis.severity_assessment.agreement_level === 'high'
                        ? { background: 'rgba(16,185,129,0.15)', color: 'var(--green-ok)' }
                        : result.analysis.severity_assessment.agreement_level === 'low'
                          ? { background: 'rgba(245,158,11,0.15)', color: 'var(--amber)' }
                          : { background: 'var(--navy-surface)', color: 'var(--text-secondary)' }
                    }>
                      {result.analysis.severity_assessment.agreement_level}
                    </span>
                  )}
                </div>
                {result.analysis.severity_assessment.final_objects?.length > 0 && (
                  <ul className="mono text-[11px] space-y-0.5" style={{ color: 'var(--text-secondary)' }}>
                    {result.analysis.severity_assessment.final_objects.map((o, i) => (
                      <li key={i}>
                        <span style={{ color: 'var(--cyan-glow)' }}>{o.role || '?'}</span>{' '}
                        {o.label || '—'}{' '}
                        <span style={{ color: 'var(--text-dim)' }}>({o.source || '?'})</span>
                      </li>
                    ))}
                  </ul>
                )}
                {result.analysis.severity_assessment.key_factors?.length > 0 && (
                  <ul className="text-[11px] list-disc list-inside space-y-0.5" style={{ color: 'var(--text-secondary)' }}>
                    {result.analysis.severity_assessment.key_factors.map((f, i) => <li key={i}>{f}</li>)}
                  </ul>
                )}
                {result.analysis.severity_assessment.conflicts?.length > 0 && (
                  <div className="pt-2 mt-1" style={{ borderTop: '1px solid var(--navy-border)' }}>
                    <p className="mono text-[10px] tracking-widest mb-1" style={{ color: 'var(--amber)' }}>CONFLICTS & RESOLUTION</p>
                    <ul className="text-[11px] space-y-1" style={{ color: 'var(--text-secondary)' }}>
                      {result.analysis.severity_assessment.conflicts.map((c, i) => (
                        <li key={i}><span style={{ color: 'var(--text-primary)' }}>{c.topic}</span>{c.resolution ? <span style={{ color: 'var(--text-dim)' }}> → {c.resolution}</span> : null}</li>
                      ))}
                    </ul>
                  </div>
                )}
                {result.analysis.pipeline_evidence?.detection && (() => {
                  const det = result.analysis.pipeline_evidence.detection;
                  const ac = det.animals?.length ?? 0;
                  const dc = det.debris?.length ?? 0;
                  const empty = ac === 0 && dc === 0;
                  return (
                    <p className="mono text-[10px] leading-relaxed" style={{ color: empty ? 'var(--amber)' : 'var(--text-dim)' }}>
                      {empty
                        ? `CV (${det.detector}): no objects detected above threshold — density from structured report / LLM text.`
                        : `CV: ${det.detector} · animals ${ac}, debris ${dc}`}
                    </p>
                  );
                })()}
              </div>
            )}
            <p className="text-sm leading-relaxed" style={{ color: 'var(--text-secondary)' }}>{result.analysis.gemini_analysis}</p>
          </div>

          <div className="rounded-xl p-4 mb-4" style={{ background: 'var(--navy-deep)', border: '1px solid var(--navy-border)' }}>
            <p className="mono text-[10px] tracking-widest mb-3" style={{ color: 'var(--cyan-glow)' }}>PREDICTED DRIFT PATH</p>
            <div className="space-y-1.5">
              {result.drift.predictions.map((p) => (
                <div key={p.hours} className="flex items-center justify-between text-xs">
                  <span className="mono" style={{ color: 'var(--text-dim)' }}>+{p.hours}h</span>
                  <span className="mono" style={{ color: 'var(--cyan-glow)' }}>{formatCoordPair(p.lat, p.lon)}</span>
                </div>
              ))}
            </div>
            <p className="mono text-xs mt-3" style={{ color: 'var(--text-dim)' }}>
              {result.drift.speed.toFixed(2)} kts · {result.drift.bearing.toFixed(0)}° · {result.drift.source}
            </p>
          </div>

          <button
            onClick={() => {
              setStep('name');
              setName('');
              setPhoto(null);
              setNotes('');
              setWasteType('');
              setSizeCategory('');
              setQuantityBand('');
              setSpreadLayout('');
              setResult(null);
              setLocation(null);
              setLocError(null);
              setLocLoading(false);
              setManualLat('');
              setManualLon('');
              setManualLonHemisphere('W');
            }}
            className="w-full mono font-bold py-3 rounded-xl transition-colors tracking-widest text-sm"
            style={{ background: 'rgba(0,212,255,0.08)', border: '1px solid var(--navy-border)', color: 'var(--text-secondary)' }}
            onMouseEnter={e => { e.target.style.borderColor = 'var(--cyan-glow)'; e.target.style.color = 'var(--cyan-glow)'; }}
            onMouseLeave={e => { e.target.style.borderColor = 'var(--navy-border)'; e.target.style.color = 'var(--text-secondary)'; }}
          >
            ← NEW REPORT
          </button>
        </div>
      </div>
    );
  }

  const selectStyle = {
    background: 'var(--navy-deep)',
    border: '1px solid var(--navy-border)',
    color: 'var(--text-primary)',
    borderRadius: '0.75rem',
    padding: '0.625rem 0.75rem',
    fontSize: '0.875rem',
    width: '100%',
    outline: 'none',
  };

  const inputStyle = {
    background: 'var(--navy-deep)',
    border: '1px solid var(--navy-border)',
    color: 'var(--text-primary)',
    borderRadius: '0.75rem',
    padding: '0.625rem 0.75rem',
    fontSize: '0.875rem',
    outline: 'none',
  };

  return (
    <div className="min-h-screen naval-bg" style={{ color: 'var(--text-primary)' }}>
      <header className="px-4 py-3 flex items-center gap-3" style={{ background: 'rgba(2,12,27,0.9)', borderBottom: '1px solid var(--navy-border)', backdropFilter: 'blur(12px)' }}>
        <span className="text-2xl">🌊</span>
        <div>
          <h1 className="display text-xl tracking-widest" style={{ color: 'var(--cyan-glow)' }}>CLEARMARINE</h1>
          <p className="mono text-[10px] tracking-widest" style={{ color: 'var(--text-secondary)' }}>REPORTER: {name.toUpperCase()}</p>
        </div>
        <div className="ml-auto flex items-center gap-1.5">
          <div className="w-2 h-2 rounded-full live-dot" style={{ background: 'var(--cyan-glow)' }} />
          <span className="mono text-xs" style={{ color: 'var(--cyan-glow)' }}>LIVE</span>
        </div>
      </header>

      <form onSubmit={handleSubmit} className="max-w-lg mx-auto p-4 space-y-4">
        {/* Photo upload */}
        <div className="glass rounded-2xl p-4">
          <div className="flex items-start justify-between gap-2 mb-3">
            <p className="mono text-xs font-bold tracking-widest" style={{ color: 'var(--text-secondary)' }}>DEBRIS PHOTO <span style={{ color: 'var(--text-dim)' }}>(OPTIONAL)</span></p>
          </div>
          {photo ? (
            <div className="relative">
              <img src={photo.preview} alt="Debris" className="w-full h-48 object-cover rounded-xl" />
              <button
                type="button"
                onClick={() => setPhoto(null)}
                className="absolute top-2 right-2 mono text-xs px-2 py-1 rounded-lg"
                style={{ background: 'rgba(2,12,27,0.85)', border: '1px solid var(--navy-border)', color: 'var(--text-secondary)' }}
              >
                REMOVE
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => fileRef.current.click()}
              className="w-full h-36 rounded-xl flex flex-col items-center justify-center gap-2 transition-colors"
              style={{ border: '2px dashed var(--navy-border)' }}
              onMouseEnter={e => e.currentTarget.style.borderColor = 'var(--cyan-glow)'}
              onMouseLeave={e => e.currentTarget.style.borderColor = 'var(--navy-border)'}
            >
              <span className="text-3xl">📷</span>
              <span className="mono text-xs tracking-widest" style={{ color: 'var(--text-secondary)' }}>TAP TO UPLOAD / CAPTURE</span>
              <span className="mono text-[10px]" style={{ color: 'var(--text-dim)' }}>JPG · PNG · HEIC</span>
            </button>
          )}
          <input ref={fileRef} type="file" accept="image/*" capture="environment" onChange={handlePhoto} className="hidden" />
          <p className="mono text-[10px] mt-2 leading-snug" style={{ color: 'var(--text-dim)' }}>
            No photo — complete sighting details below (type, size, amount required).
          </p>
        </div>

        {/* Structured sighting details */}
        <div className="glass rounded-2xl p-4 space-y-3">
          <p className="mono text-xs font-bold tracking-widest" style={{ color: 'var(--text-secondary)' }}>SIGHTING DETAILS</p>
          <p className="mono text-[10px] leading-snug" style={{ color: 'var(--text-dim)' }}>
            These fields drive AI assessment · required without photo
          </p>
          {[
            { label: 'TYPE OF WASTE', value: wasteType, setter: setWasteType, opts: WASTE_TYPE_OPTIONS, placeholder: 'Select…' },
            { label: 'APPROXIMATE SIZE', value: sizeCategory, setter: setSizeCategory, opts: SIZE_OPTIONS, placeholder: 'Select…' },
            { label: 'HOW MUCH / HOW MANY', value: quantityBand, setter: setQuantityBand, opts: QUANTITY_OPTIONS, placeholder: 'Select…' },
          ].map(({ label, value, setter, opts, placeholder }) => (
            <div key={label}>
              <label className="block mono text-[10px] font-bold mb-1.5 tracking-widest" style={{ color: 'var(--text-secondary)' }}>{label}</label>
              <select value={value} onChange={(e) => setter(e.target.value)} style={selectStyle}>
                <option value="">{placeholder}</option>
                {opts.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>
          ))}
          <div>
            <label className="block mono text-[10px] font-bold mb-1.5 tracking-widest" style={{ color: 'var(--text-secondary)' }}>
              SPREAD PATTERN <span style={{ color: 'var(--text-dim)' }}>(OPTIONAL)</span>
            </label>
            <select value={spreadLayout} onChange={(e) => setSpreadLayout(e.target.value)} style={selectStyle}>
              {SPREAD_OPTIONS.map((o) => <option key={o.value || 'skip'} value={o.value}>{o.label}</option>)}
            </select>
          </div>
        </div>

        {/* Location */}
        <div className="glass rounded-2xl p-4">
          <div className="flex items-center justify-between mb-3">
            <p className="mono text-xs font-bold tracking-widest" style={{ color: 'var(--text-secondary)' }}>POSITION FIX</p>
            <div className="flex gap-1">
              {[['auto', 'AUTO GPS'], ['manual', 'MANUAL']].map(([mode, lbl]) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => {
                    if (mode === 'auto') {
                      setLocMode('auto'); setLocError(null); setLocation(null);
                      queueMicrotask(() => { if (step === 'report') requestLocation(); });
                    } else {
                      setLocMode('manual'); setLocError(null);
                    }
                  }}
                  className="mono text-[10px] px-2.5 py-1 rounded-lg transition-colors tracking-widest"
                  style={locMode === mode
                    ? { background: 'rgba(0,212,255,0.15)', border: '1px solid var(--cyan-glow)', color: 'var(--cyan-glow)' }
                    : { background: 'var(--navy-surface)', border: '1px solid var(--navy-border)', color: 'var(--text-dim)' }}
                >
                  {lbl}
                </button>
              ))}
            </div>
          </div>
          {locMode === 'auto' ? (
            location ? (
              <p className="mono text-sm" style={{ color: 'var(--cyan-glow)' }}>{formatCoordPair(location.lat, location.lon)} ✓</p>
            ) : locError && !locLoading ? (
              <div className="space-y-2">
                <p className="mono text-xs" style={{ color: 'var(--amber)' }}>{locError}</p>
                <div className="flex gap-2">
                  <button type="button" onClick={() => requestLocation()} className="mono text-xs px-3 py-1.5 rounded-lg" style={{ background: 'rgba(0,212,255,0.1)', border: '1px solid var(--cyan-glow)', color: 'var(--cyan-glow)' }}>RETRY GPS</button>
                  <button type="button" onClick={() => { setLocMode('manual'); setLocError(null); }} className="mono text-xs px-3 py-1.5 rounded-lg" style={{ background: 'var(--navy-surface)', border: '1px solid var(--navy-border)', color: 'var(--text-secondary)' }}>MANUAL</button>
                </div>
              </div>
            ) : (
              <p className="mono text-xs glow-pulse" style={{ color: 'var(--text-secondary)' }}>ACQUIRING POSITION…</p>
            )
          ) : (
            <div className="space-y-2">
              <div className="flex gap-2">
                <input
                  type="number" step="any" value={manualLat} onChange={(e) => setManualLat(e.target.value)}
                  placeholder="Lat (34.05)" className="flex-1"
                  style={{ ...inputStyle, width: undefined }}
                  onFocus={e => e.target.style.borderColor = 'var(--cyan-glow)'}
                  onBlur={e => e.target.style.borderColor = 'var(--navy-border)'}
                />
                <div className="flex flex-1 gap-1 min-w-0">
                  <input
                    type="number" step="any" value={manualLon} onChange={(e) => setManualLon(e.target.value)}
                    placeholder="Lon (120.4)" className="min-w-0 flex-1"
                    style={{ ...inputStyle, width: undefined }}
                    onFocus={e => e.target.style.borderColor = 'var(--cyan-glow)'}
                    onBlur={e => e.target.style.borderColor = 'var(--navy-border)'}
                  />
                  <select
                    value={manualLonHemisphere} onChange={(e) => setManualLonHemisphere(e.target.value)}
                    style={{ ...inputStyle, width: undefined, padding: '0.625rem 0.5rem' }}
                    title="Hemisphere"
                  >
                    <option value="W">W</option>
                    <option value="E">E</option>
                  </select>
                </div>
              </div>
              <p className="mono text-[10px] leading-snug" style={{ color: 'var(--text-dim)' }}>
                US West Coast: enter magnitude + W (e.g. 120.4 W). Signed value overrides hemisphere.
              </p>
            </div>
          )}
        </div>

        {/* Voice / text notes */}
        <div className="glass rounded-2xl p-4">
          <div className="flex items-center justify-between mb-3">
            <p className="mono text-xs font-bold tracking-widest" style={{ color: 'var(--text-secondary)' }}>
              FIELD NOTES <span style={{ color: 'var(--text-dim)' }}>(OPTIONAL)</span>
            </p>
            <button
              type="button"
              onClick={listening ? stopVoice : startVoice}
              className="mono flex items-center gap-1.5 text-[10px] px-3 py-1.5 rounded-lg transition-colors tracking-widest"
              style={listening
                ? { background: 'rgba(239,68,68,0.15)', border: '1px solid var(--red-crit)', color: 'var(--red-crit)' }
                : { background: 'var(--navy-surface)', border: '1px solid var(--navy-border)', color: 'var(--text-secondary)' }}
            >
              🎤 {listening ? 'STOP' : 'VOICE'}
            </button>
          </div>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Landmarks, wildlife, smell/sheen, time observed…"
            rows={3}
            className="w-full text-sm resize-none focus:outline-none"
            style={{ ...inputStyle, width: '100%' }}
            onFocus={e => e.target.style.borderColor = 'var(--cyan-glow)'}
            onBlur={e => e.target.style.borderColor = 'var(--navy-border)'}
          />
          {listening && <p className="mono text-[10px] mt-1 glow-pulse" style={{ color: 'var(--red-crit)' }}>● LISTENING…</p>}
        </div>

        <button
          type="submit"
          disabled={loading || (locMode === 'auto' && !location)}
          className="w-full display text-xl tracking-widest py-4 rounded-xl transition-colors disabled:opacity-40"
          style={{ background: loading ? 'rgba(0,212,255,0.08)' : 'rgba(0,212,255,0.12)', border: '1px solid var(--cyan-glow)', color: 'var(--cyan-glow)' }}
        >
          {loading ? 'PROCESSING REPORT…' : 'TRANSMIT SIGHTING →'}
        </button>
      </form>
    </div>
  );
}
