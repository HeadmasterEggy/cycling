#!/usr/bin/env python3
"""Parse an Apple Health export.xml plus its GPX route files into the data
payload the site consumes.

Writes two files with identical content:
  health_data.json      — portable JSON export
  assets/health-data.js — the same payload wrapped as `window.HEALTH_DATA`,
                          which is what the pages actually load

Paths default to this repo (./data/apple_health_export) and can be
overridden with CLI flags or the HEALTH_EXPORT_DIR environment variable:

    python3 parse_health.py --export-dir ~/Downloads/apple_health_export
"""

import argparse
import json
import os
import re
import math
from datetime import datetime, timedelta, timezone
from xml.etree import ElementTree as ET

ROOT = os.path.dirname(os.path.abspath(__file__))

# Defaults resolve inside the repo; the raw export is gitignored (it is
# hundreds of MB), so point at wherever you unzipped it.
EXPORT_DIR = os.environ.get(
    "HEALTH_EXPORT_DIR", os.path.join(ROOT, "data", "apple_health_export"))
EXPORT_XML = os.path.join(EXPORT_DIR, "export.xml")
ROUTES_DIR = os.path.join(EXPORT_DIR, "workout-routes")
OUT_JSON = os.path.join(ROOT, "health_data.json")
OUT_JS = os.path.join(ROOT, "assets", "health-data.js")
OUT_ROUTES = os.path.join(ROOT, "assets", "routes.js")

# Ramer-Douglas-Peucker tolerance for the map polylines, in metres.
# Raise it for smaller files, lower it for more faithful corners.
RDP_EPSILON_M = 12.0


def configure_paths(export_dir=None, out_json=None, out_js=None,
                    out_routes=None):
    """Rebind the module-level paths (used by main() and its helpers)."""
    global EXPORT_DIR, EXPORT_XML, ROUTES_DIR, OUT_JSON, OUT_JS, OUT_ROUTES
    if export_dir:
        EXPORT_DIR = os.path.abspath(os.path.expanduser(export_dir))
        EXPORT_XML = os.path.join(EXPORT_DIR, "export.xml")
        ROUTES_DIR = os.path.join(EXPORT_DIR, "workout-routes")
    if out_json:
        OUT_JSON = os.path.abspath(os.path.expanduser(out_json))
    if out_js:
        OUT_JS = os.path.abspath(os.path.expanduser(out_js))
    if out_routes:
        OUT_ROUTES = os.path.abspath(os.path.expanduser(out_routes))


def parse_args():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--export-dir", default=None,
                    help="unzipped apple_health_export directory "
                         f"(default: {EXPORT_DIR})")
    ap.add_argument("--out-json", default=None,
                    help=f"JSON output path (default: {OUT_JSON})")
    ap.add_argument("--out-js", default=None,
                    help=f"JS asset output path (default: {OUT_JS})")
    ap.add_argument("--out-routes", default=None,
                    help=f"GPS track output path (default: {OUT_ROUTES})")
    ap.add_argument("--rdp-epsilon", type=float, default=RDP_EPSILON_M,
                    help="map polyline simplification tolerance in metres "
                         f"(default: {RDP_EPSILON_M})")
    ap.add_argument("--skip-routes", action="store_true",
                    help="leave assets/routes.js alone")
    ap.add_argument("--routes-only", action="store_true",
                    help="rebuild assets/routes.js and nothing else; needs "
                         "only the GPX files, not export.xml")
    ap.add_argument("--check-routes", action="store_true",
                    help="rebuild the tracks in memory and diff them against "
                         "the committed assets/routes.js without writing "
                         "anything; needs only the GPX files, not export.xml")
    return ap.parse_args()

GPX_NS = {"g": "http://www.topografix.com/GPX/1/1",
          "ge": "http://www.garmin.com/xmlschemas/GpxExtensions/v3",
          "tp": "http://www.garmin.com/xmlschemas/TrackPointExtension/v1"}


def parse_dt(s: str) -> datetime:
    # Apple Health uses e.g. "2024-10-30 23:10:47 +1000"
    return datetime.strptime(s.strip(), "%Y-%m-%d %H:%M:%S %z")


def haversine(lat1, lon1, lat2, lon2):
    R = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dphi/2)**2 + math.cos(p1)*math.cos(p2)*math.sin(dl/2)**2
    return 2 * R * math.asin(math.sqrt(a))


def extension_speed(ext):
    """Read <speed> out of a trkpt's <extensions>, whatever namespace it uses.

    Apple's export writes a bare <speed>, which inherits the GPX default
    namespace, while Garmin devices prefix it with one of their own and may
    bury it inside a TrackPointExtension wrapper. Matching on the local tag
    name covers all of them; a namespace-qualified lookup silently found
    nothing in the Apple files and left every speed at None.
    """
    if ext is None:
        return None
    for child in ext.iter():
        if child.tag.rsplit("}", 1)[-1] == "speed" and child.text:
            try:
                return float(child.text)
            except ValueError:
                return None
    return None


def read_gpx_points(path: str):
    """Read every <trkpt> in a GPX file into plain dicts.

    Shared by parse_gpx() (per-workout metrics) and build_routes() (the
    ROUTES_DATA payload), so both read the file the same way.
    """
    try:
        tree = ET.parse(path)
    except ET.ParseError:
        return None
    root = tree.getroot()
    pts = []
    for trkpt in root.iter("{http://www.topografix.com/GPX/1/1}trkpt"):
        try:
            lat = float(trkpt.get("lat"))
            lon = float(trkpt.get("lon"))
        except (TypeError, ValueError):
            continue
        ele = trkpt.find("g:ele", GPX_NS)
        time = trkpt.find("g:time", GPX_NS)
        ext = trkpt.find("g:extensions", GPX_NS)
        speed = extension_speed(ext)
        pts.append({
            "lat": lat,
            "lon": lon,
            "ele": float(ele.text) if ele is not None and ele.text else None,
            "t": time.text if time is not None and time.text else None,
            "speed": speed,
        })
    return pts or None


def parse_gpx(path: str):
    pts = read_gpx_points(path)
    if not pts:
        return None

    # Distance, elevation gain/loss, max/avg speed
    dist_km = 0.0
    elev_gain = 0.0
    elev_loss = 0.0
    speeds = []
    elevs = [p["ele"] for p in pts if p["ele"] is not None]
    prev = None
    for p in pts:
        if prev is not None:
            d = haversine(prev["lat"], prev["lon"], p["lat"], p["lon"])
            dist_km += d
            if p["ele"] is not None and prev["ele"] is not None:
                de = p["ele"] - prev["ele"]
                if de > 0:
                    elev_gain += de
                else:
                    elev_loss -= de
        if p["speed"] is not None:
            speeds.append(p["speed"])
        prev = p

    # Simplify track: keep at most ~300 points for compact JSON
    if len(pts) > 300:
        step = len(pts) / 300.0
        sampled = [pts[int(i * step)] for i in range(300)]
        sampled.append(pts[-1])
        track = [[round(p["lat"], 5), round(p["lon"], 5)] for p in sampled]
    else:
        track = [[round(p["lat"], 5), round(p["lon"], 5)] for p in pts]

    # Elevation series for sparkline (~60 samples)
    elev_series = []
    if elevs:
        n = min(60, len(elevs))
        step = max(1, len(elevs) // n)
        elev_series = [round(elevs[i], 1) for i in range(0, len(elevs), step)][:n]

    start_t = pts[0]["t"]
    end_t = pts[-1]["t"]

    return {
        "distance_km": round(dist_km, 3),
        "elev_gain_m": round(elev_gain, 1),
        "elev_loss_m": round(elev_loss, 1),
        "elev_min_m": round(min(elevs), 1) if elevs else None,
        "elev_max_m": round(max(elevs), 1) if elevs else None,
        "avg_speed_ms": round(sum(speeds)/len(speeds), 3) if speeds else None,
        "max_speed_ms": round(max(speeds), 3) if speeds else None,
        "track": track,
        "elev_series": elev_series,
        "start_t": start_t,
        "end_t": end_t,
        "n_points": len(pts),
    }


# ---- ROUTES_DATA: assets/routes.js -------------------------------------
#
# The pages load assets/routes.js as window.ROUTES_DATA — one entry per GPX
# file in the export's workout-routes/ directory, including tracks with no
# matching workout (walks, pre-watch rides, unpaired loops). Until now
# nothing in the repo produced this file, so the map could not follow a
# refreshed export.

# Bounding boxes for the places these rides happened, wide enough to absorb
# GPS drift but non-overlapping. A track centred outside all of them is
# labelled "Unknown" and reported at the end of the run rather than being
# silently filed under the nearest city.
CITY_BOXES = [
    # name,       min_lat, max_lat, min_lon, max_lon
    ("Sydney",     -34.30,  -33.50,  150.80,  151.50),
    ("Ningbo",      29.60,   30.10,  121.30,  121.90),
    ("Shanghai",    30.90,   31.60,  121.00,  121.90),
    ("Henan",       35.50,   36.10,  114.80,  115.40),
]

CITY_TZ = {
    "Sydney": "Australia/Sydney",
    "Ningbo": "Asia/Shanghai",
    "Shanghai": "Asia/Shanghai",
    "Henan": "Asia/Shanghai",
}


def classify_city(lat, lon):
    for name, min_lat, max_lat, min_lon, max_lon in CITY_BOXES:
        if min_lat <= lat <= max_lat and min_lon <= lon <= max_lon:
            return name
    return "Unknown"


def _local_wall_clock(dt_utc, city):
    """The wall-clock time at the ride's location, as a naive datetime.

    Sydney needs a real timezone because the existing data spans both AEST
    and AEDT; the Chinese cities are a fixed +08:00.
    """
    tz_name = CITY_TZ.get(city)
    if tz_name:
        try:
            from zoneinfo import ZoneInfo
            return dt_utc.astimezone(ZoneInfo(tz_name)).replace(tzinfo=None)
        except Exception:
            pass  # tzdata missing — fall through to the fixed offset below
    return (dt_utc + timedelta(hours=8)).replace(tzinfo=None)


def _perp_distance_m(p, a, b):
    """Distance from point p to segment a-b, in metres.

    Equirectangular projection around a, which is accurate well past the
    few-kilometre span of any single track here.
    """
    lat_rad = math.radians(a[0])
    mx = 111320.0 * math.cos(lat_rad)   # metres per degree of longitude
    my = 110540.0                        # metres per degree of latitude
    ax, ay = 0.0, 0.0
    bx, by = (b[1] - a[1]) * mx, (b[0] - a[0]) * my
    px, py = (p[1] - a[1]) * mx, (p[0] - a[0]) * my
    dx, dy = bx - ax, by - ay
    seg2 = dx * dx + dy * dy
    if seg2 == 0.0:
        return math.hypot(px, py)
    t = max(0.0, min(1.0, (px * dx + py * dy) / seg2))
    return math.hypot(px - t * dx, py - t * dy)


def rdp(points, epsilon_m):
    """Ramer-Douglas-Peucker simplification, iterative to avoid deep recursion.

    Keeps the shape of a route while dropping the points that sit on a
    straight line — a 20k-point track collapses to a few hundred without a
    visible change at map zoom.
    """
    n = len(points)
    if n < 3:
        return list(points)
    keep = [False] * n
    keep[0] = keep[n - 1] = True
    stack = [(0, n - 1)]
    while stack:
        first, last = stack.pop()
        if last <= first + 1:
            continue
        worst, worst_i = 0.0, -1
        a, b = points[first], points[last]
        for i in range(first + 1, last):
            d = _perp_distance_m(points[i], a, b)
            if d > worst:
                worst, worst_i = d, i
        if worst > epsilon_m and worst_i > 0:
            keep[worst_i] = True
            stack.append((first, worst_i))
            stack.append((worst_i, last))
    return [points[i] for i in range(n) if keep[i]]


def _gpx_time(value):
    """Parse a GPX <time> value into an aware UTC datetime."""
    if not value:
        return None
    text = value.strip().replace("Z", "+00:00")
    try:
        dt = datetime.fromisoformat(text)
    except ValueError:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def build_route(path, epsilon_m):
    """Build one ROUTES_DATA entry from a GPX file, or None if unusable."""
    pts = read_gpx_points(path)
    if not pts or len(pts) < 2:
        return None
    start_dt = _gpx_time(pts[0]["t"])
    end_dt = _gpx_time(pts[-1]["t"])
    if start_dt is None or end_dt is None:
        return None

    dist_km = 0.0
    elev_gain = 0.0
    speeds = []
    prev = None
    for p in pts:
        if prev is not None:
            dist_km += haversine(prev["lat"], prev["lon"], p["lat"], p["lon"])
            if p["ele"] is not None and prev["ele"] is not None:
                de = p["ele"] - prev["ele"]
                if de > 0:
                    elev_gain += de
        if p["speed"] is not None:
            speeds.append(p["speed"])
        prev = p

    duration_sec = (end_dt - start_dt).total_seconds()
    coords = [[p["lat"], p["lon"]] for p in pts]
    lats = [c[0] for c in coords]
    lons = [c[1] for c in coords]
    bbox = {"minLat": min(lats), "maxLat": max(lats),
            "minLon": min(lons), "maxLon": max(lons)}
    center = [(bbox["minLat"] + bbox["maxLat"]) / 2,
              (bbox["minLon"] + bbox["maxLon"]) / 2]
    city = classify_city(center[0], center[1])

    # Speeds come from the GPX <speed> extension in m/s. avg_speed_kmh is the
    # mean of those samples rather than distance/duration, so it reflects
    # moving speed and stays comparable with the existing data.
    if speeds:
        avg_kmh = sum(speeds) / len(speeds) * 3.6
        max_kmh = max(speeds) * 3.6
    else:
        avg_kmh = dist_km / (duration_sec / 3600) if duration_sec > 0 else 0.0
        max_kmh = 0.0

    start_local = _local_wall_clock(start_dt, city)
    end_local = _local_wall_clock(end_dt, city)
    track = [[round(lat, 6), round(lon, 6)] for lat, lon in rdp(coords, epsilon_m)]
    name = os.path.basename(path)[:-4]
    if name.startswith("route_"):
        name = name[len("route_"):]

    return {
        "filename": os.path.basename(path),
        "name": name,
        "start_time": start_dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "end_time": end_dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "duration_sec": duration_sec,
        "distance_km": dist_km,
        "avg_speed_kmh": avg_kmh,
        "max_speed_kmh": max_kmh,
        "ele_gain_m": elev_gain,
        "num_points": len(pts),
        "num_simplified": len(track),
        "track": track,
        "bbox": bbox,
        "center": center,
        "city": city,
        # Wall-clock time where the ride happened. The "+00:00" is a marker,
        # not the real offset — app.js formats these with timeZone "UTC", which
        # reads the digits straight back, so a ride at 10:57pm in Sydney shows
        # as 10:57pm to every viewer regardless of where they are.
        "start_local": start_local.isoformat() + "+00:00",
        "end_local": end_local.isoformat() + "+00:00",
        "start_hour": start_local.hour + start_local.minute / 60,
        "start_date": start_local.date().isoformat(),
        "weekday": start_local.weekday(),
    }


def build_routes(routes_dir, epsilon_m):
    """Build every ROUTES_DATA entry, ordered by filename like the existing file."""
    if not os.path.isdir(routes_dir):
        raise SystemExit(
            f"workout-routes directory not found at {routes_dir}\n"
            "Point --export-dir at your unzipped Apple Health export.")
    names = sorted(n for n in os.listdir(routes_dir) if n.lower().endswith(".gpx"))
    routes, skipped = [], []
    for n in names:
        entry = build_route(os.path.join(routes_dir, n), epsilon_m)
        if entry is None:
            skipped.append(n)
        else:
            routes.append(entry)
    if skipped:
        print(f"  !! skipped {len(skipped)} unreadable/empty GPX file(s): "
              + ", ".join(skipped[:5]) + (" ..." if len(skipped) > 5 else ""))
    unknown = [r["filename"] for r in routes if r["city"] == "Unknown"]
    if unknown:
        print(f"  !! {len(unknown)} track(s) fell outside every box in CITY_BOXES "
              "and are labelled \"Unknown\" — they will only appear under the "
              "\"all\" tab. Add a box for them if this is a new place:")
        for f in unknown[:10]:
            print(f"       {f}")
    return routes


def write_routes(epsilon_m=RDP_EPSILON_M, routes=None):
    if routes is None:
        routes = build_routes(ROUTES_DIR, epsilon_m)
    payload = json.dumps(routes, ensure_ascii=False, separators=(",", ":"))
    os.makedirs(os.path.dirname(OUT_ROUTES) or ".", exist_ok=True)
    with open(OUT_ROUTES, "w", encoding="utf-8") as f:
        f.write(f"window.ROUTES_DATA = {payload};\n")
    pts = sum(r["num_simplified"] for r in routes)
    print(f"Wrote {OUT_ROUTES} ({os.path.getsize(OUT_ROUTES)/1024:.1f} KB, "
          f"{len(routes)} tracks, {pts} polyline points)")
    return routes


def load_routes_js(path):
    """Read window.ROUTES_DATA back out of an existing routes.js."""
    with open(path, encoding="utf-8") as f:
        text = f.read().strip()
    start = text.index("[")
    end = text.rindex("]")
    return json.loads(text[start:end + 1])


# Fields whose values depend on the simplification algorithm rather than on
# the underlying GPX, so they are expected to differ from the committed file.
_DERIVED_FROM_SIMPLIFICATION = {"track", "num_simplified"}


def check_routes(epsilon_m=RDP_EPSILON_M):
    """Rebuild tracks from GPX and diff against the committed routes.js.

    Writes nothing. This exists because assets/routes.js was produced by a
    script that is no longer in the repo, so the rules used here (city boxes,
    speed units, the local-time convention) are reconstructed from its output
    and need checking against the real export before anything is overwritten.
    """
    if not os.path.exists(OUT_ROUTES):
        print(f"No existing {OUT_ROUTES} to compare against.")
        return 1
    existing = {r["filename"]: r for r in load_routes_js(OUT_ROUTES)}
    rebuilt = {r["filename"]: r for r in build_routes(ROUTES_DIR, epsilon_m)}

    added = sorted(set(rebuilt) - set(existing))
    missing = sorted(set(existing) - set(rebuilt))
    shared = sorted(set(existing) & set(rebuilt))

    print(f"\nexisting {len(existing)} tracks · rebuilt {len(rebuilt)} tracks "
          f"· {len(shared)} in both")
    if added:
        print(f"\nNEW — in the export but not in routes.js ({len(added)}):")
        for f in added:
            r = rebuilt[f]
            print(f"  + {f}  {r['city']}  {r['distance_km']:.2f} km  {r['start_date']}")
    if missing:
        print(f"\nGONE — in routes.js but not in the export ({len(missing)}):")
        for f in missing:
            print(f"  - {f}")

    fields = [k for k in (existing[shared[0]] if shared else {})
              if k not in _DERIVED_FROM_SIMPLIFICATION]
    mismatches = {}
    for f in shared:
        for k in fields:
            a, b = existing[f].get(k), rebuilt[f].get(k)
            if isinstance(a, float) and isinstance(b, float):
                same = math.isclose(a, b, rel_tol=1e-9, abs_tol=1e-9)
            else:
                same = a == b
            if not same:
                mismatches.setdefault(k, []).append((f, a, b))

    print(f"\nField check over {len(shared)} shared tracks "
          f"({len(fields)} fields, ignoring {sorted(_DERIVED_FROM_SIMPLIFICATION)}):")
    for k in fields:
        bad = mismatches.get(k, [])
        flag = "OK  " if not bad else "DIFF"
        print(f"  {flag} {k:<16} {len(shared) - len(bad)}/{len(shared)} match")
        for f, a, b in bad[:3]:
            print(f"         {f}\n           committed={a!r}\n           rebuilt  ={b!r}")
        if len(bad) > 3:
            print(f"         ... and {len(bad) - 3} more")

    if shared:
        deltas = [len(rebuilt[f]["track"]) - len(existing[f]["track"]) for f in shared]
        print(f"\nPolyline points (expected to differ — the original "
              f"simplification is not in the repo):")
        print(f"  committed total {sum(len(existing[f]['track']) for f in shared)}, "
              f"rebuilt total {sum(len(rebuilt[f]['track']) for f in shared)} "
              f"at epsilon={epsilon_m}m")
        print(f"  per-track change: min {min(deltas):+d}, max {max(deltas):+d}")

    if mismatches:
        print("\nSome fields do not reproduce — do not overwrite routes.js yet.")
        return 1
    print("\nEvery field outside the simplification reproduces exactly.")
    return 0


# ---- Stream parse export.xml: cycling workouts + daily body metrics ----

# Metric record types we want to collect from <Record .../> elements.
BODY_METRICS = {
    "HKQuantityTypeIdentifierRestingHeartRate":      "resting_hr",
    "HKQuantityTypeIdentifierHeartRateVariabilitySDNN": "hrv",
    "HKQuantityTypeIdentifierStepCount":             "steps",
    "HKQuantityTypeIdentifierFlightsClimbed":        "flights",
    "HKQuantityTypeIdentifierAppleExerciseTime":     "exercise_min",
    "HKQuantityTypeIdentifierRespiratoryRate":       "resp_rate",
    "HKQuantityTypeIdentifierOxygenSaturation":      "spo2",
    "HKQuantityTypeIdentifierWalkingHeartRateAverage": "walking_hr",
    "HKQuantityTypeIdentifierVO2Max":                "vo2max",
    "HKQuantityTypeIdentifierBodyMass":              "weight_kg",
}
# How to aggregate per day for metrics that emit many points/day.
METRIC_AGG = {
    "resting_hr": "last",   # one per day usually; take latest
    "hrv":        "mean",
    "steps":      "sum",
    "flights":    "sum",
    "exercise_min": "sum",
    "resp_rate":  "mean",
    "spo2":       "mean",
    "walking_hr": "mean",
    "vo2max":     "last",
    "weight_kg":  "last",
}
# Sleep categorical -> minutes asleep (excluding "Awake" and "InBed").
ASLEEP_VALUES = {
    "HKCategoryValueSleepAnalysisAsleepCore",
    "HKCategoryValueSleepAnalysisAsleepDeep",
    "HKCategoryValueSleepAnalysisAsleepREM",
    "HKCategoryValueSleepAnalysisAsleepUnspecified",
}


def iter_cycling_workouts(xml_path: str):
    """Yield dicts for each HKWorkoutActivityTypeCycling workout."""
    workout = None
    inside = False
    for event, elem in ET.iterparse(xml_path, events=("start", "end")):
        tag = elem.tag
        if event == "start" and tag == "Workout":
            if elem.get("workoutActivityType") == "HKWorkoutActivityTypeCycling":
                workout = {
                    "duration_min": float(elem.get("duration") or 0),
                    "start": elem.get("startDate"),
                    "end": elem.get("endDate"),
                    "source": elem.get("sourceName"),
                    "stats": {},
                    "route_path": None,
                    "indoor": False,
                    "weather_temp_f": None,
                    "weather_humidity": None,
                    "mets": None,
                }
                inside = True
        elif event == "end":
            if inside and tag == "WorkoutStatistics":
                t = elem.get("type", "")
                key = t.replace("HKQuantityTypeIdentifier", "")
                workout["stats"][key] = {
                    "sum": float(elem.get("sum")) if elem.get("sum") else None,
                    "avg": float(elem.get("average")) if elem.get("average") else None,
                    "min": float(elem.get("minimum")) if elem.get("minimum") else None,
                    "max": float(elem.get("maximum")) if elem.get("maximum") else None,
                    "unit": elem.get("unit"),
                }
            elif inside and tag == "MetadataEntry":
                k = elem.get("key"); v = elem.get("value")
                if k == "HKIndoorWorkout":
                    workout["indoor"] = (v == "1")
                elif k == "HKWeatherTemperature":
                    m = re.match(r"([\-\d.]+)", v or "")
                    if m:
                        workout["weather_temp_f"] = float(m.group(1))
                elif k == "HKWeatherHumidity":
                    m = re.match(r"([\-\d.]+)", v or "")
                    if m:
                        # Apple Health stores humidity as basis points (e.g. "7600 %" = 76%)
                        workout["weather_humidity"] = float(m.group(1)) / 10000.0
                elif k == "HKAverageMETs":
                    m = re.match(r"([\-\d.]+)", v or "")
                    if m:
                        workout["mets"] = float(m.group(1))
            elif inside and tag == "FileReference":
                workout["route_path"] = elem.get("path")
            elif tag == "Workout" and inside:
                yield workout
                workout = None
                inside = False
                elem.clear()


def parse_body_metrics(xml_path: str):
    """Single streaming pass over export.xml. Returns:
      daily:  { 'YYYY-MM-DD': { metric_name: aggregated_value, ... } }
      vo2max: [ {date, value} ] sorted ascending
      weight: [ {date, kg} ]
    """
    per_day = {}        # date -> metric -> list of values
    sleep_per_night = {}  # date -> minutes asleep (assigned to wake-up day's prior night)
    vo2max = []
    weight = []

    for ev, elem in ET.iterparse(xml_path, events=("end",)):
        tag = elem.tag
        if tag == "Record":
            t = elem.get("type", "")
            if t in BODY_METRICS:
                metric = BODY_METRICS[t]
                v = elem.get("value")
                if v is None:
                    elem.clear(); continue
                try:
                    val = float(v)
                except ValueError:
                    elem.clear(); continue
                start = elem.get("startDate")
                if start is None:
                    elem.clear(); continue
                try:
                    dt = parse_dt(start)
                except Exception:
                    elem.clear(); continue
                day = dt.strftime("%Y-%m-%d")
                if metric == "vo2max":
                    vo2max.append({"date": day, "value": round(val, 2)})
                elif metric == "weight_kg":
                    weight.append({"date": day, "kg": round(val, 2)})
                per_day.setdefault(day, {}).setdefault(metric, []).append(val)
            elif t == "HKCategoryTypeIdentifierSleepAnalysis":
                v = elem.get("value", "")
                if v in ASLEEP_VALUES:
                    sd = elem.get("startDate"); ed = elem.get("endDate")
                    if sd and ed:
                        try:
                            s = parse_dt(sd); e = parse_dt(ed)
                            mins = (e - s).total_seconds() / 60.0
                            if mins > 0:
                                # Attribute to the wake-up date (end date local).
                                day = e.strftime("%Y-%m-%d")
                                sleep_per_night[day] = sleep_per_night.get(day, 0) + mins
                        except Exception:
                            pass
            elem.clear()
        else:
            # Don't keep other large branches in memory.
            elem.clear()

    daily = {}
    for day, metrics in per_day.items():
        d = daily.setdefault(day, {})
        for m, vals in metrics.items():
            if not vals:
                continue
            agg = METRIC_AGG.get(m, "mean")
            if agg == "sum":
                d[m] = round(sum(vals), 1)
            elif agg == "last":
                d[m] = round(vals[-1], 2)
            else:
                d[m] = round(sum(vals) / len(vals), 2)
    for day, mins in sleep_per_night.items():
        daily.setdefault(day, {})["sleep_h"] = round(mins / 60.0, 2)

    vo2max.sort(key=lambda x: x["date"])
    weight.sort(key=lambda x: x["date"])
    return daily, vo2max, weight


# Body metrics carry no location, so "which city was I in on 2026-07-20" has
# to be inferred. Rides are the only geo-tagged thing in the export, so the
# ride timeline is cut into stays and each stay's window is grown outward
# into the silence around it — capped, because after a month of no rides the
# honest answer is "no idea", not a confident guess.
STAY_FILL_DAYS = 30


def build_stays(points, first_day, last_day):
    """Consecutive same-city days -> one stay, then fill the gaps between.

    `points` is every dated, located thing in the export — GPX tracks and
    rides both. Outside Sydney most tracks are walks, so deriving location
    from cycling workouts alone would leave 2024-2025 nearly blank.
    """
    located = sorted((w for w in points if w.get("city") and w["city"] != "Unknown"),
                     key=lambda w: w["date"])
    if not located:
        return []

    stays = []
    for w in located:
        if stays and stays[-1]["city"] == w["city"]:
            stays[-1]["last_ride"] = w["date"]
            stays[-1]["tracks"] += 1
        else:
            stays.append({"city": w["city"], "first_ride": w["date"],
                          "last_ride": w["date"], "tracks": 1})

    def d(x):
        return datetime.strptime(x, "%Y-%m-%d")

    def s(x):
        return x.strftime("%Y-%m-%d")

    # Each stay starts as [first track, last track] and grows outward by at
    # most STAY_FILL_DAYS. A gap between two stays is split at its midpoint so
    # the two windows meet without overlapping; when the gap is wider than
    # twice the cap the middle stays unattributed, which is the honest answer.
    for i, st in enumerate(stays):
        st["from"] = s(d(st["first_ride"]) - timedelta(days=STAY_FILL_DAYS))
        st["to"] = s(d(st["last_ride"]) + timedelta(days=STAY_FILL_DAYS))

    for i in range(len(stays) - 1):
        cur, nxt = stays[i], stays[i + 1]
        gap_days = (d(nxt["first_ride"]) - d(cur["last_ride"])).days
        mid = d(cur["last_ride"]) + timedelta(days=gap_days // 2)
        cur["to"] = s(min(d(cur["to"]), mid))
        nxt["from"] = s(max(d(nxt["from"]), mid + timedelta(days=1)))

    # Do not let the outer clamp eat into a stay: the first GPX track can
    # predate the first cycling workout, and clamping to that date pushed a
    # window's start past its own first track.
    if first_day:
        floor = min(d(first_day), d(stays[0]["first_ride"]))
        stays[0]["from"] = s(max(d(stays[0]["from"]), floor))
    if last_day:
        ceiling = max(d(last_day), d(stays[-1]["last_ride"]))
        stays[-1]["to"] = s(min(d(stays[-1]["to"]), ceiling))

    for st in stays:
        st["days"] = (d(st["to"]) - d(st["from"])).days + 1
    return stays


def build_city_list(workouts, routes, stays):
    """Per-city totals for the city picker, in descending track count."""
    def blank(c):
        return {"name": c, "rides": 0, "tracks": 0, "km": 0.0, "days": 0,
                "from": None, "to": None, "stays": 0}

    out = {}
    for r in routes:
        c = r.get("city")
        if not c or c == "Unknown":
            continue
        out.setdefault(c, blank(c))["tracks"] += 1
    for w in workouts:
        c = w.get("city")
        if not c or c == "Unknown":
            continue
        e = out.setdefault(c, blank(c))
        e["rides"] += 1
        e["km"] += w.get("distance_km") or 0
    for st in stays:
        e = out.get(st["city"])
        if not e:
            continue
        e["stays"] += 1
        span = (datetime.strptime(st["to"], "%Y-%m-%d")
                - datetime.strptime(st["from"], "%Y-%m-%d")).days + 1
        e["days"] += span
        e["from"] = st["from"] if not e["from"] else min(e["from"], st["from"])
        e["to"] = st["to"] if not e["to"] else max(e["to"], st["to"])
    for e in out.values():
        e["km"] = round(e["km"], 1)
    return sorted(out.values(), key=lambda e: (-e["tracks"], -e["rides"]))


def load_existing_routes():
    """Read a previously written assets/routes.js so --skip-routes still has
    somewhere to get the location timeline from."""
    try:
        text = open(OUT_ROUTES, encoding="utf-8").read()
        return json.loads(text[text.index("=") + 1:].rstrip().rstrip(";\n").rstrip(";"))
    except Exception:
        return []


def main(skip_routes=False, epsilon_m=RDP_EPSILON_M):
    print("Parsing workouts from export.xml ...")
    workouts = []
    for w in iter_cycling_workouts(EXPORT_XML):
        start_dt = parse_dt(w["start"])
        end_dt = parse_dt(w["end"])
        wo = {
            "id": start_dt.strftime("%Y%m%dT%H%M%S"),
            "date": start_dt.strftime("%Y-%m-%d"),
            "start_iso": start_dt.isoformat(),
            "end_iso": end_dt.isoformat(),
            "hour": start_dt.hour,
            "weekday": start_dt.weekday(),  # 0=Mon
            "duration_min": round(w["duration_min"], 2),
            "indoor": w["indoor"],
            "source": w["source"],
            "weather_temp_c": round((w["weather_temp_f"] - 32) * 5/9, 1) if w["weather_temp_f"] is not None else None,
            "weather_humidity": round(w["weather_humidity"], 2) if w["weather_humidity"] is not None else None,
            "mets": round(w["mets"], 2) if w["mets"] is not None else None,
        }
        st = w["stats"]
        d = st.get("DistanceCycling", {})
        e_active = st.get("ActiveEnergyBurned", {})
        e_basal = st.get("BasalEnergyBurned", {})
        hr = st.get("HeartRate", {})
        wo["distance_km"] = round(d.get("sum") or 0, 3)
        wo["active_kj"] = round(e_active.get("sum") or 0, 1)
        wo["basal_kj"] = round(e_basal.get("sum") or 0, 1)
        wo["active_kcal"] = round((e_active.get("sum") or 0) / 4.184, 1)
        wo["hr_avg"] = round(hr.get("avg") or 0, 1) if hr.get("avg") else None
        wo["hr_min"] = hr.get("min")
        wo["hr_max"] = hr.get("max")

        if wo["distance_km"] and wo["duration_min"]:
            wo["avg_speed_kmh"] = round(wo["distance_km"] / (wo["duration_min"]/60), 2)
        else:
            wo["avg_speed_kmh"] = None

        # GPX enrichment
        wo["route_file"] = None
        wo["city"] = None
        wo["track"] = None
        wo["elev_gain_m"] = None
        wo["elev_loss_m"] = None
        wo["elev_min_m"] = None
        wo["elev_max_m"] = None
        wo["max_speed_kmh"] = None
        wo["elev_series"] = None
        if w.get("route_path"):
            gpx_name = os.path.basename(w["route_path"])
            gpx_full = os.path.join(ROUTES_DIR, gpx_name)
            if os.path.exists(gpx_full):
                wo["route_file"] = gpx_name
                gd = parse_gpx(gpx_full)
                if gd:
                    wo["track"] = gd["track"]
                    if gd["track"]:
                        # Same CITY_BOXES the routes use, so a ride and its
                        # GPX track can never disagree about where it happened.
                        wo["city"] = classify_city(gd["track"][0][0], gd["track"][0][1])
                    wo["elev_gain_m"] = gd["elev_gain_m"]
                    wo["elev_loss_m"] = gd["elev_loss_m"]
                    wo["elev_min_m"] = gd["elev_min_m"]
                    wo["elev_max_m"] = gd["elev_max_m"]
                    wo["elev_series"] = gd["elev_series"]
                    if gd["max_speed_ms"] is not None:
                        wo["max_speed_kmh"] = round(gd["max_speed_ms"] * 3.6, 2)
                    # Prefer GPX distance when much larger (Apple sometimes undercounts)
                    if gd["distance_km"] > wo["distance_km"] * 1.05:
                        wo["distance_km_gpx"] = gd["distance_km"]
        workouts.append(wo)

    workouts.sort(key=lambda x: x["start_iso"])
    print(f"  -> {len(workouts)} cycling workouts")

    # Aggregations
    total_km = round(sum(w["distance_km"] for w in workouts), 1)
    total_min = round(sum(w["duration_min"] for w in workouts), 1)
    total_kcal = round(sum(w["active_kcal"] for w in workouts), 0)
    total_elev = round(sum((w["elev_gain_m"] or 0) for w in workouts), 0)
    longest = max(workouts, key=lambda w: w["distance_km"])
    fastest = max((w for w in workouts if w["avg_speed_kmh"]),
                  key=lambda w: w["avg_speed_kmh"], default=None)
    top_speed = max((w for w in workouts if w["max_speed_kmh"]),
                    key=lambda w: w["max_speed_kmh"], default=None)
    most_climb = max((w for w in workouts if w["elev_gain_m"]),
                     key=lambda w: w["elev_gain_m"], default=None)

    # Monthly
    monthly = {}
    for w in workouts:
        m = w["date"][:7]
        d = monthly.setdefault(m, {"month": m, "distance_km": 0, "duration_min": 0, "rides": 0, "kcal": 0, "elev_gain_m": 0})
        d["distance_km"] += w["distance_km"]
        d["duration_min"] += w["duration_min"]
        d["rides"] += 1
        d["kcal"] += w["active_kcal"]
        d["elev_gain_m"] += (w["elev_gain_m"] or 0)
    monthly_list = sorted(monthly.values(), key=lambda x: x["month"])
    for m in monthly_list:
        m["distance_km"] = round(m["distance_km"], 1)
        m["duration_min"] = round(m["duration_min"], 1)
        m["kcal"] = round(m["kcal"], 0)
        m["elev_gain_m"] = round(m["elev_gain_m"], 0)

    # Per-day for calendar heatmap
    daily = {}
    for w in workouts:
        d = daily.setdefault(w["date"], {"date": w["date"], "distance_km": 0, "rides": 0, "duration_min": 0})
        d["distance_km"] += w["distance_km"]
        d["duration_min"] += w["duration_min"]
        d["rides"] += 1
    for d in daily.values():
        d["distance_km"] = round(d["distance_km"], 2)
        d["duration_min"] = round(d["duration_min"], 1)

    # Weekday / hour distribution
    weekday_dist = [0]*7
    weekday_rides = [0]*7
    hour_rides = [0]*24
    for w in workouts:
        weekday_dist[w["weekday"]] += w["distance_km"]
        weekday_rides[w["weekday"]] += 1
        hour_rides[w["hour"]] += 1
    weekday_dist = [round(x, 1) for x in weekday_dist]

    # HR zones (simple buckets)
    hr_zones = {"<100": 0, "100-120": 0, "120-140": 0, "140-160": 0, ">=160": 0}
    for w in workouts:
        if not w["hr_avg"]:
            continue
        h = w["hr_avg"]
        if h < 100: hr_zones["<100"] += 1
        elif h < 120: hr_zones["100-120"] += 1
        elif h < 140: hr_zones["120-140"] += 1
        elif h < 160: hr_zones["140-160"] += 1
        else: hr_zones[">=160"] += 1

    # Speed buckets
    speed_buckets = {"<10": 0, "10-15": 0, "15-20": 0, "20-25": 0, ">=25": 0}
    for w in workouts:
        s = w["avg_speed_kmh"]
        if not s: continue
        if s < 10: speed_buckets["<10"] += 1
        elif s < 15: speed_buckets["10-15"] += 1
        elif s < 20: speed_buckets["15-20"] += 1
        elif s < 25: speed_buckets["20-25"] += 1
        else: speed_buckets[">=25"] += 1

    # Active days
    first_day = workouts[0]["date"]
    last_day = workouts[-1]["date"]

    # Longest streak of consecutive ride days
    days = sorted(daily.keys())
    streak = best = 1
    last = datetime.strptime(days[0], "%Y-%m-%d")
    for d in days[1:]:
        cur = datetime.strptime(d, "%Y-%m-%d")
        if (cur - last).days == 1:
            streak += 1
            best = max(best, streak)
        else:
            streak = 1
        last = cur

    summary = {
        "generated_at": datetime.utcnow().isoformat() + "Z",
        "ride_count": len(workouts),
        "active_days": len(daily),
        "first_ride": first_day,
        "last_ride": last_day,
        "total_distance_km": total_km,
        "total_duration_min": total_min,
        "total_duration_h": round(total_min/60, 1),
        "total_kcal": total_kcal,
        "total_elev_gain_m": total_elev,
        "longest_streak_days": best,
        "longest_ride": {"date": longest["date"], "distance_km": longest["distance_km"],
                         "duration_min": longest["duration_min"]},
        "fastest_avg": ({"date": fastest["date"], "kmh": fastest["avg_speed_kmh"]} if fastest else None),
        "top_speed": ({"date": top_speed["date"], "kmh": top_speed["max_speed_kmh"]} if top_speed else None),
        "most_climb": ({"date": most_climb["date"], "elev_gain_m": most_climb["elev_gain_m"]} if most_climb else None),
        "weekday_distance_km": weekday_dist,
        "weekday_rides": weekday_rides,
        "hour_rides": hour_rides,
        "hr_zones": hr_zones,
        "speed_buckets": speed_buckets,
    }

    print("Streaming body metrics (RHR / HRV / steps / sleep / VO2max) ...")
    body_daily, vo2max_series, weight_series = parse_body_metrics(EXPORT_XML)
    print(f"  -> {len(body_daily)} days with body metrics, "
          f"{len(vo2max_series)} VO2max readings")

    # Merge body metrics into daily aggregation. body_daily covers many days
    # without rides; we keep both.
    daily_full = {d["date"]: dict(d) for d in daily.values()}
    for day, m in body_daily.items():
        d = daily_full.setdefault(day, {"date": day, "distance_km": 0, "rides": 0, "duration_min": 0})
        d.update(m)
        d["date"] = day  # guard

    # Summary deltas: body adaptation during delivery period vs baseline.
    # Baseline = first 60 days of records; delivery = last 30 days.
    days_sorted = sorted(d for d in body_daily.keys())
    def baseline_vs_recent(metric, recent_days=30, baseline_days=60):
        if not days_sorted:
            return None
        baseline = [body_daily[d].get(metric) for d in days_sorted[:baseline_days]]
        baseline = [v for v in baseline if v is not None]
        recent = [body_daily[d].get(metric) for d in days_sorted[-recent_days:]]
        recent = [v for v in recent if v is not None]
        if not baseline or not recent:
            return None
        return {
            "baseline": round(sum(baseline) / len(baseline), 2),
            "recent":   round(sum(recent) / len(recent), 2),
            "delta":    round(sum(recent) / len(recent) - sum(baseline) / len(baseline), 2),
        }

    summary["body_deltas"] = {
        "resting_hr": baseline_vs_recent("resting_hr"),
        "hrv":        baseline_vs_recent("hrv"),
        "sleep_h":    baseline_vs_recent("sleep_h"),
        "resp_rate":  baseline_vs_recent("resp_rate"),
        "spo2":       baseline_vs_recent("spo2"),
        "steps":      baseline_vs_recent("steps"),
    }
    if vo2max_series:
        summary["vo2max_latest"] = vo2max_series[-1]["value"]
        summary["vo2max_first"]  = vo2max_series[0]["value"]
    if weight_series:
        summary["weight_latest_kg"] = weight_series[-1]["kg"]
        summary["weight_first_kg"]  = weight_series[0]["kg"]

    routes = load_existing_routes() if skip_routes else build_routes(ROUTES_DIR, epsilon_m)
    # Bound the stay windows by the body-metric series, not by the ride dates —
    # daily data starts weeks before the first recorded ride.
    daily_dates = sorted(daily_full)
    day_lo = daily_dates[0] if daily_dates else first_day
    day_hi = daily_dates[-1] if daily_dates else last_day
    loc_points = [{"date": r["start_date"], "city": r["city"]} for r in routes]
    loc_points += [{"date": w["date"], "city": w["city"]} for w in workouts if w.get("city")]
    stays = build_stays(loc_points, day_lo, day_hi)
    summary["cities"] = build_city_list(workouts, routes, stays)
    summary["stay_fill_days"] = STAY_FILL_DAYS

    out = {
        "summary": summary,
        "stays": stays,
        "monthly": monthly_list,
        "daily": sorted(daily_full.values(), key=lambda x: x["date"]),
        "workouts": workouts,
        "vo2max": vo2max_series,
        "weight": weight_series,
    }

    payload = json.dumps(out, ensure_ascii=False, separators=(",", ":"))

    for path, text in ((OUT_JSON, payload),
                       (OUT_JS, f"window.HEALTH_DATA = {payload};\n")):
        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            f.write(text)
        print(f"Wrote {path} ({os.path.getsize(path)/1024:.1f} KB)")

    if not skip_routes:
        write_routes(epsilon_m, routes)


if __name__ == "__main__":
    args = parse_args()
    configure_paths(args.export_dir, args.out_json, args.out_js,
                    args.out_routes)
    if args.check_routes:
        raise SystemExit(check_routes(args.rdp_epsilon))
    if args.routes_only:
        write_routes(args.rdp_epsilon)
        raise SystemExit(0)
    if not os.path.exists(EXPORT_XML):
        raise SystemExit(
            f"export.xml not found at {EXPORT_XML}\n"
            "Unzip your Apple Health export there, or pass --export-dir.")
    main(skip_routes=args.skip_routes, epsilon_m=args.rdp_epsilon)
