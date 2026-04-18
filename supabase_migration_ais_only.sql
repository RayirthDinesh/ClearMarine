-- ============================================================
-- AIS columns + Plastic Odyssey row — run on EXISTING database
-- Use this when supabase_schema.sql fails with "already exists"
-- (does not drop tables or delete seed data).
-- ============================================================

-- Anon key reads + dashboard Realtime (hackathon demo; tighten RLS for production)
alter table vessels disable row level security;

alter table vessels add column if not exists mmsi text;
alter table vessels add column if not exists imo text;
alter table vessels add column if not exists sog float;
alter table vessels add column if not exists cog float;
alter table vessels add column if not exists ais_timestamp timestamptz;

-- Enforce one row per MMSI when set (multiple NULL mmsi still allowed)
create unique index if not exists vessels_mmsi_uidx on public.vessels (mmsi) where mmsi is not null;

insert into vessels (name, zone, agency, status, fuel_level, fuel_threshold, capacity, current_lat, current_lon, mmsi, imo)
select 'Plastic Odyssey', 'Global — AIS (AISStream)', 'Plastic Odyssey', 'deployed', 70, 25, 150, null, null, '228379700', '7360655'
where not exists (select 1 from vessels where mmsi = '228379700');

-- Live map + sidebar refresh when sync_ais updates rows
do $$
begin
  if not exists (
    select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'vessels'
  ) then
    alter publication supabase_realtime add table vessels;
  end if;
end $$;
