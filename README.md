# ClearMarine

> 🥉 **3rd Place — DataHacks 2026** · Climate & Environment Track

**Ocean debris sightings → AI-enriched assessments → drift-aware dispatch for ships and shore crews.**

Built for **DataHacks 2026**.

🎥 **[Demo Video](https://www.youtube.com/watch?v=UWdY2FZE97E)** &nbsp;|&nbsp; 🌊 **[Live App](https://clear-marine.vercel.app/dashboard)** &nbsp;|&nbsp; 💻 **[Repo](https://github.com/shrivassudharsan1/ClearMarine)**

---
## Elevator pitch (45 seconds)

Marine debris reports are chaotic: photos, handwritten notes, radio chatter, and no shared picture of *who should respond*. ClearMarine gives the public a single **naval-themed field report** (`/report`), fuses **structured form data + optional CV signals + Groq reasoning** into one severity narrative, then forecasts **where debris may drift** using **real CORC Spray glider currents** plus HYCOM-style fallbacks. Coordinators watch a **live ops map** (`/dashboard`), get **Groq-ranked crew suggestions**, dispatch the right **vessel or land crew**, and crews execute from a dedicated **vessel workstation** (`/vessel/:id`). Supabase ties it together with **Realtime** updates so the room sees the same incident evolve.

---

## Problem → approach → outcome

| | |
|--|--|
| **Problem** | Coastal and offshore debris incidents need faster triage, clearer handoffs between agencies, and responders who see *where material may go*, not just where it was seen. |
| **Approach** | One React app for reporters and operators; Postgres + Realtime via Supabase; Groq for reconciliation, impact scoring, and crew/agent text; ElevenLabs for optional voice transcribe/TTS through a small Node API; Leaflet for operations visibility. |
| **Outcome** | End-to-end demo loop: **report → map → dispatch → intercept → complete**, with drift context and rostered crews. |

---

## Live paths (what to click in the demo)

| Audience | Route | What judges see |
|----------|-------|-----------------|
| Public / field | **`/report`** | Photo or text sighting, optional voice notes (STT), AI-filled severity and narrative, drift summary on submit. |
| Coordination center | **`/dashboard`** | Live map, sightings, fleet + **24 shore crews**, AI crew suggestions, dispatch modal with ETAs, optional agency handoffs. |
| Crew on the water | **`/vessel/:id`** | Assignment brief, intercept framing, **mark intercepted** to close the loop. |

---

## Judge demo script (~3 minutes)

1. **`/report`** — Log in as a reporter; add a coastline-near sighting (photo or text). Submit and show the **density label**, narrative, and **drift / pickup-mode** framing on the done screen.
2. **`/dashboard`** — Confirm the sighting appears on the map (Realtime). Open **AI Crew Agent** suggestions; click **dispatch** and walk through **ranked crews** (ship vs land logic).
3. **Assign** — Brief modal with intercept-style coordinates and **Groq-generated crew brief**.
4. **`/vessel/:id`** — Show assignment state; **mark intercepted** and watch status return on the dashboard.
5. **CREWS** tab — Quickly show shore roster breadth (demo-seeded coast-to-coast crews).
6. *(Optional)* Switch agency context to **EPA** — scoped sightings and partner handoff lane vs ClearMarine Operations.

---

## Architecture (high level)

```
Public (/report)
    │  GPS + photo/text/voice notes
    ▼
 Browser CV pipeline (optional) + Groq reconciliation / impact pass
    │  → debris_sightings , structured AI fields (Supabase)
    ▼
 predictDrift() → drift_predictions
       • CORC Spray glider index (Pacific, ≤120 km)
       • HYCOM-style ocean_currents grid
       • Bearing/speed fallback
    ▼
 Dashboard (/dashboard) ◄—— Supabase Realtime
       classifyPickupMode · rankCrewsForSighting · Groq crew agent
       assignments · handoffs · supplies
```

---

## Tech stack

| Layer | Choices |
|-------|---------|
| **Frontend** | React (CRA), Tailwind, React Router, Leaflet |
| **Backend (API)** | Express routes mounted at `/` and `/api/*` for **Vercel serverless** + local `npm run start:api` |
| **Data** | Supabase (Postgres + Realtime) |
| **AI (browser)** | Groq (`groq-sdk`, default `llama-3.1-8b-instant`) |
| **Voice** | ElevenLabs Scribe/TTS via backend **`/api/transcribe`** and **`/api/tts`** |
| **Drift** | Precomputed `corc_glider_index.json` + seeded `ocean_currents` |

---

## Environment variables

Single root **`.env`** can hold both UI and API secrets (see `.env.example`).

**Required for core app**

| Variable | Purpose |
|----------|---------|
| `REACT_APP_SUPABASE_URL` | Supabase project URL |
| `REACT_APP_SUPABASE_ANON_KEY` | Supabase anon key |
| `REACT_APP_GROQ_API_KEY` | Groq (browser) for debris text, reconciliation, crew agent |

**Voice (STT/TTS)**

| Variable | Purpose |
|----------|---------|
| `ELEVENLABS_KEY` | Backend Scribe + TTS |

**URLs**

| Variable | Purpose |
|----------|---------|
| _(omit)_ | **Vercel**: same-origin **`/api`** |
| `REACT_APP_BACKEND_URL=http://localhost:8787` | Optional local override if not using CRA proxy |

**Optional:** `ROBOFLOW_API_KEY`, `REACT_APP_ENABLE_ROBOFLOW`, `REACT_APP_ROBOFLOW_PROXY_URL`, ElevenLabs model overrides, `REACT_APP_MAINTENANCE_SCALE` (demo timers).

---

## Run locally

```bash
git clone https://github.com/shrivassudharsan1/ClearMarine.git
cd ClearMarine
npm install
cp .env.example .env   # fill Supabase + Groq + ElevenLabs
```

**Two terminals** (voice + map STT/TTS requires the API):

```bash
# Terminal 1 — API on :8787
npm run start:api

# Terminal 2 — CRA dev server (proxies /api → 8787 via package.json)
npm start
```

Health check: open **`http://localhost:3000/api/health`** — `elevenlabs_key_configured` should be `true` when ElevenLabs is set.

Seed optional currents: `node scripts/seed_currents.js`

---

## Deploy (Vercel — single project)

1. Import the GitHub repo.
2. Add the same variables from `.env` in **Project → Settings → Environment Variables**.
3. Deploy; API lives at **`https://<your-domain>/api/*`** (`vercel.json` + `api/[...path].js`).

Do not commit `.env`; use Vercel’s dashboard for secrets.

---

## Reproduce this submission build

Hackathon reviewers can pin the tree to the submission commit:

```bash
git checkout 0d5a866
npm ci && npm run build
```

Adjust the hash if you tag a release later (`git tag demo-submission && git push --tags`).

---

## Database & data

- **Schema & seeds:** run `supabase_schema.sql` in the Supabase SQL editor.
- **CORC glider JSON:** shipped as `public/data/corc_glider_index.json`; rebuild via `scripts/build_corc_glider_json.py` if you have `CORC.nc`.

---

## Team

**Shrivas Sudharsan** — DataHacks 2026 · ClearMarine  

---

## License / usage

Contents follow this repository’s license as published upstream; do not embed live API keys in forks or demos.
