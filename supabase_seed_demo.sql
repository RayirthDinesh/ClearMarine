-- ============================================================
-- OPTIONAL demo seed — wipes assignments, drift, sightings, supplies, vessels then inserts samples.
-- Run only when you want a clean hackathon demo dataset.
-- Do NOT run on production if you need to keep existing rows.
-- Run supabase_schema.sql first (idempotent).
-- ============================================================

delete from assignments;
delete from drift_predictions;
delete from debris_sightings;
delete from supplies;
delete from vessels;

insert into vessels (name, zone, agency, status, fuel_level, fuel_threshold, capacity, current_lat, current_lon) values
  ('Ocean Guardian I',   'Zone A — California Coast', 'Local Coastguard', 'available',  78, 25, 100, 34.05, -120.42),
  ('Sea Shepherd II',    'Zone B — Hawaii Waters',    'Local Coastguard', 'available',  91, 25, 120, 21.30, -157.82),
  ('EPA Response Unit',  'Zone C — Federal Waters',   'EPA',              'available',  55, 25, 200, 36.10, -124.90),
  ('Pacific Interceptor','Zone A — California Coast', 'Local Coastguard', 'deployed',   40, 25,  80, 33.70, -118.50),
  ('Deep Clean Alpha',   'Zone D — Open Pacific',     'EPA',              'maintenance',20, 25, 150, 28.00, -145.00);

insert into supplies (name, zone, quantity, low_threshold) values
  ('Collection Nets',       'Zone A — California Coast', 8,  3),
  ('Fuel Drums',            'Zone A — California Coast', 3,  4),
  ('PPE Kits',              'Zone A — California Coast', 15, 5),
  ('Collection Bags',       'Zone A — California Coast', 40, 10),
  ('Collection Nets',       'Zone B — Hawaii Waters',    5,  3),
  ('Fuel Drums',            'Zone B — Hawaii Waters',    6,  4),
  ('Hazmat Suits',          'Zone B — Hawaii Waters',    2,  3),
  ('Collection Nets',       'Zone C — Federal Waters',   12, 3),
  ('Fuel Drums',            'Zone C — Federal Waters',   2,  4),
  ('Oil Booms',             'Zone C — Federal Waters',   4,  5),
  ('Skimmer Equipment',     'Zone D — Open Pacific',     1,  2),
  ('Fuel Drums',            'Zone D — Open Pacific',     3,  4);

with s1 as (
  insert into debris_sightings (reporter_name, latitude, longitude, debris_type, density_score, density_label, estimated_volume, gemini_analysis, status, jurisdiction)
  values ('Coastal Patrol Officer Chen', 33.95, -119.20, 'plastic', 8, 'Critical', '~200 kg',
    'Large accumulation of plastic bottles, bags and microplastics observed. High marine life entanglement risk. Immediate cleanup recommended.',
    'reported', 'Local Coastguard')
  returning id
),
s2 as (
  insert into debris_sightings (reporter_name, latitude, longitude, debris_type, density_score, density_label, estimated_volume, gemini_analysis, status, jurisdiction)
  values ('Fisherman Rodriguez', 35.40, -122.80, 'fishing_gear', 6, 'Dense', '~80 kg',
    'Abandoned fishing nets and lines creating ghost fishing hazard. Moderate entanglement risk to marine mammals. Cleanup within 48 hours recommended.',
    'reported', 'Local Coastguard')
  returning id
)
insert into drift_predictions (sighting_id, lat_24h, lon_24h, lat_48h, lon_48h, lat_72h, lon_72h, current_speed, current_bearing)
select s1.id, 34.12, -118.60, 34.30, -118.00, 34.50, -117.40, 1.8, 75 from s1
union all
select s2.id, 35.55, -122.20, 35.70, -121.60, 35.85, -121.00, 1.5, 80 from s2;
