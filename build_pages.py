#!/usr/bin/env python3
"""
Site builder. Reads cycling-analysis.html, slices every <section> block by
its visible title marker, and reassembles them into the per-topic pages
(index, patterns, body, training, rides, explorer, recovery) plus the
all-in-one cycling-analysis.html itself.

cycling-analysis.html is the section source of truth: edit a chart's markup
there (or in assets/*.js) and re-run this script to propagate it. The run is
idempotent — building twice in a row produces byte-identical output — so it
is safe to re-run at any time.

    python3 build_pages.py
"""
import json
import re
from datetime import datetime
from pathlib import Path
from textwrap import dedent

ROOT = Path(__file__).parent
SRC = ROOT / "cycling-analysis.html"


def _js_payload(path):
    """Pull the JSON out of an `window.X = <json>;` asset file."""
    text = path.read_text(encoding="utf-8").strip()
    start = text.index("=") + 1
    return json.loads(text[start:].rstrip().rstrip(";"))


def load_site_stats():
    """Numbers the page copy quotes, read from the committed data.

    These used to be typed into the prose by hand, so every refreshed export
    left the text disagreeing with the charts beside it. Missing or unreadable
    data falls back to the last built values rather than failing the build —
    the copy stays stale, but the pages still regenerate.
    """
    stats = {"months": 19, "tracks": 55, "cities": 4, "rides": 34}
    try:
        summary = _js_payload(ROOT / "assets" / "health-data.js")["summary"]
        first = datetime.strptime(summary["first_ride"], "%Y-%m-%d")
        last = datetime.strptime(summary["last_ride"], "%Y-%m-%d")
        stats["months"] = (last.year - first.year) * 12 + (last.month - first.month)
        stats["rides"] = summary["ride_count"]
    except Exception as exc:
        print(f"  !! assets/health-data.js unreadable ({exc}); "
              "keeping last built month/ride counts")
    try:
        routes = _js_payload(ROOT / "assets" / "routes.js")
        stats["tracks"] = len(routes)
        stats["cities"] = len({r["city"] for r in routes})
    except Exception as exc:
        print(f"  !! assets/routes.js unreadable ({exc}); "
              "keeping last built track/city counts")
    return stats


STATS = load_site_stats()

# -- 1. read source ---------------------------------------------------------
text = SRC.read_text(encoding="utf-8")
lines = text.splitlines(keepends=True)

# -- 2. locate every <section> ... </section> block by its visible title ----
# returns dict: title-keyword -> (start_line_index, end_line_index) inclusive
SECTION_OPEN_RE = re.compile(r'^\s*<section[\s>]')
SECTION_CLOSE_RE = re.compile(r'^\s*</section>')

def slice_lines(start, end):
    return "".join(lines[start:end + 1])

def find_section_by_title(keyword):
    """Find the <section>...</section> whose .section-title contains keyword.
    Returns the inclusive text slice."""
    for i, line in enumerate(lines):
        if 'section-title' in line and keyword in line:
            # walk backward to <section>
            j = i
            while j >= 0 and not SECTION_OPEN_RE.match(lines[j]):
                j -= 1
            # walk forward to </section>
            k = i
            while k < len(lines) and not SECTION_CLOSE_RE.match(lines[k]):
                k += 1
            return slice_lines(j, k)
    raise KeyError(f"section with title {keyword!r} not found")

def find_block(open_tag_re, close_tag_re):
    """Find first block matching open/close regex pair."""
    for i, line in enumerate(lines):
        if re.match(open_tag_re, line):
            for k in range(i, len(lines)):
                if re.match(close_tag_re, lines[k]):
                    return slice_lines(i, k)
    raise KeyError(f"block {open_tag_re} not found")

# Hero is the literal <section class="hero">
hero = find_block(r'^<section class="hero"', r'^</section>')
stats_bar = find_block(r'^<div class="stats-bar"', r'^</div>\s*$')
latest_band = find_block(r'^<section class="latest-band"', r'^</section>')

# Sections by their bilingual title (Chinese token is unique per section)
SECTIONS = {
    'map':          find_section_by_title('轨迹地图'),
    'records':      find_section_by_title('最佳成绩'),
    'cities':       find_section_by_title('城市分布'),
    'temporal':     find_section_by_title('时间画像'),
    'monthly':      find_section_by_title('月度全景'),
    'journey':      find_section_by_title('累计旅程'),
    'hr_zones':     find_section_by_title('健康指标'),
    'calendar':     find_section_by_title('活动日历'),
    'load':         find_section_by_title('7 天滚动负荷'),
    'body':         find_section_by_title('身体适应'),
    'climb':        find_section_by_title('爬升 × 配速'),
    'quadrant':     find_section_by_title('强度象限'),
    'daily_stack':  find_section_by_title('送外卖期'),
    'efficiency':   find_section_by_title('训练效率'),
    'fitness_form': find_section_by_title('训练负荷与状态'),
    'hr_range':     find_section_by_title('心率范围'),
    'energy':       find_section_by_title('能量构成'),
    'climate':      find_section_by_title('气候画像'),
    'daily_pulse':  find_section_by_title('日常脉搏'),
    'elev_gallery': find_section_by_title('爬升画像'),
    'ascent_descent': find_section_by_title('爬升 vs 下降'),
    'ride_explorer':  find_section_by_title('逐次骑行'),
    'mets':         find_section_by_title('代谢强度'),
    'departure':    find_section_by_title('出发热力图'),
    'rides_table':  find_section_by_title('全部骑行明细'),
    'hrv':          find_section_by_title('HRV 复元'),
    'rhr':          find_section_by_title('静息心率'),
    'resp':         find_section_by_title('呼吸节律'),
    'sleep':        find_section_by_title('睡眠时长'),
    'walking_reserve': find_section_by_title('心率储备'),
    'recovery_composite': find_section_by_title('晨间生理'),
}

# -- 3. page assembly -------------------------------------------------------
RANGE_FILTER_HTML = """
<div class="range-filter" id="rangeFilter">
  <span class="range-filter-label">时间范围 · Time Range</span>
  <div class="range-filter-presets">
    <button class="range-preset" data-preset="sydney">悉尼期</button>
    <button class="range-preset" data-preset="30d">近 30 天</button>
    <button class="range-preset" data-preset="90d">近 90 天</button>
    <button class="range-preset" data-preset="year">近 1 年</button>
    <button class="range-preset" data-preset="all">全部</button>
  </div>
  <div class="range-filter-inputs">
    <input type="date" id="rangeFrom">
    <span class="range-filter-sep">→</span>
    <input type="date" id="rangeTo">
  </div>
  <div class="range-filter-summary" id="rangeFilterSummary">全部数据</div>
</div>
"""

# Leaflet is only pulled in by pages that actually render the map section.
LEAFLET_CSS = """<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"
  integrity="sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY="
  crossorigin=""/>
"""

LEAFLET_JS = """<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"
  integrity="sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo="
  crossorigin=""></script>
"""

PAGE_TEMPLATE = """<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>{title}</title>
<meta name="description" content="{description}">
<meta name="theme-color" content="#0f0e0c">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Cycling Atlas">
<meta property="og:title" content="{title}">
<meta property="og:description" content="{description}">
<meta name="twitter:card" content="summary">
<link rel="icon" href="assets/favicon.svg" type="image/svg+xml">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,300;9..144,400;9..144,500;9..144,700&family=JetBrains+Mono:wght@300;400;500&family=Noto+Serif+SC:wght@300;400;500;700&display=swap" rel="stylesheet">
{leaflet_css}<link rel="stylesheet" href="assets/styles.css">
</head>
<body data-page="{page_key}">

<nav id="topNav" class="top-nav" aria-label="主导航"></nav>

{hero_block}
{intro_block}
{range_filter_block}

<main class="main">
{body_html}
</main>

<footer>
  <div id="footerGen">导出于 — · Apple Health Export</div>
  <div style="display: flex; gap: 24px;">
    <span id="footerTracks">— GPX tracks</span>
    <span id="footerDays">— days monitored</span>
    <span>Joey's data</span>
  </div>
</footer>

<div class="tooltip" id="tooltip"></div>

{leaflet_js}<script src="assets/routes.js"></script>
<script src="assets/health-data.js"></script>
<script src="assets/recovery.js"></script>
<script src="assets/app.js"></script>
</body>
</html>
"""

def make_hero(custom_h1=None, custom_sub=None, custom_meta=None):
    h = hero
    if custom_meta:
        h = re.sub(
            r'<span id="heroMetaText">[^<]*</span>',
            f'<span id="heroMetaText">{custom_meta}</span>', h)
    if custom_h1:
        h = re.sub(
            r'<h1 id="heroH1">[\s\S]*?</h1>',
            f'<h1 id="heroH1">{custom_h1}</h1>', h)
    if custom_sub:
        h = re.sub(
            r'<p class="hero-sub" id="heroSub">[\s\S]*?</p>',
            f'<p class="hero-sub" id="heroSub">{custom_sub}</p>', h)
    return h

PAGES = [
    {
        'file': 'index.html',
        'description': f'{STATS["months"]} 个月、{STATS["tracks"]} 条 GPS 轨迹、{STATS["cities"]} 座城市的骑行总览 —— 轨迹地图、个人最佳、城市分布与累计旅程。',
        'page_key': 'overview',
        'title': '总览 · Cycling Atlas',
        'hero': make_hero(
            custom_h1='在路上<br><em>夜色与坐垫</em>',
            custom_sub=f'<span data-stat="months">{STATS["months"]}</span> 个月,<span data-stat="tracks">{STATS["tracks"]}</span> 条 GPS 轨迹,<span data-stat="cities">{STATS["cities"]}</span> 个城市。这是你在悉尼下午到深夜骑出的城市,也是早期在宁波、上海、河南留下的零星记号。每一条线,都是一次出门。',
            custom_meta='总览 · Overview'),
        'intro': stats_bar + "\n" + latest_band,
        'sections': ['map', 'records', 'cities', 'journey'],
        'has_filter': False,
    },
    {
        'file': 'patterns.html',
        'description': '出发时刻、星期与月份的节律画像 —— 时段时钟、月度全景、出发热力图与活动日历。',
        'page_key': 'patterns',
        'title': '节律 · Patterns',
        'hero': make_hero(
            custom_h1='何时出门<br><em>节律与日历</em>',
            custom_sub='出发的时刻、星期、月份。把全部 411 天活动摊开,看身体在一周中怎么呼吸,在一年中怎么变形。',
            custom_meta='节律 · Patterns'),
        'intro': '',
        'sections': ['temporal', 'monthly', 'departure', 'calendar'],
        'has_filter': True,
    },
    {
        'file': 'body.html',
        'description': '骑行写在身体上的痕迹 —— 心率区间、气候画像、VO₂max、体重与日常脉搏。',
        'page_key': 'body',
        'title': '身体 · Body Signals',
        'hero': make_hero(
            custom_h1='身体在听<br><em>心率与适应</em>',
            custom_sub=f'<span data-stat="rides">{STATS["rides"]}</span> 次骑行的心率、VO₂max 的爬升、体重的浮动、湿度温度对心率的拉拽。骑行不是一组数字 —— 是身体在被改写。',
            custom_meta='身体 · Body Signals'),
        'intro': '',
        'sections': ['hr_zones', 'hr_range', 'climate', 'body', 'daily_pulse'],
        'has_filter': True,
    },
    {
        'file': 'training.html',
        'description': '训练负荷与状态 —— 7 天滚动负荷、Fitness/Form、训练效率、强度象限与爬升配速。',
        'page_key': 'training',
        'title': '训练 · Training Load',
        'hero': make_hero(
            custom_h1='负荷与形态<br><em>CTL · ATL · TSB</em>',
            custom_sub='7 天滚动、长期 / 短期负荷、训练效率、爬升与配速、强度象限。一切都为了回答:今天的身体在哪里。',
            custom_meta='训练 · Training'),
        'intro': '',
        'sections': ['load', 'fitness_form', 'efficiency', 'quadrant',
                     'climb', 'mets', 'daily_stack'],
        'has_filter': True,
    },
    {
        'file': 'rides.html',
        'description': '逐条骑行的记录 —— 能量构成、海拔剖面画廊、爬升与下降,以及完整骑行明细表。',
        'page_key': 'rides',
        'title': '骑行 · Per-Ride Detail',
        'hero': make_hero(
            custom_h1='每一次出门<br><em>逐次拆解</em>',
            custom_sub='34 条骑行的能量、爬升画像、明细表。挑一条放大,看那一天的身体怎么花掉了那 1000 千焦。',
            custom_meta='骑行 · Rides'),
        'intro': '',
        'sections': ['energy', 'elev_gallery', 'ascent_descent', 'rides_table'],
        'has_filter': True,
    },
    {
        'file': 'explorer.html',
        'description': '挑一条骑行逐次放大 —— 海拔剖面、心率、消耗与路线,在历次骑行间穿梭。',
        'page_key': 'explorer',
        'title': '逐次 · Ride Explorer',
        'hero': make_hero(
            custom_h1='挑一次出门<br><em>逐次放大</em>',
            custom_sub='挑一条骑行,看它的海拔剖面、心率、消耗与路线。悬停海拔曲线看任一公里数的高度,左右按钮在历次骑行间穿梭。',
            custom_meta='逐次 · Explorer'),
        'intro': '',
        'sections': ['ride_explorer'],
        'has_filter': False,
    },
    {
        'file': 'recovery.html',
        'description': '晨间生理读数 —— 心率变异性、静息心率、呼吸频率、血氧与睡眠的恢复曲线。',
        'page_key': 'recovery',
        'title': '复元 · Recovery',
        'hero': make_hero(
            custom_h1='身体在恢复<br><em>HRV · 静息 · 睡眠</em>',
            custom_sub='晨间的生理读数 —— 心率变异性、静息心率、呼吸频率、血氧、睡眠。骑行写下的力,身体在凌晨偷偷地还回去。拖动密集曲线可框选任一时间窗。',
            custom_meta='复元 · Recovery'),
        'intro': '',
        'sections': ['hrv', 'rhr', 'resp', 'sleep', 'walking_reserve', 'recovery_composite'],
        'has_filter': True,
    },
]

for p in PAGES:
    body_html = "\n\n".join(SECTIONS[s] for s in p['sections'])
    has_map = 'map' in p['sections']
    out = PAGE_TEMPLATE.format(
        title=p['title'],
        description=p['description'],
        page_key=p['page_key'],
        hero_block=p['hero'],
        intro_block=p['intro'],
        range_filter_block=RANGE_FILTER_HTML if p.get('has_filter') else '',
        body_html=body_html,
        leaflet_css=LEAFLET_CSS if has_map else '',
        leaflet_js=LEAFLET_JS if has_map else '',
    )
    (ROOT / p['file']).write_text(out, encoding="utf-8")
    print(f"wrote {p['file']:18s} ({len(out)//1024} KB, {len(p['sections'])} sections)")

# -- 4. rewrite cycling-analysis.html as a slim shell loading shared assets -
ALL_TITLES_ORDER = [
    'map', 'records', 'cities', 'temporal', 'monthly', 'journey',
    'hr_zones', 'calendar', 'load', 'body', 'climb', 'quadrant',
    'daily_stack', 'efficiency', 'fitness_form', 'hr_range', 'energy',
    'climate', 'daily_pulse',
    'hrv', 'rhr', 'resp', 'sleep', 'walking_reserve', 'recovery_composite',
    'elev_gallery', 'ascent_descent',
    'ride_explorer', 'mets', 'departure', 'rides_table',
]
all_body = "\n\n".join(SECTIONS[s] for s in ALL_TITLES_ORDER)
all_html = PAGE_TEMPLATE.format(
    title='全景 · Cycling Atlas (single page)',
    description='所有章节合并成一页的全景视图 —— 地图、节律、身体、训练、骑行、复元与逐次探索。',
    page_key='all',
    hero_block=hero,
    intro_block=stats_bar + "\n" + latest_band,
    range_filter_block=RANGE_FILTER_HTML,
    body_html=all_body,
    leaflet_css=LEAFLET_CSS,
    leaflet_js=LEAFLET_JS,
)
(ROOT / 'cycling-analysis.html').write_text(all_html, encoding="utf-8")
print(f"wrote cycling-analysis.html ({len(all_html)//1024} KB, all sections)")
