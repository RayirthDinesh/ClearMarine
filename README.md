# ClearMarine — AI-Powered Ocean Debris Coordination

> **DataHacks 2026** — Real-time ocean debris tracking, drift forecasting, and multi-agency fleet + shore crew coordination.

**Repo:** [github.com/shrivassudharsan1/ClearMarine](https://github.com/shrivassudharsan1/ClearMarine)

---

## What It Does

ClearMarine connects three groups in a single web app:

| Who | Route | Role |
|-----|-------|------|
| Anyone (beach, boat, drone) | `/report` | Photo + GPS → AI debris assessment → sighting logged |
| Ops coordinators | `/dashboard` | Live map, AI crew agent, assign vessels & shore crews, partner handoffs |
| Vessel crews | `/vessel/:id` | Assignment brief, status updates, fuel/supplies, maintenance timer |

---

## Key Features

### Reporting (`/report`)
- Snap a photo or describe debris in text — **Groq vision AI** returns type, density (1–10), and estimated volume
- GPS auto-detected or manually entered; drift forecast computed on submit
- Voice report support with transcription
- Done screen shows drift path, pickup mode badge, and predicted landfall

### Dashboard (`/dashboard`)
- **Leaflet map** with live vessel positions, animated mission paths, and shore crew markers coast-to-coast
- **Drift paths** clipped at modeled coastline — ⚑ flag only when track approaches shore
- **Pickup classification** — debris within 15 km of shore routes to land crews automatically; deep-ocean sightings go to ships; drift-to-coast routes to shore crews. Land sightings suppress the drift heatmap entirely.
- **AI Crew Agent** — Groq-powered suggestions: named vessel or shore crew, supply reorders, handoffs. Suggestions are dismissible
- Dispatch modal ranks all available crews by ETA (ship or land depending on pickup mode)
- Per-agency isolation — each agency sees only their sightings and fleet; shore crews are shared
- New sighting and assignment toast notifications at top of screen
- Partner handoff lane: ClearMarine Operations ↔ EPA

### Vessel Station (`/vessel/:id`)
- Mark intercepted → vessel automatically returns to `available`
- Maintenance timer with 3 duration presets (demo-scaled via `REACT_APP_MAINTENANCE_SCALE`)
- Supply resupply request button per zone with live delivery countdown

### Crew Routing (`src/lib/cleanupTime.js`)
- Haversine distance + vessel speed (knots) or land crew speed (km/h) → ETA in minutes
- Parses free-form AI volume strings ("~200 kg", "10 m patch", "5–20 items") with density fallbacks
- Drift interception: picks closest 24/48/72 h waypoint to vessel as intercept proxy

---

## Architecture

```
Public Reporter (/report)
    │  photo + GPS
    ▼
Groq vision → debris_sightings (Supabase)
    │
    ▼
predictDrift() → drift_predictions
    │  1. Spray CORC glider (≤120 km)
    │  2. HYCOM ocean_currents grid
    │  3. Gyre fallback
    │  24h / 48h / 72h positions
    ▼
Dashboard (/dashboard) ← Supabase Realtime
    ├── classifyPickupMode() → land / ship / ship_coast / unknown
    ├── rankCrewsForSighting() → sorted ETA list
    ├── AI Crew Agent (Groq) → assign / handoff / reorder suggestions
    └── Assign → interception point + Groq crew brief → /vessel/:id
```

---

## Tech Stack

- **React 18** + **Tailwind CSS** (naval dark theme, glassmorphism)
- **Supabase** (Postgres + Realtime subscriptions)
- **Groq** (`llama-3.1-8b-instant`) for all AI: vision, text, crew suggestions, briefs
- **Leaflet** + `react-leaflet` for maps
- **Spray CORC glider data** (`public/data/corc_glider_index.json`) for real ocean current drift

---

## Quick Start

### 1. Clone & install

```bash
git clone https://github.com/shrivassudharsan1/ClearMarine.git
cd ClearMarine
npm install
```

### 2. Supabase setup

1. Create a free project at [supabase.com](https://supabase.com)
2. SQL Editor → run `supabase_schema.sql` (tables, seeds, Realtime)
3. Copy your project URL and anon key

### 3. Environment

```bash
cp .env.example .env
```

Fill in:

```env
REACT_APP_SUPABASE_URL=https://your-project.supabase.co
REACT_APP_SUPABASE_ANON_KEY=your-anon-key
REACT_APP_GROQ_API_KEY=your-groq-key
REACT_APP_MAINTENANCE_SCALE=0.05   # 0.05 = 20x shorter timers for demos
```

### 4. (Optional) Seed HYCOM ocean currents

```bash
node scripts/seed_currents.js
```

### 5. Run

```bash
npm start
```

---

## Demo Script (3 min)

1. **`/report`** — submit a photo or typed sighting near a coastline. AI fills in debris type, density, and volume. Done screen shows drift path and pickup badge (Land crew / Ship pickup).
2. **`/dashboard`** — sighting appears live on the map. AI Crew Agent suggests a vessel or shore crew. Click **DISPATCH CREW** → modal ranks all available crews by ETA.
3. Assign the top crew → brief modal with intercept coordinates and Groq-generated crew brief.
4. **`/vessel/:id`** — crew view shows the assignment. Hit **MARK INTERCEPTED** → vessel returns to available, mission closes on dashboard.
5. Show the **CREWS tab** — full roster of 24 shore crews coast-to-coast, all with live status badges.
6. *(Bonus)* Switch agency selector to **EPA** — dashboard shows only EPA sightings and handles incoming handoffs from ClearMarine Operations.

---

## Database Schema

| Table | Purpose |
|-------|---------|
| `debris_sightings` | Reports: location, AI fields, jurisdiction, handoff_status |
| `drift_predictions` | 24/48/72 h lat/lon snapshots |
| `ocean_currents` | HYCOM-style grid for drift fallback |
| `vessels` | Fleet: status, position, speed, capacity |
| `land_crews` | Shore crews: base coords, speed, capacity, agency |
| `assignments` | Sighting ↔ crew, intercept point, brief |
| `supplies` | Zone inventory with low-stock thresholds |
| `supply_orders` | Resupply requests with delivery ETAs |

Full DDL: `supabase_schema.sql`

---

## Glider Data (Spray CORC)

Real observed depth-mean currents from **Spray underwater gliders** (CORC — California Regional Ocean) inform drift for Pacific sightings.

The browser loads `public/data/corc_glider_index.json` (pre-built, ~1.3 MB). To rebuild from a fresh `CORC.nc`:

```bash
pip install -r scripts/requirements-glider.txt
python3 scripts/build_corc_glider_json.py /path/to/CORC.nc
# or: npm run build:glider-data  (needs CORC.nc at ../CORC.nc)
```

`*.nc` files are gitignored. Only the JSON index is committed.

---

## Built By

Shrivas Sudharsan — DataHacks 2026
