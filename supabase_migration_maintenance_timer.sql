-- Add maintenance_until timestamp to vessels so the station page can show a live countdown
-- and auto-clear maintenance when the timer expires.
ALTER TABLE vessels
  ADD COLUMN IF NOT EXISTS maintenance_until TIMESTAMPTZ DEFAULT NULL;

-- Similarly, a supply_requests table isn't needed — we re-use supply_orders which already
-- tracks per-zone orders with ETAs. No schema change needed for supply timers.
