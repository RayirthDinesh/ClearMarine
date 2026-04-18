#!/usr/bin/env python3
"""
Build public/data/corc_glider_index.json from a Spray CORC NetCDF (Level 3 style).

Requires: pip install netcdf4 numpy

Usage:
  python3 scripts/build_corc_glider_json.py /path/to/CORC.nc
  python3 scripts/build_corc_glider_json.py ../CORC.nc    # from clearer/
  python3 scripts/build_corc_glider_json.py             # auto: env, clearer/data/, parent folder

Output: clearer/public/data/corc_glider_index.json
"""
import hashlib
import json
import os
import sys
import time

import numpy as np

# Skip near-stagnant samples (bearing is ill-defined when speed ~ 0).
SPEED_MS_MIN = 1e-5


def main():
    here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # clearer/

    nc_path = os.environ.get("CORC_NC")
    if len(sys.argv) > 1:
        nc_path = os.path.abspath(sys.argv[1])

    if not nc_path:
        candidates = [
            os.path.join(here, "data", "CORC.nc"),
            os.path.normpath(os.path.join(here, "..", "CORC.nc")),
            os.path.join(here, "CORC.nc"),
        ]
        for c in candidates:
            if os.path.isfile(c):
                nc_path = c
                break

    if not nc_path or not os.path.isfile(nc_path):
        print("Missing CORC.nc. Tried:", file=sys.stderr)
        print(f"  CORC_NC env, then {os.path.join(here, 'data', 'CORC.nc')},", file=sys.stderr)
        print(f"  {os.path.normpath(os.path.join(here, '..', 'CORC.nc'))} (parent of clearer/)", file=sys.stderr)
        print("Or pass the file path, e.g.:", file=sys.stderr)
        print(f'  python3 scripts/build_corc_glider_json.py "{os.path.normpath(os.path.join(here, "..", "CORC.nc"))}"', file=sys.stderr)
        sys.exit(1)

    from netCDF4 import Dataset

    ds = Dataset(nc_path, "r")
    lat = np.array(ds.variables["lat_uv"][:])
    lon = np.array(ds.variables["lon_uv"][:])
    u = np.array(ds.variables["u_depth_mean"][:])
    v = np.array(ds.variables["v_depth_mean"][:])
    t = np.array(ds.variables["time_uv"][:])
    mask = np.isfinite(lat) & np.isfinite(lon) & np.isfinite(u) & np.isfinite(v) & np.isfinite(t)
    lat, lon, u, v, t = lat[mask], lon[mask], u[mask], v[mask], t[mask]

    n = len(lat)
    max_pts = 8000
    step = max(1, n // max_pts)
    idx = np.arange(0, n, step)

    profiles = []
    for i in idx:
        speed_ms = float(np.hypot(u[i], v[i]))
        if speed_ms < SPEED_MS_MIN:
            continue
        br = (np.degrees(np.arctan2(u[i], v[i])) + 360) % 360
        profiles.append(
            {
                "lat": round(float(lat[i]), 5),
                "lon": round(float(lon[i]), 5),
                "t": round(float(t[i]), 3),
                "u_ms": round(float(u[i]), 6),
                "v_ms": round(float(v[i]), 6),
                "speed_knots": round(float(speed_ms * 1.94384), 4),
                "bearing_deg": round(float(br), 2),
            }
        )

    with open(nc_path, "rb") as bf:
        source_sha256 = hashlib.sha256(bf.read()).hexdigest()[:16]

    out = {
        "meta": {
            "id": "CORC",
            "description": "Spray glider depth-mean velocity (CORC). Nearest profile within max_km informs drift.",
            "source_file": os.path.basename(nc_path),
            "source_sha256_prefix": source_sha256,
            "profiles_indexed": len(profiles),
            "note": "Subsampled for web bundle size; near-stagnant samples (speed < 1e-5 m/s) omitted.",
            "build_time": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "bearing_convention": (
                "bearing_deg is direction the current flows toward, degrees clockwise from north (0=N, 90=E); "
                "computed as atan2(u, v) with u eastward and v northward (m/s)."
            ),
            "units": {
                "u_ms": "m/s eastward",
                "v_ms": "m/s northward",
                "speed_knots": "1.94384 m/s per knot (approx)",
            },
        },
        "max_km_glider_priority": 120,
        "profiles": profiles,
    }

    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    out_path = os.path.join(root, "public", "data", "corc_glider_index.json")
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with open(out_path, "w") as f:
        json.dump(out, f)
    print(f"Wrote {out_path} ({os.path.getsize(out_path)} bytes)")


if __name__ == "__main__":
    main()
