-- Add pickup routing column (run once on existing projects)
alter table debris_sightings add column if not exists pickup_mode text;

comment on column debris_sightings.pickup_mode is 'land | ship | ship_coast | unknown — from pickupClassification + drift';
