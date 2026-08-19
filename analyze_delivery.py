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

# A zone earns a rank only with this much exposure. Below it the numbers are
# still shown, greyed, because "I have barely been there" is itself a fact.
RANK_MIN_KM = 5.0
RANK_MIN_SHIFTS = 4

# Shrinkage priors, in the same units as the exposure they damp. A zone with
# PRIOR_KM of riding sits halfway between its own measurement and the city's.
PRIOR_KM = 3.0
PRIOR_HOURS = 0.75

FLOW_WEIGHTS = {"pace": 0.34, "lights": 0.28, "climb": 0.20, "stopgo": 0.18}

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
        "light_secs": 0.0, "work_secs": 0.0, "m": 0.0, "speeds": [], "climb": 0.0,
        "shifts": set(), "hours": defaultdict(int), "leg_min": [],
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
            if kind == "light":
                z["light_secs"] += s["dt"]
            z["ride_secs"] += s["dt"]
            if s["state"] == "move":
                z["move_secs"] += s["dt"]
                z["speeds"].append(s["v"] * 3.6)
            elif s["state"] == "crawl":
                z["crawl_secs"] += s["dt"]
            if s["grade"] > 0:
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
            # -- raw friction measurements, pre-shrinkage
            "_pace": (z["ride_secs"] / 60) / km if km > 0 else None,       # min/km
            "_light_s_km": z["light_secs"] / km if km > 0 else 0.0,
            "_climb_km": z["climb"] / km if km > 0 else 0.0,
            "_stopgo": (z["crawl_secs"] / moving) if moving else 0.0,
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
            "ranked": km >= RANK_MIN_KM and len(z["shifts"]) >= RANK_MIN_SHIFTS,
        })
    return rows


def score_flow(rows):
    """0-100 rideability, self-scaled and sample-aware.

    Four things make a suburb hard to ride: it is slow, it stops you at lights,
    it goes uphill, and it makes you crawl. Each is measured, shrunk toward the
    city figure by how little was ridden there, then normalised against the
    exposure-weighted 10th and 90th percentile of the data itself. The old
    version used hand-picked bounds (8-22 km/h, 0-26 m/km); those were guesses,
    and anything outside them clipped silently. The anchors are written into
    the output so the page can print the scale it is scoring against.
    """
    ranked = [r for r in rows if r["ranked"]]
    basis = ranked or rows
    weights = [(r, r["km"]) for r in basis]

    def city(key):
        vals = [(r[key], w) for r, w in weights if r[key] is not None]
        return wpercentile(vals, 0.5)

    anchors = {}
    for key, prior, good_high in (("_pace", PRIOR_KM, False),
                                  ("_light_s_km", PRIOR_KM, False),
                                  ("_climb_km", PRIOR_KM, False),
                                  ("_stopgo", PRIOR_KM, False)):
        vals = [(r[key], w) for r, w in weights if r[key] is not None]
        lo = wpercentile(vals, 0.10)
        hi = wpercentile(vals, 0.90)
        anchors[key] = {"good": lo if not good_high else hi,
                        "bad": hi if not good_high else lo,
                        "city": city(key)}

    comp_keys = {"pace": "_pace", "lights": "_light_s_km",
                 "climb": "_climb_km", "stopgo": "_stopgo"}
    for r in rows:
        parts = {}
        for comp, key in comp_keys.items():
            a = anchors[key]
            raw = r[key]
            if raw is None:
                parts[comp] = 0.5
                continue
            sh = shrink(raw, r["km"], a["city"], PRIOR_KM)
            r[key + "_shrunk"] = round(sh, 3)
            parts[comp] = 1 - norm01(sh, a["good"], a["bad"])
        r["flow_parts"] = {k: round(100 * v, 1) for k, v in parts.items()}
        r["flow"] = round(100 * sum(FLOW_WEIGHTS[k] * parts[k] for k in FLOW_WEIGHTS), 1)
    return anchors


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
    city_flow = wpercentile([(r["flow"], r["km"]) for r in basis], 0.5) or 50.0
    for r in rows:
        rate = shrink(r["jobs_per_hour"], r["hours"], city_rate, PRIOR_HOURS)
        r["rate_shrunk"] = round(rate, 2)
        r["worth"] = round(rate * (r["flow"] / city_flow), 2) if r["ranked"] else None
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
    legs = build_legs(shifts)
    print(f"  -> {len(all_dwells)} dwells: {counts['dropoff']} 送达, {counts['pickup']} 取餐, "
          f"{counts['light']} 等灯 ({len(anchors)} repeat pickup points, "
          f"{endpoint_dropped} dropped as shift endpoints)")
    print(f"  -> {len(legs)} pickup→drop-off legs paired")

    Z = build_zones(shifts, subs, ctx)
    zones = zone_rows(Z, subs, ctx, legs)
    flow_anchors = score_flow(zones)
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
            "flow_weights": FLOW_WEIGHTS,
            "flow_anchors": {k: {kk: (round(vv, 3) if isinstance(vv, float) else vv)
                                 for kk, vv in v.items()} for k, v in flow_anchors.items()},
            "worth_basis": worth_basis,
            "rank_min_km": RANK_MIN_KM, "rank_min_shifts": RANK_MIN_SHIFTS,
            "prior_km": PRIOR_KM, "prior_hours": PRIOR_HOURS,
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
