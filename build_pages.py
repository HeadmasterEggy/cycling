#!/usr/bin/env python3
"""
One-shot extractor: read the legacy single-page cycling-analysis.html,
slice each section block by its title-text marker, and assemble the
multi-page output files (index, patterns, body, training, rides).

After this script runs once, the multi-page files become the source of
truth. The legacy file is rewritten to load the same shared assets so
it still works as the "all-in-one" view.
"""
import re
from pathlib import Path
from textwrap import dedent

ROOT = Path(__file__).parent
SRC = ROOT / "cycling-analysis.html"

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
    'mets':         find_section_by_title('代谢强度'),
    'departure':    find_section_by_title('出发热力图'),
    'rides_table':  find_section_by_title('全部骑行明细'),
}

# -- 3. page assembly -------------------------------------------------------
PAGE_TEMPLATE = """<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>{title}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,300;9..144,400;9..144,500;9..144,700&family=JetBrains+Mono:wght@300;400;500&family=Noto+Serif+SC:wght@300;400;500;700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"
  integrity="sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY="
  crossorigin=""/>
<link rel="stylesheet" href="assets/styles.css">
</head>
<body data-page="{page_key}">

<nav id="topNav" class="top-nav" aria-label="主导航"></nav>

{hero_block}
{intro_block}

<main class="main">
{body_html}
</main>

<footer>
  <div id="footerGen">导出于 — · Apple Health Export</div>
  <div style="display: flex; gap: 24px;">
    <span>55 GPX tracks</span>
    <span id="footerDays">— days monitored</span>
    <span>Joey's data</span>
  </div>
</footer>

<div class="tooltip" id="tooltip"></div>

<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"
  integrity="sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo="
  crossorigin=""></script>
<script src="assets/routes.js"></script>
<script src="assets/health-data.js"></script>
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
        'page_key': 'overview',
        'title': '总览 · Cycling Atlas',
        'hero': make_hero(
            custom_h1='在路上<br><em>夜色与坐垫</em>',
            custom_sub='19 个月,55 条 GPS 轨迹,4 个城市。这是你在悉尼下午到深夜骑出的城市,也是早期在宁波、上海、河南留下的零星记号。每一条线,都是一次出门。',
            custom_meta='总览 · Overview'),
        'intro': stats_bar + "\n" + latest_band,
        'sections': ['map', 'records', 'cities', 'journey'],
    },
    {
        'file': 'patterns.html',
        'page_key': 'patterns',
        'title': '节律 · Patterns',
        'hero': make_hero(
            custom_h1='何时出门<br><em>节律与日历</em>',
            custom_sub='出发的时刻、星期、月份。把全部 411 天活动摊开,看身体在一周中怎么呼吸,在一年中怎么变形。',
            custom_meta='节律 · Patterns'),
        'intro': '',
        'sections': ['temporal', 'monthly', 'departure', 'calendar'],
    },
    {
        'file': 'body.html',
        'page_key': 'body',
        'title': '身体 · Body Signals',
        'hero': make_hero(
            custom_h1='身体在听<br><em>心率与适应</em>',
            custom_sub='34 次骑行的心率、VO₂max 的爬升、体重的浮动、湿度温度对心率的拉拽。骑行不是一组数字 —— 是身体在被改写。',
            custom_meta='身体 · Body Signals'),
        'intro': '',
        'sections': ['hr_zones', 'hr_range', 'climate', 'body', 'daily_pulse'],
    },
    {
        'file': 'training.html',
        'page_key': 'training',
        'title': '训练 · Training Load',
        'hero': make_hero(
            custom_h1='负荷与形态<br><em>CTL · ATL · TSB</em>',
            custom_sub='7 天滚动、长期 / 短期负荷、训练效率、爬升与配速、强度象限。一切都为了回答:今天的身体在哪里。',
            custom_meta='训练 · Training'),
        'intro': '',
        'sections': ['load', 'fitness_form', 'efficiency', 'quadrant',
                     'climb', 'mets', 'daily_stack'],
    },
    {
        'file': 'rides.html',
        'page_key': 'rides',
        'title': '骑行 · Per-Ride Detail',
        'hero': make_hero(
            custom_h1='每一次出门<br><em>逐次拆解</em>',
            custom_sub='34 条骑行的能量、爬升画像、明细表。挑一条放大,看那一天的身体怎么花掉了那 1000 千焦。',
            custom_meta='骑行 · Rides'),
        'intro': '',
        'sections': ['energy', 'elev_gallery', 'rides_table'],
    },
]

for p in PAGES:
    body_html = "\n\n".join(SECTIONS[s] for s in p['sections'])
    out = PAGE_TEMPLATE.format(
        title=p['title'],
        page_key=p['page_key'],
        hero_block=p['hero'],
        intro_block=p['intro'],
        body_html=body_html,
    )
    (ROOT / p['file']).write_text(out, encoding="utf-8")
    print(f"wrote {p['file']:18s} ({len(out)//1024} KB, {len(p['sections'])} sections)")

# -- 4. rewrite cycling-analysis.html as a slim shell loading shared assets -
ALL_TITLES_ORDER = [
    'map', 'records', 'cities', 'temporal', 'monthly', 'journey',
    'hr_zones', 'calendar', 'load', 'body', 'climb', 'quadrant',
    'daily_stack', 'efficiency', 'fitness_form', 'hr_range', 'energy',
    'climate', 'daily_pulse', 'elev_gallery', 'mets', 'departure',
    'rides_table',
]
all_body = "\n\n".join(SECTIONS[s] for s in ALL_TITLES_ORDER)
all_html = PAGE_TEMPLATE.format(
    title='全景 · Cycling Atlas (single page)',
    page_key='all',
    hero_block=hero,
    intro_block=stats_bar + "\n" + latest_band,
    body_html=all_body,
)
(ROOT / 'cycling-analysis.html').write_text(all_html, encoding="utf-8")
print(f"wrote cycling-analysis.html ({len(all_html)//1024} KB, all sections)")
