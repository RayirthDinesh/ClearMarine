-- ============================================================
-- ClearMarine — Ocean Waste Coordination System
-- Safe to run on empty OR existing databases (idempotent DDL).
-- Does not DROP core tables or DELETE rows — use supabase_seed_demo.sql for demo reset.
-- ============================================================

-- Legacy ClearER-only tables (remove if you never used ClearER)
drop table if exists alerts cascade;
drop table if exists rooms cascade;
drop table if exists patients cascade;

-- Debris sightings reported by public/crews
create table if not exists debris_sightings (
  id uuid primary key default gen_random_uuid(),
  reporter_name text,
  photo_url text,
  latitude float,
  longitude float,
  debris_type text default 'unknown',
  density_score int,
  density_label text,
  estimated_volume text,
  gemini_analysis text,
  pickup_mode text,                   -- land | ship | ship_coast | unknown (see src/lib/pickupClassification.js)
  status text default 'reported',     -- reported / assigned / intercepted / cleared
  jurisdiction text default 'Local Coastguard',
  source_jurisdiction text default 'public',
  handoff_status text default 'none', -- none / pending / accepted
  created_at timestamp default now()
);

-- Cleanup vessels / crews
create table if not exists vessels (
  id uuid primary key default gen_random_uuid(),
  name text,
  zone text,
  agency text,
  status text default 'available',    -- available / deployed / returning / maintenance
  fuel_level int default 80,
  fuel_threshold int default 25,
  capacity int default 100,
  current_lat float,
  current_lon float,
  updated_at timestamp default now()
);

-- Drift predictions per sighting
create table if not exists drift_predictions (
  id uuid primary key default gen_random_uuid(),
  sighting_id uuid references debris_sightings(id) on delete cascade,
  lat_24h float,
  lon_24h float,
  lat_48h float,
  lon_48h float,
  lat_72h float,
  lon_72h float,
  current_speed float,
  current_bearing float,
  created_at timestamp default now()
);

-- Supplies per zone (nets, fuel, collection bags, PPE)
create table if not exists supplies (
  id uuid primary key default gen_random_uuid(),
  name text,
  zone text,
  quantity int,
  low_threshold int,
  updated_at timestamp default now()
);

-- Real ocean current data populated by scripts/seed_currents.js (NOAA HYCOM)
create table if not exists ocean_currents (
  id uuid primary key default gen_random_uuid(),
  lat float not null,
  lon float not null,
  u_ms float,           -- eastward current m/s
  v_ms float,           -- northward current m/s
  speed_knots float,
  bearing float,        -- direction current flows toward, degrees (0=N, 90=E)
  source text,
  recorded_at text,
  created_at timestamp default now()
);
create index if not exists idx_ocean_currents_lat_lon on ocean_currents (lat, lon);

-- Crew assignments linking vessel to sighting intercept
create table if not exists assignments (
  id uuid primary key default gen_random_uuid(),
  sighting_id uuid references debris_sightings(id) on delete cascade,
  vessel_id uuid references vessels(id) on delete cascade,
  interception_lat float,
  interception_lon float,
  interception_hours int,
  status text default 'assigned',     -- assigned / en_route / completed
  gemini_brief text,
  created_at timestamp default now()
);

-- Columns added after initial deploy (safe if already present)
alter table debris_sightings add column if not exists pickup_mode text;

comment on column debris_sightings.pickup_mode is 'land | ship | ship_coast | unknown — from pickupClassification + drift';

-- ============================================================
-- Disable RLS for hackathon demo
-- ============================================================
alter table debris_sightings disable row level security;
alter table vessels disable row level security;
alter table drift_predictions disable row level security;
alter table supplies disable row level security;
alter table assignments disable row level security;

-- ============================================================
-- Enable Realtime
-- ============================================================
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname='supabase_realtime' AND tablename='debris_sightings') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE debris_sightings; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname='supabase_realtime' AND tablename='vessels') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE vessels; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname='supabase_realtime' AND tablename='supplies') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE supplies; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname='supabase_realtime' AND tablename='assignments') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE assignments; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname='supabase_realtime' AND tablename='drift_predictions') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE drift_predictions; END IF;
END $$;
