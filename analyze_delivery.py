#!/usr/bin/env python3
"""
Delivery-shift analyser. Reads the raw Apple Health GPX tracks and answers
one question the rest of the site does not: *where is the work worth doing?*

The Apple export has no orders in it — only 1 Hz position, speed and
elevation. Everything here is inferred from that:

  order      a run of >= STOP_SECONDS below STOP_SPEED. A pickup or a
             drop-off both look the same from the outside: the bike parks
             for a couple of minutes. Traffic lights are shorter, so they
             fall into the separate "wait" bucket instead of inflating the
             order count. See --stop-seconds to move the line.
  zone       ABS 2016 suburb polygon the point falls inside (suburbs_sydney.json).
             Point-in-polygon, not nearest-centroid — a centroid lookup put
             stops in the wrong suburb wherever two suburbs interlock, which
             inner Sydney does constantly.
  flow       0-100 composite of how easy a zone is to ride: moving speed,
             waits per km, climb per km, and how much of the moving time is
             spent crawling. Weights are in FLOW_WEIGHTS and printed on the
             page, because a single number is only honest if you can see
             what went into it.

Writes assets/delivery-data.js (window.DELIVERY_DATA) and delivery_data.json.

    python3 analyze_delivery.py
    python3 analyze_delivery.py --stop-seconds 120 --dry-run
"""
import argparse
import json
import math
import os
import re
import statistics as st
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from xml.etree import ElementTree as ET

try:
    from zoneinfo import ZoneInfo
    SYD_TZ = ZoneInfo("Australia/Sydney")
except Exception:                                    # pragma: no cover
    SYD_TZ = timezone(timedelta(hours=10))

ROOT = Path(__file__).parent
GPX_NS = "{http://www.topografix.com/GPX/1/1}"

# -- thresholds -------------------------------------------------------------
STOP_SPEED = 0.7      # m/s. Below this the bike is parked, not rolling.
STOP_SECONDS = 90     # >= this long and it is an order, not a red light.
WAIT_SECONDS = 20     # 20-90 s stopped is traffic friction.
CRAWL_SPEED = 2.2     # m/s. Above STOP_SPEED but slower than a walk-ish pace.
CLUSTER_M = 70        # hotspot merge radius
CELL_M = 60           # friction grid cell
MIN_SHIFT_ORDERS = 3  # fewer than this and the ride was not a work shift
MIN_SHIFT_MINUTES = 40

FLOW_WEIGHTS = {"speed": 0.40, "waits": 0.25, "climb": 0.20, "crawl": 0.15}

# Sydney only — the other cities in the export are holiday riding, not work.
SYD_BOX = (-34.30, -33.50, 150.80, 151.50)


# -- geometry ---------------------------------------------------------------
def haversine(lat1, lon1, lat2, lon2):
    R = 6371000.0
    p = math.radians
    dlat, dlon = p(lat2 - lat1), p(lon2 - lon1)
    a = math.sin(dlat / 2) ** 2 + math.cos(p(lat1)) * math.cos(p(lat2)) * math.sin(dlon / 2) ** 2
    return 2 * R * math.asin(math.sqrt(a))


def _point_in_ring(ring, x, y):
    inside = False
    n = len(ring)
    j = n - 1
    for i in range(n):
        xi, yi = ring[i]
        xj, yj = ring[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
            inside = not inside
        j = i
    return inside


class SuburbIndex:
    """Point-in-polygon suburb lookup with a coarse grid to skip most rings.

    136 polygons x ~100k track points is 14M ring tests done naively; bucketing
    ring bounding boxes into 0.01 degree tiles cuts it to a handful per point.
    """

    TILE = 0.01

    def __init__(self, path):
        self.subs = json.loads(Path(path).read_text(encoding="utf-8"))
        self.tiles = defaultdict(list)
        for si, s in enumerate(self.subs):
            for ring in s["rings"]:
                xs = [p[0] for p in ring]
                ys = [p[1] for p in ring]
                bbox = (min(xs), max(xs), min(ys), max(ys))
                for tx in range(int(bbox[0] / self.TILE), int(bbox[1] / self.TILE) + 1):
                    for ty in range(int(bbox[2] / self.TILE) - 1, int(bbox[3] / self.TILE) + 1):
                        self.tiles[(tx, ty)].append((si, ring, bbox))
        self._cache = {}

    def lookup(self, lat, lon):
        key = (round(lat, 4), round(lon, 4))       # ~11 m — plenty for a suburb
        hit = self._cache.get(key)
        if hit is not None:
            return hit
        name = None
        for si, ring, (x0, x1, y0, y1) in self.tiles.get(
                (int(lon / self.TILE), int(lat / self.TILE)), ()):
            if x0 <= lon <= x1 and y0 <= lat <= y1 and _point_in_ring(ring, lon, lat):
                name = self.subs[si]["name"]
                break
        self._cache[key] = name
        return name

    def meta(self, name):
        for s in self.subs:
            if s["name"] == name:
                return s
        return None


# -- GPX --------------------------------------------------------------------
def read_track(path):
    """Every <trkpt> as a dict. Speed comes from Apple's <extensions>."""
    pts = []
    for tp in ET.parse(path).getroot().iter(GPX_NS + "trkpt"):
        ele = tp.find(GPX_NS + "ele")
        tm = tp.find(GPX_NS + "time")
        if tm is None:
            continue
        speed = hacc = None
        ext = tp.find(GPX_NS + "extensions")
        if ext is not None:
            for child in ext.iter():
                tag = child.tag.rsplit("}", 1)[-1]
                if tag == "speed" and child.text:
                    speed = float(child.text)
                elif tag == "hAcc" and child.text:
                    hacc = float(child.text)
        pts.append({
            "lat": float(tp.get("lat")),
            "lon": float(tp.get("lon")),
            "ele": float(ele.text) if ele is not None and ele.text else 0.0,
            "t": datetime.strptime(tm.text, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc),
            "v": speed if speed is not None else 0.0,
            "hacc": hacc if hacc is not None else 99.0,
        })
    return pts


def in_sydney(pts):
    if not pts:
        return False
    lat, lon = pts[len(pts) // 2]["lat"], pts[len(pts) // 2]["lon"]
    return SYD_BOX[0] <= lat <= SYD_BOX[1] and SYD_BOX[2] <= lon <= SYD_BOX[3]


def find_stops(pts, min_seconds, max_seconds=None):
    """Runs of consecutive sub-STOP_SPEED points, as (start_i, end_i, seconds)."""
    out = []
    i, n = 0, len(pts)
    while i < n:
        if pts[i]["v"] < STOP_SPEED:
            j = i
            while j + 1 < n and pts[j + 1]["v"] < STOP_SPEED:
                j += 1
            secs = (pts[j]["t"] - pts[i]["t"]).total_seconds()
            if secs >= min_seconds and (max_seconds is None or secs < max_seconds):
                out.append((i, j, secs))
            i = j + 1
        else:
            i += 1
    return out


def smooth_elevation(pts, window=9):
    """Median-smooth the barometric trace before differencing it.

    Raw Apple elevation wanders a metre or two point to point; differencing it
    unsmoothed turns a flat street into 40 m/km of "climb".
    """
    ele = [p["ele"] for p in pts]
    if len(ele) < window:
        return ele
    half = window // 2
    out = list(ele)
    for i in range(half, len(ele) - half):
        out[i] = st.median(ele[i - half:i + half + 1])
    return out


# -- per-ride pass ----------------------------------------------------------
def analyse_ride(path, idx, args):
    pts = read_track(path)
    if len(pts) < 60 or not in_sydney(pts):
        return None

    ele = smooth_elevation(pts)
    n = len(pts)

    orders = find_stops(pts, args.stop_seconds)
    waits = find_stops(pts, WAIT_SECONDS, args.stop_seconds)
    order_idx = {i for s, e, _ in orders for i in range(s, e + 1)}

    # Per-sample enrichment: distance / dt to the next point, and the state.
    samples = []
    for i in range(n - 1):
        a, b = pts[i], pts[i + 1]
        dt = (b["t"] - a["t"]).total_seconds()
        if dt <= 0 or dt > 120:            # gap: recording paused, skip it
            continue
        d = haversine(a["lat"], a["lon"], b["lat"], b["lon"])
        if d > 60:                         # GPS jump, not a 200 km/h sprint
            continue
        v = a["v"]
        grade = 0.0
        if d > 3:
            grade = max(-0.20, min(0.20, (ele[i + 1] - ele[i]) / d))
        samples.append({
            "lat": a["lat"], "lon": a["lon"], "t": a["t"], "dt": dt, "d": d,
            "v": v, "grade": grade,
            "state": "stop" if v < STOP_SPEED else ("crawl" if v < CRAWL_SPEED else "move"),
            "in_order": i in order_idx,
        })

    start_local = pts[0]["t"].astimezone(SYD_TZ)
    total_s = (pts[-1]["t"] - pts[0]["t"]).total_seconds()
    ride = {
        "id": Path(path).stem,
        "date": start_local.strftime("%Y-%m-%d"),
        "start_local": start_local.isoformat(timespec="seconds"),
        "hour": start_local.hour + start_local.minute / 60,
        "weekday": start_local.weekday(),
        "seconds": total_s,
        "km": sum(s["d"] for s in samples) / 1000,
        "orders": [],
        "waits": len(waits),
        "samples": samples,
        "start_pt": (pts[0]["lat"], pts[0]["lon"]),
        "end_pt": (pts[-1]["lat"], pts[-1]["lon"]),
    }
    for s, e, secs in orders:
        seg = pts[s:e + 1]
        ride["orders"].append({
            "lat": sum(p["lat"] for p in seg) / len(seg),
            "lon": sum(p["lon"] for p in seg) / len(seg),
            "secs": secs,
            "t": pts[s]["t"].astimezone(SYD_TZ),
            "ride": ride["id"],
        })
    ride["is_shift"] = (len(ride["orders"]) >= MIN_SHIFT_ORDERS
                        and total_s >= MIN_SHIFT_MINUTES * 60)
    return ride


# -- aggregation ------------------------------------------------------------
def cluster_stops(all_orders, radius=CLUSTER_M):
    """Greedy leader clustering — longest dwell seeds each cluster.

    DBSCAN would be tidier but pulls in a dependency, and with a few hundred
    points the greedy pass lands in the same place: a restaurant visited eight
    times reads as one hotspot either way.
    """
    clusters = []
    for o in sorted(all_orders, key=lambda x: -x["secs"]):
        for c in clusters:
            if haversine(c["lat"], c["lon"], o["lat"], o["lon"]) < radius:
                c["members"].append(o)
                k = len(c["members"])
                c["lat"] = sum(m["lat"] for m in c["members"]) / k
                c["lon"] = sum(m["lon"] for m in c["members"]) / k
                break
        else:
            clusters.append({"lat": o["lat"], "lon": o["lon"], "members": [o]})
    return clusters


def norm(value, lo, hi):
    """Map value into 0-1 with lo -> 0, hi -> 1 (inverted when hi < lo)."""
    if hi == lo:
        return 0.5
    return max(0.0, min(1.0, (value - lo) / (hi - lo)))


def flow_score(med_speed_kmh, waits_per_km, climb_per_km, crawl_share):
    w = FLOW_WEIGHTS
    return round(100 * (
        w["speed"] * norm(med_speed_kmh, 8, 22)
        + w["waits"] * norm(waits_per_km, 4.0, 0.0)
        + w["climb"] * norm(climb_per_km, 26, 0)
        + w["crawl"] * norm(crawl_share, 0.45, 0.05)
    ), 1)


DROPPED = [0]


def build(rides, subs, args):
    DROPPED[0] = 0
    shifts = [r for r in rides if r["is_shift"]]
    if not shifts:
        raise SystemExit("no delivery shifts found — try a lower --stop-seconds")

    # ---- zones ------------------------------------------------------------
    Z = defaultdict(lambda: {
        "orders": 0, "dwell": [], "secs": 0.0, "move_secs": 0.0, "crawl_secs": 0.0,
        "stop_secs": 0.0, "m": 0.0, "speeds": [], "climb": 0.0, "waits": 0,
        "shifts": set(), "hours": defaultdict(int),
    })
    for r in shifts:
        for s in r["samples"]:
            name = subs.lookup(s["lat"], s["lon"])
            if not name:
                continue
            z = Z[name]
            z["secs"] += s["dt"]
            z["m"] += s["d"]
            z["shifts"].add(r["id"])
            if s["state"] == "move":
                z["move_secs"] += s["dt"]
                z["speeds"].append(s["v"] * 3.6)
            elif s["state"] == "crawl":
                z["crawl_secs"] += s["dt"]
            else:
                z["stop_secs"] += s["dt"]
            if s["grade"] > 0:
                z["climb"] += s["grade"] * s["d"]

    for r in shifts:
        for o in r["orders"]:
            if is_endpoint_stop(r, o):
                DROPPED[0] += 1
                continue
            name = subs.lookup(o["lat"], o["lon"])
            if not name:
                continue
            Z[name]["orders"] += 1
            Z[name]["dwell"].append(o["secs"])
            Z[name]["hours"][o["t"].hour] += 1
    for r in shifts:
        for i, j, _ in find_stops(
                [{"v": s["v"], "t": s["t"]} for s in r["samples"]],
                WAIT_SECONDS, args.stop_seconds):
            name = subs.lookup(r["samples"][i]["lat"], r["samples"][i]["lon"])
            if name:
                Z[name]["waits"] += 1

    zones = []
    for name, z in Z.items():
        km = z["m"] / 1000
        if km < 0.4 and z["orders"] == 0:
            continue                       # clipped a corner, nothing to say
        hours = z["secs"] / 3600
        med_speed = st.median(z["speeds"]) if z["speeds"] else 0.0
        waits_km = z["waits"] / km if km else 0.0
        climb_km = z["climb"] / km if km else 0.0
        moving = z["move_secs"] + z["crawl_secs"]
        crawl_share = z["crawl_secs"] / moving if moving else 0.0
        meta = subs.meta(name) or {}
        zones.append({
            "name": name,
            "lga": (meta.get("lga") or "").replace(" (City)", "").replace(" (Area)", ""),
            "c": meta.get("c"),
            "orders": z["orders"],
            "shifts": len(z["shifts"]),
            "hours": round(hours, 2),
            "km": round(km, 2),
            "med_speed": round(med_speed, 1),
            "waits_per_km": round(waits_km, 2),
            "climb_per_km": round(climb_km, 1),
            "crawl_share": round(crawl_share, 3),
            "dwell_med": round(st.median(z["dwell"])) if z["dwell"] else 0,
            "orders_per_hour": round(z["orders"] / hours, 2) if hours > 0.05 else 0.0,
            "km_per_order": round(km / z["orders"], 2) if z["orders"] else None,
            "flow": flow_score(med_speed, waits_km, climb_km, crawl_share),
            "hour_hist": [z["hours"].get(h, 0) for h in range(24)],
            # Orders/hour off 8 minutes in a suburb is noise, not a rate.
            # `ranked` marks the zones with enough exposure to compare.
            "ranked": len(z["shifts"]) >= 3 and hours >= 0.5,
        })
    # "Worth going" = how fast the orders come in, discounted by how hard the
    # riding is. Unranked zones get no score rather than a flattering one.
    rate_cap = max([z["orders_per_hour"] for z in zones if z["ranked"]] or [1]) or 1
    for z in zones:
        z["worth"] = (round(100 * (z["orders_per_hour"] / rate_cap) * (z["flow"] / 100), 1)
                      if z["ranked"] else None)
    zones.sort(key=lambda x: (-x["orders"], -x["hours"]))
    for i, z in enumerate(zones, 1):
        z["rank"] = i
    # Only zones with real presence get an outline on the map.
    for z in zones:
        meta = subs.meta(z["name"])
        z["ring"] = meta["rings"][0] if (meta and z["orders"] >= 1) else None

    return zones, DROPPED[0]


ENDPOINT_M = 150


def is_endpoint_stop(ride, order):
    """True when a stop sits on the ride's own start or end point.

    Parking where the shift began or ended is the couch, not a customer.
    An earlier version clustered every shift's endpoints and called the
    densest one "home", but the starts scatter — GPS locks half a block
    along, and not every shift leaves from the same door — so the cluster
    never crossed the threshold and nothing got excluded. Comparing each
    stop against its own ride needs no threshold and cannot mislabel a
    genuinely busy suburb as somebody's living room.
    """
    for pt in (ride["start_pt"], ride["end_pt"]):
        if haversine(pt[0], pt[1], order["lat"], order["lon"]) < ENDPOINT_M:
            return True
    return False


# -- street-level grid ------------------------------------------------------
class Grid:
    """Equirectangular metre grid. Cheap, and over 15 km of city it is exact
    enough that a 60 m cell stays a 60 m cell."""

    def __init__(self, lat0, lon0, size=CELL_M):
        self.lat0, self.lon0, self.size = lat0, lon0, size
        self.kx = 111320.0 * math.cos(math.radians(lat0))
        self.ky = 110540.0

    def key(self, lat, lon):
        return (int(round((lon - self.lon0) * self.kx / self.size)),
                int(round((lat - self.lat0) * self.ky / self.size)))

    def center(self, key):
        return (self.lat0 + key[1] * self.size / self.ky,
                self.lon0 + key[0] * self.size / self.kx)


def build_cells(shifts, grid):
    cells = defaultdict(lambda: {
        "secs": 0.0, "m": 0.0, "speeds": [], "grades": [], "waits": 0,
        "shifts": set(), "stop_secs": 0.0,
    })
    for r in shifts:
        for s in r["samples"]:
            k = grid.key(s["lat"], s["lon"])
            c = cells[k]
            c["secs"] += s["dt"]
            c["m"] += s["d"]
            c["shifts"].add(r["id"])
            if s["state"] == "stop":
                c["stop_secs"] += s["dt"]
            else:
                c["speeds"].append(s["v"] * 3.6)
                c["grades"].append(s["grade"])
    return cells


NEIGHBOURS = [(1, 0), (0, 1), (-1, 0), (0, -1), (1, 1), (1, -1), (-1, 1), (-1, -1)]


def build_corridors(cells, grid, subs, min_shifts=3, max_out=140):
    """Chain busy adjacent cells into street-shaped runs.

    A single 60 m cell is not a road you can think about; a chain of them is.
    Growth stops when the next cell is much quieter than the one before, so a
    busy artery does not absorb every side street that touches it.
    """
    busy = {k: v for k, v in cells.items() if len(v["shifts"]) >= min_shifts and v["m"] > 20}
    used = set()
    corridors = []
    for seed in sorted(busy, key=lambda k: -len(busy[k]["shifts"])):
        if seed in used:
            continue
        chain = [seed]
        used.add(seed)
        for direction in (1, -1):
            cur = seed
            while True:
                base = len(busy[cur]["shifts"])
                nxt, best = None, 0
                for dx, dy in NEIGHBOURS:
                    cand = (cur[0] + dx, cur[1] + dy)
                    if cand in used or cand not in busy:
                        continue
                    n = len(busy[cand]["shifts"])
                    if n > best and n >= base * 0.65:
                        nxt, best = cand, n
                if nxt is None or len(chain) > 60:
                    break
                used.add(nxt)
                chain.append(nxt) if direction == 1 else chain.insert(0, nxt)
                cur = nxt
        if len(chain) < 3:
            continue
        speeds, grades, secs, metres, stop_secs = [], [], 0.0, 0.0, 0.0
        ridden = set()
        for k in chain:
            c = busy[k]
            speeds += c["speeds"]
            grades += c["grades"]
            secs += c["secs"]
            metres += c["m"]
            stop_secs += c["stop_secs"]
            ridden |= c["shifts"]
        if not speeds or metres < 120:
            continue
        pts = [grid.center(k) for k in chain]
        med_speed = st.median(speeds)
        up = st.mean([g for g in grades if g > 0]) if any(g > 0 for g in grades) else 0.0
        # Time lost against a 18 km/h free-running pace, over all passes.
        free = metres / (18 / 3.6)
        names = [n for n in (subs.lookup(p[0], p[1]) for p in pts) if n]
        lost = max(0.0, secs - free) / 60
        # A corridor is named by where it runs from and to. Two different
        # streets inside one suburb otherwise come out with the same label,
        # and the list reads like a stutter.
        head = next((n for n in names), None)
        tail = next((n for n in reversed(names)), None)
        label = head if (not tail or head == tail) else f"{head} → {tail}"
        corridors.append({
            "passes": len(ridden),
            "cells": len(chain),
            "len_m": round(metres / max(1, len(ridden))),
            "med_speed": round(med_speed, 1),
            "grade_up": round(up * 100, 1),
            "stop_share": round(stop_secs / secs, 3) if secs else 0,
            "lost_min": round(lost, 1),
            # Total lost time just re-ranks the longest, most-ridden roads.
            # Per pass is the number that answers "what does this cost me
            # every time I ride it".
            "lost_per_pass": round(lost / max(1, len(ridden)), 2),
            "zone": label,
            "zones": sorted(set(names)),
            "track": [[round(p[0], 5), round(p[1], 5)] for p in pts],
        })
    corridors.sort(key=lambda c: -c["passes"])
    return corridors[:max_out]


# -- main -------------------------------------------------------------------
def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--export-dir", default=str(ROOT / "data" / "apple_health_export"))
    ap.add_argument("--suburbs", default=str(ROOT / "suburbs_sydney.json"))
    ap.add_argument("--stop-seconds", type=int, default=STOP_SECONDS,
                    help="dwell that counts as an order (default 90)")
    ap.add_argument("--dry-run", action="store_true", help="print, do not write")
    args = ap.parse_args()

    routes_dir = Path(args.export_dir) / "workout-routes"
    files = sorted(routes_dir.glob("*.gpx"))
    if not files:
        raise SystemExit(f"no GPX under {routes_dir}")
    subs = SuburbIndex(args.suburbs)
    print(f"Reading {len(files)} GPX tracks from {routes_dir} ...")

    rides = []
    for i, f in enumerate(files):
        r = analyse_ride(f, i, args)
        if r:
            rides.append(r)
    shifts = [r for r in rides if r["is_shift"]]
    print(f"  -> {len(rides)} Sydney tracks, {len(shifts)} of them work shifts "
          f"(>= {MIN_SHIFT_ORDERS} orders and >= {MIN_SHIFT_MINUTES} min)")

    zones, dropped = build(rides, subs, args)
    print(f"  -> {len(zones)} suburbs touched, {dropped} stop(s) dropped as shift endpoints")

    lat0 = st.mean([s["lat"] for r in shifts for s in r["samples"][::50]])
    lon0 = st.mean([s["lon"] for r in shifts for s in r["samples"][::50]])
    dropped_endpoint_stops = dropped
    grid = Grid(lat0, lon0)
    cells = build_cells(shifts, grid)
    corridors = build_corridors(cells, grid, subs)
    print(f"  -> {len(cells)} grid cells, {len(corridors)} corridors")

    all_orders = [o for r in shifts for o in r["orders"] if not is_endpoint_stop(r, o)]
    clusters = cluster_stops(all_orders)
    hotspots = []
    for c in sorted(clusters, key=lambda c: -len(c["members"])):
        if len(c["members"]) < 2:
            continue
        durs = [m["secs"] for m in c["members"]]
        hh = defaultdict(int)
        for m in c["members"]:
            hh[m["t"].hour] += 1
        hotspots.append({
            "lat": round(c["lat"], 5), "lon": round(c["lon"], 5),
            "zone": subs.lookup(c["lat"], c["lon"]),
            "visits": len(durs),
            "shifts": len({m["ride"] for m in c["members"]}),
            "dwell_med": round(st.median(durs)),
            "dwell_total_min": round(sum(durs) / 60, 1),
            "hours": [hh.get(h, 0) for h in range(24)],
        })
    print(f"  -> {len(clusters)} stop clusters, {len(hotspots)} revisited hotspots")

    shift_rows = []
    for r in sorted(shifts, key=lambda r: r["start_local"]):
        hrs = r["seconds"] / 3600
        zc = defaultdict(int)
        for o in r["orders"]:
            nm = subs.lookup(o["lat"], o["lon"])
            if nm:
                zc[nm] += 1
        shift_rows.append({
            "id": r["id"], "date": r["date"], "start": r["start_local"][11:16],
            "hour": round(r["hour"], 2), "weekday": r["weekday"],
            "hours": round(hrs, 2), "km": round(r["km"], 1),
            "orders": len(r["orders"]),
            "orders_per_hour": round(len(r["orders"]) / hrs, 2) if hrs else 0,
            "top_zone": max(zc, key=zc.get) if zc else None,
        })

    tot_orders = sum(s["orders"] for s in shift_rows)
    tot_hours = sum(s["hours"] for s in shift_rows)
    tot_km = sum(s["km"] for s in shift_rows)
    ranked = [z for z in zones if z["ranked"] and z["orders"] >= 2]
    sweet = sorted(ranked, key=lambda z: -(z["worth"] or 0))

    hour_totals = [0] * 24
    for z in zones:
        for h in range(24):
            hour_totals[h] += z["hour_hist"][h]

    data = {
        "meta": {
            "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "city": "Sydney", "tz": "Australia/Sydney",
            "stop_speed_ms": STOP_SPEED, "stop_seconds": args.stop_seconds,
            "wait_seconds": WAIT_SECONDS, "crawl_speed_ms": CRAWL_SPEED,
            "cell_m": CELL_M, "cluster_m": CLUSTER_M,
            "flow_weights": FLOW_WEIGHTS,
            "shifts": len(shift_rows), "sydney_tracks": len(rides),
            "first": shift_rows[0]["date"], "last": shift_rows[-1]["date"],
            "suburb_source": "ABS 2016 SSC boundaries via michalsn/australian-suburbs (MIT)",
            # The site is public. Stops on a shift's own start/end point are
            # dropped before anything downstream sees them, so the map never
            # grows a bright circle over wherever the rider lives.
            "endpoint_m": ENDPOINT_M,
            "endpoint_stops_dropped": dropped_endpoint_stops,
        },
        "summary": {
            "orders": tot_orders,
            "hours": round(tot_hours, 1),
            "km": round(tot_km, 1),
            "orders_per_hour": round(tot_orders / tot_hours, 2) if tot_hours else 0,
            "km_per_order": round(tot_km / tot_orders, 2) if tot_orders else 0,
            "min_per_order": round(tot_hours * 60 / tot_orders, 1) if tot_orders else 0,
            "zones_touched": len(zones),
            "top_zone": zones[0]["name"] if zones else None,
            "sweet_zone": sweet[0]["name"] if sweet else None,
            "peak_hour": max(range(24), key=lambda h: hour_totals[h]),
            "hour_totals": hour_totals,
        },
        "zones": zones,
        "ranked_zones": [z["name"] for z in ranked],
        "hotspots": hotspots[:120],
        "corridors": corridors,
        "shifts": shift_rows,
    }

    if args.dry_run:
        print(json.dumps(data["summary"], indent=2, ensure_ascii=False))
        return

    payload = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
    (ROOT / "assets" / "delivery-data.js").write_text(
        "window.DELIVERY_DATA = " + payload + ";\n", encoding="utf-8")
    (ROOT / "delivery_data.json").write_text(
        json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
    kb = len(payload) / 1024
    print(f"Wrote {ROOT / 'assets' / 'delivery-data.js'} ({kb:.1f} KB)")
    print(f"Wrote {ROOT / 'delivery_data.json'}")
    print(f"  {tot_orders} orders · {tot_hours:.1f} h · {tot_km:.0f} km · "
          f"{data['summary']['orders_per_hour']:.2f} orders/h")


if __name__ == "__main__":
    main()
