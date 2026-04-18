import { useState, useRef, useEffect } from 'react';
import {
  analyzeDebrisPhoto,
  analyzeDebrisText,
  notesLookSufficient,
  structuredReportComplete,
} from '../lib/gemini';
import { supabase } from '../lib/supabase';
import { predictDrift } from '../lib/drift';
import { isOnLandInPacificModel } from '../lib/landfall';
import { classifyPickupMode, pickupBadgeClassName } from '../lib/pickupClassification';
import { coordsNearlyEqual, formatCoordPair, normalizeLatLon, parseManualLongitudeWest } from '../lib/coords';

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
  const [locMode, setLocMode] = useState('auto'); // auto | manual
  const [loading, setLoading] = useState(false);
  const [locLoading, setLocLoading] = useState(false);
  const [result, setResult] = useState(null);
  /** Set when coords look on-land in the Pacific model: show drift preview but block save until user fixes location. */
  const [landReview, setLandReview] = useState(null);
  /** After dismissing land gate: show hint that a new offshore position is required. */
  const [landReentryRequired, setLandReentryRequired] = useState(false);
  const [listening, setListening] = useState(false);
  const [notes, setNotes] = useState('');
  const [wasteType, setWasteType] = useState('');
  const [sizeCategory, setSizeCategory] = useState('');
  const [quantityBand, setQuantityBand] = useState('');
  const [spreadLayout, setSpreadLayout] = useState('');
  const fileRef = useRef(null);
  const recognitionRef = useRef(null);
  /** Normalized coords from last land rejection — block resubmit until user changes position. */
  const lastRejectedLandCoordsRef = useRef(null);

  useEffect(() => {
    if (locMode === 'auto') {
      setLocLoading(true);
      navigator.geolocation?.getCurrentPosition(
        (pos) => {
          setLocation({ lat: pos.coords.latitude, lon: pos.coords.longitude });
          setLocLoading(false);
        },
        () => {
          setLocMode('manual');
          setLocLoading(false);
        }
      );
    }
  }, [locMode]);

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

  const dismissLandReview = () => {
    setLandReview((prev) => {
      if (prev?.coords) {
        lastRejectedLandCoordsRef.current = {
          lat: prev.coords.lat,
          lon: prev.coords.lon,
        };
      }
      return null;
    });
    setLocation(null);
    setManualLat('');
    setManualLon('');
    setLocMode('manual');
    setLandReentryRequired(true);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    const lat = locMode === 'manual' ? parseFloat(manualLat) : location?.lat;
    const lon = locMode === 'manual'
      ? parseManualLongitudeWest(manualLon)
      : location?.lon;
    if (lat == null || lon == null || !Number.isFinite(lat) || !Number.isFinite(lon)) {
      alert('Location required — enter valid latitude and longitude.');
      return;
    }
    const coords = normalizeLatLon(lat, lon);
    if (!coords) {
      alert('Invalid coordinates — latitude must be −90…90°, longitude a finite value.');
      return;
    }
    if (
      lastRejectedLandCoordsRef.current
      && coordsNearlyEqual(coords, lastRejectedLandCoordsRef.current)
    ) {
      alert(
        'You must change the coordinates from your last attempt. Move the pin to open water (ocean or bay) and enter a new position.',
      );
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
        + 'That lets the AI give a reliable intensity rating.',
      );
      return;
    }

    setLoading(true);
    try {
      let analysis = photo
        ? await analyzeDebrisPhoto(photo.base64, photo.mimeType, coords.lat, coords.lon, reporterStructured)
        : await analyzeDebrisText(notes, coords.lat, coords.lon, reporterStructured);

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

      const drift = await predictDrift(coords.lat, coords.lon);

      if (isOnLandInPacificModel(coords.lat, coords.lon)) {
        setLandReview({ analysis, drift, coords, pickup: classifyPickupMode(coords.lat, coords.lon, drift) });
        return;
      }

      const pickup = classifyPickupMode(coords.lat, coords.lon, drift);

      const structuredSummary = structuredReportComplete(reporterStructured)
        ? `[Reporter: type=${reporterStructured.waste_type}; size=${reporterStructured.size_category}; amount=${reporterStructured.quantity_band}${reporterStructured.spread_layout ? `; spread=${reporterStructured.spread_layout}` : ''}]\n\n`
        : '';
      const intensityBlock = analysis.intensity_rationale
        ? `\n\nIntensity rating (${analysis.density_score}/10 — ${analysis.density_label}): ${analysis.intensity_rationale}`
        : '';
      const scaleBlock = (analysis.approximate_size && analysis.approximate_size !== 'unknown')
        || (analysis.quantity_estimate && analysis.quantity_estimate !== 'unknown')
        ? `\n\nAI scale summary — size: ${analysis.approximate_size}; quantity: ${analysis.quantity_estimate}; spread: ${analysis.spread || 'unknown'}`
        : '';
      const geminiAnalysisStored = [
        structuredSummary + analysis.gemini_analysis + scaleBlock + intensityBlock,
        notes.trim() && `Reporter notes: ${notes.trim()}`,
      ].filter(Boolean).join('\n\n');

      const { data: sighting, error } = await supabase
        .from('debris_sightings')
        .insert({
          reporter_name: name,
          latitude: coords.lat,
          longitude: coords.lon,
          debris_type: analysis.debris_type,
          density_score: analysis.density_score,
          density_label: analysis.density_label,
          estimated_volume: analysis.estimated_volume,
          gemini_analysis: geminiAnalysisStored,
          pickup_mode: pickup.key,
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

      lastRejectedLandCoordsRef.current = null;
      setLandReentryRequired(false);
      setResult({ analysis, drift, lat: coords.lat, lon: coords.lon, pickup });
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

  if (landReview) {
    const { analysis, drift, coords: crd, pickup } = landReview;
    return (
      <div className="min-h-screen bg-slate-900 flex flex-col items-center justify-center p-4">
        <div className="bg-slate-800 rounded-2xl p-6 w-full max-w-md border border-amber-700/60 shadow-2xl">
          <div className="text-center mb-4">
            <div className="text-4xl mb-2">⚠️</div>
            <h2 className="text-white font-bold text-xl">Location looks on land</h2>
            {pickup && (
              <div className="mt-2 flex justify-center">
                <span className={`text-xs font-semibold px-3 py-1 rounded-lg ${pickupBadgeClassName(pickup.key)}`}>
                  {pickup.shortLabel} — move offshore for vessel ops
                </span>
              </div>
            )}
            <p className="text-amber-200/90 text-sm mt-2 leading-snug">
              In our coastal model this position is <span className="font-semibold">inland or onshore</span>, not open ocean.
              Drift below is illustrative only — we cannot file the sighting until you move the pin to the water (ocean or bay).
            </p>
            <p className="text-slate-400 text-xs mt-2 font-mono">{formatCoordPair(crd.lat, crd.lon)}</p>
          </div>

          <div className="bg-slate-900 rounded-xl p-4 mb-4 border border-slate-700">
            <p className="text-slate-400 text-xs mb-2 font-medium uppercase tracking-wider">Illustrative drift (not saved)</p>
            <div className="space-y-1.5">
              {drift.predictions.map((p) => (
                <div key={p.hours} className="flex items-center justify-between text-xs">
                  <span className="text-slate-400">+{p.hours}h</span>
                  <span className="text-cyan-400/90 font-mono">{formatCoordPair(p.lat, p.lon)}</span>
                </div>
              ))}
            </div>
            <p className="text-slate-500 text-xs mt-2">
              Current: {drift.speed.toFixed(2)} kn @ {drift.bearing.toFixed(0)}° — {drift.source}
            </p>
          </div>

          <div className="bg-slate-700/50 rounded-xl p-3 mb-4 border border-slate-600">
            <p className="text-slate-300 text-xs leading-relaxed">{analysis.gemini_analysis?.slice(0, 200)}{analysis.gemini_analysis?.length > 200 ? '…' : ''}</p>
          </div>

          <button
            type="button"
            onClick={dismissLandReview}
            className="w-full bg-cyan-600 hover:bg-cyan-500 text-white font-semibold py-3 rounded-xl transition-colors text-sm"
          >
            Edit location — try again
          </button>
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
                Scale (AI): {result.analysis.approximate_size}
                {result.analysis.quantity_estimate ? ` · ${result.analysis.quantity_estimate}` : ''}
                {result.analysis.spread && result.analysis.spread !== 'unknown' ? ` · ${result.analysis.spread.replace(/_/g, ' ')}` : ''}
              </p>
            )}
            {result.analysis.intensity_rationale ? (
              <p className="text-slate-400 text-xs italic border-l-2 border-cyan-600 pl-2 mt-1">
                Why this rating: {result.analysis.intensity_rationale}
              </p>
            ) : null}
            <p className="text-slate-300 text-sm leading-relaxed">{result.analysis.gemini_analysis}</p>
          </div>

          {result.pickup && (
            <div className="bg-slate-900/80 rounded-xl p-4 mb-4 border border-slate-600">
              <p className="text-slate-400 text-xs mb-2 font-medium uppercase tracking-wider">Pickup routing</p>
              <span className={`inline-block text-xs font-semibold px-2.5 py-1 rounded-lg mb-2 ${pickupBadgeClassName(result.pickup.key)}`}>
                {result.pickup.shortLabel}
              </span>
              <p className="text-slate-400 text-xs leading-relaxed">{result.pickup.detail}</p>
              <p className="text-slate-600 text-[10px] mt-2 leading-snug">
                Based on the same drift model as the dashboard (CORC glider index when nearby, else HYCOM, else fallback) and the Pacific shoreline clip.
              </p>
            </div>
          )}

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
              setLandReview(null);
              lastRejectedLandCoordsRef.current = null;
              setLandReentryRequired(false);
              setLocation(null);
              setManualLat('');
              setManualLon('');
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
          <p className="text-slate-300 text-sm font-medium mb-3">Debris Photo</p>
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
            No photo? Use the fields below — type, size, and amount are required for a rated text report.
          </p>
        </div>

        {/* Structured sighting details */}
        <div className="bg-slate-800 rounded-2xl p-4 border border-slate-700 space-y-3">
          <p className="text-slate-300 text-sm font-medium">What you saw</p>
          <p className="text-slate-500 text-xs leading-snug">
            Separate fields help the model quantify intensity (1–10) and explain the score. Required if you are not attaching a photo.
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
              <button type="button" onClick={() => setLocMode('auto')} className={`text-xs px-2.5 py-1 rounded-lg transition-colors ${locMode === 'auto' ? 'bg-cyan-700 text-white' : 'bg-slate-700 text-slate-400'}`}>Auto GPS</button>
              <button type="button" onClick={() => setLocMode('manual')} className={`text-xs px-2.5 py-1 rounded-lg transition-colors ${locMode === 'manual' ? 'bg-cyan-700 text-white' : 'bg-slate-700 text-slate-400'}`}>Manual</button>
            </div>
          </div>
          {landReentryRequired && (
            <p className="text-amber-200/90 text-xs leading-snug mb-3 border border-amber-700/50 rounded-lg px-3 py-2 bg-amber-950/30">
              Enter offshore coordinates (west longitude). You can switch back to Auto GPS after updating your position.
            </p>
          )}
          {locMode === 'auto' ? (
            locLoading ? (
              <p className="text-slate-400 text-sm">Detecting location...</p>
            ) : location ? (
              <p className="text-cyan-400 text-sm font-mono">
                {formatCoordPair(location.lat, location.lon)} ✓
              </p>
            ) : (
              <p className="text-red-400 text-sm">GPS unavailable — switch to Manual</p>
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
                <input
                  type="number"
                  step="any"
                  value={manualLon}
                  onChange={(e) => setManualLon(e.target.value)}
                  placeholder="Longitude °W (e.g. 120.4)"
                  className="min-w-0 flex-1 bg-slate-700 text-white placeholder-slate-500 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-cyan-500"
                />
              </div>
              <p className="text-slate-500 text-xs leading-snug">
                All coordinates use <span className="text-slate-300">west longitude</span>: enter the degrees west as a positive number (e.g. <span className="font-mono text-slate-400">120.4</span> for 120.4°W), or type a signed decimal with a minus sign (e.g. <span className="font-mono text-slate-400">-120.4</span>).
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
          {loading ? 'Analyzing with AI + Computing Drift...' : 'Submit Sighting Report'}
        </button>
      </form>
    </div>
  );
}
