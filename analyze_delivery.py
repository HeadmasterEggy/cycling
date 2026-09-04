#!/usr/bin/env python3
"""
Delivery-shift analyser. Reads the raw Apple Health GPX tracks and answers
one question the rest of the site does not: *where is the work worth doing?*

The Apple export has no orders in it — only 1 Hz position, speed, course and
elevation. Everything here is inferred from that, plus the map context cached
by `fetch_osm.py` (traffic signals, food venues, road centre-lines).

  dwell      a stay in one place. Detected as a run below STOP_SPEED, then
             merged across short low-speed excursions — walking an order to a
             door breaks a naive stop run into three, and counting those as
             three jobs was the single biggest error in the old numbers.
  stop kind  every dwell is classified 等灯 / 取餐 / 送达 by weighing evidence
             that a human would use: how long it lasted, how far it sits from
             the nearest traffic signal, how far from the nearest restaurant,
             how much ground the rider covered while "stopped", and whether
             they left the way they came in. Duration alone was the old rule
             and it is wrong in both directions — a 98 s wait at a six-lane
             intersection is not an order, and an 81 s stop at a restaurant
             you visit fourteen times is.
  order      one completed delivery = one 送达. Pickups are counted too, but
             adding them to the order count double-counts every job.
  zone       ABS 2016 suburb polygon the point falls inside. Point-in-polygon,
             not nearest-centroid — a centroid lookup put stops in the wrong
             suburb wherever two suburbs interlock, which inner Sydney does
             constantly.
  flow       0-100 composite of how easy a zone is to ride. Components are
             normalised against the exposure-weighted 10th/90th percentile of
             the data itself rather than hand-picked bounds, and every zone's
             value is shrunk toward the city figure in proportion to how
             little was ridden there, so eight minutes in a suburb cannot
             produce a confident score.

Writes assets/delivery-data.js (window.DELIVERY_DATA) and delivery_data.json.

    python3 fetch_osm.py            # once, or when you want fresher map data
    python3 analyze_delivery.py
    python3 analyze_delivery.py --dry-run
"""
import argparse
import json
import math
import random
import statistics as st
from collections import Counter, defaultdict
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
STOP_SPEED = 0.7      # m/s. Below this the bike is not rolling.
CORE_SECONDS = 12     # shortest run of stillness worth treating as a stop
DWELL_SECONDS = 20    # shortest dwell that gets classified at all
CRAWL_SPEED = 2.2     # m/s. Rolling, but slower than walking pace.
# Merging two still runs into one dwell: the excursion between them has to be
# short, local and slow — i.e. the rider walked, they did not ride away.
MERGE_GAP_S = 100
MERGE_GAP_M = 70
MERGE_GAP_V = 3.2
CLUSTER_M = 35        # repeat-visit radius. A venue revisited reads as one place.
# Pickup evidence. A place is a restaurant either because the rider keeps
# going back to it and the map agrees there is food there (anchor), or because
# the rider is standing on top of somewhere that cooks (solo).
ANCHOR_SHIFTS = 2
ANCHOR_VENUE_M = 30
SOLO_VENUE_M = 25
HOTSPOT_M = 45        # map hotspot merge radius
CELL_M = 60           # friction grid cell
MIN_SHIFT_ORDERS = 2  # fewer than this and the ride was not a work shift
MIN_SHIFT_MINUTES = 40

# Free-running pace: the 90th percentile of moving speed on flat ground away
# from a signal, measured across every shift (25.0 km/h). Not a guess about
# what a bike can do — what this rider actually does when nothing is in the way.
V_FREE_KMH = 25.0

# Empirical cost of climbing, from the speed-versus-grade curve in the data:
# a +6% grade costs ~0.7 min/km against flat, which works out near a hundredth
# of a minute per metre gained. Used only to label how much of the cruising
# shortfall is the hill rather than the traffic.
CLIMB_MIN_PER_M = 0.010

# A zone is published only if its score is actually pinned down. The test is
# the width of a bootstrap interval over shifts, not a distance threshold:
# 5 km across 4 shifts sounds like enough and carries a +-18 point interval,
# which makes any ordering inside the table meaningless. See score_rideability.
MAX_CI_WIDTH = 12.0
MIN_SHIFTS_FOR_CI = 5
BOOTSTRAP_N = 600

# Shrinkage prior for the order rate, in hours. Distances no longer need one:
# the rideability score is published only where it is already precise.
PRIOR_HOURS = 0.75

# Somewhere an order is cooked or packed, as opposed to somewhere that merely
# sells food. Pickup evidence leans on the difference.
PREPARED_KINDS = {"restaurant", "fast_food", "cafe", "pub", "bar", "food_court",
                  "ice_cream", "bakery", "shop:bakery"}

# Sydney only — the other cities in the export are holiday riding, not work.
SYD_BOX = (-34.30, -33.50, 150.80, 151.50)

# The CBD's ABS suburb is literally called "Sydney", which reads on a chart as
# though the row covered the whole city. It does not: it is the 2.9 km^2 block
# between Circular Quay and Central. Renamed for display only — the lookup,
# the polygon and the OSM context all still key off the official name.
DISPLAY_NAMES = {"Sydney": "Sydney CBD"}


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


def circ_mean(degrees):
    """Mean of compass bearings. Averaging 350 and 10 arithmetically gives 180."""
    if not degrees:
        return None
    x = sum(math.cos(math.radians(d)) for d in degrees)
    y = sum(math.sin(math.radians(d)) for d in degrees)
    if x == 0 and y == 0:
        return None
    return math.degrees(math.atan2(y, x)) % 360


def angle_gap(a, b):
    return abs((b - a + 180) % 360 - 180)


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


# -- map context ------------------------------------------------------------
class PointIndex:
    """Nearest-point lookup over a grid. Returns (distance, payload)."""

    TILE = 0.0025

    def __init__(self, rows):
        self.grid = defaultdict(list)
        for r in rows:
            self.grid[(int(r[0] / self.TILE), int(r[1] / self.TILE))].append(r)

    def nearest(self, lat, lon, radius=200.0):
        span = int(radius / (self.TILE * 111000)) + 1
        gx, gy = int(lat / self.TILE), int(lon / self.TILE)
        best = (radius, None)
        for dx in range(-span, span + 1):
            for dy in range(-span, span + 1):
                for r in self.grid.get((gx + dx, gy + dy), ()):
                    d = haversine(lat, lon, r[0], r[1])
                    if d < best[0]:
                        best = (d, r)
        return best


class LineIndex:
    """Nearest distance to a set of polylines, on a local metre projection."""

    TILE = 0.002

    def __init__(self, lines):
        self.grid = defaultdict(list)
        for line in lines:
            for i in range(len(line) - 1):
                a, b = line[i], line[i + 1]
                seg = (a[0], a[1], b[0], b[1])
                for tx in range(int(min(a[0], b[0]) / self.TILE), int(max(a[0], b[0]) / self.TILE) + 1):
                    for ty in range(int(min(a[1], b[1]) / self.TILE), int(max(a[1], b[1]) / self.TILE) + 1):
                        self.grid[(tx, ty)].append(seg)

    def nearest(self, lat, lon, radius=200.0):
        kx = 111320.0 * math.cos(math.radians(lat))
        ky = 110540.0
        best = radius
        gx, gy = int(lat / self.TILE), int(lon / self.TILE)
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for (la0, lo0, la1, lo1) in self.grid.get((gx + dx, gy + dy), ()):
                    px, py = (lon - lo0) * kx, (lat - la0) * ky
                    ax, ay = (lo1 - lo0) * kx, (la1 - la0) * ky
                    L = ax * ax + ay * ay
                    t = 0.0 if L == 0 else max(0.0, min(1.0, (px * ax + py * ay) / L))
                    d = math.hypot(px - t * ax, py - t * ay)
                    if d < best:
                        best = d
        return best


class MapContext:
    """Everything `fetch_osm.py` cached, wrapped in the lookups the classifier
    asks for. Absent cache degrades to 'no map knowledge' rather than dying —
    the classifier then leans entirely on the motion features."""

    def __init__(self, path):
        self.ok = False
        self.suburbs = {}
        self.meta = {}
        try:
            raw = json.loads(Path(path).read_text(encoding="utf-8"))
        except (OSError, ValueError):
            self.signals = PointIndex([])
            self.venues = PointIndex([])
            self.roads = LineIndex([])
            return
        self.ok = True
        self.meta = raw.get("meta", {})
        self.suburbs = raw.get("suburbs", {})
        self.signals = PointIndex([(r[0], r[1]) for r in raw.get("signals", [])])
        self.venues = PointIndex([tuple(r) for r in raw.get("venues", [])])
        self.roads = LineIndex(raw.get("major_roads", []))

    def probe(self, lat, lon):
        d_sig, _ = self.signals.nearest(lat, lon, 250)
        d_ven, ven = self.venues.nearest(lat, lon, 250)
        return {
            "d_signal": round(d_sig, 1),
            "d_venue": round(d_ven, 1),
            "venue": (ven[3] or None) if ven else None,
            "venue_kind": ven[2] if ven else None,
            "d_road": round(self.roads.nearest(lat, lon, 200), 1),
        }


# -- GPX --------------------------------------------------------------------
def read_track(path):
    """Every <trkpt> as a dict. Speed and course come from Apple's <extensions>."""
    pts = []
    for tp in ET.parse(path).getroot().iter(GPX_NS + "trkpt"):
        ele = tp.find(GPX_NS + "ele")
        tm = tp.find(GPX_NS + "time")
        if tm is None:
            continue
        speed = course = hacc = None
        ext = tp.find(GPX_NS + "extensions")
        if ext is not None:
            for child in ext.iter():
                tag = child.tag.rsplit("}", 1)[-1]
                if tag == "speed" and child.text:
                    speed = float(child.text)
                elif tag == "course" and child.text:
                    course = float(child.text)
                elif tag == "hAcc" and child.text:
                    hacc = float(child.text)
        pts.append({
            "lat": float(tp.get("lat")),
            "lon": float(tp.get("lon")),
            "ele": float(ele.text) if ele is not None and ele.text else 0.0,
            "t": datetime.strptime(tm.text, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc),
            "v": speed if speed is not None else 0.0,
            "c": course if (course is not None and course >= 0) else None,
            "hacc": hacc if hacc is not None else 99.0,
        })
    return pts


def in_sydney(pts):
    if not pts:
        return False
    lat, lon = pts[len(pts) // 2]["lat"], pts[len(pts) // 2]["lon"]
    return SYD_BOX[0] <= lat <= SYD_BOX[1] and SYD_BOX[2] <= lon <= SYD_BOX[3]


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


# -- dwell detection --------------------------------------------------------
def core_stops(pts):
    """Runs of consecutive sub-STOP_SPEED points lasting CORE_SECONDS."""
    out = []
    i, n = 0, len(pts)
    while i < n:
        if pts[i]["v"] < STOP_SPEED:
            j = i
            while (j + 1 < n and pts[j + 1]["v"] < STOP_SPEED
                   and (pts[j + 1]["t"] - pts[j]["t"]).total_seconds() <= 60):
                j += 1
            if (pts[j]["t"] - pts[i]["t"]).total_seconds() >= CORE_SECONDS:
                out.append([i, j])
            i = j + 1
        else:
            i += 1
    return out


def find_dwells(pts):
    """Core stops, merged across short local excursions.

    Delivering an order means parking, walking to a door, waiting, walking
    back. The walk sits above STOP_SPEED, so a naive stop detector cuts one
    delivery into three stops and — under a duration rule — counts three
    orders. Merging when the excursion is brief, nearby and slower than a
    jog puts the delivery back together as one dwell whose footprint is
    itself a useful signal: red lights have none.
    """
    cs = core_stops(pts)
    if not cs:
        return []
    merged = [cs[0][:]]
    for a, b in cs[1:]:
        prev_a, prev_b = merged[-1]
        gap = (pts[a]["t"] - pts[prev_b]["t"]).total_seconds()
        span = pts[prev_b:a + 1]
        far = max((haversine(pts[prev_a]["lat"], pts[prev_a]["lon"], q["lat"], q["lon"])
                   for q in span), default=0.0)
        vmax = max((q["v"] for q in span), default=0.0)
        if gap <= MERGE_GAP_S and far <= MERGE_GAP_M and vmax <= MERGE_GAP_V:
            merged[-1][1] = b
        else:
            merged.append([a, b])
    out = []
    for a, b in merged:
        if (pts[b]["t"] - pts[a]["t"]).total_seconds() >= DWELL_SECONDS:
            out.append((a, b))
    return out


def dwell_features(pts, i, j):
    """Shape of one dwell: how big, how busy, and how the rider left it."""
    seg = pts[i:j + 1]
    clat = sum(p["lat"] for p in seg) / len(seg)
    clon = sum(p["lon"] for p in seg) / len(seg)
    radius = max(haversine(clat, clon, p["lat"], p["lon"]) for p in seg)
    path = sum(haversine(seg[k]["lat"], seg[k]["lon"], seg[k + 1]["lat"], seg[k + 1]["lon"])
               for k in range(len(seg) - 1))

    def side_courses(start, step):
        got = []
        k, guard = start, 0
        while 0 <= k < len(pts) and len(got) < 8 and guard < 60:
            if pts[k]["v"] > 2.5 and pts[k]["c"] is not None:
                got.append(pts[k]["c"])
            k += step
            guard += 1
        return got

    c_in = circ_mean(side_courses(i - 1, -1))
    c_out = circ_mean(side_courses(j + 1, 1))
    turn = angle_gap(c_in, c_out) if (c_in is not None and c_out is not None) else None
    return {
        "lat": clat, "lon": clon,
        "secs": (seg[-1]["t"] - seg[0]["t"]).total_seconds(),
        "radius": round(radius, 1),
        "path": round(path, 1),
        "turn": None if turn is None else round(turn, 1),
        "walk": round(sum(1 for p in seg if STOP_SPEED <= p["v"] < CRAWL_SPEED) / len(seg), 3),
        "still": round(sum(1 for p in seg if p["v"] < 0.15) / len(seg), 3),
        "t": seg[0]["t"].astimezone(SYD_TZ),
        "i": i, "j": j,
    }


# -- classification ---------------------------------------------------------
def _band(value, cuts, scores):
    for cut, s in zip(cuts, scores):
        if value < cut:
            return s
    return scores[-1]


def score_work(d):
    """Weigh 'this is a job' against 'this is a red light'.

    Additive log-odds-ish evidence, positive meaning work. The weights are not
    fitted — there are no labels to fit them to. They are set from the shape of
    the data: dwells within 12 m of a signal run a median 45 s with a 2 m
    footprint, dwells 80 m away run 87 s with a 7 m footprint, and the gap
    between those two populations is wide enough that the exact numbers move
    very few cases. Each term is kept as text so the page can show its work.
    """
    ev = []

    def add(w, why):
        if w:
            ev.append([round(w, 2), why])

    add(_band(d["secs"], [40, 70, 100, 150, 240], [-2.0, -1.2, -0.2, 0.8, 1.6, 2.4]),
        f"停了 {d['secs']:.0f} 秒")
    if d["d_signal"] is not None:
        add(_band(d["d_signal"], [12, 25, 45, 80], [-1.8, -1.0, -0.1, 0.7, 1.2]),
            f"离最近红绿灯 {d['d_signal']:.0f} m")
    add(_band(d["radius"], [6, 12, 25], [-0.9, -0.2, 0.9, 1.5]),
        f"停留范围 {d['radius']:.0f} m")
    if d["path"] > 40 and d["walk"] > 0.05:
        add(0.8, f"停着还挪了 {d['path']:.0f} m（像是走去门口）")
    if d["turn"] is not None:
        if d["turn"] >= 130:
            add(1.2, f"原路折返 {d['turn']:.0f}°")
        elif d["turn"] >= 90:
            add(0.4, f"掉头 {d['turn']:.0f}°")
        elif d["turn"] < 40:
            add(-0.5, f"直着穿过去 {d['turn']:.0f}°")
    if d["d_road"] is not None:
        if d["d_road"] < 10:
            add(-0.5, "就停在主干道上")
        elif d["d_road"] > 35:
            add(0.5, "离主干道很远")
    if d["d_venue"] is not None:
        if d["d_venue"] < 20:
            add(0.6, f"门口就是{d['venue'] or '餐饮店'}")
        elif d["d_venue"] > 80:
            add(-0.3, "周围没有餐饮")
    return round(sum(w for w, _ in ev), 2), ev


def cluster_dwells(dwells, radius=CLUSTER_M):
    """Greedy leader clustering, longest dwell seeding each cluster.

    The point is repeat detection: a restaurant you collect from every other
    shift lands in one cluster, a customer's address lands in a cluster of one.
    DBSCAN would be tidier but pulls in a dependency and, at a few hundred
    points, arrives at the same answer.
    """
    clusters = []
    for d in sorted(dwells, key=lambda x: -x["secs"]):
        for c in clusters:
            if haversine(c["lat"], c["lon"], d["lat"], d["lon"]) < radius:
                c["members"].append(d)
                k = len(c["members"])
                c["lat"] += (d["lat"] - c["lat"]) / k
                c["lon"] += (d["lon"] - c["lon"]) / k
                break
        else:
            clusters.append({"lat": d["lat"], "lon": d["lon"], "members": [d]})
    for ci, c in enumerate(clusters):
        shifts = len({m["ride"] for m in c["members"]})
        for m in c["members"]:
            m["cluster"] = ci
            m["cluster_visits"] = len(c["members"])
            m["cluster_shifts"] = shifts
    return clusters


def classify(dwells):
    """Label every dwell 等灯 / 取餐 / 送达.

    Two passes. The first separates work from traffic on motion plus map
    evidence. The second splits work into pickups and drop-offs on two
    independent tests, neither of which knows anything about the other:

      anchor  a place returned to on two or more different shifts whose stops
              sit, on median, within 30 m of a food venue. Behaviour and map
              agreeing: that is a restaurant, not an assumption.
      solo    a stop inside 25 m of somewhere that cooks. Covers the venues
              visited once — the map already says what they are.

    Nothing here forces pickups and drop-offs to balance, which makes the
    resulting ratio worth looking at: every job should be one of each, and the
    labels land at 215 pickups against 197 drop-offs, a ratio of 1.09. That is
    a consistency check rather than a proof — plausible variants of these two
    rules span roughly 0.8 to 1.4 — but a classifier wrong in bulk would have
    no reason to come out anywhere near even.
    """
    for d in dwells:
        d["score"], d["evidence"] = score_work(d)
        d["kind"] = "work" if d["score"] > 0 else "light"
        # How far from the fence this one sat. 7% of dwells land inside ±0.5,
        # where the evidence genuinely does not settle it; saying so is more
        # useful than a confident label that happens to be a coin flip.
        d["confidence"] = round(min(1.0, abs(d["score"]) / 2.5), 2)

    work = [d for d in dwells if d["kind"] == "work"]
    by_cluster = defaultdict(list)
    for d in work:
        by_cluster[d["cluster"]].append(d)
    anchors = {ci for ci, ms in by_cluster.items()
               if len({m["ride"] for m in ms}) >= ANCHOR_SHIFTS
               and st.median([m["d_venue"] for m in ms
                              if m["d_venue"] is not None] or [999]) < ANCHOR_VENUE_M}

    for d in work:
        why = []
        if d["cluster"] in anchors:
            why.append(f"常去的取餐点（去过 {d['cluster_visits']} 次）")
        elif (d["d_venue"] is not None and d["d_venue"] <= SOLO_VENUE_M
              and d["venue_kind"] in PREPARED_KINDS):
            why.append(f"停在{d['venue'] or '餐饮店'}门口 {d['d_venue']:.0f} m")
        d["kind"] = "pickup" if why else "dropoff"
        d["kind_why"] = why or ["不在任何餐饮点旁，也不是反复来的地方"]
    return anchors


def build_legs(shifts):
    """Pair each pickup with the drop-off that follows it, inside one shift.

    The gap between them is the part of the job the rider actually controls:
    how long the delivery leg took and how far it ran. Pickups queue rather
    than overwrite each other, because collecting two orders before delivering
    either is normal and an earlier version threw away the first one every
    time it happened — it paired barely a third of the pickups. Anything left
    unpaired at the end of a shift is dropped rather than matched to something
    implausible.
    """
    legs = []
    for r in shifts:
        seq = sorted([d for d in r["dwells"] if d["kind"] in ("pickup", "dropoff")],
                     key=lambda d: d["t"])
        pending = []
        for d in seq:
            if d["kind"] == "pickup":
                pending.append(d)
            elif pending:
                src = pending.pop(0)
                mins = (d["t"] - src["t"]).total_seconds() / 60 - src["secs"] / 60
                km = haversine(src["lat"], src["lon"], d["lat"], d["lon"]) / 1000
                if 0 < mins < 60:
                    legs.append({"min": round(mins, 2), "km_direct": round(km, 3),
                                 "from": src, "to": d, "ride": r["id"]})
    return legs


def build_transitions(shifts, subs):
    """What happens between jobs, and where the next one starts.

    A shift is not a list of orders, it is a chain: collect, deliver, ride to
    the next collection, repeat. That middle leg earns nothing, and it turns
    out to be 41% of the distance ridden — which makes "where does the next
    job start after I drop here" a more useful question about a suburb than
    anything measured at the drop itself.

    Per zone this records two different roles, because a suburb is rarely good
    at both: as a place to collect from (how often, how long the restaurant
    keeps you, how far the delivery then runs) and as a place to deliver into
    (how far you then have to ride before the next collection, and how often
    that collection is in the same suburb).
    """
    from_zone = defaultdict(list)     # pickup zone  -> delivery legs
    into_zone = defaultdict(list)     # dropoff zone -> dead legs after it
    flows = defaultdict(int)          # (dropoff zone, next pickup zone) -> n
    dead_all, paid_all = [], []

    # Where the work comes from, as a single point: the mean of every pickup.
    # A drop-off can then be described by whether the next job pulled the rider
    # back toward it or pushed them further out, which is the difference
    # between a suburb that keeps feeding you and one you have to escape.
    picks = [d for r in shifts for d in r["dwells"] if d["kind"] == "pickup"]
    core = (sum(d["lat"] for d in picks) / len(picks),
            sum(d["lon"] for d in picks) / len(picks)) if picks else None

    for r in shifts:
        seq = sorted([d for d in r["dwells"] if d["kind"] in ("pickup", "dropoff")],
                     key=lambda d: d["t"])
        for a, b in zip(seq, seq[1:]):
            t0 = a["t"].timestamp() + a["secs"]
            t1 = b["t"].timestamp()
            mins = (t1 - t0) / 60
            # A gap longer than this is a break, a re-position across town, or
            # a stretch the watch did not record — not a leg between two jobs.
            if not (0 <= mins <= 45):
                continue
            km = sum(s["d"] for s in r["samples"] if t0 <= s["t"].timestamp() < t1) / 1000
            if a["kind"] == "pickup" and b["kind"] == "dropoff":
                paid_all.append(km)
                if a["zone"]:
                    from_zone[a["zone"]].append((mins, km))
            elif a["kind"] == "dropoff" and b["kind"] == "pickup":
                dead_all.append(km)
                if a["zone"]:
                    d_from = d_to = None
                    if core:
                        d_from = haversine(a["lat"], a["lon"], core[0], core[1]) / 1000
                        d_to = haversine(b["lat"], b["lon"], core[0], core[1]) / 1000
                    into_zone[a["zone"]].append((mins, km, b["zone"], d_from, d_to))
                    flows[(a["zone"], b["zone"])] += 1

    pickup_stats, drop_stats = {}, {}
    for z, legs in from_zone.items():
        pickup_stats[z] = {
            "legs": len(legs),
            "leg_min": round(st.median([m for m, _ in legs]), 1),
            "leg_km": round(st.median([k for _, k in legs]), 2),
        }
    for z, legs in into_zone.items():
        same = sum(1 for _, _, nz, _, _ in legs if nz == z)
        nxt = Counter(nz for _, _, nz, _, _ in legs if nz and nz != z)
        # "Had to ride back" = the next collection sat measurably closer to the
        # core than the drop did. The 200 m deadband keeps a job across the
        # street from counting as a journey home.
        back = sum(1 for _, _, _, df, dt in legs
                   if df is not None and dt is not None and dt < df - 0.2)
        far = [df for _, _, _, df, _ in legs if df is not None]
        drop_stats[z] = {
            "legs": len(legs),
            "dead_min": round(st.median([m for m, _, _, _, _ in legs]), 1),
            "dead_km": round(st.median([k for _, k, _, _, _ in legs]), 2),
            "same_pct": round(100 * same / len(legs)),
            "back_pct": round(100 * back / len(legs)),
            "from_core_km": round(st.median(far), 2) if far else None,
            "next_zone": DISPLAY_NAMES.get(nxt.most_common(1)[0][0], nxt.most_common(1)[0][0]) if nxt else None,
        }

    dead_km = sum(dead_all)
    paid_km = sum(paid_all)
    top_flows = [{"from": DISPLAY_NAMES.get(a, a), "to": DISPLAY_NAMES.get(b, b),
                  "n": n, "same": a == b}
                 for (a, b), n in sorted(flows.items(), key=lambda kv: -kv[1])[:14]
                 if b and n >= 2]
    summary = {
        "dead_legs": len(dead_all),
        "dead_min_med": round(st.median([m for legs in into_zone.values()
                                         for m, _, _, _, _ in legs]), 1)
                        if into_zone else None,
        "dead_km_med": round(st.median(dead_all), 2) if dead_all else None,
        "paid_km_med": round(st.median(paid_all), 2) if paid_all else None,
        "dead_km_total": round(dead_km, 1),
        "paid_km_total": round(paid_km, 1),
        "dead_share": round(100 * dead_km / (dead_km + paid_km)) if (dead_km + paid_km) else None,
        "same_zone_pct": round(100 * sum(1 for z, legs in into_zone.items()
                                         for _, _, nz, _, _ in legs if nz == z)
                               / max(1, sum(len(v) for v in into_zone.values()))),
        "flows": top_flows,
    }
    # Citywide split of what the unpaid leg was actually doing.
    all_legs = [lg for legs in into_zone.values() for lg in legs]
    inward = [lg for lg in all_legs if lg[3] is not None and lg[4] < lg[3] - 0.2]
    outward = [lg for lg in all_legs if lg[3] is not None and lg[4] > lg[3] + 0.2]
    local = [lg for lg in all_legs if lg[3] is not None
             and abs(lg[4] - lg[3]) <= 0.2]
    if all_legs:
        summary["direction"] = {
            "inward": len(inward), "outward": len(outward), "local": len(local),
            "inward_pct": round(100 * len(inward) / len(all_legs)),
            "inward_km": round(st.median([lg[1] for lg in inward]), 2) if inward else None,
            "inward_min": round(st.median([lg[0] for lg in inward]), 1) if inward else None,
            "local_km": round(st.median([lg[1] for lg in local]), 2) if local else None,
            "local_min": round(st.median([lg[0] for lg in local]), 1) if local else None,
            "core": [round(core[0], 5), round(core[1], 5)] if core else None,
        }
    return pickup_stats, drop_stats, summary


# -- ground truth -----------------------------------------------------------
# One platform's real order log, used to measure how well the inference above
# actually works. The file is a pipe-delimited export of the rider's own Uber
# driver activity — `at|type|total|duration_s|distance_km|pickup|dropoff` —
# and it stays out of the repo: the drop-off column is a list of customers'
# home addresses, and this site is public. Only the aggregate scores below
# ever reach the page.
UBER_ORDER_TYPES = {"TRIP", "CT"}
MATCH_WINDOW_S = 420


def read_uber(path):
    rows = []
    try:
        text = Path(path).read_text(encoding="utf-8")
    except OSError:
        return rows
    for line in text.splitlines():
        if not line.strip():
            continue
        parts = line.split("|")
        if len(parts) < 7:
            continue
        at, kind, total, dur, dist, frm, to = parts[:7]
        if kind not in UBER_ORDER_TYPES or not dur:
            continue
        rows.append({
            "at": int(at), "kind": kind,
            "total": float(total or 0),
            "dur": int(dur),
            "dist": float(dist) if dist else None,
            "venue": frm or None, "to": to or None,
        })
    return rows


def _gap(dwell, target):
    """Seconds between a moment and a dwell, zero while inside it."""
    start = dwell["t"].timestamp()
    if start <= target <= start + dwell["secs"]:
        return 0.0
    return min(abs(start - target), abs(start + dwell["secs"] - target))


def validate_against_uber(path, shifts, dwells, subs):
    """Score the classifier against a real order log.

    Only recall is measurable. The rider also runs two other platforms, so an
    inferred stop with no Uber order behind it is not an error — it is most
    likely a HungryPanda or DoorDash job that this file simply cannot see.
    Precision would need every platform's log; claiming it from one would be
    a straight lie about a number the page displays.

    The order's own timestamp turned out to be the *pickup*, not the hand-over:
    anchoring on `at + duration` lines the drop-offs up to within a few seconds,
    where anchoring on `at` was hundreds out. That alignment is itself the
    strongest single piece of evidence that the dwell detector is finding real
    events rather than fitting noise.
    """
    orders = read_uber(path)
    if not orders:
        return None

    drops = [d for d in dwells if d["kind"] == "dropoff"]
    picks = [d for d in dwells if d["kind"] == "pickup"]
    spans = []
    for r in shifts:
        ts = [s["t"].timestamp() for s in r["samples"]]
        if ts:
            spans.append((min(ts) - 60, max(ts) + 60))

    def covered(t):
        return any(a <= t <= b for a, b in spans)

    def nearest(pool, target):
        best = None
        for d in pool:
            g = _gap(d, target)
            if g <= MATCH_WINDOW_S and (best is None or g < best[1]):
                best = (d, g)
        return best

    offsets = []
    in_window = 0
    hit_drop = hit_pick = 0
    zone_ok = zone_tot = 0
    venue_ok = venue_tot = 0
    misses = defaultdict(int)
    matched_ids = set()

    for o in orders:
        drop_at = o["at"] + o["dur"]
        if not covered(drop_at):
            continue
        in_window += 1
        md = nearest(drops, drop_at)
        mp = nearest(picks, o["at"])
        if md:
            hit_drop += 1
            matched_ids.add(id(md[0]))
            offsets.append(md[0]["t"].timestamp() - drop_at)
            want = (o["to"] or "").split(",")[-1].strip()
            got = subs.lookup(md[0]["lat"], md[0]["lon"])
            if want and got:
                zone_tot += 1
                zone_ok += (want.lower() == got.lower())
        else:
            other = nearest([d for d in dwells if d["kind"] != "dropoff"], drop_at)
            misses[other[0]["kind"] if other else "no_dwell"] += 1
        if mp:
            hit_pick += 1
            venue_tot += 1
            venue_ok += bool(mp[0]["venue"])

    if not in_window:
        return None
    offsets.sort()
    lo = offsets[len(offsets) // 4] if offsets else 0
    hi = offsets[3 * len(offsets) // 4] if offsets else 0
    pct = lambda a, b: round(100 * a / b) if b else None
    return {
        "source": "Uber driver activity export (rider's own account)",
        "first": datetime.fromtimestamp(min(o["at"] for o in orders),
                                        timezone.utc).astimezone(SYD_TZ).strftime("%Y-%m-%d"),
        "last": datetime.fromtimestamp(max(o["at"] for o in orders),
                                       timezone.utc).astimezone(SYD_TZ).strftime("%Y-%m-%d"),
        "orders": len(orders),
        "in_window": in_window,
        "coverage_pct": pct(in_window, len(orders)),
        "recall_drop": pct(hit_drop, in_window),
        "recall_pickup": pct(hit_pick, in_window),
        "zone_pct": pct(zone_ok, zone_tot),
        "venue_pct": pct(venue_ok, venue_tot),
        "align_median_s": round(st.median(offsets)) if offsets else None,
        "align_iqr": [round(lo), round(hi)],
        "misses": dict(misses),
        "match_window_s": MATCH_WINDOW_S,
        # What share of the inferred drop-offs this one platform accounts for.
        # The remainder is the other two apps, not a pile of false positives.
        "matched_drops": len(matched_ids),
        "total_drops": len(drops),
        "platform_share_pct": pct(len(matched_ids), len(drops)),
        "median_fare": round(st.median([o["total"] for o in orders]), 2),
        "median_km": round(st.median([o["dist"] for o in orders if o["dist"]]), 2),
        "median_min": round(st.median([o["dur"] for o in orders]) / 60, 1),
    }


# -- which offers are worth taking ------------------------------------------
# The offer screen shows three numbers: the fare, the distance, and an ETA.
# All three describe the *paid* leg. None of them describe the ride to the
# restaurant, which the rider pays for out of the same hour. This block joins
# the order log to the ridden track so the hidden half can be measured, and
# turns the result into a rule that can be applied in the eight seconds an
# offer stays on screen.
OFFER_APPROACH_CAP_S = 45 * 60     # longer than this is a break, not an approach
OFFER_MIN_ROWS = 40                # below this the fits are not worth printing
OFFER_TARGET_RATES = (15, 20, 25, 31.3, 35)
OFFER_RULE_CUTS = (1.0, 1.2, 1.4, 1.6, 1.8, 2.0)
OFFER_KM_BANDS = ((0, 1.2), (1.2, 1.6), (1.6, 2.0), (2.0, 2.6), (2.6, 99))

# The Interim On-Demand Delivery Employee-like Worker Minimum Standards Order.
# From 17 August 2026 a covered platform must compare what it paid against
# `engaged hours x rate` over an earnings period and top up the shortfall.
# That single fact reorganises this whole section: below the floor an offer's
# fare stops being what it earns you, and the clock does the earning instead.
FLOOR = {
    "rate": 31.30,                 # bicycle / e-bike / e-scooter
    "from": "2026-08-17",
    "vehicle": "自行车 / 电动自行车",
    "other": [("摩托车 / 燃油踏板", 31.50), ("汽车 / 面包车（≤1 吨）", 32.00)],
    "basis": "engaged time — 从接单那一刻到送达完成",
    "period_days": 21,
    "source": "Fair Work Commission · Interim On-Demand Delivery "
              "Employee-like Worker Minimum Standards Order",
    "url": "https://www.fairwork.gov.au/about-us/workplace-laws/"
           "fair-work-commission-orders/minimum-standards-order-on-demand-delivery-workers",
}


def _ols(X, y):
    """Least squares by Gaussian elimination. Returns (coefficients, R^2).

    Three predictors at most and a few hundred rows, so the normal equations
    are fine and the file stays dependency-free.
    """
    n, p = len(y), len(X[0])
    A = [[sum(X[i][a] * X[i][b] for i in range(n)) for b in range(p)]
         + [sum(X[i][a] * y[i] for i in range(n))] for a in range(p)]
    for c in range(p):
        piv = max(range(c, p), key=lambda r: abs(A[r][c]))
        A[c], A[piv] = A[piv], A[c]
        if abs(A[c][c]) < 1e-12:
            return None, None
        d = A[c][c]
        A[c] = [v / d for v in A[c]]
        for r in range(p):
            if r != c and A[r][c]:
                f = A[r][c]
                A[r] = [x - f * z for x, z in zip(A[r], A[c])]
    beta = [A[i][p] for i in range(p)]
    fit = [sum(X[i][a] * beta[a] for a in range(p)) for i in range(n)]
    ybar = sum(y) / n
    ss_tot = sum((v - ybar) ** 2 for v in y)
    if ss_tot <= 0:
        return beta, None
    return beta, 1 - sum((y[i] - fit[i]) ** 2 for i in range(n)) / ss_tot


def _spearman(a, b):
    """Rank correlation — the relationships here are monotone, not linear."""
    n = len(a)
    if n < 3:
        return None
    ra, rb = [0] * n, [0] * n
    for r, i in enumerate(sorted(range(n), key=lambda i: a[i])):
        ra[i] = r
    for r, i in enumerate(sorted(range(n), key=lambda i: b[i])):
        rb[i] = r
    ma, mb = sum(ra) / n, sum(rb) / n
    num = sum((ra[i] - ma) * (rb[i] - mb) for i in range(n))
    den = (sum((ra[i] - ma) ** 2 for i in range(n))
           * sum((rb[i] - mb) ** 2 for i in range(n))) ** 0.5
    return round(num / den, 3) if den else None


def _window(ride, t0, t1):
    """Moving seconds, stopped seconds and kilometres inside a time window."""
    move = stop = 0.0
    metres = 0.0
    for s in ride["samples"]:
        t = s["t"].timestamp()
        if t < t0:
            continue
        if t > t1:
            break
        if s["state"] == "stop":
            stop += s["dt"]
        else:
            move += s["dt"]
        metres += s["d"]
    return move, stop, metres / 1000



PROMO_TYPES = {"QUEST", "MISC"}
PROMO_PAIR_S = 600


def _read_promotions(path):
    """Total the log's non-trip payouts, without counting them twice.

    The export carries promotion payouts under two labels, and 73 of the 81
    MISC rows have a QUEST row of exactly the same amount within ten minutes.
    They are one payout listed twice, so MISC only counts where it has no
    QUEST twin. What none of it settles is whether these amounts are already
    inside the trip totals or sit on top of them, and the earnings site's own
    breakdown is not reachable to check — so this is reported beside the fare
    figures, never folded into them.
    """
    try:
        text = Path(path).read_text(encoding="utf-8")
    except OSError:
        return None
    quest, misc = [], []
    for line in text.splitlines():
        parts = line.split("|")
        if len(parts) < 3 or parts[1] not in PROMO_TYPES:
            continue
        (quest if parts[1] == "QUEST" else misc).append(
            (int(parts[0]), float(parts[2] or 0)))
    if not quest and not misc:
        return None
    rows = [(t, a) for t, a in quest if a > 0]
    dupes = 0
    for t, a in misc:
        if a <= 0:
            continue
        if any(abs(t - t2) <= PROMO_PAIR_S and abs(a - a2) < 0.005 for t2, a2 in quest):
            dupes += 1
        else:
            rows.append((t, a))
    if not rows:
        return None
    amounts = sorted(a for _, a in rows)
    return {
        "n": len(rows), "total": round(sum(amounts), 2),
        "med": round(st.median(amounts), 2),
        "max": round(amounts[-1], 2),
        "deduped": dupes,
        "raw_quest": round(sum(a for _, a in quest), 2),
        "raw_misc": round(sum(a for _, a in misc), 2),
    }


def _idle_seconds(ride, t0, t1):
    """Stopped seconds inside a window that fall outside every detected dwell.

    A light, a restaurant counter and a customer's door are all stops that
    belong to the job. Standing anywhere else is the rider waiting to be given
    one, which is the only part of the gap between two jobs that the minimum
    standards order would not call engaged time.
    """
    spans = [(d["t"].timestamp(), d["t"].timestamp() + d["secs"]) for d in ride["dwells"]]
    idle = 0.0
    for s in ride["samples"]:
        t = s["t"].timestamp()
        if t < t0:
            continue
        if t > t1:
            break
        if s["state"] == "stop" and not any(a <= t <= b for a, b in spans):
            idle += s["dt"]
    return idle


TAIL_BANDS = ((0, 1), (1, 2), (2, 3), (3, 99))


def _drop_tail(shifts):
    """How much the *next* order costs, as a function of where this one ended.

    A fare buys a ride to a front door and stops paying there. The ride out of
    that door is charged to the following order, which is why a drop-off deep
    in a quiet suburb can be a bad job at a good price. Measured against the
    middle of the restaurant cluster, since that is where the next collection
    almost always is.
    """
    picks = [d for r in shifts for d in r["dwells"] if d["kind"] == "pickup"]
    if len(picks) < 20:
        return None
    core = (sum(d["lat"] for d in picks) / len(picks),
            sum(d["lon"] for d in picks) / len(picks))

    legs = []
    for r in shifts:
        seq = sorted([d for d in r["dwells"] if d["kind"] in ("pickup", "dropoff")],
                     key=lambda d: d["t"])
        for a, b in zip(seq, seq[1:]):
            if a["kind"] != "dropoff" or b["kind"] != "pickup":
                continue
            t0 = a["t"].timestamp() + a["secs"]
            t1 = b["t"].timestamp()
            mins = (t1 - t0) / 60
            if not 0 <= mins <= 45:
                continue
            km = sum(s["d"] for s in r["samples"] if t0 <= s["t"].timestamp() < t1) / 1000
            legs.append((haversine(a["lat"], a["lon"], core[0], core[1]) / 1000, mins, km))
    if len(legs) < 40:
        return None

    n = len(legs)
    mx = sum(l[0] for l in legs) / n
    my = sum(l[1] for l in legs) / n
    den = sum((l[0] - mx) ** 2 for l in legs)
    slope = sum((l[0] - mx) * (l[1] - my) for l in legs) / den if den else 0.0

    bands = []
    for lo, hi in TAIL_BANDS:
        sub = [l for l in legs if lo <= l[0] < hi]
        if len(sub) < 8:
            continue
        bands.append({"lo": lo, "hi": hi if hi < 90 else None, "n": len(sub),
                      "min": round(st.median([l[1] for l in sub]), 1),
                      "km": round(st.median([l[2] for l in sub]), 2)})
    return {
        "legs": n,
        "rho": _spearman([l[0] for l in legs], [l[1] for l in legs]),
        "base": round(my - slope * mx, 1),
        "per_km": round(slope, 2),
        "bands": bands,
    }


def build_offers(path, shifts, subs):
    """Measure what an accepted order actually costs, and what that implies.

    Every order in the log is placed inside the shift that contains it, which
    gives each one the thing the log itself cannot know: the ride that led to
    the restaurant. That approach leg starts at the end of the previous
    hand-over — the moment the rider became free — and ends at the collection.

    Two denominators are reported, because they answer different questions.
    *Marginal* time is approach riding plus the paid leg: what accepting this
    offer costs that declining it would not. *Full* time adds the standing
    around, and is what an hour of the evening actually pays. The first drives
    the accept rule; the second is the honest headline.

    Only this one platform's fares are visible, so every dollar figure here is
    an Uber figure. The times are not — they come from the track, which does
    not know which app the job came from.
    """
    orders = [o for o in read_uber(path) if o["dist"] and o["dur"] > 0]
    if not orders:
        return None
    orders.sort(key=lambda o: o["at"])

    rows = []
    for o in orders:
        ride = next((r for r in shifts
                     if r["samples"][0]["t"].timestamp() - 60 <= o["at"]
                     and o["at"] + o["dur"] <= r["samples"][-1]["t"].timestamp() + 60), None)
        if ride is None:
            continue
        # Free again at the end of the last hand-over; before the first one,
        # free from the moment the recording started.
        released = ride["samples"][0]["t"].timestamp()
        for d in ride["dwells"]:
            end = d["t"].timestamp() + d["secs"]
            if d["kind"] == "dropoff" and end <= o["at"]:
                released = max(released, end)
        released = max(released, o["at"] - OFFER_APPROACH_CAP_S)
        ap_move, ap_stop, ap_km = _window(ride, released, o["at"])
        lg_move, lg_stop, lg_km = _window(ride, o["at"], o["at"] + o["dur"])
        marg = (ap_move + o["dur"]) / 60
        full = (o["at"] - released + o["dur"]) / 60
        if marg <= 0:
            continue
        # Engaged time as the order defines it: acceptance to hand-over. The
        # acceptance moment is not in either source, so it is taken as the
        # moment the rider became free — everything after that was spent on
        # this job. The one part that plainly was not is standing still
        # somewhere that is not a light and not a restaurant, which is waiting
        # for an offer rather than working on one, so it comes back out.
        idle = _idle_seconds(ride, released, o["at"])
        engaged = (o["at"] - released - idle + o["dur"]) / 60
        tot_km = o["dist"] + ap_km
        rows.append({
            "at": o["at"],
            "amt": o["total"], "km": o["dist"], "ap_km": ap_km, "tot_km": tot_km,
            "dur_min": o["dur"] / 60, "ap_move": ap_move / 60, "ap_stop": ap_stop / 60,
            "lg_move": lg_move / 60, "lg_stop": lg_stop / 60, "lg_km": lg_km,
            "marg": marg, "full": full, "engaged": engaged, "idle": idle / 60,
            "offer_rate": o["total"] / (o["dur"] / 3600),
            "marg_rate": o["total"] / (marg / 60),
            "full_rate": o["total"] / (full / 60),
            "eng_rate": o["total"] / (engaged / 60),
            # What the order guarantees this job on its own: the clock times
            # the rate. Whichever of this and the fare is larger is what the
            # hour is worth, once the platform settles the period.
            "floor_value": engaged * FLOOR["rate"] / 60,
            "per_km": o["total"] / o["dist"],
            "per_tot_km": o["total"] / tot_km if tot_km > 0 else 0.0,
            "batched": o["kind"] == "CT",
            "hour": datetime.fromtimestamp(o["at"], timezone.utc).astimezone(SYD_TZ).hour,
        })
    if len(rows) < OFFER_MIN_ROWS:
        return None

    med = lambda f, src=None: st.median([f(r) for r in (src or rows)])

    # -- what the offer screen is paying for
    pay, pay_r2 = _ols([[1.0, r["km"], r["dur_min"]] for r in rows],
                       [r["amt"] for r in rows])
    # -- what an accepted offer costs in minutes
    tm, tm_r2 = _ols([[1.0, r["tot_km"]] for r in rows], [r["marg"] for r in rows])
    tmb, tmb_r2 = _ols([[1.0, r["tot_km"], 1.0 if r["batched"] else 0.0] for r in rows],
                       [r["marg"] for r in rows])
    # -- and in engaged minutes, which is the clock the floor is paid against
    em, em_r2 = _ols([[1.0, r["tot_km"]] for r in rows], [r["engaged"] for r in rows])
    emb, emb_r2 = _ols([[1.0, r["tot_km"], 1.0 if r["batched"] else 0.0] for r in rows],
                       [r["engaged"] for r in rows])

    # -- which of the offer's visible numbers actually moves the hourly rate.
    # The approach distance sits in the denominator of the rate, so some of
    # this correlation is arithmetic rather than discovery. What is not
    # arithmetic is the comparison: the fare varies by a factor of three
    # across orders and the approach by a factor of twenty, so the small
    # number on the screen is the one with room to decide the hour.
    y = [r["marg_rate"] for r in rows]
    drivers = [
        {"key": "ap_km", "cn": "取餐点有多远", "en": "distance to the restaurant",
         "rho": _spearman([-r["ap_km"] for r in rows], y)},
        {"key": "amt", "cn": "这一单给多少钱", "en": "what the offer pays",
         "rho": _spearman([r["amt"] for r in rows], y)},
        {"key": "per_km", "cn": "每公里多少钱（只算送餐段）", "en": "dollars per delivered km",
         "rho": _spearman([r["per_km"] for r in rows], y)},
        {"key": "km", "cn": "送多远", "en": "how far the delivery runs",
         "rho": _spearman([r["km"] for r in rows], y)},
        {"key": "per_tot_km", "cn": "每公里多少钱（含去餐厅的路）", "en": "dollars per ridden km",
         "rho": _spearman([r["per_tot_km"] for r in rows], y)},
    ]
    drivers.sort(key=lambda d: -(d["rho"] or 0))

    q = lambda vals, k: round(st.quantiles(sorted(vals), n=10)[k], 2)
    spread = {}
    for key, label in (("ap_km", "取餐距离"), ("km", "送餐距离"), ("amt", "单价")):
        v = [r[key] for r in rows]
        spread[key] = {"label": label, "p10": q(v, 0), "med": round(st.median(v), 2),
                       "p90": q(v, 8), "ratio": round(q(v, 8) / max(q(v, 0), 0.01), 1)}

    bands = []
    for lo, hi in OFFER_KM_BANDS:
        sub = [r for r in rows if lo <= r["per_tot_km"] < hi]
        if len(sub) < 8:
            continue
        bands.append({"lo": lo, "hi": hi if hi < 90 else None, "n": len(sub),
                      "rate": round(med(lambda r: r["marg_rate"], sub), 1),
                      "amt": round(med(lambda r: r["amt"], sub), 2),
                      "km": round(med(lambda r: r["km"], sub), 2),
                      "ap_km": round(med(lambda r: r["ap_km"], sub), 2)})

    # -- the rule, swept. `refilled` assumes a declined order is replaced by
    # another at the kept set's rate; `idle` assumes the freed minutes earn
    # nothing at all. The truth is in between and this data cannot locate it,
    # because a log of accepted orders has nothing to say about the ones that
    # were never offered.
    gross = sum(r["amt"] for r in rows)
    hours = sum(r["marg"] for r in rows) / 60
    cuts = []
    for thr in OFFER_RULE_CUTS:
        keep = [r for r in rows if r["per_tot_km"] >= thr]
        skip = [r for r in rows if r["per_tot_km"] < thr]
        if len(keep) < 10 or len(skip) < 10:
            continue
        kh = sum(r["marg"] for r in keep) / 60
        cuts.append({"thr": thr, "keep": len(keep),
                     "keep_pct": round(100 * len(keep) / len(rows)),
                     "kept_rate": round(med(lambda r: r["marg_rate"], keep), 1),
                     "skip_rate": round(med(lambda r: r["marg_rate"], skip), 1),
                     "gross_pct": round(100 * sum(r["amt"] for r in keep) / gross),
                     "refilled": round(sum(r["amt"] for r in keep) / kh, 1),
                     "idle": round(sum(r["amt"] for r in keep) / hours, 1)})

    targets = []
    if tm:
        for t in OFFER_TARGET_RATES:
            targets.append({"rate": t, "base": round(t / 60 * tm[0], 2),
                            "per_km": round(t / 60 * tm[1], 2),
                            "at4": round(t / 60 * (tm[0] + tm[1] * 4), 2)})

    kinds = {}
    for key, sub in (("single", [r for r in rows if not r["batched"]]),
                     ("batched", [r for r in rows if r["batched"]])):
        if len(sub) < 10:
            continue
        kinds[key] = {"n": len(sub),
                      "amt": round(med(lambda r: r["amt"], sub), 2),
                      "km": round(med(lambda r: r["km"], sub), 2),
                      "ap_km": round(med(lambda r: r["ap_km"], sub), 2),
                      "paid_min": round(med(lambda r: r["dur_min"], sub), 1),
                      "offer_rate": round(med(lambda r: r["offer_rate"], sub), 1),
                      "marg_rate": round(med(lambda r: r["marg_rate"], sub), 1)}

    hours_rows = []
    for h in sorted({r["hour"] for r in rows}):
        sub = [r for r in rows if r["hour"] == h]
        if len(sub) < 10:
            continue
        hours_rows.append({"h": h, "n": len(sub),
                           "rate": round(med(lambda r: r["marg_rate"], sub), 1),
                           "amt": round(med(lambda r: r["amt"], sub), 2),
                           "ap_km": round(med(lambda r: r["ap_km"], sub), 2)})

    # -- what the drop-off point costs *after* the order is over.
    # Splitting the fares by destination suburb was the obvious way to ask
    # this and it does not survive contact with the sample: six or seven
    # priced orders per suburb, and the spread between the best and worst is
    # smaller than the noise. Asked as a continuous question it holds up,
    # because it can use every drop the watch saw rather than only the ones
    # this platform priced — how far the drop lands from the middle of the
    # restaurant cluster, against the unpaid ride that follows it.
    tail = _drop_tail(shifts)

    waits = [d["secs"] / 60 for r in shifts for d in r["dwells"] if d["kind"] == "pickup"]

    # -- the floor, and which side of it this work sits on ------------------
    eng_hours = sum(r["engaged"] for r in rows) / 60
    fare_rate = gross / eng_hours
    below = [r for r in rows if r["amt"] < r["floor_value"]]
    cut = datetime.fromisoformat(FLOOR["from"]).replace(tzinfo=SYD_TZ).timestamp()
    eras = {}
    for key, sel in (("before", lambda r: r["at"] < cut), ("after", lambda r: r["at"] >= cut)):
        sub = [r for r in rows if sel(r)]
        if len(sub) < 10:
            continue
        h = sum(r["engaged"] for r in sub) / 60
        eras[key] = {"n": len(sub), "hours": round(h, 1),
                     "fare_rate": round(sum(r["amt"] for r in sub) / h, 1),
                     "below_pct": round(100 * sum(1 for r in sub
                                                  if r["amt"] < r["floor_value"]) / len(sub))}
    floor = dict(FLOOR)
    floor.update({
        "eng_hours": round(eng_hours, 1),
        "fare_rate": round(fare_rate, 1),
        "gap": round(FLOOR["rate"] - fare_rate, 1),
        "gap_total": round(FLOOR["rate"] * eng_hours - gross, 2),
        "below_n": len(below), "below_pct": round(100 * len(below) / len(rows)),
        "med_engaged": round(med(lambda r: r["engaged"]), 1),
        "med_floor_value": round(med(lambda r: r["floor_value"]), 2),
        "med_amt": round(med(lambda r: r["amt"]), 2),
        "eras": eras,
        # Break-even: at this fare an order pays its own way and the clock
        # adds nothing. Below it the minutes are worth more than the money.
        "break_even_per_min": round(FLOOR["rate"] / 60, 3),
        "engaged_model": {"base": round(em[0], 2), "per_km": round(em[1], 2),
                          "r2": round(em_r2, 3)} if em else None,
        "engaged_model_ct": {"base": round(emb[0], 2), "per_km": round(emb[1], 2),
                             "extra": round(emb[2], 1), "r2": round(emb_r2, 3)} if emb else None,
    })
    promos = _read_promotions(path)
    if promos:
        # The promotion rows have no distance and no duration, so they cannot
        # be matched to a shift the way an order can. Shared out per order —
        # quests pay for trip counts, so per order is the closest thing to
        # right — they say what the engaged hour looks like if those payouts
        # really are on top of the fares rather than already inside them.
        share = len(rows) / max(1, len(orders))
        est = promos["total"] * share
        promos.update({
            "per_order": round(promos["total"] / max(1, len(orders)), 2),
            "matched_est": round(est, 2),
            "with_promo_rate": round((gross + est) / eng_hours, 1),
            "covers_gap": round(est) >= round(FLOOR["rate"] * eng_hours - gross),
        })

    return {
        "n": len(rows), "of_orders": len(orders),
        "gross": round(gross, 2), "hours": round(hours, 1),
        "engaged_rate": round(gross / hours, 1),
        "pay_model": {"base": round(pay[0], 2), "per_km": round(pay[1], 2),
                      "per_min": round(pay[2], 3), "r2": round(pay_r2, 3)} if pay else None,
        # Two fits of the same thing. The plain one is what the calculator
        # quotes and what the accept rule is derived from; the second adds a
        # batched flag, and its own base/slope must be used with its own
        # coefficient rather than bolted onto the first.
        "time_model": {"base": round(tm[0], 2), "per_km": round(tm[1], 2),
                       "r2": round(tm_r2, 3), "kmh": round(60 / tm[1], 1)} if tm else None,
        "time_model_ct": {"base": round(tmb[0], 2), "per_km": round(tmb[1], 2),
                          "extra": round(tmb[2], 1), "r2": round(tmb_r2, 3)} if tmb else None,
        "split": {
            "ap_min": round(med(lambda r: r["ap_move"] + r["ap_stop"]), 1),
            "ap_move": round(med(lambda r: r["ap_move"]), 1),
            "ap_stop": round(med(lambda r: r["ap_stop"]), 1),
            "ap_km": round(med(lambda r: r["ap_km"]), 2),
            "paid_min": round(med(lambda r: r["dur_min"]), 1),
            "paid_move": round(med(lambda r: r["lg_move"]), 1),
            "paid_stop": round(med(lambda r: r["lg_stop"]), 1),
            "paid_km": round(med(lambda r: r["km"]), 2),
            "marg_min": round(med(lambda r: r["marg"]), 1),
            "full_min": round(med(lambda r: r["full"]), 1),
            "engaged_min": round(med(lambda r: r["engaged"]), 1),
            "idle_min": round(med(lambda r: r["idle"]), 1),
            "unpaid_km_pct": round(100 * sum(r["ap_km"] for r in rows)
                                   / sum(r["ap_km"] + r["km"] for r in rows)),
        },
        "rates": {"offer": round(med(lambda r: r["offer_rate"]), 1),
                  "marginal": round(med(lambda r: r["marg_rate"]), 1),
                  "full": round(med(lambda r: r["full_rate"]), 1),
                  "haircut": round(100 * (1 - med(lambda r: r["full_rate"])
                                          / med(lambda r: r["offer_rate"])))},
        "drivers": drivers, "spread": spread, "bands": bands, "cuts": cuts,
        "targets": targets, "kinds": kinds, "by_hour": hours_rows, "tail": tail,
        "floor": floor, "promos": promos,
        "wait": {"n": len(waits), "med": round(st.median(waits), 1),
                 "p90": round(st.quantiles(sorted(waits), n=10)[8], 1)} if waits else None,
        # One point per order for the scatter: money against the kilometres it
        # cost. No addresses, no timestamps — nothing that locates a customer.
        "points": [{"k": round(r["tot_km"], 2), "a": round(r["amt"], 2),
                    "m": round(r["marg"], 1), "e": round(r["engaged"], 1),
                    "b": 1 if r["batched"] else 0,
                    "h": r["hour"]} for r in rows],
    }

# -- per-ride pass ----------------------------------------------------------
ENDPOINT_M = 150


def is_endpoint_stop(ride, lat, lon):
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
        if haversine(pt[0], pt[1], lat, lon) < ENDPOINT_M:
            return True
    return False


def analyse_ride(path, ctx):
    pts = read_track(path)
    if len(pts) < 60 or not in_sydney(pts):
        return None

    ele = smooth_elevation(pts)
    n = len(pts)
    dwell_spans = find_dwells(pts)
    # Which samples sit inside which dwell, so zone time can be split into
    # riding, waiting at lights, and working.
    span_of = {}
    for k, (a, b) in enumerate(dwell_spans):
        for i in range(a, b + 1):
            span_of[i] = k

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
            "dwell": span_of.get(i),
        })

    start_local = pts[0]["t"].astimezone(SYD_TZ)
    ride = {
        "id": Path(path).stem,
        "date": start_local.strftime("%Y-%m-%d"),
        "start_local": start_local.isoformat(timespec="seconds"),
        "hour": start_local.hour + start_local.minute / 60,
        "weekday": start_local.weekday(),
        "seconds": (pts[-1]["t"] - pts[0]["t"]).total_seconds(),
        "km": sum(s["d"] for s in samples) / 1000,
        "samples": samples,
        "start_pt": (pts[0]["lat"], pts[0]["lon"]),
        "end_pt": (pts[-1]["lat"], pts[-1]["lon"]),
        "dwells": [],
    }

    dropped = 0
    for k, (a, b) in enumerate(dwell_spans):
        f = dwell_features(pts, a, b)
        if is_endpoint_stop(ride, f["lat"], f["lon"]):
            dropped += 1
            for s in samples:
                if s["dwell"] == k:
                    s["dwell"] = None
            continue
        f.update(ctx.probe(f["lat"], f["lon"]))
        f["ride"] = ride["id"]
        f["span"] = k
        ride["dwells"].append(f)
    ride["endpoint_dropped"] = dropped
    return ride


# -- statistics helpers -----------------------------------------------------
def wpercentile(pairs, p):
    """Exposure-weighted percentile over (value, weight) pairs.

    Zones are wildly uneven — one has 56 km of riding in it and another 2 —
    so an unweighted percentile lets a suburb the rider crossed once set the
    scale for the whole index.
    """
    rows = sorted((v, w) for v, w in pairs if w > 0)
    total = sum(w for _, w in rows)
    if not rows or total <= 0:
        return None
    target = total * p
    run = 0.0
    for v, w in rows:
        run += w
        if run >= target:
            return v
    return rows[-1][0]


def shrink(value, exposure, city, prior):
    """Pull a thin measurement toward the city figure.

    A suburb ridden for 400 m has a median speed, but it is the median of one
    street on one evening. Rather than hiding those zones or letting them rank,
    each metric is a weighted blend of what was measured there and what the
    city does generally, with the blend set by how much was actually ridden.
    At `prior` km of exposure the two count equally.
    """
    if city is None:
        return value
    if exposure <= 0:
        return city
    return (exposure * value + prior * city) / (exposure + prior)


def norm01(value, lo, hi):
    """Map value into 0-1 with lo -> 0, hi -> 1 (inverted when hi < lo)."""
    if lo is None or hi is None or hi == lo:
        return 0.5
    return max(0.0, min(1.0, (value - lo) / (hi - lo)))


# -- aggregation ------------------------------------------------------------
def build_zones(shifts, subs, ctx):
    Z = defaultdict(lambda: {
        "orders": 0, "pickups": 0, "lights": 0, "dwell": [], "pickup_wait": [],
        "secs": 0.0, "ride_secs": 0.0, "move_secs": 0.0, "crawl_secs": 0.0,
        "light_secs": 0.0, "stop_secs": 0.0, "work_secs": 0.0, "m": 0.0,
        "move_m": 0.0, "crawl_m": 0.0, "speeds": [], "climb": 0.0,
        "shifts": set(), "hours": defaultdict(int), "leg_min": [],
        # Per-shift (time, distance) so the score can be bootstrapped over
        # shifts rather than over 1 Hz samples, which are not independent.
        "by_shift": defaultdict(lambda: [0.0, 0.0]),
    })

    kind_of = {}
    for r in shifts:
        for d in r["dwells"]:
            kind_of[(r["id"], d["span"])] = d["kind"]

    for r in shifts:
        for s in r["samples"]:
            name = subs.lookup(s["lat"], s["lon"])
            if not name:
                continue
            z = Z[name]
            z["secs"] += s["dt"]
            z["m"] += s["d"]
            z["shifts"].add(r["id"])
            kind = kind_of.get((r["id"], s["dwell"])) if s["dwell"] is not None else None
            if kind in ("pickup", "dropoff"):
                z["work_secs"] += s["dt"]
                continue                     # working, not travelling
            z["ride_secs"] += s["dt"]
            z["by_shift"][r["id"]][0] += s["dt"]
            z["by_shift"][r["id"]][1] += s["d"]
            # Four buckets that partition riding time exactly once each.
            # A sample sitting in a classified light dwell is light time even
            # though its state is also "stop"; counting it in both would make
            # the decomposition sum to more than the clock.
            if kind == "light":
                z["light_secs"] += s["dt"]
            elif s["state"] == "stop":
                z["stop_secs"] += s["dt"]
            elif s["state"] == "crawl":
                z["crawl_secs"] += s["dt"]
                z["crawl_m"] += s["d"]
            else:
                z["move_secs"] += s["dt"]
                z["move_m"] += s["d"]
                z["speeds"].append(s["v"] * 3.6)
            # Grade is only computed where the bike actually moved a few metres;
            # forcing it to zero on slow samples would credit crawling as flat.
            if s["grade"] > 0 and s["d"] > 3:
                z["climb"] += s["grade"] * s["d"]

    for r in shifts:
        for d in r["dwells"]:
            name = subs.lookup(d["lat"], d["lon"])
            if not name:
                continue
            z = Z[name]
            if d["kind"] == "light":
                z["lights"] += 1
                continue
            if d["kind"] == "pickup":
                z["pickups"] += 1
                z["pickup_wait"].append(d["secs"])
            else:
                z["orders"] += 1
                z["dwell"].append(d["secs"])
            # The hour histogram counts every job touch, pickup or drop-off.
            # It answers "where should I be at 19:00", and at 19:00 a suburb
            # full of restaurants you collect from is exactly where to be even
            # if you never hand an order over inside it.
            z["hours"][d["t"].hour] += 1
    return Z


def zone_rows(Z, subs, ctx, legs):
    leg_by_zone = defaultdict(list)
    for lg in legs:
        name = subs.lookup(lg["to"]["lat"], lg["to"]["lon"])
        if name:
            leg_by_zone[name].append(lg["min"])

    rows = []
    for name, z in Z.items():
        km = z["m"] / 1000
        if km < 0.4 and z["orders"] == 0:
            continue                       # clipped a corner, nothing to say
        hours = z["secs"] / 3600
        ride_h = z["ride_secs"] / 3600
        med_speed = st.median(z["speeds"]) if z["speeds"] else 0.0
        moving = z["move_secs"] + z["crawl_secs"]
        meta = subs.meta(name) or {}
        osm = ctx.suburbs.get(name, {})
        area = osm.get("area_km2") or 0.0
        road_km = osm.get("road_km") or 0.0
        rows.append({
            "name": name,
            "label": DISPLAY_NAMES.get(name, name),
            "lga": (meta.get("lga") or "").replace(" (City)", "").replace(" (Area)", ""),
            "c": meta.get("c"),
            "orders": z["orders"],
            "pickups": z["pickups"],
            # A job touches two suburbs — collected in one, handed over in
            # another — and both count as work that suburb gave you. Haymarket
            # hands over six orders and hands you thirty-five, which the old
            # single "orders" column flattened into one misleading number.
            "jobs": z["orders"] + z["pickups"],
            "lights": z["lights"],
            "shifts": len(z["shifts"]),
            "hours": round(hours, 2),
            "km": round(km, 2),
            # -- raw material for the rideability score
            "_ride_min": z["ride_secs"] / 60,
            "_light_min": z["light_secs"] / 60,
            "_stop_min": z["stop_secs"] / 60,
            "_crawl_min": z["crawl_secs"] / 60,
            "_move_min": z["move_secs"] / 60,
            "_crawl_km": z["crawl_m"] / 1000,
            "_move_km": z["move_m"] / 1000,
            "_climb_m": z["climb"],
            "_by_shift": [tuple(v) for v in z["by_shift"].values()],
            "med_speed": round(med_speed, 1),
            "lights_per_km": round(z["lights"] / km, 2) if km else 0.0,
            "climb_per_km": round(z["climb"] / km, 1) if km else 0.0,
            "crawl_share": round((z["crawl_secs"] / moving) if moving else 0.0, 3),
            "light_min_per_km": round((z["light_secs"] / 60) / km, 2) if km else 0.0,
            "dwell_med": round(st.median(z["dwell"])) if z["dwell"] else 0,
            "pickup_wait_med": round(st.median(z["pickup_wait"])) if z["pickup_wait"] else 0,
            "leg_min_med": round(st.median(leg_by_zone[name]), 1) if leg_by_zone[name] else None,
            "orders_per_hour": round(z["orders"] / hours, 2) if hours > 0.05 else 0.0,
            "jobs_per_hour": round((z["orders"] + z["pickups"]) / hours, 2) if hours > 0.05 else 0.0,
            "km_per_order": round(km / z["orders"], 2) if z["orders"] else None,
            "hour_hist": [z["hours"].get(h, 0) for h in range(24)],
            # -- structural context from OpenStreetMap
            "area_km2": round(area, 2) if area else None,
            "food": osm.get("food"),
            "prepared": osm.get("prepared"),
            "prep_per_km2": round(osm["prepared"] / area, 1) if (area and osm.get("prepared") is not None) else None,
            "signals": osm.get("signals"),
            "sig_per_km": round(osm["signals"] / road_km, 1) if (road_km > 0.2 and osm.get("signals") is not None) else None,
            "road_km": round(road_km, 1) if road_km else None,
            "pop_density": osm.get("pop_density"),
            # Filled in by score_rideability once the interval is known.
            "ranked": False,
        })
    return rows


def score_rideability(rows):
    """How much of free-running pace a suburb actually lets you keep.

        指数 = 100 x (distance / V_FREE) / time_actually_spent_riding

    One measured ratio, no weights. The old score was a weighted blend of four
    normalised components — median speed 34%, light density 28%, climb 20%,
    crawl share 18% — and it had two faults that only showed up once there was
    enough data to test it.

    The first is double counting. Minutes per kilometre already *contains* the
    time spent at lights and the time spent crawling; adding those back as
    separate weighted terms scores the same lost minute two or three times.
    Measured on this dataset the components were badly tangled — pace against
    crawl share r=0.76, pace against lights r=0.64 — and the finished index
    tracked its own pace term at r=0.87. It was a noisy restatement of one
    number dressed up as four.

    The second is that the weights were wrong about physics. Climb carried 20%
    of the index, but the speed-versus-grade curve in this data says a metre of
    ascent costs about 0.01 min: even a hilly suburb at 12 m/km loses about
    0.12 min/km to gradient, against 0.4-1.7 min/km lost to traffic lights.
    Lights cost roughly ten times what hills do, and the index said otherwise.

    So the score is now the ratio itself, and the four numbers become a
    decomposition of the gap rather than voters on it. Every lost minute is
    attributed exactly once, to waiting at a signal, to stopping briefly for
    something else, to crawling, or to cruising below free pace — and the part
    of the cruising shortfall the gradient explains is labelled inside it.
    The parts sum to the measured total instead of to an arbitrary 100.
    """
    for r in rows:
        km, T = r["km"], r["_ride_min"]
        if not km or T <= 0:
            r["flow"] = None
            r["flow_parts"] = None
            continue
        free = km * 60 / V_FREE_KMH
        # Excess over free pace on the distance that was actually covered.
        crawl_excess = max(0.0, r["_crawl_min"] - r["_crawl_km"] * 60 / V_FREE_KMH)
        move_excess = max(0.0, r["_move_min"] - r["_move_km"] * 60 / V_FREE_KMH)
        climb_cost = min(move_excess, r["_climb_m"] * CLIMB_MIN_PER_M)
        r["flow"] = round(100 * free / T, 1)
        r["min_per_km"] = round(T / km, 2)
        r["free_min_per_km"] = round(60 / V_FREE_KMH, 2)
        r["flow_parts"] = {
            "light": round(r["_light_min"] / km, 2),
            "stop": round(r["_stop_min"] / km, 2),
            "crawl": round(crawl_excess / km, 2),
            "cruise": round(move_excess / km, 2),
            "climb_of_cruise": round(climb_cost / km, 2),
        }

    # ---- how firm is each score ------------------------------------------
    # Resampling is over shifts, not over 1 Hz samples: consecutive samples on
    # one evening are the same traffic, the same weather and the same rider, so
    # treating them as independent would report a confidence nobody has earned.
    rng = random.Random(20260831)
    for r in rows:
        legs = r.get("_by_shift") or []
        r["ci"] = None
        if r["flow"] is None or len(legs) < MIN_SHIFTS_FOR_CI:
            continue
        draws = []
        n = len(legs)
        for _ in range(BOOTSTRAP_N):
            secs = dist = 0.0
            for _ in range(n):
                a, b = legs[rng.randrange(n)]
                secs += a
                dist += b
            if secs > 0 and dist > 0:
                draws.append(100 * ((dist / 1000) * 3600 / V_FREE_KMH) / secs)
        if len(draws) < BOOTSTRAP_N // 2:
            continue
        draws.sort()
        lo = draws[int(0.05 * len(draws))]
        hi = draws[int(0.95 * len(draws))]
        r["ci"] = [round(lo, 1), round(hi, 1)]
        r["ci_width"] = round(hi - lo, 1)

    for r in rows:
        r["ranked"] = bool(r.get("ci") and r["ci_width"] <= MAX_CI_WIDTH)
        if not r["ranked"]:
            # Blank the estimates rather than leaving them for a caller to
            # print next to a "not enough data" badge. Counts survive — how
            # many times the rider was there is an observation, not a guess.
            r["flow"] = None
            r["flow_parts"] = None
            r["min_per_km"] = None
            r["ci"] = None
            r["ci_width"] = None

    published = [r for r in rows if r["ranked"]]
    return {
        "v_free_kmh": V_FREE_KMH,
        "free_min_per_km": round(60 / V_FREE_KMH, 2),
        "climb_min_per_m": CLIMB_MIN_PER_M,
        "max_ci_width": MAX_CI_WIDTH,
        "min_shifts": MIN_SHIFTS_FOR_CI,
        "bootstrap_n": BOOTSTRAP_N,
        "published": len(published),
        "median_ci_width": round(st.median([r["ci_width"] for r in published]), 1)
                           if published else None,
    }


def score_worth(rows):
    """Expected job touches per hour, discounted by how hard the zone rides.

    The old "worth" was a 0-100 index built from a ratio to the best zone,
    which moved whenever the best zone moved and meant nothing on its own.
    This is in the unit the question is actually asked in — jobs per hour —
    with two corrections: the observed rate is shrunk toward the city rate by
    how many hours were spent there, and it is scaled by the zone's rideability
    against the city's, because a job picked up where you average 22 km/h costs
    less of your evening than one where you average 15.

    Jobs rather than deliveries, because a suburb that hands you thirty-five
    orders to carry elsewhere is somewhere worth being, and counting only
    drop-offs scores it as though nothing happened there.
    """
    ranked = [r for r in rows if r["ranked"]]
    basis = ranked or rows
    city_rate = wpercentile([(r["jobs_per_hour"], r["hours"]) for r in basis], 0.5) or 0.0
    city_flow = wpercentile([(r["flow"], r["km"]) for r in basis
                             if r["flow"] is not None], 0.5) or 50.0
    for r in rows:
        rate = shrink(r["jobs_per_hour"], r["hours"], city_rate, PRIOR_HOURS)
        r["rate_shrunk"] = round(rate, 2)
        r["worth"] = (round(rate * (r["flow"] / city_flow), 2)
                      if (r["ranked"] and r["flow"] is not None) else None)
    return {"city_rate": round(city_rate, 2), "city_flow": round(city_flow, 1)}


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


def build_cells(shifts, grid, kind_of):
    cells = defaultdict(lambda: {
        "secs": 0.0, "m": 0.0, "speeds": [], "grades": [], "light_secs": 0.0,
        "shifts": set(), "stop_secs": 0.0,
    })
    for r in shifts:
        for s in r["samples"]:
            kind = kind_of.get((r["id"], s["dwell"])) if s["dwell"] is not None else None
            if kind in ("pickup", "dropoff"):
                continue                    # parked for work, not road friction
            k = grid.key(s["lat"], s["lon"])
            c = cells[k]
            c["secs"] += s["dt"]
            c["m"] += s["d"]
            c["shifts"].add(r["id"])
            if kind == "light":
                c["light_secs"] += s["dt"]
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
        speeds, grades, secs, metres, stop_secs, light_secs = [], [], 0.0, 0.0, 0.0, 0.0
        ridden = set()
        for k in chain:
            c = busy[k]
            speeds += c["speeds"]
            grades += c["grades"]
            secs += c["secs"]
            metres += c["m"]
            stop_secs += c["stop_secs"]
            light_secs += c["light_secs"]
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
        disp = [DISPLAY_NAMES.get(n, n) for n in (head, tail) if n]
        label = disp[0] if (len(disp) < 2 or disp[0] == disp[1]) else f"{disp[0]} → {disp[1]}"
        corridors.append({
            "passes": len(ridden),
            "cells": len(chain),
            "len_m": round(metres / max(1, len(ridden))),
            "med_speed": round(med_speed, 1),
            "grade_up": round(up * 100, 1),
            "stop_share": round(stop_secs / secs, 3) if secs else 0,
            "light_share": round(light_secs / secs, 3) if secs else 0,
            "lost_min": round(lost, 1),
            # Total lost time just re-ranks the longest, most-ridden roads.
            # Per pass is the number that answers "what does this cost me
            # every time I ride it".
            "lost_per_pass": round(lost / max(1, len(ridden)), 2),
            "zone": label,
            "zones": sorted({DISPLAY_NAMES.get(n, n) for n in names}),
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
    ap.add_argument("--osm", default=str(ROOT / "osm_context.json"))
    ap.add_argument("--uber", default=str(ROOT / "data" / "uber" / "uber_activity.psv"),
                    help="real order log to score the classifier against (optional)")
    ap.add_argument("--dry-run", action="store_true", help="print, do not write")
    args = ap.parse_args()

    routes_dir = Path(args.export_dir) / "workout-routes"
    files = sorted(routes_dir.glob("*.gpx"))
    if not files:
        raise SystemExit(f"no GPX under {routes_dir}")
    subs = SuburbIndex(args.suburbs)
    ctx = MapContext(args.osm)
    if ctx.ok:
        c = ctx.meta.get("counts", {})
        print(f"Map context: {c.get('signals', 0)} signals, {c.get('venues', 0)} venues, "
              f"{c.get('suburbs', 0)} suburbs")
    else:
        print("WARNING: no osm_context.json — run fetch_osm.py; classification "
              "will fall back to motion features only")
    print(f"Reading {len(files)} GPX tracks from {routes_dir} ...")

    rides = []
    for f in files:
        r = analyse_ride(f, ctx)
        if r:
            rides.append(r)
    for r in rides:
        work_like = sum(1 for d in r["dwells"] if d["secs"] >= 60)
        r["is_shift"] = work_like >= MIN_SHIFT_ORDERS and r["seconds"] >= MIN_SHIFT_MINUTES * 60
    shifts = [r for r in rides if r["is_shift"]]
    if not shifts:
        raise SystemExit("no delivery shifts found in the export")
    endpoint_dropped = sum(r["endpoint_dropped"] for r in shifts)
    print(f"  -> {len(rides)} Sydney tracks, {len(shifts)} work shifts")

    all_dwells = [d for r in shifts for d in r["dwells"]]
    clusters = cluster_dwells(all_dwells)
    anchors = classify(all_dwells)
    counts = defaultdict(int)
    for d in all_dwells:
        counts[d["kind"]] += 1
    for d in all_dwells:
        d["zone"] = subs.lookup(d["lat"], d["lon"])
    legs = build_legs(shifts)
    pickup_stats, drop_stats, chain = build_transitions(shifts, subs)
    validation = validate_against_uber(args.uber, shifts, all_dwells, subs)
    offers = build_offers(args.uber, shifts, subs)
    print(f"  -> {len(all_dwells)} dwells: {counts['dropoff']} 送达, {counts['pickup']} 取餐, "
          f"{counts['light']} 等灯 ({len(anchors)} repeat pickup points, "
          f"{endpoint_dropped} dropped as shift endpoints)")
    print(f"  -> {len(legs)} pickup→drop-off legs paired")
    print(f"  -> {chain['dead_legs']} dead legs: median {chain['dead_km_med']} km / "
          f"{chain['dead_min_med']} min, {chain['dead_share']}% of distance unpaid, "
          f"{chain['same_zone_pct']}% next job in the same suburb")
    if validation:
        print(f"  -> validated against {validation['orders']} real orders: "
              f"{validation['recall_drop']}% of drop-offs caught, "
              f"{validation['zone_pct']}% in the right suburb")
    else:
        print("  -> no order log found, skipping validation")
    if offers:
        f = offers["floor"]
        print(f"  -> offer model on {offers['n']} priced orders: "
              f"${offers['rates']['offer']}/h on the offer screen, "
              f"${f['fare_rate']}/h per engaged hour, floor ${f['rate']}/h "
              f"({f['below_pct']}% of orders pay less than their own engaged time is worth)")

    Z = build_zones(shifts, subs, ctx)
    zones = zone_rows(Z, subs, ctx, legs)
    for z in zones:
        z["as_pickup"] = pickup_stats.get(z["name"])
        z["as_drop"] = drop_stats.get(z["name"])
    flow_basis = score_rideability(zones)
    worth_basis = score_worth(zones)
    zones.sort(key=lambda x: (-x["jobs"], -x["hours"]))
    for i, z in enumerate(zones, 1):
        z["rank"] = i
    for z in zones:
        meta = subs.meta(z["name"])
        z["ring"] = meta["rings"][0] if (meta and z["jobs"] >= 1) else None
        for k in list(z):
            if k.startswith("_"):
                del z[k]
    ranked = [z for z in zones if z["ranked"]]
    print(f"  -> {len(zones)} suburbs touched, {len(ranked)} with enough exposure to rank")

    kind_of = {(r["id"], d["span"]): d["kind"] for r in shifts for d in r["dwells"]}
    lat0 = st.mean([s["lat"] for r in shifts for s in r["samples"][::50]])
    lon0 = st.mean([s["lon"] for r in shifts for s in r["samples"][::50]])
    grid = Grid(lat0, lon0)
    cells = build_cells(shifts, grid, kind_of)
    corridors = build_corridors(cells, grid, subs)
    print(f"  -> {len(cells)} grid cells, {len(corridors)} corridors")

    # ---- hotspots, now split by what actually happens there ---------------
    hotspots = []
    for c in sorted(clusters, key=lambda c: -len(c["members"])):
        members = [m for m in c["members"] if m["kind"] != "light"]
        if len(members) < 2:
            continue
        kinds = defaultdict(int)
        hh = defaultdict(int)
        for m in members:
            kinds[m["kind"]] += 1
            hh[m["t"].hour] += 1
        durs = [m["secs"] for m in members]
        kind = "pickup" if kinds["pickup"] >= kinds["dropoff"] else "dropoff"
        name = subs.lookup(c["lat"], c["lon"])
        venue = next((m["venue"] for m in members if m["venue"]), None)
        hotspots.append({
            "lat": round(c["lat"], 5), "lon": round(c["lon"], 5),
            "zone": DISPLAY_NAMES.get(name, name),
            "kind": kind,
            "venue": venue if kind == "pickup" else None,
            "visits": len(members),
            "pickups": kinds["pickup"], "dropoffs": kinds["dropoff"],
            "shifts": len({m["ride"] for m in members}),
            "dwell_med": round(st.median(durs)),
            "dwell_total_min": round(sum(durs) / 60, 1),
            "hours": [hh.get(h, 0) for h in range(24)],
        })

    # Where the lights actually cost time, as its own map layer.
    light_spots = []
    for c in sorted(clusters, key=lambda c: -sum(m["secs"] for m in c["members"] if m["kind"] == "light")):
        members = [m for m in c["members"] if m["kind"] == "light"]
        if len(members) < 3:
            continue
        name = subs.lookup(c["lat"], c["lon"])
        light_spots.append({
            "lat": round(c["lat"], 5), "lon": round(c["lon"], 5),
            "zone": DISPLAY_NAMES.get(name, name),
            "waits": len(members),
            "shifts": len({m["ride"] for m in members}),
            "wait_med": round(st.median([m["secs"] for m in members])),
            "wait_total_min": round(sum(m["secs"] for m in members) / 60, 1),
            "d_signal": round(st.median([m["d_signal"] for m in members
                                         if m["d_signal"] is not None] or [0])),
        })
    print(f"  -> {len(hotspots)} work hotspots, {len(light_spots)} recurring light waits")

    # ---- a readable sample of the classifier's reasoning -------------------
    def as_row(d):
        name = subs.lookup(d["lat"], d["lon"])
        return {
            "kind": d["kind"], "secs": round(d["secs"]),
            "zone": DISPLAY_NAMES.get(name, name),
            "venue": d["venue"] if d["kind"] == "pickup" else None,
            "d_signal": d["d_signal"], "d_venue": d["d_venue"],
            "radius": d["radius"], "visits": d["cluster_visits"],
            "score": d["score"], "confidence": d["confidence"],
            "evidence": d["evidence"], "kind_why": d.get("kind_why") or [],
            "hour": d["t"].hour,
        }

    # The two cases the old duration rule got wrong, kept on the page as its
    # justification. Both lists want *convincing* examples, so they are sorted
    # by how strongly the evidence points, not by how extreme the duration is —
    # the shortest "pickup" in the set is a 23 s stop scoring 0.1, which is a
    # coin flip and proves nothing to anybody.
    quick_work = sorted([d for d in all_dwells
                         if d["kind"] in ("pickup", "dropoff") and d["secs"] < 90],
                        key=lambda d: -d["score"])[:8]
    long_light = sorted([d for d in all_dwells
                         if d["kind"] == "light" and d["secs"] >= 90],
                        key=lambda d: d["score"])[:8]
    quick_work = [as_row(d) for d in quick_work]
    long_light = [as_row(d) for d in long_light]

    shift_rows = []
    for r in sorted(shifts, key=lambda r: r["start_local"]):
        hrs = r["seconds"] / 3600
        zc = defaultdict(int)
        drops = [d for d in r["dwells"] if d["kind"] == "dropoff"]
        for d in drops:
            nm = subs.lookup(d["lat"], d["lon"])
            if nm:
                zc[nm] += 1
        top = max(zc, key=zc.get) if zc else None
        shift_rows.append({
            "id": r["id"], "date": r["date"], "start": r["start_local"][11:16],
            "hour": round(r["hour"], 2), "weekday": r["weekday"],
            "hours": round(hrs, 2), "km": round(r["km"], 1),
            "orders": len(drops),
            "pickups": sum(1 for d in r["dwells"] if d["kind"] == "pickup"),
            "lights": sum(1 for d in r["dwells"] if d["kind"] == "light"),
            "orders_per_hour": round(len(drops) / hrs, 2) if hrs else 0,
            "top_zone": DISPLAY_NAMES.get(top, top),
        })

    tot_orders = sum(s["orders"] for s in shift_rows)
    tot_pickups = sum(s["pickups"] for s in shift_rows)
    tot_hours = sum(s["hours"] for s in shift_rows)
    tot_km = sum(s["km"] for s in shift_rows)
    light_secs = sum(d["secs"] for d in all_dwells if d["kind"] == "light")
    pickup_waits = [d["secs"] for d in all_dwells if d["kind"] == "pickup"]
    drop_waits = [d["secs"] for d in all_dwells if d["kind"] == "dropoff"]
    sweet = sorted([z for z in zones if z["ranked"]], key=lambda z: -(z["worth"] or 0))

    hour_totals = [0] * 24
    for z in zones:
        for h in range(24):
            hour_totals[h] += z["hour_hist"][h]

    data = {
        "meta": {
            "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "city": "Sydney", "tz": "Australia/Sydney",
            "stop_speed_ms": STOP_SPEED, "dwell_seconds": DWELL_SECONDS,
            "crawl_speed_ms": CRAWL_SPEED, "cell_m": CELL_M, "cluster_m": CLUSTER_M,
            "flow_basis": flow_basis,
            "worth_basis": worth_basis,
            "prior_hours": PRIOR_HOURS,
            "shifts": len(shift_rows), "sydney_tracks": len(rides),
            "first": shift_rows[0]["date"], "last": shift_rows[-1]["date"],
            "suburb_source": "ABS 2016 SSC boundaries via michalsn/australian-suburbs (MIT)",
            "osm": ctx.meta,
            # The site is public. Stops on a shift's own start/end point are
            # dropped before anything downstream sees them, so the map never
            # grows a bright circle over wherever the rider lives.
            "endpoint_m": ENDPOINT_M,
            "endpoint_stops_dropped": endpoint_dropped,
            "dwells": len(all_dwells),
            "pickup_anchors": len(anchors),
            "anchor_shifts": ANCHOR_SHIFTS, "anchor_venue_m": ANCHOR_VENUE_M,
            "solo_venue_m": SOLO_VENUE_M,
            "uncertain": sum(1 for d in all_dwells if d["confidence"] < 0.2),
        },
        "summary": {
            "orders": tot_orders,
            "pickups": tot_pickups,
            "lights": counts["light"],
            "pd_ratio": round(tot_pickups / tot_orders, 2) if tot_orders else None,
            "hours": round(tot_hours, 1),
            "km": round(tot_km, 1),
            "orders_per_hour": round(tot_orders / tot_hours, 2) if tot_hours else 0,
            "km_per_order": round(tot_km / tot_orders, 2) if tot_orders else 0,
            "min_per_order": round(tot_hours * 60 / tot_orders, 1) if tot_orders else 0,
            "light_min_total": round(light_secs / 60, 1),
            "light_min_per_hour": round(light_secs / 60 / tot_hours, 1) if tot_hours else 0,
            "light_share": round(light_secs / (tot_hours * 3600), 3) if tot_hours else 0,
            "pickup_wait_med": round(st.median(pickup_waits)) if pickup_waits else 0,
            "drop_wait_med": round(st.median(drop_waits)) if drop_waits else 0,
            "leg_min_med": round(st.median([lg["min"] for lg in legs]), 1) if legs else None,
            "leg_km_med": round(st.median([lg["km_direct"] for lg in legs]), 2) if legs else None,
            "legs": len(legs),
            "zones_touched": len(zones),
            "zones_ranked": len(ranked),
            "top_zone": zones[0]["label"] if zones else None,
            "top_pickup_zone": max(zones, key=lambda z: z["pickups"])["label"] if zones else None,
            "top_drop_zone": max(zones, key=lambda z: z["orders"])["label"] if zones else None,
            "sweet_zone": sweet[0]["label"] if sweet else None,
            "peak_hour": max(range(24), key=lambda h: hour_totals[h]),
            "hour_totals": hour_totals,
        },
        "zones": zones,
        "ranked_zones": [z["label"] for z in ranked],
        "hotspots": hotspots[:140],
        "light_spots": light_spots[:80],
        "corridors": corridors,
        "shifts": shift_rows,
        "validation": validation,
        "offers": offers,
        "chain": chain,
        "samples": {"quick_pickups": quick_work, "long_lights": long_light},
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
    print(f"  {tot_orders} 送达 · {tot_pickups} 取餐 (ratio {data['summary']['pd_ratio']}) · "
          f"{tot_hours:.1f} h · {tot_km:.0f} km · "
          f"{data['summary']['orders_per_hour']:.2f} orders/h")


if __name__ == "__main__":
    main()
