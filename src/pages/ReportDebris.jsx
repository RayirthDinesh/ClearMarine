import { useState, useRef, useEffect, useCallback } from 'react';
import {
  analyzeDebrisPhoto,
  analyzeDebrisText,
  notesLookSufficient,
  structuredReportComplete,
} from '../lib/gemini';
import { supabase } from '../lib/supabase';
import { predictDrift } from '../lib/drift';
import { formatCoordPair, parseManualLongitude } from '../lib/coords';

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
      ? parseManualLongitude(manualLon, manualLonHemisphere === 'E' ? 'E' : 'W')
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

  const densityColor = (label) => {
    if (label === 'Unverified') return 'bg-slate-600 text-slate-100';
    if (label === 'Critical') return 'bg-red-600 text-white';
    if (label === 'Dense') return 'bg-orange-500 text-white';
    if (label === 'Moderate') return 'bg-yellow-500 text-black';
    return 'bg-green-600 text-white';
  };

  if (step === 'name') {
    return (
      <div className="min-h-screen bg-slate-900 flex items-center justify-center p-4">
        <div className="bg-slate-800 rounded-2xl p-8 w-full max-w-md shadow-2xl border border-slate-700">
          <div className="text-center mb-6">
            <div className="text-5xl mb-3">🌊</div>
            <h1 className="text-2xl font-bold text-white">ClearMarine</h1>
            <p className="text-slate-400 mt-1 text-sm">Ocean Debris Reporting System</p>
          </div>
          <form onSubmit={(e) => { e.preventDefault(); if (name.trim()) setStep('report'); }} className="space-y-4">
            <div>
              <label className="block text-slate-300 text-sm font-medium mb-2">Your name or vessel ID</label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Patrol Officer Chen / MV Seabird"
                className="w-full bg-slate-700 text-white placeholder-slate-400 rounded-xl px-4 py-3 focus:outline-none focus:ring-2 focus:ring-cyan-500"
                autoFocus
              />
            </div>
            <button type="submit" className="w-full bg-cyan-600 hover:bg-cyan-700 text-white font-semibold py-3 rounded-xl transition-colors">
              Report Debris Sighting
            </button>
          </form>
          <div className="mt-4 pt-4 border-t border-slate-700 text-center">
            <a href="/dashboard" className="text-slate-500 text-xs hover:text-slate-300 transition-colors">
              Coordinator? Go to Dashboard →
            </a>
          </div>
        </div>
      </div>
    );
  }

  if (step === 'done' && result) {
    return (
      <div className="min-h-screen bg-slate-900 flex flex-col items-center justify-center p-4">
        <div className="bg-slate-800 rounded-2xl p-6 w-full max-w-md border border-slate-700 shadow-2xl">
          <div className="text-center mb-4">
            <div className="text-4xl mb-2">✅</div>
            <h2 className="text-white font-bold text-xl">Sighting Reported</h2>
            <p className="text-slate-400 text-sm">Cleanup crews have been notified</p>
          </div>

          <div className="bg-slate-700 rounded-xl p-4 mb-4 space-y-2">
            <div className="flex items-center gap-2 flex-wrap">
              <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${densityColor(result.analysis.density_label)}`}>
                {result.analysis.density_label} — {result.analysis.density_score}/10
              </span>
              <span className="text-xs bg-slate-600 text-slate-200 px-2 py-0.5 rounded-full capitalize">
                {result.analysis.debris_type.replace('_', ' ')}
              </span>
              <span className="text-xs text-slate-400">
                {result.analysis.estimated_volume === 'unknown' ? 'Volume not estimated' : result.analysis.estimated_volume}
              </span>
            </div>
            {(result.analysis.approximate_size || result.analysis.quantity_estimate) && (
              <p className="text-slate-400 text-xs">
                Scale (reconciled): {result.analysis.approximate_size}
                {result.analysis.quantity_estimate ? ` · ${result.analysis.quantity_estimate}` : ''}
                {result.analysis.spread && result.analysis.spread !== 'unknown'
                  ? ` · ${String(result.analysis.spread).replace(/_/g, ' ')}`
                  : ''}
              </p>
            )}
            {result.analysis.intensity_rationale ? (
              <p className="text-slate-400 text-xs italic border-l-2 border-cyan-600 pl-2 mt-1">
                Why this rating: {result.analysis.intensity_rationale}
              </p>
            ) : null}
            {result.analysis.severity_assessment && (
              <div className="rounded-lg border border-cyan-800/60 bg-slate-900/90 p-3 space-y-2">
                <p className="text-cyan-400 text-[10px] font-semibold uppercase tracking-wider">Reconciled risk (CV + expert hypothesis)</p>
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <span className="text-slate-300">
                    Severity <span className="text-white font-mono">{result.analysis.severity_assessment.severity}/10</span>
                  </span>
                  <span className="text-slate-500">·</span>
                  <span className="text-slate-300">
                    confidence <span className="text-white font-mono">{result.analysis.severity_assessment.confidence ?? '—'}</span>
                  </span>
                  {result.analysis.severity_assessment.agreement_level && (
                    <>
                      <span className="text-slate-500">·</span>
                      <span
                        className={`px-1.5 py-0.5 rounded text-[10px] font-medium uppercase ${
                          result.analysis.severity_assessment.agreement_level === 'high'
                            ? 'bg-emerald-900/80 text-emerald-200'
                            : result.analysis.severity_assessment.agreement_level === 'low'
                              ? 'bg-amber-900/80 text-amber-200'
                              : 'bg-slate-700 text-slate-200'
                        }`}
                      >
                        agreement: {result.analysis.severity_assessment.agreement_level}
                      </span>
                    </>
                  )}
                </div>
                {result.analysis.severity_assessment.final_objects?.length > 0 && (
                  <div>
                    <p className="text-slate-500 text-[10px] uppercase tracking-wider mb-1">Final objects (reconciled)</p>
                    <ul className="text-slate-300 text-[11px] space-y-0.5 font-mono">
                      {result.analysis.severity_assessment.final_objects.map((o, i) => (
                        <li key={i}>
                          <span className="text-cyan-500/90">{o.role || '?'}</span>{' '}
                          {o.label || '—'}{' '}
                          <span className="text-slate-500">({o.source || '?'})</span>
                          {o.detail ? <span className="text-slate-500"> — {o.detail}</span> : null}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {result.analysis.severity_assessment.key_factors?.length > 0 && (
                  <ul className="text-slate-400 text-[11px] list-disc list-inside space-y-0.5">
                    {result.analysis.severity_assessment.key_factors.map((f, i) => (
                      <li key={i}>{f}</li>
                    ))}
                  </ul>
                )}
                {result.analysis.severity_assessment.conflicts?.length > 0 && (
                  <div className="border-t border-slate-700 pt-2 mt-1">
                    <p className="text-amber-400/90 text-[10px] font-semibold uppercase tracking-wider mb-1">Conflicts & resolution</p>
                    <ul className="text-slate-400 text-[11px] space-y-1">
                      {result.analysis.severity_assessment.conflicts.map((c, i) => (
                        <li key={i}>
                          <span className="text-slate-300">{c.topic}</span>
                          {c.resolution ? (
                            <span className="text-slate-500"> → {c.resolution}</span>
                          ) : null}
                        </li>
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
                    <p className={`text-[10px] font-mono leading-relaxed ${empty ? 'text-amber-300/90' : 'text-slate-500'}`}>
                      {empty ? (
                        <>
                          Object detector ({det.detector}): <strong>no bbox hits</strong> (0 animals, 0 debris above
                          confidence threshold). Dense rating here comes from your structured report / LLM text — not
                          from counted objects in the image.
                        </>
                      ) : (
                        <>
                          Raw CV: {det.detector} · animals {ac}, debris {dc}
                          {result.analysis.pipeline_evidence.geo?.protected_area ? ' · illustrative protected-area flag' : ''}
                        </>
                      )}
                    </p>
                  );
                })()}
              </div>
            )}
            <p className="text-slate-300 text-sm leading-relaxed">{result.analysis.gemini_analysis}</p>
          </div>

          <div className="bg-slate-900 rounded-xl p-4 mb-4">
            <p className="text-slate-400 text-xs mb-2 font-medium uppercase tracking-wider">Predicted Drift Path</p>
            <div className="space-y-1.5">
              {result.drift.predictions.map((p) => (
                <div key={p.hours} className="flex items-center justify-between text-xs">
                  <span className="text-slate-400">+{p.hours}h</span>
                  <span className="text-cyan-400 font-mono">{formatCoordPair(p.lat, p.lon)}</span>
                </div>
              ))}
            </div>
            <p className="text-slate-500 text-xs mt-2">
              Current: {result.drift.speed.toFixed(2)} knots at {result.drift.bearing.toFixed(0)}°
            </p>
            <p className={`text-xs mt-1 leading-snug ${result.drift.source.includes('Spray') ? 'text-emerald-400 font-medium' : 'text-slate-500'}`}>
              Drift driver: {result.drift.source}
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
            className="w-full bg-slate-700 hover:bg-slate-600 text-slate-200 font-medium py-3 rounded-xl transition-colors text-sm"
          >
            ← Report Another Sighting
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-900 text-white">
      <header className="bg-slate-800 border-b border-slate-700 px-4 py-3 flex items-center gap-3">
        <span className="text-2xl">🌊</span>
        <div>
          <h1 className="text-white font-bold">ClearMarine — Report Sighting</h1>
          <p className="text-slate-400 text-xs">Reporter: {name}</p>
        </div>
        <div className="ml-auto flex items-center gap-1.5">
          <div className="w-2 h-2 bg-cyan-400 rounded-full animate-pulse" />
          <span className="text-cyan-400 text-xs">Live</span>
        </div>
      </header>

      <form onSubmit={handleSubmit} className="max-w-lg mx-auto p-4 space-y-4">
        {/* Photo upload */}
        <div className="bg-slate-800 rounded-2xl p-4 border border-slate-700">
          <div className="flex items-start justify-between gap-2 mb-3">
            <p className="text-slate-300 text-sm font-medium">Debris Photo</p>
            <p className="text-slate-500 text-[10px] text-right max-w-[240px] leading-snug">
              Your form + notes lead; CV JSON adds hints. If COCO finds nothing, Gemini may read the photo once (when API key set). Groq only sees JSON.
            </p>
          </div>
          {photo ? (
            <div className="relative">
              <img src={photo.preview} alt="Debris" className="w-full h-48 object-cover rounded-xl" />
              <button
                type="button"
                onClick={() => setPhoto(null)}
                className="absolute top-2 right-2 bg-slate-900 bg-opacity-80 text-white text-xs px-2 py-1 rounded-lg"
              >
                Remove
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => fileRef.current.click()}
              className="w-full h-40 border-2 border-dashed border-slate-600 rounded-xl flex flex-col items-center justify-center gap-2 hover:border-cyan-500 transition-colors"
            >
              <span className="text-3xl">📷</span>
              <span className="text-slate-400 text-sm">Tap to upload or take photo</span>
              <span className="text-slate-600 text-xs">JPG, PNG, HEIC supported</span>
            </button>
          )}
          <input ref={fileRef} type="file" accept="image/*" capture="environment" onChange={handlePhoto} className="hidden" />
          <p className="text-slate-500 text-xs mt-2">
            No photo? Complete &quot;What you saw&quot; below — type, size, and amount are required for a text-only report.
          </p>
        </div>

        {/* Structured sighting details (friend: dropdowns for LLM scale / importance) */}
        <div className="bg-slate-800 rounded-2xl p-4 border border-slate-700 space-y-3">
          <p className="text-slate-300 text-sm font-medium">What you saw</p>
          <p className="text-slate-500 text-xs leading-snug">
            These fields drive the AI assessment first; CV refines when it recognizes objects. Required if you are not attaching a photo.
          </p>
          <div>
            <label className="block text-slate-400 text-xs font-medium mb-1">Type of waste</label>
            <select
              value={wasteType}
              onChange={(e) => setWasteType(e.target.value)}
              className="w-full bg-slate-700 text-white rounded-xl px-3 py-2.5 text-sm border border-slate-600 focus:outline-none focus:ring-2 focus:ring-cyan-500"
            >
              <option value="">Select…</option>
              {WASTE_TYPE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-slate-400 text-xs font-medium mb-1">Approximate size (biggest dimension or overall pile)</label>
            <select
              value={sizeCategory}
              onChange={(e) => setSizeCategory(e.target.value)}
              className="w-full bg-slate-700 text-white rounded-xl px-3 py-2.5 text-sm border border-slate-600 focus:outline-none focus:ring-2 focus:ring-cyan-500"
            >
              <option value="">Select…</option>
              {SIZE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-slate-400 text-xs font-medium mb-1">How much / how many</label>
            <select
              value={quantityBand}
              onChange={(e) => setQuantityBand(e.target.value)}
              className="w-full bg-slate-700 text-white rounded-xl px-3 py-2.5 text-sm border border-slate-600 focus:outline-none focus:ring-2 focus:ring-cyan-500"
            >
              <option value="">Select…</option>
              {QUANTITY_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-slate-400 text-xs font-medium mb-1">How it is spread <span className="text-slate-600">(optional)</span></label>
            <select
              value={spreadLayout}
              onChange={(e) => setSpreadLayout(e.target.value)}
              className="w-full bg-slate-700 text-white rounded-xl px-3 py-2.5 text-sm border border-slate-600 focus:outline-none focus:ring-2 focus:ring-cyan-500"
            >
              {SPREAD_OPTIONS.map((o) => (
                <option key={o.value || 'skip'} value={o.value}>{o.label}</option>
              ))}
            </select>
          </div>
        </div>

        {/* Location */}
        <div className="bg-slate-800 rounded-2xl p-4 border border-slate-700">
          <div className="flex items-center justify-between mb-3">
            <p className="text-slate-300 text-sm font-medium">Location</p>
            <div className="flex gap-1">
              <button
                type="button"
                onClick={() => {
                  setLocMode('auto');
                  setLocError(null);
                  setLocation(null);
                  queueMicrotask(() => {
                    if (step === 'report') requestLocation();
                  });
                }}
                className={`text-xs px-2.5 py-1 rounded-lg transition-colors ${locMode === 'auto' ? 'bg-cyan-700 text-white' : 'bg-slate-700 text-slate-400'}`}
              >
                Auto GPS
              </button>
              <button
                type="button"
                onClick={() => {
                  setLocMode('manual');
                  setLocError(null);
                }}
                className={`text-xs px-2.5 py-1 rounded-lg transition-colors ${locMode === 'manual' ? 'bg-cyan-700 text-white' : 'bg-slate-700 text-slate-400'}`}
              >
                Manual
              </button>
            </div>
          </div>
          {locMode === 'auto' ? (
            location ? (
              <p className="text-cyan-400 text-sm font-mono">
                {formatCoordPair(location.lat, location.lon)} ✓
              </p>
            ) : locError && !locLoading ? (
              <div className="space-y-2">
                <p className="text-amber-400/90 text-sm">{locError}</p>
                <div className="flex gap-2 flex-wrap">
                  <button
                    type="button"
                    onClick={() => requestLocation()}
                    className="text-xs px-3 py-1.5 rounded-lg bg-cyan-800 hover:bg-cyan-700 text-white"
                  >
                    Retry GPS
                  </button>
                  <button
                    type="button"
                    onClick={() => { setLocMode('manual'); setLocError(null); }}
                    className="text-xs px-3 py-1.5 rounded-lg bg-slate-700 hover:bg-slate-600 text-slate-200"
                  >
                    Enter manually
                  </button>
                </div>
              </div>
            ) : (
              <p className="text-slate-400 text-sm">Getting your location…</p>
            )
          ) : (
            <div className="space-y-2">
              <div className="flex gap-2">
                <input
                  type="number"
                  step="any"
                  value={manualLat}
                  onChange={(e) => setManualLat(e.target.value)}
                  placeholder="Latitude (e.g. 34.05)"
                  className="flex-1 bg-slate-700 text-white placeholder-slate-500 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-cyan-500"
                />
                <div className="flex flex-1 gap-1 min-w-0">
                  <input
                    type="number"
                    step="any"
                    value={manualLon}
                    onChange={(e) => setManualLon(e.target.value)}
                    placeholder="Longitude (e.g. 120.4)"
                    className="min-w-0 flex-1 bg-slate-700 text-white placeholder-slate-500 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-cyan-500"
                  />
                  <select
                    value={manualLonHemisphere}
                    onChange={(e) => setManualLonHemisphere(e.target.value)}
                    className="shrink-0 bg-slate-700 text-white rounded-xl px-2 py-2 text-sm border border-slate-600 focus:outline-none focus:ring-2 focus:ring-cyan-500"
                    title="East or West — unsigned numbers use this"
                  >
                    <option value="W">W</option>
                    <option value="E">E</option>
                  </select>
                </div>
              </div>
              <p className="text-slate-500 text-xs leading-snug">
                Tip: For US West Coast, enter longitude magnitude and choose <span className="text-slate-400">W</span> (e.g. 120.4 + W = 120.4°W). Or type a signed value <span className="font-mono text-slate-400">-120.4</span> — sign overrides the menu.
              </p>
            </div>
          )}
        </div>

        {/* Voice / text notes */}
        <div className="bg-slate-800 rounded-2xl p-4 border border-slate-700">
          <div className="flex items-center justify-between mb-3">
            <p className="text-slate-300 text-sm font-medium">Extra detail <span className="text-slate-500">(optional)</span></p>
            <button
              type="button"
              onClick={listening ? stopVoice : startVoice}
              className={`flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg transition-colors ${listening ? 'bg-red-600 animate-pulse text-white' : 'bg-slate-700 text-slate-300 hover:bg-slate-600'}`}
            >
              🎤 {listening ? 'Stop' : 'Voice'}
            </button>
          </div>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Landmarks, wildlife, smell/sheen, time seen, anything not captured above…"
            rows={3}
            className="w-full bg-slate-700 text-white placeholder-slate-500 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-cyan-500 resize-none"
          />
          {listening && <p className="text-red-400 text-xs mt-1">● Listening...</p>}
        </div>

        <button
          type="submit"
          disabled={loading || (locMode === 'auto' && !location)}
          className="w-full bg-cyan-600 hover:bg-cyan-700 disabled:opacity-40 text-white font-bold py-4 rounded-xl transition-colors text-base"
        >
          {loading ? 'Detection + reconciliation + drift…' : 'Submit Sighting Report'}
        </button>
      </form>
    </div>
  );
}
