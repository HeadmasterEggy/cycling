// ============================================================
// 配送分析 / Delivery analytics renderers
//
// Reads window.DELIVERY_DATA (built by analyze_delivery.py) and draws the
// 配送 page: shift economics, how each stop was classified, the zone
// leaderboard, the hotspot map, the corridor lists, the hour x zone heatmap
// and the per-suburb structural profile.
//
// Kept out of app.js because the data behind it is only loaded on the pages
// that show it — every other page would pay for it and render nothing.
// ============================================================

const DLV = {
  amber: '#e8b76d', amberBright: '#ffd897',
  cyan: '#6cc4d9', rose: '#d97a8a', green: '#8fbf7f', violet: '#a894d9',
  grid: '#1c1e25', axis: '#5d5b55', dim: '#908d85', line: '#3a3d48',
};

// One colour per stop kind, used by the map, the legend, the evidence cards
// and the profile chart so a 取餐 dot means the same thing everywhere.
const DLV_KIND = {
  pickup: { label: '取餐', en: 'Pickup', color: DLV.cyan },
  dropoff: { label: '送达', en: 'Drop-off', color: DLV.amber },
  light: { label: '等灯', en: 'Traffic light', color: DLV.rose },
};

function dlvData() {
  const D = window.DELIVERY_DATA || null;
  if (D && !D._indexed) {
    // Stable ids so the panel, the map and the corridor lists further down
    // the page can all point at the same feature after any amount of
    // filtering or re-sorting.
    D.pickups = D.hotspots.filter(h => h.kind === 'pickup');
    D.drops = D.hotspots.filter(h => h.kind === 'dropoff');
    D.pickups.forEach((h, i) => { h._i = i; h._kind = 'pickups'; });
    D.drops.forEach((h, i) => { h._i = i; h._kind = 'drops'; });
    (D.light_spots || []).forEach((h, i) => { h._i = i; h._kind = 'lights'; });
    D.zones.forEach((z, i) => { z._i = i; });
    D.corridors.forEach((c, i) => { c._i = i; });
    D._indexed = true;
  }
  return D;
}

function dlvMedian(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
}

// Amber ramp shared by the choropleth and both heatmaps, so "brighter means
// more" reads the same everywhere on the page.
function dlvRamp(t) {
  t = Math.max(0, Math.min(1, t));
  const stops = [
    [0.00, [28, 30, 37]], [0.25, [92, 66, 38]],
    [0.55, [168, 127, 62]], [0.80, [232, 183, 109]], [1.00, [255, 216, 151]],
  ];
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i][0]) {
      const [t0, c0] = stops[i - 1];
      const [t1, c1] = stops[i];
      const k = (t - t0) / (t1 - t0);
      return `rgb(${c0.map((c, j) => Math.round(c + (c1[j] - c) * k)).join(',')})`;
    }
  }
  return 'rgb(255,216,151)';
}

function dlvEsc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function dlvNum(v, digits = 1, dash = '—') {
  return (v == null || Number.isNaN(v)) ? dash : Number(v).toFixed(digits);
}

// ============ 配送概览 / Shift economics ============
function renderDeliveryKpis() {
  const D = dlvData();
  if (!D) return;
  const host = document.getElementById('dlvKpis');
  if (!host) return;
  const s = D.summary;
  const m = D.meta;

  const cards = [
    ['送达', s.orders, '单', `${m.shifts} 个班次 · ${m.first} → ${m.last}`],
    ['取餐', s.pickups, '次', `每 ${s.orders} 单配 ${s.pickups} 次取餐 · 比值 ${s.pd_ratio}`],
    ['单 / 小时', dlvNum(s.orders_per_hour, 2), '单/h', `平均每 ${s.min_per_order} 分钟一单`],
    ['送一单要多久', dlvNum(s.leg_min_med, 1), 'min', `取到餐再到门口 · 直线 ${s.leg_km_med} km`],
    ['在店里等餐', `${s.pickup_wait_med}`, 's', `中位等待 · 送达停留 ${s.drop_wait_med}s`],
    ['等红灯', dlvNum(s.light_min_per_hour, 1), 'min/h', `${s.lights} 次 · 占在岗时间 ${(s.light_share * 100).toFixed(1)}%`],
    ['每单里程', dlvNum(s.km_per_order, 2), 'km', `合计骑了 ${s.km} km`],
    ['最该待的区', s.sweet_zone || '—', '', `出单密度 × 好跑指数 · ${s.zones_ranked}/${s.zones_touched} 个区够样本`],
  ];
  host.innerHTML = cards.map(([label, value, unit, foot]) => `
    <div class="dlv-kpi">
      <div class="dlv-kpi-label">${label}</div>
      <div class="dlv-kpi-value">${dlvEsc(value)}${unit ? `<span class="dlv-kpi-unit">${unit}</span>` : ''}</div>
      <div class="dlv-kpi-foot">${dlvEsc(foot)}</div>
    </div>`).join('');

  const secEl = document.getElementById('dlvStopSec');
  if (secEl) secEl.textContent = m.dwell_seconds;
  const note = document.getElementById('dlvMethod');
  if (note) {
    const fb = m.flow_basis || {};
    const osm = m.osm && m.osm.counts ? m.osm.counts : {};
    note.innerHTML = `<strong>怎么算的</strong> · 平台数据一条都没有，全部从 1 Hz 的 GPS 轨迹里反推。`
      + `每一次停车都对着地图判断是<em>取餐 / 送达 / 等红灯</em>（方法见下一节），`
      + `不再用「超过 90 秒就算一单」这种只看时长的规则。`
      + `一单 = 一次送达；取餐单独计数，把两者相加会把每一单算两遍。`
      + `地图底料来自 OpenStreetMap：${osm.signals || 0} 个红绿灯、${osm.venues || 0} 家餐饮店、`
      + `${osm.suburbs || 0} 个区的路网与人口。`
      + `好跑指数 = 自由通行耗时 ÷ 实际耗时 —— 一个比值，没有权重。`
      + `自由通行取 ${fb.v_free_kmh} km/h（平路、不在路口、实测移动速度的 90 分位），`
      + `所以 ${fb.free_min_per_km} 分钟/km 是理论下限，指数 60 就是「只跑出了自由流的六成」。`
      + `每个区都用班次做 ${fb.bootstrap_n} 次 bootstrap 估出 90% 区间，`
      + `区间宽超过 ${fb.max_ci_width} 分的区直接不上榜 —— ${fb.published} 个区达标，中位区间宽 ${fb.median_ci_width} 分。`
      + `每次出勤自己的起点/终点 ${m.endpoint_m} 米内的停留已剔除（共 ${m.endpoint_stops_dropped} 次），那是家不是客户。`;
  }
}

// ============ 停车判定 / How each stop was classified ============
function dlvEvidenceCard(row) {
  const kind = DLV_KIND[row.kind] || DLV_KIND.dropoff;
  const chips = (row.evidence || []).map(([w, why]) => {
    const cls = w > 0 ? 'pos' : 'neg';
    return `<span class="dlv-ev ${cls}"><em>${w > 0 ? '+' : ''}${w.toFixed(1)}</em>${dlvEsc(why)}</span>`;
  }).join('');
  const why = (row.kind_why || []).map(t => dlvEsc(t)).join('、');
  const conf = row.confidence >= 0.8 ? '很确定' : (row.confidence >= 0.4 ? '比较确定' : '把握不大');
  return `<div class="dlv-case">
    <div class="dlv-case-head">
      <span class="dlv-case-kind" style="background:${kind.color}1f;color:${kind.color};border-color:${kind.color}55">${kind.label}</span>
      <span class="dlv-case-secs">${row.secs}s</span>
      <span class="dlv-case-where">${dlvEsc(row.venue || row.zone || '—')}</span>
      <span class="dlv-case-score" title="证据总分，正数偏向「在干活」">${row.score > 0 ? '+' : ''}${row.score} · ${conf}</span>
    </div>
    <div class="dlv-case-ev">${chips}</div>
    ${why ? `<div class="dlv-case-why">判为${kind.label}：${why}</div>` : ''}
  </div>`;
}

function renderStopMethod() {
  const D = dlvData();
  if (!D) return;
  const s = D.summary;
  const m = D.meta;

  const tally = document.getElementById('dlvTally');
  if (tally) {
    const total = s.orders + s.pickups + s.lights;
    const rows = [
      ['dropoff', s.orders], ['pickup', s.pickups], ['light', s.lights],
    ];
    tally.innerHTML = rows.map(([k, n]) => {
      const kind = DLV_KIND[k];
      return `<div class="dlv-tally-row">
        <span class="dlv-tally-label" style="color:${kind.color}">${kind.label}<em>${kind.en}</em></span>
        <span class="dlv-tally-bar"><span style="width:${(n / total) * 100}%;background:${kind.color}"></span></span>
        <span class="dlv-tally-num">${n}</span>
      </div>`;
    }).join('')
      + `<div class="dlv-tally-foot">${m.dwells} 次停车 · 其中 ${m.uncertain} 次证据接近五五开，标为「把握不大」</div>`;
  }

  const quick = document.getElementById('dlvCasesQuick');
  if (quick) quick.innerHTML = (D.samples.quick_pickups || []).map(dlvEvidenceCard).join('');
  const slow = document.getElementById('dlvCasesLong');
  if (slow) slow.innerHTML = (D.samples.long_lights || []).map(dlvEvidenceCard).join('');

  const ratio = document.getElementById('dlvRatioNote');
  if (ratio) {
    ratio.innerHTML = `<strong>一个自检</strong> · 每一单都该是「取一次 + 送一次」，`
      + `所以取餐数和送达数本来就该差不多。分类器完全没有被告知这件事 —— `
      + `取餐和送达是用两条互不相关的证据判的 —— 结果落在 `
      + `<b>${s.pickups} : ${s.orders}</b>（比值 ${s.pd_ratio}）。`
      + `这不是证明，只是个说得过去的旁证：规则稍微换一换，比值会在 0.8–1.4 之间晃。`
      + `真要是大面积判错了，它没有理由这么接近 1。`;
  }
}

// ============ 区域排行 / Zone leaderboard ============
function renderZoneQuadrant() {
  const D = dlvData();
  if (!D) return;
  const svg = document.getElementById('zoneQuadrant');
  if (!svg) return;
  // Published zones only. A grey dot for a suburb crossed twice still invited
  // the eye to read a position that the interval says is not there.
  const zones = D.zones.filter(z => z.ranked && z.flow != null);
  if (!zones.length) return;

  const W = 900, H = 460, P = { l: 58, r: 28, t: 34, b: 52 };
  const xMax = Math.max(4, Math.max(...zones.map(z => z.jobs)) * 1.12);
  const y0 = Math.max(0, Math.min(...zones.map(z => z.flow)) - 8);
  const y1 = Math.min(100, Math.max(...zones.map(z => z.flow)) + 8);
  const xs = v => P.l + (v / xMax) * (W - P.l - P.r);
  const ys = v => H - P.b - ((v - y0) / (y1 - y0 || 1)) * (H - P.t - P.b);

  const xMed = dlvMedian(zones.map(z => z.jobs));
  const yMed = dlvMedian(zones.map(z => z.flow));

  const xTicks = [0, 0.25, 0.5, 0.75, 1].map(f => Math.round(xMax * f));
  const yTicks = [y0, (y0 + y1) / 2, y1].map(v => Math.round(v));

  const grid =
    xTicks.map(t => `<line x1="${xs(t)}" x2="${xs(t)}" y1="${P.t}" y2="${H - P.b}" stroke="${DLV.grid}"/>`
      + `<text x="${xs(t)}" y="${H - P.b + 18}" text-anchor="middle" fill="${DLV.axis}" font-family="JetBrains Mono" font-size="10">${t}</text>`).join('')
    + yTicks.map(t => `<line x1="${P.l}" x2="${W - P.r}" y1="${ys(t)}" y2="${ys(t)}" stroke="${DLV.grid}"/>`
      + `<text x="${P.l - 8}" y="${ys(t) + 4}" text-anchor="end" fill="${DLV.axis}" font-family="JetBrains Mono" font-size="10">${t}</text>`).join('');

  const cross =
    `<line x1="${xs(xMed)}" x2="${xs(xMed)}" y1="${P.t}" y2="${H - P.b}" stroke="${DLV.line}" stroke-dasharray="4 4"/>`
    + `<line x1="${P.l}" x2="${W - P.r}" y1="${ys(yMed)}" y2="${ys(yMed)}" stroke="${DLV.line}" stroke-dasharray="4 4"/>`;

  const quads =
    `<text x="${W - P.r - 8}" y="${P.t + 14}" text-anchor="end" fill="${DLV.amberBright}" font-family="JetBrains Mono" font-size="10" letter-spacing="0.1em">活 多 · 好 跑</text>`
    + `<text x="${P.l + 8}" y="${P.t + 14}" fill="${DLV.cyan}" font-family="JetBrains Mono" font-size="10" letter-spacing="0.1em">活 少 · 好 跑</text>`
    + `<text x="${W - P.r - 8}" y="${H - P.b - 8}" text-anchor="end" fill="${DLV.rose}" font-family="JetBrains Mono" font-size="10" letter-spacing="0.1em">活 多 · 难 跑</text>`
    + `<text x="${P.l + 8}" y="${H - P.b - 8}" fill="${DLV.axis}" font-family="JetBrains Mono" font-size="10" letter-spacing="0.1em">活 少 · 难 跑</text>`;

  const hMax = Math.max(...zones.map(z => z.hours)) || 1;
  const dots = zones.map(z => {
    const r = 5 + Math.sqrt(z.hours / hMax) * 16;
    const hot = z.jobs >= xMed && z.flow >= yMed;
    const col = hot ? DLV.amber : (z.jobs >= xMed ? DLV.rose : DLV.cyan);
    const ci = z.ci ? ` (${z.ci[0]}–${z.ci[1]})` : '';
    // A vertical whisker for the bootstrap interval: the dot is an estimate,
    // and on this chart the estimate's height is the whole point.
    const bar = z.ci
      ? `<line x1="${xs(z.jobs)}" x2="${xs(z.jobs)}" y1="${ys(z.ci[1])}" y2="${ys(z.ci[0])}" stroke="${col}" stroke-width="1" stroke-opacity="0.5"/>`
      : '';
    return bar + `<circle cx="${xs(z.jobs)}" cy="${ys(z.flow)}" r="${r}" fill="${col}" fill-opacity="0.3" stroke="${col}" stroke-width="1.2">`
      + `<title>${dlvEsc(z.label)} · ${z.jobs} 次活（送 ${z.orders} / 取 ${z.pickups}）· ${z.shifts} 个班次 · 好跑 ${z.flow}${ci} · ${z.min_per_km} min/km · 红灯 ${z.light_min_per_km} min/km · 爬升 ${z.climb_per_km} m/km</title></circle>`;
  }).join('');

  // Label the zones worth reading; the rest stay hover targets. Busy suburbs
  // cluster, so nudge a label up until it clears the one above it — otherwise
  // the two or three names that matter most are the ones that overlap.
  const placed = [];
  const labels = [...zones].sort((a, b) => b.jobs - a.jobs).slice(0, 10).map(z => {
    const cx = xs(z.jobs);
    let cy = ys(z.flow) - (7 + Math.sqrt(z.hours / hMax) * 16);
    for (let guard = 0; guard < 8; guard++) {
      const clash = placed.find(p => Math.abs(p.x - cx) < 72 && Math.abs(p.y - cy) < 13);
      if (!clash) break;
      cy = clash.y - 13;
    }
    placed.push({ x: cx, y: cy });
    return `<text x="${cx}" y="${Math.max(P.t + 24, cy)}" text-anchor="middle" fill="${DLV.dim}" font-family="JetBrains Mono" font-size="9.5">${dlvEsc(z.label)}</text>`;
  }).join('');

  svg.innerHTML = grid + cross + quads + dots + labels
    + `<text x="${W / 2}" y="${H - 8}" text-anchor="middle" class="eq-axis-title">识别出的活（取餐 + 送达）</text>`
    + `<text x="16" y="${H / 2}" text-anchor="middle" class="eq-axis-title" transform="rotate(-90 16 ${H / 2})">好跑指数 0–100</text>`;

  // The grey dots stay on the chart — a suburb crossed twice is still part of
  // the picture — but only zones with enough exposure get named underneath.
  // Reading "好跑但没活: Croydon" off two minutes of riding is worse than
  // reading nothing.
  const buckets = { hot: [], flowOnly: [], grind: [], quiet: [] };
  zones.forEach(z => {
    if (z.jobs >= xMed && z.flow >= yMed) buckets.hot.push(z);
    else if (z.jobs < xMed && z.flow >= yMed) buckets.flowOnly.push(z);
    else if (z.jobs >= xMed) buckets.grind.push(z);
    else buckets.quiet.push(z);
  });
  const names = list => list.sort((a, b) => b.jobs - a.jobs).slice(0, 4).map(z => z.label).join('、') || '—';
  const legend = document.getElementById('zoneQuadLegend');
  if (legend) {
    legend.innerHTML =
      `<div class="eq-tag eff"><strong>活多又好跑</strong><span class="eq-count">${buckets.hot.length} 区</span><br>${dlvEsc(names(buckets.hot))}</div>`
      + `<div class="eq-tag costly"><strong>活多但难跑</strong><span class="eq-count">${buckets.grind.length} 区</span><br>${dlvEsc(names(buckets.grind))}</div>`
      + `<div class="eq-tag eff"><strong>好跑但没活</strong><span class="eq-count">${buckets.flowOnly.length} 区</span><br>${dlvEsc(names(buckets.flowOnly))}</div>`
      + `<div class="eq-tag easy"><strong>又少又难</strong><span class="eq-count">${buckets.quiet.length} 区</span><br>${dlvEsc(names(buckets.quiet))}</div>`;
  }
}

function renderZoneTable() {
  const D = dlvData();
  if (!D) return;
  const tbody = document.getElementById('zoneTbody');
  if (!tbody) return;
  // Only zones whose score is actually pinned down. The rest are not greyed
  // out any more, they are simply absent — a row you are told not to trust is
  // still a row people read.
  let rows = D.zones.filter(z => z.ranked);
  const st = window.__dlvZoneSort || { key: 'jobs', dir: 'desc' };
  rows = [...rows].sort((a, b) => {
    const av = a[st.key], bv = b[st.key];
    const an = av == null ? -Infinity : av;
    const bn = bv == null ? -Infinity : bv;
    if (an === bn) return b.jobs - a.jobs;
    return st.dir === 'desc' ? (bn > an ? 1 : -1) : (an > bn ? 1 : -1);
  });
  tbody.innerHTML = rows.map(z => {
    const bar = `<span class="flow-bar"><span class="flow-bar-fill" style="width:${z.flow}%;background:${dlvRamp(z.flow / 100)}"></span></span>`;
    const ci = z.ci ? `<span class="flow-ci">±${(z.ci_width / 2).toFixed(1)}</span>` : '';
    return `<tr data-zone="${dlvEsc(z.name)}">
      <td class="dlv-zone">${dlvEsc(z.label)}<span class="dlv-lga">${dlvEsc(z.lga || '')}</span></td>
      <td class="col-distance">${z.jobs}</td>
      <td>${z.orders}</td>
      <td>${z.pickups}</td>
      <td>${z.shifts}</td>
      <td>${dlvNum(z.jobs_per_hour, 2)}</td>
      <td>${dlvNum(z.min_per_km, 2)}</td>
      <td>${dlvNum(z.light_min_per_km, 2)}</td>
      <td>${dlvNum(z.climb_per_km, 1)}</td>
      <td>${z.prep_per_km2 == null ? '—' : Math.round(z.prep_per_km2)}</td>
      <td>${bar}<span class="flow-num">${z.flow.toFixed(0)}</span>${ci}</td>
      <td>${z.worth == null ? '—' : dlvNum(z.worth, 1)}</td>
    </tr>`;
  }).join('');

  const foot = document.getElementById('zoneTableFoot');
  if (foot) {
    const fb = D.meta.flow_basis || {};
    const hidden = D.zones.filter(z => !z.ranked && z.jobs > 0).length;
    foot.textContent = `${rows.length} 个区 · 好跑指数的 90% 区间宽在 ${fb.max_ci_width} 分以内才列出`
      + `；另有 ${hidden} 个去过但样本不够的区没有列出`;
  }
}

function bindZoneTable() {
  const table = document.getElementById('zoneTable');
  if (table) {
    table.querySelectorAll('thead th[data-sort]').forEach(th => {
      th.addEventListener('click', () => {
        const key = th.dataset.sort;
        const cur = window.__dlvZoneSort || { key: 'jobs', dir: 'desc' };
        const dir = cur.key === key ? (cur.dir === 'desc' ? 'asc' : 'desc') : (th.dataset.dir || 'desc');
        window.__dlvZoneSort = { key, dir };
        table.querySelectorAll('thead th').forEach(o => o.classList.remove('sorted'));
        th.classList.add('sorted');
        renderZoneTable();
      });
    });
    // A row is a way into the map: click it and the map drills to that suburb.
    table.addEventListener('click', ev => {
      const tr = ev.target.closest('tbody tr[data-zone]');
      if (!tr) return;
      dlvSetFocus(tr.dataset.zone);
      const map = document.getElementById('dlvMap');
      if (map) map.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  }
}

// ============ 热点地图 / Hotspot map ============
// One map, six layers that stack rather than replace each other, a panel
// wired to it in both directions, an hour scrubber, and a click-a-suburb
// drill-down.

const DLVMAP = {
  map: null,
  panes: {},                 // kind -> L.LayerGroup
  refs: {},                  // "kind:id" -> leaflet layer
  items: { pickups: [], drops: [], lights: [], zones: [], common: [], hard: [] },
  visible: { pickups: true, drops: true, lights: false, zones: true, common: false, hard: false },
  panel: 'pickups',
  hour: -1,                  // -1 = 全天
  focus: null,               // suburb name being drilled into
  selected: null,            // { kind, id }
  metric: 'jobs',            // what the choropleth shades by
  play: null,
};

const DLV_KIND_LABEL = {
  pickups: '取餐点', drops: '送达点', lights: '红灯堵点',
  zones: '区域', common: '最常走', hard: '最难走',
};
const DLV_KIND_UNIT = { pickups: '处', drops: '处', lights: '处', zones: '区', common: '段', hard: '段' };

// Hour filtering only makes sense for things counted per job. Corridors are
// aggregated over whole shifts, so the scrubber leaves them alone — said out
// loud under the slider rather than silently doing nothing.
const DLV_HOURLY = new Set(['pickups', 'drops', 'zones']);

// What the suburb fill can be shaded by. Every one of these is a number the
// page can defend: three measured on the bike, two read off the map.
const DLV_METRICS = {
  jobs: { label: '活的数量', unit: '次', get: z => z.jobs, hourly: true },
  worth: { label: '值得去', unit: '次/h', get: z => z.worth, rankedOnly: true },
  flow: { label: '好跑指数', unit: '', get: z => z.flow, rankedOnly: true },
  min_per_km: { label: '每公里耗时', unit: 'min/km', get: z => z.min_per_km, invert: true, rankedOnly: true },
  light_min_per_km: { label: '红灯耗时', unit: 'min/km', get: z => z.light_min_per_km, invert: true },
  climb_per_km: { label: '爬升', unit: 'm/km', get: z => z.climb_per_km, invert: true },
  prep_per_km2: { label: '餐厅密度', unit: '家/km²', get: z => z.prep_per_km2 },
  sig_per_km: { label: '红绿灯密度', unit: '个/km路', get: z => z.sig_per_km, invert: true },
  pop_density: { label: '人口密度', unit: '人/km²', get: z => z.pop_density },
};

function dlvMetric() { return DLV_METRICS[DLVMAP.metric] || DLV_METRICS.jobs; }

function dlvZoneValue(z) {
  const m = dlvMetric();
  if (m.hourly && DLVMAP.hour >= 0) return (z.hour_hist && z.hour_hist[DLVMAP.hour]) || 0;
  if (m.rankedOnly && !z.ranked) return null;
  return m.get(z);
}

function dlvHourCount(kind, item) {
  if (kind === 'zones') return dlvZoneValue(item) || 0;
  if (kind === 'lights') return item.waits;
  if (DLVMAP.hour < 0) return item.visits;
  return (item.hours && item.hours[DLVMAP.hour]) || 0;
}

// The lists behind each layer, after the hour scrubber and the suburb focus.
function dlvItems(kind) {
  const D = dlvData();
  if (!D) return [];
  const focus = DLVMAP.focus;
  if (kind === 'pickups' || kind === 'drops') {
    return D[kind].filter(h => (!focus || h.zone === dlvLabelOf(focus))
      && dlvHourCount(kind, h) > 0);
  }
  if (kind === 'lights') {
    return (D.light_spots || []).filter(h => !focus || h.zone === dlvLabelOf(focus));
  }
  if (kind === 'zones') {
    // Keep every polygon while focused — the neighbours are the context that
    // makes the focused one mean something — and dim them at draw time.
    return D.zones.filter(z => z.ring && (focus ? true : dlvZoneValue(z) != null));
  }
  const pool = kind === 'hard'
    ? D.corridors.filter(c => c.passes >= 3).sort((a, b) => b.lost_per_pass - a.lost_per_pass).slice(0, 25)
    : [...D.corridors].sort((a, b) => b.passes - a.passes).slice(0, 25);
  return focus ? pool.filter(c => (c.zones || []).includes(dlvLabelOf(focus))) : pool;
}

function dlvLabelOf(name) {
  const D = dlvData();
  const z = D && D.zones.find(x => x.name === name);
  return z ? z.label : name;
}

function dlvBaseStyle(kind, item, max) {
  if (kind === 'pickups' || kind === 'drops' || kind === 'lights') {
    const v = dlvHourCount(kind, item);
    const col = kind === 'pickups' ? DLV.cyan : (kind === 'drops' ? DLV.amber : DLV.rose);
    return {
      radius: 5 + Math.sqrt(v / max) * 16, color: col, weight: 1.2,
      opacity: 0.9, fillColor: col, fillOpacity: 0.18 + 0.42 * (v / max),
    };
  }
  if (kind === 'zones') {
    const v = dlvZoneValue(item);
    const focused = DLVMAP.focus === item.name;
    const muted = DLVMAP.focus && !focused;
    const m = dlvMetric();
    let t = v == null ? null : (max ? v / max : 0);
    if (t != null && m.invert) t = 1 - t;
    // The focused suburb trades fill for outline: a solid amber wash hid the
    // hotspot circles sitting inside it, which are the reason to drill in.
    return {
      color: focused ? DLV.amberBright : DLV.amber,
      weight: focused ? 2.5 : (muted ? 0.6 : 1),
      opacity: focused ? 0.95 : (muted ? 0.18 : 0.45),
      fillColor: t == null ? '#15171c' : dlvRamp(t),
      // Light enough that the pickup and drop-off dots still read on top of
      // it — the fill is context, the dots are the subject.
      fillOpacity: focused ? 0.14 : (muted ? 0.05 : (t == null ? 0.07 : 0.26)),
    };
  }
  const key = kind === 'hard' ? 'lost_per_pass' : 'passes';
  const col = kind === 'hard' ? DLV.rose : DLV.amber;
  return { color: col, weight: 3 + (item[key] / max) * 6, opacity: 0.35 + (item[key] / max) * 0.55 };
}

function dlvApplyStyle(kind, item, layer, max, mode) {
  const base = dlvBaseStyle(kind, item, max);
  if (mode === 'dim') {
    layer.setStyle({ ...base, opacity: base.opacity * 0.22, fillOpacity: (base.fillOpacity || 0) * 0.22 });
    return;
  }
  if (mode === 'hot' || mode === 'sel') {
    const lift = { ...base, color: kind === 'hard' ? '#f2a0ad' : DLV.amberBright, opacity: 1 };
    if (base.fillOpacity != null) lift.fillOpacity = Math.min(0.75, base.fillOpacity + 0.25);
    if (base.weight != null) lift.weight = base.weight + (kind === 'common' || kind === 'hard' ? 2.5 : 1.2);
    layer.setStyle(lift);
    layer.bringToFront();
    return;
  }
  layer.setStyle(base);
}

function dlvRestyle(kind) {
  const items = DLVMAP.items[kind];
  if (!items.length) return;
  const max = dlvMaxFor(kind, items);
  const sel = DLVMAP.selected;
  items.forEach(item => {
    const layer = DLVMAP.refs[`${kind}:${item._i}`];
    if (!layer) return;
    if (sel && sel.kind === kind) {
      dlvApplyStyle(kind, item, layer, max, sel.id === item._i ? 'sel' : 'dim');
    } else {
      dlvApplyStyle(kind, item, layer, max, 'base');
    }
  });
}

function dlvMaxFor(kind, items) {
  if (kind === 'zones') {
    return Math.max(...items.map(i => dlvZoneValue(i) || 0), 1);
  }
  if (kind === 'pickups' || kind === 'drops' || kind === 'lights') {
    return Math.max(...items.map(i => dlvHourCount(kind, i)), 1);
  }
  const key = kind === 'hard' ? 'lost_per_pass' : 'passes';
  return Math.max(...items.map(i => i[key]), 1);
}

function dlvPopupHtml(kind, item) {
  if (kind === 'pickups' || kind === 'drops') {
    const v = dlvHourCount(kind, item);
    const title = kind === 'pickups' ? (item.venue || item.zone || '取餐点') : (item.zone || '送达点');
    return `<b>${dlvEsc(title)}</b><br>`
      + (kind === 'pickups' && item.venue ? `<span class="dlv-pop-sub">${dlvEsc(item.zone || '')}</span><br>` : '')
      + (DLVMAP.hour >= 0 ? `${String(DLVMAP.hour).padStart(2, '0')}:00 来过 ${v} 次<br>` : '')
      + `合计 ${item.visits} 次 · ${item.shifts} 个班次<br>`
      + `取餐 ${item.pickups} · 送达 ${item.dropoffs}<br>`
      + `中位停留 ${item.dwell_med}s · 累计 ${item.dwell_total_min} min`;
  }
  if (kind === 'lights') {
    return `<b>${dlvEsc(item.zone || '路口')}</b><br>`
      + `等过 ${item.waits} 次 · ${item.shifts} 个班次<br>`
      + `中位每次 ${item.wait_med}s · 累计 ${item.wait_total_min} min<br>`
      + `离最近红绿灯 ${item.d_signal} m`;
  }
  if (kind === 'zones') {
    const m = dlvMetric();
    const v = dlvZoneValue(item);
    return `<b>${dlvEsc(item.label)}</b><br>`
      + `<span class="dlv-pop-sub">${dlvEsc(item.lga || '')}</span><br>`
      + `${m.label}：${v == null ? '—' : v}${m.unit ? ' ' + m.unit : ''}<br>`
      + `送达 ${item.orders} · 取餐 ${item.pickups} · ${item.shifts} 个班次<br>`
      + (item.flow == null
          ? `好跑 —（样本不足，未计分）<br>`
          : `好跑 ${item.flow}${item.ci ? ` (${item.ci[0]}–${item.ci[1]})` : ''} · ${item.min_per_km} min/km<br>`)
      + `<span class="dlv-pop-hint">点一下只看这个区</span>`;
  }
  return `<b>${dlvEsc(item.zone || '—')}</b><br>${item.passes} 个班次经过 · 约 ${item.len_m} m<br>`
    + `中位 ${item.med_speed} km/h · 红灯占 ${(item.light_share * 100).toFixed(0)}% · 上坡 ${item.grade_up}%<br>`
    + `每趟比 18 km/h 多花 ${item.lost_per_pass} min（累计 ${item.lost_min} min）`;
}

function dlvDrawLayer(kind) {
  const pane = DLVMAP.panes[kind];
  if (!pane) return;
  pane.clearLayers();
  Object.keys(DLVMAP.refs).forEach(k => { if (k.startsWith(kind + ':')) delete DLVMAP.refs[k]; });

  const items = dlvItems(kind);
  DLVMAP.items[kind] = items;
  if (!items.length) return;
  const max = dlvMaxFor(kind, items);

  items.forEach(item => {
    let layer;
    if (kind === 'zones') {
      layer = L.polygon(item.ring.map(p => [p[1], p[0]]), dlvBaseStyle(kind, item, max));
    } else if (kind === 'common' || kind === 'hard') {
      layer = L.polyline(item.track, dlvBaseStyle(kind, item, max));
    } else {
      layer = L.circleMarker([item.lat, item.lon], dlvBaseStyle(kind, item, max));
    }
    layer.bindPopup(dlvPopupHtml(kind, item));
    layer.on('mouseover', () => {
      if (!DLVMAP.selected) dlvApplyStyle(kind, item, layer, max, 'hot');
      dlvMarkRow(kind, item._i, 'hover', true);
    });
    layer.on('mouseout', () => {
      if (!DLVMAP.selected) dlvApplyStyle(kind, item, layer, max, 'base');
      dlvMarkRow(kind, item._i, 'hover', false);
    });
    layer.on('click', ev => {
      L.DomEvent.stopPropagation(ev);
      // A suburb polygon is a door, not a data point: clicking drills in.
      if (kind === 'zones') dlvSetFocus(DLVMAP.focus === item.name ? null : item.name);
      else dlvSelect(kind, item._i, false);
    });
    layer.addTo(pane);
    DLVMAP.refs[`${kind}:${item._i}`] = layer;
  });
  dlvRestyle(kind);
}

function dlvMarkRow(kind, id, cls, on) {
  if (DLVMAP.panel !== kind) return;
  const row = document.querySelector(`#dlvList .dlv-row[data-id="${id}"]`);
  if (row) row.classList.toggle(cls, on);
}

function dlvSelect(kind, id, fromList) {
  DLVMAP.selected = { kind, id };
  if (DLVMAP.panel !== kind) dlvSetPanel(kind);
  dlvRestyle(kind);
  const layer = DLVMAP.refs[`${kind}:${id}`];
  if (layer && DLVMAP.map) {
    if (layer.getBounds) DLVMAP.map.fitBounds(layer.getBounds(), { padding: [50, 50], maxZoom: 17 });
    else DLVMAP.map.setView(layer.getLatLng(), Math.max(DLVMAP.map.getZoom(), 16));
    layer.openPopup();
  }
  document.querySelectorAll('#dlvList .dlv-row').forEach(r => {
    const on = r.dataset.id === String(id);
    r.classList.toggle('active', on);
    if (on && !fromList) r.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  });
}

function dlvClearSelection() {
  if (!DLVMAP.selected) return;
  const kind = DLVMAP.selected.kind;
  DLVMAP.selected = null;
  dlvRestyle(kind);
  document.querySelectorAll('#dlvList .dlv-row').forEach(r => r.classList.remove('active'));
}

// ============ 钻进一个区 / Suburb focus ============
function dlvSetFocus(name) {
  DLVMAP.focus = name || null;
  DLVMAP.selected = null;
  if (name && !DLVMAP.visible.zones) {
    DLVMAP.visible.zones = true;
    const chip = document.querySelector('#dlvLayerChips .dlv-chip[data-layer="zones"]');
    if (chip) chip.classList.add('active');
  }
  dlvRedraw();
  dlvRenderFocusBar();
  if (name) {
    const z = dlvData().zones.find(x => x.name === name);
    const layer = z && DLVMAP.refs[`zones:${z._i}`];
    if (layer && DLVMAP.map) DLVMAP.map.fitBounds(layer.getBounds(), { padding: [40, 40] });
  } else {
    dlvFitAll();
  }
}

function dlvRenderFocusBar() {
  const bar = document.getElementById('dlvFocusBar');
  if (!bar) return;
  if (!DLVMAP.focus) { bar.hidden = true; bar.innerHTML = ''; return; }
  const D = dlvData();
  const z = D.zones.find(s => s.name === DLVMAP.focus);
  if (!z) { bar.hidden = true; return; }
  const freeMin = (D.meta.flow_basis || {}).free_min_per_km;
  const peak = z.hour_hist.indexOf(Math.max(...z.hour_hist));
  const stats = [
    ['送达', z.orders],
    ['取餐', z.pickups],
    ['出现班次', z.shifts],
    ['活/小时', dlvNum(z.jobs_per_hour, 2)],
    ['中位速度', `${z.med_speed} km/h`],
    ['比自由流慢', (z.min_per_km == null || !freeMin) ? '—' : `${(z.min_per_km - freeMin).toFixed(2)} min/km`],
    ['红灯', `${dlvNum(z.light_min_per_km, 2)} min/km`],
    ['爬升', `${z.climb_per_km} m/km`],
    ['餐厅密度', z.prep_per_km2 == null ? '—' : `${Math.round(z.prep_per_km2)}/km²`],
    ['人口密度', z.pop_density == null ? '—' : `${Math.round(z.pop_density)}/km²`],
    ['好跑指数', z.flow == null ? '—' : `${z.flow.toFixed(0)}${z.ci ? ` (${z.ci[0]}–${z.ci[1]})` : ''}`],
    ['每公里耗时', z.min_per_km == null ? '—' : `${z.min_per_km} min`],
    ['最忙时段', Math.max(...z.hour_hist) ? `${String(peak).padStart(2, '0')}:00` : '—'],
  ];
  // The decomposition is in minutes lost per km, so the bars are scaled
  // against the biggest single loss rather than against 100.
  const parts = z.flow_parts || {};
  const names = { light: '等红灯', stop: '短停', crawl: '龟速', cruise: '巡航偏慢' };
  const keys = ['light', 'stop', 'crawl', 'cruise'];
  const maxPart = Math.max(...keys.map(k => parts[k] || 0), 0.01);
  const partBar = keys.map(k => {
    const v = parts[k] == null ? 0 : parts[k];
    const extra = k === 'cruise' && parts.climb_of_cruise
      ? `，其中坡度约 ${parts.climb_of_cruise} min` : '';
    return `<span class="dlv-part" title="${names[k]} 每公里损失 ${v} 分钟${extra}">
      <em>${names[k]}</em><span class="dlv-part-bar"><span style="width:${(v / maxPart) * 100}%;background:${dlvRamp(v / maxPart)}"></span></span><b>${v}</b></span>`;
  }).join('');
  bar.hidden = false;
  bar.innerHTML = `<div class="dlv-focus-name">${dlvEsc(z.label)}<span class="dlv-focus-lga">${dlvEsc(z.lga || '')}</span>`
    + `${z.ranked ? '' : '<span class="dlv-focus-thin">样本不足，未计分</span>'}</div>`
    + `<div class="dlv-focus-stats">${stats.map(([k, v]) => `<span><em>${k}</em>${dlvEsc(v)}</span>`).join('')}</div>`
    + `<div class="dlv-focus-parts">${partBar}</div>`
    + `<button class="dlv-focus-exit" id="dlvFocusExit">退出 ×</button>`;
  const exit = document.getElementById('dlvFocusExit');
  if (exit) exit.addEventListener('click', () => dlvSetFocus(null));
}

// ============ 侧栏列表 / Panel ============
function dlvSetPanel(kind) {
  DLVMAP.panel = kind;
  document.querySelectorAll('#dlvPanelTabs .dlv-ptab').forEach(b =>
    b.classList.toggle('active', b.dataset.list === kind));
  dlvRenderPanel();
}

function dlvRenderPanel() {
  const kind = DLVMAP.panel;
  const items = DLVMAP.items[kind] || [];
  const title = document.getElementById('dlvPanelTitle');
  const count = document.getElementById('dlvPanelCount');
  const list = document.getElementById('dlvList');
  if (title) title.textContent = DLV_KIND_LABEL[kind] + (DLVMAP.focus ? ` · ${dlvLabelOf(DLVMAP.focus)}` : '');
  if (!list) return;

  let shown = items;
  if (kind === 'zones') {
    shown = items.filter(z => dlvZoneValue(z) != null)
      .sort((a, b) => (dlvZoneValue(b) || 0) - (dlvZoneValue(a) || 0));
  } else if (kind === 'pickups' || kind === 'drops') {
    shown = [...items].sort((a, b) => dlvHourCount(kind, b) - dlvHourCount(kind, a));
  } else if (kind === 'lights') {
    shown = [...items].sort((a, b) => b.wait_total_min - a.wait_total_min);
  }
  // Count what the list actually shows. The zone layer keeps every polygon
  // while focused — the neighbours are the context — so the layer size and
  // the row count diverge, and the header was quietly reporting the wrong one.
  if (count) count.textContent = `${shown.length} ${DLV_KIND_UNIT[kind]}`;
  if (!shown.length) {
    list.innerHTML = '<div class="empty-range">这个筛选下没有内容</div>';
    return;
  }

  const seen = {};
  list.innerHTML = shown.slice(0, 60).map((item, i) => {
    let main, meta;
    if (kind === 'pickups') {
      main = item.venue || item.zone || '取餐点';
      meta = DLVMAP.hour >= 0
        ? `${String(DLVMAP.hour).padStart(2, '0')}:00 来 ${dlvHourCount(kind, item)} 次 · 合计 ${item.visits} 次`
        : `${item.visits} 次 · ${item.shifts} 班次 · 等餐中位 ${item.dwell_med}s`;
    } else if (kind === 'drops') {
      main = item.zone || '送达点';
      meta = DLVMAP.hour >= 0
        ? `${String(DLVMAP.hour).padStart(2, '0')}:00 来 ${dlvHourCount(kind, item)} 次 · 合计 ${item.visits} 次`
        : `${item.visits} 次 · ${item.shifts} 班次 · 中位 ${item.dwell_med}s`;
    } else if (kind === 'lights') {
      main = item.zone || '路口';
      meta = `等 ${item.waits} 次 · 累计 ${item.wait_total_min} min · 每次 ${item.wait_med}s`;
    } else if (kind === 'zones') {
      const m = dlvMetric();
      const v = dlvZoneValue(item);
      main = item.label;
      meta = `${m.label} ${v == null ? '—' : v}${m.unit ? ' ' + m.unit : ''} · 送 ${item.orders} / 取 ${item.pickups}`
        + (item.flow == null ? ' · 好跑 样本不足' : ` · 好跑 ${item.flow}`);
    } else {
      const n = (seen[item.zone] = (seen[item.zone] || 0) + 1);
      main = n === 1 ? item.zone : `${item.zone} ${'②③④⑤⑥⑦⑧⑨'[n - 2] || n}`;
      meta = kind === 'hard'
        ? `${item.passes} 班次 · ${item.med_speed} km/h · 每趟 +${item.lost_per_pass} min`
        : `${item.passes} 班次 · ${item.med_speed} km/h · 约 ${item.len_m} m`;
    }
    const active = kind === 'zones'
      ? DLVMAP.focus === item.name
      : (DLVMAP.selected && DLVMAP.selected.kind === kind && DLVMAP.selected.id === item._i);
    return `<div class="dlv-row${active ? ' active' : ''}" data-id="${item._i}">
        <div class="dlv-row-main"><span class="dlv-rank">${i + 1}</span>${dlvEsc(main || '—')}</div>
        <div class="dlv-row-meta">${dlvEsc(meta)}</div>
      </div>`;
  }).join('');

  list.querySelectorAll('.dlv-row').forEach(row => {
    const id = +row.dataset.id;
    row.addEventListener('mouseenter', () => {
      const layer = DLVMAP.refs[`${kind}:${id}`];
      const item = (DLVMAP.items[kind] || []).find(x => x._i === id);
      if (layer && item && !DLVMAP.selected) {
        dlvApplyStyle(kind, item, layer, dlvMaxFor(kind, DLVMAP.items[kind]), 'hot');
      }
    });
    row.addEventListener('mouseleave', () => { if (!DLVMAP.selected) dlvRestyle(kind); });
    row.addEventListener('click', () => {
      if (kind === 'zones') {
        const item = (DLVMAP.items[kind] || []).find(x => x._i === id);
        dlvSetFocus(item && DLVMAP.focus === item.name ? null : (item ? item.name : null));
      } else {
        dlvSelect(kind, id, true);
      }
    });
  });
}

// ============ 视图与控件 / View + controls ============
function dlvRedraw() {
  Object.keys(DLVMAP.panes).forEach(kind => {
    if (DLVMAP.visible[kind]) dlvDrawLayer(kind);
    else { DLVMAP.panes[kind].clearLayers(); DLVMAP.items[kind] = []; }
  });
  dlvRenderPanel();
  dlvRenderLegend();
}

function dlvRenderLegend() {
  const host = document.getElementById('dlvMapLegend');
  if (!host) return;
  const m = dlvMetric();
  const items = DLVMAP.items.zones || [];
  const vals = items.map(dlvZoneValue).filter(v => v != null);
  const max = vals.length ? Math.max(...vals) : 0;
  const min = vals.length ? Math.min(...vals) : 0;
  const dots = [];
  if (DLVMAP.visible.pickups) dots.push(['取餐点', DLV.cyan]);
  if (DLVMAP.visible.drops) dots.push(['送达点', DLV.amber]);
  if (DLVMAP.visible.lights) dots.push(['红灯堵点', DLV.rose]);
  // Left is always the smaller number and right the larger, whichever end is
  // the good one — a legend that silently flips its axis to keep "good" on the
  // left is harder to read than one that just says which way is better.
  const digits = max >= 100 ? 0 : (max >= 10 ? 1 : 2);
  host.innerHTML =
    (DLVMAP.visible.zones
      ? `<div class="dlv-leg-scale"><span>${dlvNum(min, digits)}</span>`
        + `<span class="dlv-leg-grad${m.invert ? ' rev' : ''}"></span>`
        + `<span>${dlvNum(max, digits)}</span>`
        + `<em>底色 = ${m.label}${m.unit ? ` (${m.unit})` : ''} · ${m.invert ? '越少越好' : '越多越好'}</em></div>`
      : '')
    + (dots.length
      ? `<div class="dlv-leg-dots">${dots.map(([t, c]) =>
        `<span><i style="background:${c}"></i>${t}</span>`).join('')}</div>`
      : '');
}

function dlvFitAll() {
  if (!DLVMAP.map) return;
  // Fit to the stops, not to the suburb outlines. The polygons stretch from
  // Mascot to Brighton-le-Sands and fitting them squeezed the inner-city
  // cluster — where nearly every job actually is — into a thumbnail.
  const stops = [];
  ['pickups', 'drops', 'lights'].forEach(kind =>
    (DLVMAP.items[kind] || []).forEach(i => stops.push([i.lat, i.lon])));
  let pts = stops;
  if (!pts.length) {
    Object.keys(DLVMAP.items).forEach(kind => {
      (DLVMAP.items[kind] || []).forEach(item => {
        if (kind === 'zones') item.ring.forEach(p => pts.push([p[1], p[0]]));
        else if (kind === 'common' || kind === 'hard') item.track.forEach(p => pts.push(p));
      });
    });
  } else if (pts.length >= 12) {
    // Trim the far tail. A handful of shifts wandered to the airport and back;
    // letting those two dots set the zoom costs every other dot its detail.
    const lats = pts.map(p => p[0]).sort((a, b) => a - b);
    const lons = pts.map(p => p[1]).sort((a, b) => a - b);
    const at = (arr, q) => arr[Math.min(arr.length - 1, Math.floor(q * arr.length))];
    const box = [at(lats, 0.03), at(lats, 0.97), at(lons, 0.03), at(lons, 0.97)];
    pts = pts.filter(p => p[0] >= box[0] && p[0] <= box[1] && p[1] >= box[2] && p[1] <= box[3]);
  }
  if (pts.length) DLVMAP.map.fitBounds(pts, { padding: [28, 28] });
}

function dlvSetHour(h) {
  DLVMAP.hour = h;
  DLVMAP.selected = null;
  const label = document.getElementById('dlvHourLabel');
  if (label) label.textContent = h < 0 ? '全天' : `${String(h).padStart(2, '0')}:00`;
  const slider = document.getElementById('dlvHour');
  if (slider && +slider.value !== h) slider.value = String(h);
  dlvRedraw();
}

function dlvSetMetric(key) {
  DLVMAP.metric = key;
  document.querySelectorAll('#dlvMetricChips .dlv-mchip').forEach(b =>
    b.classList.toggle('active', b.dataset.metric === key));
  const note = document.getElementById('dlvMetricNote');
  if (note) {
    const m = DLV_METRICS[key];
    note.textContent = m.hourly ? '这个口径跟着时间轴走' :
      (m.rankedOnly ? '只有样本够的区有值，其余留空' : '整段统计，不随时间轴变化');
  }
  dlvRedraw();
}

function dlvTogglePlay() {
  const btn = document.getElementById('dlvPlay');
  if (DLVMAP.play) {
    clearInterval(DLVMAP.play);
    DLVMAP.play = null;
    if (btn) { btn.textContent = '▶'; btn.classList.remove('playing'); }
    return;
  }
  // Step only through hours that actually have jobs — most of the night is
  // empty and watching it tick through 03:00 teaches nothing.
  const totals = (dlvData().summary.hour_totals) || [];
  const live = totals.map((v, h) => (v ? h : -1)).filter(h => h >= 0);
  if (!live.length) return;
  let k = Math.max(0, live.indexOf(DLVMAP.hour));
  if (btn) { btn.textContent = '❚❚'; btn.classList.add('playing'); }
  dlvSetHour(live[k]);
  DLVMAP.play = setInterval(() => {
    k = (k + 1) % live.length;
    dlvSetHour(live[k]);
  }, 900);
}

function renderDeliveryMap() {
  const D = dlvData();
  if (!D || typeof L === 'undefined') return;
  const host = document.getElementById('dlvMap');
  if (!host || DLVMAP.map) return;

  DLVMAP.map = L.map('dlvMap', { zoomControl: true, scrollWheelZoom: true })
    .setView([-33.89, 151.20], 13);
  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}{r}.png', {
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OSM</a> · © <a href="https://carto.com/">CARTO</a>',
    subdomains: 'abcd', maxZoom: 19,
  }).addTo(DLVMAP.map);
  // Labels ride in shadowPane so street names stay readable on top of the
  // suburb fills and corridor lines. Same trick as the overview map.
  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_only_labels/{z}/{x}/{y}{r}.png', {
    subdomains: 'abcd', maxZoom: 19, pane: 'shadowPane',
  }).addTo(DLVMAP.map);

  // Draw order matters: fills first, lines over them, dots on top.
  ['zones', 'common', 'hard', 'lights', 'drops', 'pickups'].forEach(kind => {
    DLVMAP.panes[kind] = L.layerGroup().addTo(DLVMAP.map);
  });
  DLVMAP.map.on('click', () => dlvClearSelection());

  const chips = document.getElementById('dlvLayerChips');
  if (chips) {
    chips.querySelectorAll('.dlv-chip').forEach(btn => {
      const kind = btn.dataset.layer;
      btn.classList.toggle('active', !!DLVMAP.visible[kind]);
      btn.addEventListener('click', () => {
        DLVMAP.visible[kind] = !DLVMAP.visible[kind];
        btn.classList.toggle('active', DLVMAP.visible[kind]);
        if (DLVMAP.selected && DLVMAP.selected.kind === kind && !DLVMAP.visible[kind]) {
          DLVMAP.selected = null;
        }
        // Switching a layer on used to refit the map. It no longer does —
        // you keep whatever corner you were looking at.
        if (DLVMAP.visible[kind]) dlvSetPanel(kind);
        dlvRedraw();
      });
    });
  }
  const metrics = document.getElementById('dlvMetricChips');
  if (metrics) {
    metrics.innerHTML = Object.entries(DLV_METRICS).map(([k, m]) =>
      `<button class="dlv-mchip${k === DLVMAP.metric ? ' active' : ''}" data-metric="${k}">${m.label}</button>`).join('');
    metrics.querySelectorAll('.dlv-mchip').forEach(b =>
      b.addEventListener('click', () => dlvSetMetric(b.dataset.metric)));
  }
  const tabs = document.getElementById('dlvPanelTabs');
  if (tabs) {
    tabs.querySelectorAll('.dlv-ptab').forEach(btn => btn.addEventListener('click', () => {
      const kind = btn.dataset.list;
      if (!DLVMAP.visible[kind]) {
        DLVMAP.visible[kind] = true;
        const chip = document.querySelector(`#dlvLayerChips .dlv-chip[data-layer="${kind}"]`);
        if (chip) chip.classList.add('active');
        dlvRedraw();
      }
      dlvSetPanel(kind);
    }));
  }
  const slider = document.getElementById('dlvHour');
  if (slider) slider.addEventListener('input', () => {
    if (DLVMAP.play) dlvTogglePlay();
    dlvSetHour(+slider.value);
  });
  const play = document.getElementById('dlvPlay');
  if (play) play.addEventListener('click', dlvTogglePlay);
  const reset = document.getElementById('dlvReset');
  if (reset) reset.addEventListener('click', () => {
    if (DLVMAP.play) dlvTogglePlay();
    DLVMAP.focus = null;
    DLVMAP.selected = null;
    dlvSetHour(-1);
    dlvRenderFocusBar();
    dlvFitAll();
  });

  dlvRedraw();
  dlvFitAll();
  // Leaflet measures the container before the fonts settle; nudge it once.
  setTimeout(() => DLVMAP.map && DLVMAP.map.invalidateSize(), 300);
}

// Called by the corridor lists in 路段好坏 below the map.
function dlvFocusCorridor(kind, id) {
  if (!DLVMAP.map) return;
  if (DLVMAP.play) dlvTogglePlay();
  // Show the whole picture around that road, not whatever hour the scrubber
  // happened to be parked on when you clicked down here.
  DLVMAP.focus = null;
  DLVMAP.hour = -1;
  const hourLabel = document.getElementById('dlvHourLabel');
  if (hourLabel) hourLabel.textContent = '全天';
  const hourSlider = document.getElementById('dlvHour');
  if (hourSlider) hourSlider.value = '-1';
  DLVMAP.visible[kind] = true;
  const chip = document.querySelector(`#dlvLayerChips .dlv-chip[data-layer="${kind}"]`);
  if (chip) chip.classList.add('active');
  dlvRenderFocusBar();
  dlvRedraw();
  if (DLVMAP.refs[`${kind}:${id}`]) dlvSelect(kind, id, true);
  document.getElementById('dlvMap').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

// ============ 路段好坏 / Corridor lists ============
function renderCorridors() {
  const D = dlvData();
  if (!D) return;
  const common = [...D.corridors].sort((a, b) => b.passes - a.passes).slice(0, 25);
  const hard = [...D.corridors].filter(c => c.passes >= 3)
    .sort((a, b) => b.lost_per_pass - a.lost_per_pass).slice(0, 25);

  // Two chains can share a from→to label; number the repeats so a row in the
  // list and a line on the map can still be matched up by eye.
  const dedupe = rows => {
    const seen = {};
    return rows.map(c => {
      const n = (seen[c.zone] = (seen[c.zone] || 0) + 1);
      return { ...c, label: n === 1 ? c.zone : `${c.zone} ${'②③④⑤⑥⑦⑧⑨'[n - 2] || n}` };
    });
  };

  const draw = (hostId, rows, kind) => {
    const host = document.getElementById(hostId);
    if (!host) return;
    if (!rows.length) { host.innerHTML = '<div class="empty-range">数据还不够画出路段</div>'; return; }
    const metric = kind === 'hard' ? 'lost_per_pass' : 'passes';
    const max = Math.max(...rows.map(r => r[metric]), 1);
    host.innerHTML = rows.map((c, i) => {
      const w = (c[metric] / max) * 100;
      const col = kind === 'hard' ? DLV.rose : DLV.amber;
      return `<div class="corridor-row" data-kind="${kind}" data-i="${c._i}">
        <div class="corridor-head">
          <span class="corridor-rank">${i + 1}</span>
          <span class="corridor-name">${dlvEsc(c.label || c.zone || '—')}</span>
          <span class="corridor-metric">${kind === 'hard' ? `+${c.lost_per_pass} min/趟` : `${c.passes} 班次`}</span>
        </div>
        <div class="corridor-bar"><span style="width:${w}%;background:${col}"></span></div>
        <div class="corridor-meta">${c.med_speed} km/h · 约 ${c.len_m} m · 红灯占 ${(c.light_share * 100).toFixed(0)}% · 上坡 ${c.grade_up}%${c.zones.length > 1 ? ` · 途经 ${dlvEsc(c.zones.slice(0, 3).join('/'))}` : ''}</div>
      </div>`;
    }).join('');
    host.querySelectorAll('.corridor-row').forEach(row => row.addEventListener('click', () => {
      dlvFocusCorridor(row.dataset.kind, +row.dataset.i);
    }));
  };
  draw('corridorTop', dedupe(common), 'common');
  draw('corridorHard', dedupe(hard), 'hard');
}

// ============ 时段规律 / Hour x zone ============
function renderHourBars() {
  const D = dlvData();
  if (!D) return;
  const svg = document.getElementById('hourBars');
  if (!svg) return;
  const totals = D.summary.hour_totals || [];
  const max = Math.max(...totals, 1);
  const W = 900, H = 180, P = { l: 40, r: 20, t: 16, b: 34 };
  const bw = (W - P.l - P.r) / 24;
  const bars = totals.map((v, h) => {
    const bh = (v / max) * (H - P.t - P.b);
    const x = P.l + h * bw;
    const y = H - P.b - bh;
    const peak = h === D.summary.peak_hour;
    return `<rect x="${x + 2}" y="${y}" width="${bw - 4}" height="${Math.max(0, bh)}" fill="${peak ? DLV.amberBright : DLV.amber}" fill-opacity="${v ? 0.72 : 0.12}" rx="2">`
      + `<title>${String(h).padStart(2, '0')}:00 · ${v} 次活</title></rect>`
      + (h % 3 === 0 ? `<text x="${x + bw / 2}" y="${H - P.b + 16}" text-anchor="middle" fill="${DLV.axis}" font-family="JetBrains Mono" font-size="10">${h}</text>` : '');
  }).join('');
  const axis = `<line x1="${P.l}" x2="${W - P.r}" y1="${H - P.b}" y2="${H - P.b}" stroke="${DLV.line}"/>`
    + `<text x="${P.l - 8}" y="${P.t + 8}" text-anchor="end" fill="${DLV.axis}" font-family="JetBrains Mono" font-size="10">${max}</text>`
    + `<text x="${W - P.r}" y="${P.t + 8}" text-anchor="end" fill="${DLV.dim}" font-family="JetBrains Mono" font-size="10">峰值 ${String(D.summary.peak_hour).padStart(2, '0')}:00</text>`;
  svg.innerHTML = axis + bars;
}

function renderHourZone() {
  const D = dlvData();
  if (!D) return;
  const host = document.getElementById('hourZoneHeat');
  if (!host) return;
  // Only zones with enough exposure to mean something. A suburb crossed once
  // that happened to yield two jobs used to sit in this grid looking like a
  // pattern; three data points are not a pattern.
  const zones = D.zones.filter(z => z.ranked && z.jobs >= 3).slice(0, 16);
  if (!zones.length) { host.innerHTML = '<div class="empty-range">还没有足够的数据画热力图</div>'; return; }

  // Trim the all-zero hours off both ends so the grid is not mostly empty.
  const totals = D.summary.hour_totals || [];
  let lo = 0, hi = 23;
  while (lo < 23 && !totals[lo]) lo++;
  while (hi > lo && !totals[hi]) hi--;
  const hours = [];
  for (let h = lo; h <= hi; h++) hours.push(h);

  // Row-normalised: each suburb is shaded against its own busiest hour, so a
  // quiet suburb still shows *when* it is busy. Shading everything against one
  // global max just redrew the leaderboard in a second form.
  const rowMode = window.__dlvHzRow !== false;
  const globalMax = Math.max(...zones.flatMap(z => hours.map(h => z.hour_hist[h])), 1);
  const head = `<div class="hz-row hz-head"><div class="hz-label"></div>`
    + hours.map(h => `<div class="hz-cell hz-hour">${String(h).padStart(2, '0')}</div>`).join('') + `</div>`;
  const body = zones.map(z => {
    const rowMax = Math.max(...hours.map(h => z.hour_hist[h]), 1);
    const max = rowMode ? rowMax : globalMax;
    return `<div class="hz-row" data-zone="${dlvEsc(z.name)}">
      <div class="hz-label" title="${dlvEsc(z.label)} · ${z.jobs} 次活（送 ${z.orders} / 取 ${z.pickups}）">${dlvEsc(z.label)}</div>`
      + hours.map(h => {
        const v = z.hour_hist[h];
        return `<div class="hz-cell" style="background:${v ? dlvRamp(v / max) : '#1c1e25'}" title="${dlvEsc(z.label)} ${String(h).padStart(2, '0')}:00 · ${v} 次活"></div>`;
      }).join('') + `</div>`;
  }).join('');
  host.innerHTML = head + body;
  host.querySelectorAll('.hz-row[data-zone]').forEach(row =>
    row.addEventListener('click', () => {
      dlvSetFocus(row.dataset.zone);
      document.getElementById('dlvMap').scrollIntoView({ behavior: 'smooth', block: 'center' });
    }));

  const foot = document.getElementById('hzFoot');
  if (foot) {
    let best = { v: -1 };
    zones.forEach(z => hours.forEach(h => {
      if (z.hour_hist[h] > best.v) best = { v: z.hour_hist[h], z: z.label, h };
    }));
    foot.textContent = best.v > 0
      ? `最密：${best.z} ${String(best.h).padStart(2, '0')}:00 · ${best.v} 次活`
      : '—';
  }
}

function bindHourZone() {
  const btn = document.getElementById('hzRowToggle');
  if (!btn) return;
  btn.addEventListener('click', () => {
    window.__dlvHzRow = window.__dlvHzRow === false;
    btn.classList.toggle('active', window.__dlvHzRow !== false);
    btn.textContent = window.__dlvHzRow !== false ? '每区各自归一' : '全表统一色阶';
    renderHourZone();
  });
}

// ============ 区域档案 / Structural profile ============
// The measured numbers say what riding a suburb was like. These say what the
// suburb *is* — how much food it has, how many signals per km of road, how
// many people live there. They come from the map rather than the bike, so
// they are the part that can say something about a suburb before you ride it.
function renderZoneProfile() {
  const D = dlvData();
  if (!D) return;
  const host = document.getElementById('zoneProfile');
  if (!host) return;
  const zones = D.zones.filter(z => z.ranked).slice(0, 18);
  if (!zones.length) { host.innerHTML = '<div class="empty-range">样本还不够</div>'; return; }

  const cols = [
    { key: 'prep_per_km2', label: '餐厅密度', unit: '家/km²', good: 'high', fmt: v => Math.round(v) },
    { key: 'pop_density', label: '人口密度', unit: '人/km²', good: 'high', fmt: v => Math.round(v) },
    { key: 'sig_per_km', label: '红绿灯', unit: '个/km 路', good: 'low', fmt: v => v.toFixed(1) },
    { key: 'climb_per_km', label: '爬升', unit: 'm/km', good: 'low', fmt: v => v.toFixed(1) },
    { key: 'med_speed', label: '实测速度', unit: 'km/h', good: 'high', fmt: v => v.toFixed(1) },
    { key: 'light_min_per_km', label: '红灯耗时', unit: 'min/km', good: 'low', fmt: v => v.toFixed(2) },
    { key: 'jobs_per_hour', label: '活/小时', unit: '', good: 'high', fmt: v => v.toFixed(2) },
  ];
  const ranges = {};
  cols.forEach(c => {
    const vals = zones.map(z => z[c.key]).filter(v => v != null);
    ranges[c.key] = { lo: Math.min(...vals), hi: Math.max(...vals) };
  });

  const sortKey = window.__dlvProfSort || 'flow';
  const sorted = [...zones].sort((a, b) => (b[sortKey] ?? -Infinity) - (a[sortKey] ?? -Infinity));

  const head = `<div class="zp-row zp-head"><div class="zp-name">区</div>`
    + cols.map(c => `<div class="zp-cell" data-sort="${c.key}" title="点击按这列排序">${c.label}<em>${c.unit}</em></div>`).join('')
    + `<div class="zp-cell zp-flow" data-sort="flow">好跑<em>0–100</em></div></div>`;

  const body = sorted.map(z => {
    const cells = cols.map(c => {
      const v = z[c.key];
      if (v == null) return `<div class="zp-cell"><span class="zp-dash">—</span></div>`;
      const { lo, hi } = ranges[c.key];
      let t = hi === lo ? 0.5 : (v - lo) / (hi - lo);
      if (c.good === 'low') t = 1 - t;
      return `<div class="zp-cell">
        <span class="zp-bar"><span style="width:${Math.max(4, t * 100)}%;background:${dlvRamp(t)}"></span></span>
        <span class="zp-val">${c.fmt(v)}</span></div>`;
    }).join('');
    return `<div class="zp-row" data-zone="${dlvEsc(z.name)}">
      <div class="zp-name">${dlvEsc(z.label)}</div>${cells}
      <div class="zp-cell zp-flow"><span class="zp-bar"><span style="width:${z.flow}%;background:${dlvRamp(z.flow / 100)}"></span></span><span class="zp-val">${z.flow.toFixed(0)}</span></div>
    </div>`;
  }).join('');

  host.innerHTML = head + body;
  host.querySelectorAll('[data-sort]').forEach(el => el.addEventListener('click', () => {
    window.__dlvProfSort = el.dataset.sort;
    renderZoneProfile();
  }));
  host.querySelectorAll('.zp-row[data-zone]').forEach(row =>
    row.addEventListener('click', ev => {
      if (ev.target.closest('[data-sort]')) return;
      dlvSetFocus(row.dataset.zone);
      document.getElementById('dlvMap').scrollIntoView({ behavior: 'smooth', block: 'center' });
    }));

  const foot = document.getElementById('zpFoot');
  if (foot) {
    const src = (D.meta.osm && D.meta.osm.source) || 'OpenStreetMap';
    foot.textContent = `餐厅数、红绿灯、路网长度来自 ${src}；速度、爬升、红灯耗时是自己骑出来的。`
      + ` 条越长越有利 —— 红绿灯、爬升、红灯耗时是越少越好，已经反过来画了。`;
  }
}

// ============ 准不准 / Scored against a real order log ============
// Everything above is inferred. This section is the one place the page can
// say how well that inference actually does, because one of the three
// platforms the rider works for hands over a real order log.
function renderValidation() {
  const D = dlvData();
  if (!D) return;
  const host = document.getElementById('dlvValidation');
  if (!host) return;
  const v = D.validation;
  if (!v) {
    host.innerHTML = '<div class="empty-range">没有可对照的真实订单记录</div>';
    const note = document.getElementById('dlvValNote');
    if (note) note.innerHTML = '';
    return;
  }

  const cards = [
    ['送达召回率', v.recall_drop, '%', `手表在录时发生的 ${v.in_window} 单里，判对了 ${Math.round(v.in_window * v.recall_drop / 100)} 单`],
    ['取餐召回率', v.recall_pickup, '%', `同一批单，取餐那一头判对的比例`],
    ['区域判对', v.zone_pct, '%', `对上的单里，送达区和真实地址所在区一致`],
    ['餐厅命中', v.venue_pct, '%', `对上的取餐点，地图上确实有餐饮店`],
  ];
  host.innerHTML = cards.map(([label, value, unit, foot]) => `
    <div class="dlv-kpi">
      <div class="dlv-kpi-label">${label}</div>
      <div class="dlv-kpi-value">${value == null ? '—' : value}<span class="dlv-kpi-unit">${unit}</span></div>
      <div class="dlv-kpi-foot">${dlvEsc(foot)}</div>
    </div>`).join('');

  // Where the missed ones went. Naming the failure mode is more useful than
  // a single accuracy number: half of them look exactly like a red light.
  const missHost = document.getElementById('dlvMisses');
  if (missHost) {
    const m = v.misses || {};
    const total = Object.values(m).reduce((a, b) => a + b, 0) || 1;
    const rows = [
      ['light', '被判成了等灯', DLV.rose, '停 20–60 秒、范围两三米、就在信号灯旁边 —— 和一个红灯在物理上没有区别'],
      ['pickup', '被判成了取餐', DLV.cyan, '停对了地方，但方向搞反：密集街区里客户楼下就是餐厅'],
      ['no_dwell', '当时压根没停留', DLV.axis, '轨迹里那一刻还在动，可能是隔着门递出去的'],
    ].filter(([k]) => m[k]);
    missHost.innerHTML = rows.map(([k, label, col, why]) => `
      <div class="dlv-miss">
        <div class="dlv-miss-head">
          <span class="dlv-miss-n" style="color:${col}">${m[k]}</span>
          <span class="dlv-miss-label">${label}</span>
        </div>
        <div class="dlv-miss-bar"><span style="width:${(m[k] / total) * 100}%;background:${col}"></span></div>
        <div class="dlv-miss-why">${why}</div>
      </div>`).join('');
  }

  const align = document.getElementById('dlvAlign');
  if (align) {
    const sign = v.align_median_s > 0 ? '+' : '';
    align.innerHTML = `<div class="dlv-align-num">${sign}${v.align_median_s}<em>秒</em></div>`
      + `<div class="dlv-align-sub">我判定的送达时刻，和真实送达时刻的中位差<br>`
      + `四分位区间 ${v.align_iqr[0]} ~ +${v.align_iqr[1]} 秒</div>`;
  }

  const note = document.getElementById('dlvValNote');
  if (note) {
    note.innerHTML = `<strong>这些数字怎么来的，以及不能怎么用</strong> · `
      + `对照的是${dlvEsc(v.source)}，${v.first} → ${v.last} 共 ${v.orders} 单。`
      + `<br><br>`
      + `<b>时间锚点</b>：订单记录里的时间戳其实是<em>取餐</em>时刻，不是送达。`
      + `用「时间戳 + 时长」去对，送达停留的中位偏差只有 ${Math.abs(v.align_median_s)} 秒；`
      + `直接用时间戳去对会差出几百秒。能对得这么齐，本身就说明停留检测抓到的是真事件，不是噪声。`
      + `<br><br>`
      + `<b>只有召回率，没有准确率</b>：这一份记录只是三个平台里的一个 —— 另外两个（熊猫外卖、DoorDash）`
      + `没有记录可对。我判出的 ${v.total_drops} 个送达里，只有 ${v.matched_drops} 个能在这份记录里找到，`
      + `约 ${v.platform_share_pct}%；剩下的绝大多数是另外两个平台的单，不是误判。`
      + `所以「判多了」这件事这里量不出来，页面也不会假装量得出来。`
      + `<br><br>`
      + `<b>还有 ${100 - v.coverage_pct}% 对不上是因为没录</b>：${v.orders - v.in_window} 单发生在手表没在记录的时段，`
      + `不可能匹配，已从分母里剔除。`
      + `<br><br>`
      + `<b>口径</b>：时间差在 ${Math.round(v.match_window_s / 60)} 分钟以内算对上。`
      + `真实单的中位车费 A$${v.median_fare}、${v.median_km} km、${v.median_min} 分钟 —— `
      + `和上面推断出的每单里程量级一致。`
      + `<br><br>`
      + `客户送达地址没有出现在这个网站的任何地方，也没有进代码仓库：那是别人的家庭住址，`
      + `只有上面这些汇总分数离开了本地。`;
  }
}

// ============ 接单区 vs 送达区 / Collect or deliver ============
// A suburb is rarely good at both jobs. Haymarket hands out thirty-five
// orders and takes six; Camperdown takes eleven and hands out none. And the
// part that decides the hourly rate is neither — it is the unpaid ride
// between dropping one order and collecting the next.
function renderChain() {
  const D = dlvData();
  if (!D || !D.chain) return;
  const c = D.chain;

  const sum = document.getElementById('dlvChainSum');
  if (sum) {
    const cards = [
      ['空驶占比', c.dead_share, '%', `送完到下一次取餐之间的里程 —— ${c.dead_km_total} km 不挣钱，载单 ${c.paid_km_total} km`],
      ['每次空驶', c.dead_km_med, 'km', `中位 ${c.dead_min_med} 分钟 · 共 ${c.dead_legs} 段`],
      ['下一单还在同区', c.same_zone_pct, '%', `送完之后，下一次取餐仍在同一个 suburb 的比例`],
      ['载单里程', c.paid_km_med, 'km', `取餐到送达的中位直线距离`],
    ];
    sum.innerHTML = cards.map(([label, v, unit, foot]) => `
      <div class="dlv-kpi">
        <div class="dlv-kpi-label">${label}</div>
        <div class="dlv-kpi-value">${v == null ? '—' : v}<span class="dlv-kpi-unit">${unit}</span></div>
        <div class="dlv-kpi-foot">${dlvEsc(foot)}</div>
      </div>`).join('');
  }

  const MIN_LEGS = 4;   // below this the per-zone medians are anecdotes
  const zones = D.zones.filter(z => z.ranked);

  // ---- best places to collect from ----
  const pk = document.getElementById('dlvPickupRank');
  if (pk) {
    const rows = zones.filter(z => z.pickups >= 3)
      .sort((a, b) => b.pickups - a.pickups).slice(0, 12);
    pk.innerHTML = rows.map(z => {
      const ap = z.as_pickup || {};
      const thin = (ap.legs || 0) < MIN_LEGS;
      const wait = z.pickup_wait_med;
      return `<div class="ch-row" data-zone="${dlvEsc(z.name)}">
        <div class="ch-name">${dlvEsc(z.label)}<em>${z.pickups} 次取餐</em></div>
        <div class="ch-stats">
          <span><i>等餐</i>${wait}s</span>
          <span class="${thin ? 'ch-thin' : ''}"><i>送出去要</i>${ap.leg_min == null ? '—' : ap.leg_min + ' min'}</span>
          <span class="${thin ? 'ch-thin' : ''}"><i>送出去多远</i>${ap.leg_km == null ? '—' : ap.leg_km + ' km'}</span>
          <span><i>餐厅密度</i>${z.prep_per_km2 == null ? '—' : Math.round(z.prep_per_km2)}/km²</span>
        </div>
      </div>`;
    }).join('');
  }

  // ---- best places to deliver into ----
  // Both ends, not just the good one. Showing the twelve shortest hid exactly
  // the suburbs worth avoiding — the whole point of asking where you land
  // well is also learning where you land badly.
  const dp = document.getElementById('dlvDropRank');
  if (dp) {
    const pool = zones.filter(z => z.orders >= 3 && z.as_drop && z.as_drop.legs >= 3)
      .sort((a, b) => (a.as_drop.dead_min) - (b.as_drop.dead_min));
    const best = pool.slice(0, 8);
    const worst = pool.slice(8);
    const render = z => {
      const ad = z.as_drop;
      const thin = ad.legs < MIN_LEGS;
      // Long wait but short distance is not the same failure as long wait and
      // long distance: one is sitting still, the other is riding for nothing.
      const idling = ad.dead_min >= 8 && ad.dead_km <= 1.0;
      return `<div class="ch-row${thin ? ' ch-row-thin' : ''}" data-zone="${dlvEsc(z.name)}">
        <div class="ch-name">${dlvEsc(z.label)}<em>${z.orders} 次送达</em></div>
        <div class="ch-stats">
          <span><i>空驶</i>${ad.dead_min} min</span>
          <span><i>骑了</i>${ad.dead_km} km</span>
          <span><i>同区续单</i>${ad.same_pct}%</span>
          <span><i>常去的下一区</i>${dlvEsc(ad.next_zone || '—')}</span>
        </div>
        ${idling ? '<div class="ch-flag">时间长但没骑多远 —— 是在原地等单，不是在跑远路</div>' : ''}
        ${thin ? `<div class="ch-thin-note">只有 ${ad.legs} 段样本</div>` : ''}
      </div>`;
    };
    dp.innerHTML = best.map(render).join('')
      + (worst.length ? '<div class="ch-split">最难接上下一单的</div>' + worst.map(render).join('') : '');
  }

  // ---- where the next job actually comes from ----
  const fl = document.getElementById('dlvFlows');
  if (fl) {
    const max = Math.max(...c.flows.map(f => f.n), 1);
    fl.innerHTML = c.flows.map(f => `
      <div class="ch-flow${f.same ? ' same' : ''}">
        <span class="ch-flow-from">${dlvEsc(f.from)}</span>
        <span class="ch-flow-arrow">→</span>
        <span class="ch-flow-to">${dlvEsc(f.to)}</span>
        <span class="ch-flow-bar"><span style="width:${(f.n / max) * 100}%;background:${f.same ? DLV.cyan : DLV.amber}"></span></span>
        <span class="ch-flow-n">${f.n}</span>
      </div>`).join('');
  }

  const note = document.getElementById('dlvChainNote');
  if (note) {
    note.innerHTML = `<strong>怎么读这两张表</strong> · `
      + `一个区很少两头都好。<em>接单区</em>看的是它把单派出去的能力：取餐次数、餐厅让你等多久、`
      + `以及接了之后要骑多远才送到 —— 送得越近，同样时间里能跑的单越多。`
      + `<em>送达区</em>看的是完全不同的东西：送完之后，你离下一单有多远。`
      + `<br><br>`
      + `<b>空驶是最大的一笔隐形成本</b>：全部里程里有 ${c.dead_share}% 花在「送完了、还没接到下一单」的路上，`
      + `一分钱不挣。把它压下去比多接一单更划算。`
      + `<br><br>`
      + `<b>两种不同的坏</b>：空驶时间长、距离也长，是真的在跑远路；`
      + `时间长但距离很短，是停在原地等派单 —— 后者换个位置也没用，得换时段。表里标出来了。`
      + `<br><br>`
      + `<b>样本很薄</b>：一共只有 ${c.dead_legs} 段空驶可分析，摊到各区每区只有几段，`
      + `少于 4 段的已经标灰。这一节看趋势可以，别拿单个数字下结论。`
      + `另外这里只统计相邻两次作业间隔在 45 分钟以内的 —— 更长的那些是休息或跨城转场，不是接单间隙。`;
  }
}
