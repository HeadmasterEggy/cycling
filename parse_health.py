#!/usr/bin/env python3
"""Parse Apple Health export.xml and GPX route files into a single JSON
payload consumed by cycling-analysis.html."""

import json
import os
import re
import math
from datetime import datetime, timedelta
from xml.etree import ElementTree as ET

EXPORT_DIR = "/Users/joey/cycling/data/apple_health_export"
EXPORT_XML = os.path.join(EXPORT_DIR, "export.xml")
ROUTES_DIR = os.path.join(EXPORT_DIR, "workout-routes")
OUT_JSON = "/Users/joey/cycling/health_data.json"

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


def parse_gpx(path: str):
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
        speed = None
        if ext is not None:
            sp = ext.find("ge:speed", GPX_NS)
            if sp is not None and sp.text:
                try:
                    speed = float(sp.text)
                except ValueError:
                    speed = None
        pts.append({
            "lat": lat,
            "lon": lon,
            "ele": float(ele.text) if ele is not None and ele.text else None,
            "t": time.text if time is not None and time.text else None,
            "speed": speed,
        })
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


def main():
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

    out = {
        "summary": summary,
        "monthly": monthly_list,
        "daily": sorted(daily_full.values(), key=lambda x: x["date"]),
        "workouts": workouts,
        "vo2max": vo2max_series,
        "weight": weight_series,
    }

    with open(OUT_JSON, "w") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
    print(f"Wrote {OUT_JSON} ({os.path.getsize(OUT_JSON)/1024:.1f} KB)")


if __name__ == "__main__":
    main()
