#!/usr/bin/env python3
"""
Downloads the map context the delivery analysis needs and caches it in
`osm_context.json`, so `analyze_delivery.py` runs offline afterwards.

The GPX export knows where the bike was and how fast. It does not know what
the bike was *next to*, and that is the whole difference between "parked for
two minutes at a restaurant" and "parked for two minutes at a red light".
Three layers close that gap:

  signals   every traffic-signal / signalised-crossing node. A stop that
            happens 8 m from one, with a 2 m footprint, is a light. This is
            the single most discriminating feature in the classifier.
  venues    restaurants, cafes, takeaways, pubs, bakeries, convenience
            stores. Where the food comes from — a pickup happens at one of
            these, a drop-off almost never does.
  roads     centre-lines, used two ways: how far a stop sits off the nearest
            major road, and per-suburb road length so signal density can be
            expressed per km of road instead of per km^2 (a big industrial
            suburb has few signals per km^2 and still stops you constantly).

Suburb-level population comes from Wikipedia infoboxes, which carry the ABS
suburb (SAL/SSC) figures against the same boundaries this repo already uses —
Haymarket reads 0.52 km^2 in both, so the densities line up rather than
mixing two different ideas of where a suburb ends.

    python3 fetch_osm.py                # refresh everything
    python3 fetch_osm.py --skip-pop     # keep the cached population table
"""
import argparse
import json
import math
import re
import subprocess
import sys
import time
import urllib.parse
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).parent
CACHE = ROOT / "osm_context.json"
OVERPASS = "https://overpass-api.de/api/interpreter"

# The riding envelope with room to spare. Bigger costs download time; smaller
# starts dropping the signals just outside a shift's furthest corner.
BBOX = (-33.97, 151.09, -33.85, 151.26)

# Anything a courier could plausibly collect an order from.
VENUE_Q = (
    'nwr["amenity"~"^(restaurant|fast_food|cafe|pub|bar|food_court|ice_cream|bakery)$"]',
    'nwr["shop"~"^(bakery|convenience|supermarket|deli|butcher|greengrocer|alcohol|pastry|confectionery)$"]',
)
ROAD_CLASSES = (
    "motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|"
    "service|cycleway|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link"
)
# Roads that carry traffic. Service roads and cycleways are excluded from the
# per-suburb road length so signal density is not diluted by car parks.
THROUGH_ROADS = {
    "motorway", "trunk", "primary", "secondary", "tertiary", "unclassified",
    "residential", "living_street", "motorway_link", "trunk_link",
    "primary_link", "secondary_link", "tertiary_link",
}
MAJOR_ROADS = {
    "motorway", "trunk", "primary", "secondary", "tertiary",
    "motorway_link", "trunk_link", "primary_link", "secondary_link", "tertiary_link",
}
# Somewhere an order is cooked or packed, as opposed to somewhere you could
# also buy a bottle of milk. Kept separate because pickup evidence leans on it.
PREPARED = {"restaurant", "fast_food", "cafe", "pub", "bar", "food_court", "ice_cream", "bakery"}

UA = "cycling-atlas/1.0 (personal delivery analysis)"


def curl(url, data=None, timeout=420):
    """Overpass and the Wikipedia API both dislike urllib here; curl works."""
    cmd = ["curl", "-s", "--max-time", str(timeout), "-A", UA]
    if data is not None:
        cmd += ["-X", "POST", "--data-binary", data]
    cmd.append(url)
    return subprocess.run(cmd, capture_output=True, text=True).stdout


def overpass(query, tries=3):
    for attempt in range(tries):
        raw = curl(OVERPASS, data=query)
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            head = raw.strip()[:160].replace("\n", " ")
            print(f"    overpass retry {attempt + 1}/{tries}: {head or 'empty response'}")
            time.sleep(20 * (attempt + 1))
    raise SystemExit("overpass would not answer — try again in a few minutes")


def haversine(lat1, lon1, lat2, lon2):
    R = 6371000.0
    p = math.radians
    dlat, dlon = p(lat2 - lat1), p(lon2 - lon1)
    a = math.sin(dlat / 2) ** 2 + math.cos(p(lat1)) * math.cos(p(lat2)) * math.sin(dlon / 2) ** 2
    return 2 * R * math.asin(math.sqrt(a))


def centre(el):
    lat = el.get("lat") or (el.get("center") or {}).get("lat")
    lon = el.get("lon") or (el.get("center") or {}).get("lon")
    return (lat, lon) if lat is not None else (None, None)


# -- track envelope ---------------------------------------------------------
def track_points(export_dir):
    """Coarse sample of every Sydney GPX point, for trimming the POI lists.

    Full resolution is pointless here — the trim radius is 250 m and points
    arrive at 1 Hz, so every 25th point still covers the same ground.
    """
    from xml.etree import ElementTree as ET
    ns = "{http://www.topografix.com/GPX/1/1}"
    pts = []
    for f in sorted(Path(export_dir).glob("workout-routes/*.gpx")):
        got = []
        for i, tp in enumerate(ET.parse(f).getroot().iter(ns + "trkpt")):
            if i % 25:
                continue
            got.append((float(tp.get("lat")), float(tp.get("lon"))))
        if got:
            mid = got[len(got) // 2]
            if BBOX[0] <= mid[0] <= BBOX[2] and BBOX[1] <= mid[1] <= BBOX[3]:
                pts += got
    return pts


class NearIndex:
    """Grid bucket for 'is anything within R of this point'."""

    def __init__(self, pts, tile=0.0025):
        self.tile = tile
        self.grid = defaultdict(list)
        for p in pts:
            self.grid[(int(p[0] / tile), int(p[1] / tile))].append(p)

    def within(self, lat, lon, radius):
        span = int(radius / (self.tile * 111000)) + 1
        gx, gy = int(lat / self.tile), int(lon / self.tile)
        for dx in range(-span, span + 1):
            for dy in range(-span, span + 1):
                for p in self.grid.get((gx + dx, gy + dy), ()):
                    if haversine(lat, lon, p[0], p[1]) <= radius:
                        return True
        return False


# -- suburbs ----------------------------------------------------------------
def ring_area_km2(ring):
    """Shoelace on a local equirectangular projection.

    Spherical excess would be more correct and, over a 1 km^2 suburb, differs
    from this by less than the boundary generalisation already costs.
    """
    lat0 = sum(p[1] for p in ring) / len(ring)
    kx = 111320.0 * math.cos(math.radians(lat0))
    ky = 110540.0
    a = 0.0
    for i in range(len(ring)):
        x0, y0 = ring[i][0] * kx, ring[i][1] * ky
        x1, y1 = ring[(i + 1) % len(ring)][0] * kx, ring[(i + 1) % len(ring)][1] * ky
        a += x0 * y1 - x1 * y0
    return abs(a) / 2 / 1e6


# -- population -------------------------------------------------------------
def wiki_api(host, params):
    url = f"https://{host}/w/api.php?" + urllib.parse.urlencode(params)
    try:
        return json.loads(curl(url, timeout=90))
    except json.JSONDecodeError:
        return {}


def fetch_population(names):
    """Infobox density first, Wikidata head-count second.

    Most suburb infoboxes carry an explicit `density` against the same ABS
    boundary; the rest leave it blank and draw the population from Wikidata,
    where the count is there but the area is not. Taking density directly when
    it exists avoids re-deriving it from a slightly different polygon.
    """
    out = {}
    titles = {n: ("Sydney central business district" if n == "Sydney"
                  else f"{n}, New South Wales") for n in names}
    todo = list(titles.items())
    for i in range(0, len(todo), 12):
        chunk = todo[i:i + 12]
        d = wiki_api("en.wikipedia.org", {
            "action": "query", "prop": "revisions|pageprops", "rvprop": "content",
            "rvslots": "main", "format": "json", "redirects": "1",
            "titles": "|".join(t for _, t in chunk)})
        pages = (d.get("query") or {}).get("pages") or {}
        by_title = {}
        for p in pages.values():
            try:
                text = p["revisions"][0]["slots"]["main"]["*"]
            except (KeyError, IndexError):
                text = ""
            by_title[p.get("title", "")] = (text, (p.get("pageprops") or {}).get("wikibase_item"))
        red = {r["from"]: r["to"] for r in (d.get("query") or {}).get("redirects", [])}
        for name, title in chunk:
            text, qid = by_title.get(red.get(title, title), ("", None))
            dens = re.search(r"\|\s*density\s*=\s*([\d,\.]+)", text)
            out[name] = {
                "density": float(dens.group(1).replace(",", "")) if dens else None,
                "pop": None, "qid": qid,
            }
        time.sleep(1)

    need = [(n, v["qid"]) for n, v in out.items() if v["density"] is None and v["qid"]]
    for i in range(0, len(need), 25):
        chunk = need[i:i + 25]
        d = wiki_api("www.wikidata.org", {
            "action": "wbgetentities", "props": "claims", "format": "json",
            "ids": "|".join(q for _, q in chunk)})
        for name, qid in chunk:
            claims = ((d.get("entities") or {}).get(qid) or {}).get("claims") or {}
            best = None
            for c in claims.get("P1082", []):
                try:
                    amt = int(float(c["mainsnak"]["datavalue"]["value"]["amount"]))
                except (KeyError, TypeError, ValueError):
                    continue
                year = None
                for t in (c.get("qualifiers") or {}).get("P585", []):
                    year = t["datavalue"]["value"]["time"][1:5]
                if best is None or (year or "0") >= (best[1] or "0"):
                    best = (amt, year)
            if best:
                out[name]["pop"] = best[0]
        time.sleep(1)
    for v in out.values():
        v.pop("qid", None)
    return out


# -- main -------------------------------------------------------------------
def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--export-dir", default=str(ROOT / "data" / "apple_health_export"))
    ap.add_argument("--suburbs", default=str(ROOT / "suburbs_sydney.json"))
    ap.add_argument("--trim-m", type=float, default=250,
                    help="keep POIs within this many metres of a ridden track")
    ap.add_argument("--skip-pop", action="store_true", help="reuse the cached population table")
    args = ap.parse_args()

    sys.path.insert(0, str(ROOT))
    from analyze_delivery import SuburbIndex

    subs = SuburbIndex(args.suburbs)
    bbox = ",".join(str(v) for v in BBOX)

    print("Sampling ridden tracks for the trim envelope ...")
    envelope = NearIndex(track_points(args.export_dir))
    print(f"  -> {sum(len(v) for v in envelope.grid.values())} sampled track points")

    print("Fetching traffic signals ...")
    sig = overpass(f"""[out:json][timeout:180];
(
  node["highway"="traffic_signals"]({bbox});
  node["crossing"="traffic_signals"]({bbox});
  node["highway"="crossing"]["crossing:signals"="yes"]({bbox});
);
out body;""")["elements"]
    print(f"  -> {len(sig)} signal nodes")

    print("Fetching food venues ...")
    venue_body = "\n  ".join(f"{q}({bbox});" for q in VENUE_Q)
    ven = overpass(f"[out:json][timeout:240];\n(\n  {venue_body}\n);\nout center tags;")["elements"]
    print(f"  -> {len(ven)} venues")

    print("Fetching road network ...")
    roads = overpass(f'[out:json][timeout:300];\nway["highway"~"^({ROAD_CLASSES})$"]({bbox});\nout geom tags;')["elements"]
    print(f"  -> {len(roads)} ways")

    # ---- trim to what the classifier can actually reach --------------------
    signals = [[round(e["lat"], 5), round(e["lon"], 5)] for e in sig
               if envelope.within(e["lat"], e["lon"], args.trim_m)]
    venues = []
    for e in ven:
        lat, lon = centre(e)
        if lat is None or not envelope.within(lat, lon, args.trim_m):
            continue
        t = e.get("tags", {})
        kind = t.get("amenity") or ("shop:" + str(t.get("shop")))
        venues.append([round(lat, 5), round(lon, 5), kind, t.get("name") or ""])
    print(f"  -> trimmed to {len(signals)} signals, {len(venues)} venues near ridden roads")

    # Major-road centre-lines, also trimmed — used for the "is this stop on the
    # roadway" test, which only ever asks about places the bike has been.
    major = []
    for w in roads:
        if w["tags"].get("highway") not in MAJOR_ROADS:
            continue
        g = w.get("geometry") or []
        run = []
        for p in g:
            if envelope.within(p["lat"], p["lon"], args.trim_m + 60):
                run.append([round(p["lat"], 5), round(p["lon"], 5)])
            elif len(run) >= 2:
                major.append(run)
                run = []
            else:
                run = []
        if len(run) >= 2:
            major.append(run)
    print(f"  -> {len(major)} major-road polylines near ridden roads")

    # ---- per-suburb structure ---------------------------------------------
    print("Aggregating per suburb ...")
    area = {s["name"]: sum(ring_area_km2(r) for r in s["rings"]) for s in subs.subs}
    food = defaultdict(int)
    prep = defaultdict(int)
    for e in ven:
        lat, lon = centre(e)
        if lat is None:
            continue
        n = subs.lookup(lat, lon)
        if not n:
            continue
        food[n] += 1
        if e.get("tags", {}).get("amenity") in PREPARED:
            prep[n] += 1
    signals_in = defaultdict(int)
    for e in sig:
        n = subs.lookup(e["lat"], e["lon"])
        if n:
            signals_in[n] += 1
    road_m = defaultdict(float)
    for w in roads:
        if w["tags"].get("highway") not in THROUGH_ROADS:
            continue
        g = w.get("geometry") or []
        for i in range(len(g) - 1):
            a, b = g[i], g[i + 1]
            n = subs.lookup((a["lat"] + b["lat"]) / 2, (a["lon"] + b["lon"]) / 2)
            if n:
                road_m[n] += haversine(a["lat"], a["lon"], b["lat"], b["lon"])

    touched = sorted(set(food) | set(signals_in) | set(road_m))
    if args.skip_pop and CACHE.exists():
        pop = json.loads(CACHE.read_text(encoding="utf-8")).get("population", {})
        print(f"  -> reusing cached population for {len(pop)} suburbs")
    else:
        print("Fetching suburb populations ...")
        want = [n for n in touched if (road_m.get(n, 0) > 800 or food.get(n, 0) >= 5)]
        pop = fetch_population(want)
        have = sum(1 for v in pop.values() if v.get("density") or v.get("pop"))
        print(f"  -> {have}/{len(want)} suburbs with a population figure")

    suburbs = {}
    for n in touched:
        a = area.get(n) or 0.0
        p = pop.get(n) or {}
        density = p.get("density")
        if density is None and p.get("pop") and a > 0.02:
            density = round(p["pop"] / a, 0)
        suburbs[n] = {
            "area_km2": round(a, 3),
            "food": food.get(n, 0),
            "prepared": prep.get(n, 0),
            "signals": signals_in.get(n, 0),
            "road_km": round(road_m.get(n, 0) / 1000, 2),
            "pop_density": density,
        }

    payload = {
        "meta": {
            "fetched_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "bbox": list(BBOX),
            "trim_m": args.trim_m,
            "source": "OpenStreetMap via Overpass (ODbL); population via Wikipedia/Wikidata (ABS census)",
            "counts": {"signals": len(signals), "venues": len(venues),
                       "major_road_lines": len(major), "suburbs": len(suburbs)},
        },
        "signals": signals,
        "venues": venues,
        "major_roads": major,
        "suburbs": suburbs,
        "population": pop,
    }
    CACHE.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"Wrote {CACHE} ({CACHE.stat().st_size / 1024:.0f} KB)")


if __name__ == "__main__":
    main()
