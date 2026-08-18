// ============================================================
// 配送分析 / Delivery analytics renderers
//
// Reads window.DELIVERY_DATA (built by analyze_delivery.py) and draws the
// 配送 page: shift economics, the zone leaderboard, the hotspot map, the
// corridor lists and the hour x zone heatmap.
//
// Kept out of app.js because the data behind it is only loaded on the pages
// that show it — every other page would pay for it and render nothing.
// ============================================================

const DLV = {
  amber: '#e8b76d', amberBright: '#ffd897',
  cyan: '#6cc4d9', rose: '#d97a8a',
  grid: '#1c1e25', axis: '#5d5b55', dim: '#908d85', line: '#3a3d48',
};

function dlvData() { return window.DELIVERY_DATA || null; }

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

// ============ 配送概览 / Shift economics ============
function renderDeliveryKpis() {
  const D = dlvData();
  if (!D) return;
  const host = document.getElementById('dlvKpis');
  if (!host) return;
  const s = D.summary;
  const m = D.meta;

  const secEl = document.getElementById('dlvStopSec');
  if (secEl) secEl.textContent = m.stop_seconds;

  const cards = [
    ['识别出的单量', s.orders, '单', `${m.shifts} 个班次 · ${m.first} → ${m.last}`],
    ['单 / 小时', s.orders_per_hour.toFixed(2), '单/h', `平均每 ${s.min_per_order} 分钟一单`],
    ['每单里程', s.km_per_order.toFixed(2), 'km', `合计骑了 ${s.km} km`],
    ['在岗时长', s.hours.toFixed(1), 'h', `覆盖 ${s.zones_touched} 个区`],
    ['单最多的区', s.top_zone || '—', '', '按识别出的停车次数'],
    ['最值得去', s.sweet_zone || '—', '', '出单速度 × 好跑指数'],
  ];
  host.innerHTML = cards.map(([label, value, unit, foot]) => `
    <div class="dlv-kpi">
      <div class="dlv-kpi-label">${label}</div>
      <div class="dlv-kpi-value">${dlvEsc(value)}${unit ? `<span class="dlv-kpi-unit">${unit}</span>` : ''}</div>
      <div class="dlv-kpi-foot">${dlvEsc(foot)}</div>
    </div>`).join('');

  const note = document.getElementById('dlvMethod');
  if (note) {
    const w = m.flow_weights || {};
    const pct = k => Math.round((w[k] || 0) * 100);
    note.innerHTML = `<strong>怎么算的</strong> · 速度低于 ${m.stop_speed_ms} m/s 连续 ${m.stop_seconds} 秒以上算一单；`
      + `${m.wait_seconds}–${m.stop_seconds} 秒算红灯路口，只进路况不进单量。`
      + `区名用 ABS 2016 suburb 边界做点在多边形判定，不是就近取中心点。`
      + `好跑指数 = 中位速度 ${pct('speed')}% + 红灯密度 ${pct('waits')}% + 爬升 ${pct('climb')}% + 龟速占比 ${pct('crawl')}%。`
      + `每次出勤自己的起点/终点 ${m.endpoint_m} 米内的停留已剔除（共 ${m.endpoint_stops_dropped} 次），那是家不是客户。`
      + `单量是从轨迹推断的，不是平台真实单数 —— 用来比区与区的相对高低，别当账单看。`;
  }
}

// ============ 区域排行 / Zone leaderboard ============
function renderZoneQuadrant() {
  const D = dlvData();
  if (!D) return;
  const svg = document.getElementById('zoneQuadrant');
  if (!svg) return;
  const zones = D.zones.filter(z => z.orders > 0);
  if (!zones.length) return;

  const W = 900, H = 460, P = { l: 58, r: 28, t: 34, b: 52 };
  const xMax = Math.max(4, Math.max(...zones.map(z => z.orders)) * 1.12);
  const y0 = Math.max(0, Math.min(...zones.map(z => z.flow)) - 8);
  const y1 = Math.min(100, Math.max(...zones.map(z => z.flow)) + 8);
  const xs = v => P.l + (v / xMax) * (W - P.l - P.r);
  const ys = v => H - P.b - ((v - y0) / (y1 - y0 || 1)) * (H - P.t - P.b);

  const xMed = dlvMedian(zones.map(z => z.orders));
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
    `<text x="${W - P.r - 8}" y="${P.t + 14}" text-anchor="end" fill="${DLV.amberBright}" font-family="JetBrains Mono" font-size="10" letter-spacing="0.1em">单 多 · 好 跑</text>`
    + `<text x="${P.l + 8}" y="${P.t + 14}" fill="${DLV.cyan}" font-family="JetBrains Mono" font-size="10" letter-spacing="0.1em">单 少 · 好 跑</text>`
    + `<text x="${W - P.r - 8}" y="${H - P.b - 8}" text-anchor="end" fill="${DLV.rose}" font-family="JetBrains Mono" font-size="10" letter-spacing="0.1em">单 多 · 难 跑</text>`
    + `<text x="${P.l + 8}" y="${H - P.b - 8}" fill="${DLV.axis}" font-family="JetBrains Mono" font-size="10" letter-spacing="0.1em">单 少 · 难 跑</text>`;

  const hMax = Math.max(...zones.map(z => z.hours)) || 1;
  const dots = zones.map(z => {
    const r = 5 + Math.sqrt(z.hours / hMax) * 16;
    const hot = z.orders >= xMed && z.flow >= yMed;
    const col = !z.ranked ? DLV.axis : (hot ? DLV.amber : (z.orders >= xMed ? DLV.rose : DLV.cyan));
    return `<circle cx="${xs(z.orders)}" cy="${ys(z.flow)}" r="${r}" fill="${col}" fill-opacity="${z.ranked ? 0.3 : 0.14}" stroke="${col}" stroke-width="1.2" stroke-opacity="${z.ranked ? 1 : 0.5}">`
      + `<title>${dlvEsc(z.name)} · ${z.orders} 单 · ${z.shifts} 个班次 · 好跑 ${z.flow} · 中位 ${z.med_speed} km/h · 红灯 ${z.waits_per_km}/km · 爬升 ${z.climb_per_km} m/km${z.ranked ? '' : ' · 样本不足'}</title></circle>`;
  }).join('');

  // Label the zones worth reading; the rest stay hover targets. Busy suburbs
  // cluster, so nudge a label up until it clears the one above it — otherwise
  // the two or three names that matter most are the ones that overlap.
  const placed = [];
  const labels = [...zones].sort((a, b) => b.orders - a.orders).slice(0, 10).map(z => {
    const cx = xs(z.orders);
    let cy = ys(z.flow) - (7 + Math.sqrt(z.hours / hMax) * 16);
    for (let guard = 0; guard < 8; guard++) {
      const clash = placed.find(p => Math.abs(p.x - cx) < 72 && Math.abs(p.y - cy) < 13);
      if (!clash) break;
      cy = clash.y - 13;
    }
    placed.push({ x: cx, y: cy });
    return `<text x="${cx}" y="${Math.max(P.t + 24, cy)}" text-anchor="middle" fill="${DLV.dim}" font-family="JetBrains Mono" font-size="9.5">${dlvEsc(z.name)}</text>`;
  }).join('');

  svg.innerHTML = grid + cross + quads + dots + labels
    + `<text x="${W / 2}" y="${H - 8}" text-anchor="middle" class="eq-axis-title">识别出的单量</text>`
    + `<text x="16" y="${H / 2}" text-anchor="middle" class="eq-axis-title" transform="rotate(-90 16 ${H / 2})">好跑指数 0–100</text>`;

  const buckets = { hot: [], flowOnly: [], grind: [], quiet: [] };
  zones.forEach(z => {
    if (z.orders >= xMed && z.flow >= yMed) buckets.hot.push(z);
    else if (z.orders < xMed && z.flow >= yMed) buckets.flowOnly.push(z);
    else if (z.orders >= xMed) buckets.grind.push(z);
    else buckets.quiet.push(z);
  });
  const names = list => list.sort((a, b) => b.orders - a.orders).slice(0, 4).map(z => z.name).join('、') || '—';
  const legend = document.getElementById('zoneQuadLegend');
  if (legend) {
    legend.innerHTML =
      `<div class="eq-tag eff"><strong>单多又好跑</strong><span class="eq-count">${buckets.hot.length} 区</span><br>${dlvEsc(names(buckets.hot))}</div>`
      + `<div class="eq-tag costly"><strong>单多但难跑</strong><span class="eq-count">${buckets.grind.length} 区</span><br>${dlvEsc(names(buckets.grind))}</div>`
      + `<div class="eq-tag eff"><strong>好跑但没单</strong><span class="eq-count">${buckets.flowOnly.length} 区</span><br>${dlvEsc(names(buckets.flowOnly))}</div>`
      + `<div class="eq-tag easy"><strong>又少又难</strong><span class="eq-count">${buckets.quiet.length} 区</span><br>${dlvEsc(names(buckets.quiet))}</div>`;
  }
}

function renderZoneTable() {
  const D = dlvData();
  if (!D) return;
  const tbody = document.getElementById('zoneTbody');
  if (!tbody) return;
  const rows = D.zones.filter(z => z.orders > 0 || z.km >= 1.5);
  const st = window.__dlvZoneSort || { key: 'orders', dir: 'desc' };
  rows.sort((a, b) => {
    const av = a[st.key], bv = b[st.key];
    const an = av == null ? -Infinity : av;
    const bn = bv == null ? -Infinity : bv;
    if (an === bn) return b.orders - a.orders;
    return st.dir === 'desc' ? (bn > an ? 1 : -1) : (an > bn ? 1 : -1);
  });
  const flowMax = 100;
  tbody.innerHTML = rows.map(z => {
    const bar = `<span class="flow-bar"><span class="flow-bar-fill" style="width:${(z.flow / flowMax) * 100}%;background:${dlvRamp(z.flow / flowMax)}"></span></span>`;
    return `<tr${z.ranked ? '' : ' class="dlv-thin"'}>
      <td class="dlv-zone">${dlvEsc(z.name)}<span class="dlv-lga">${dlvEsc(z.lga || '')}</span></td>
      <td class="col-distance">${z.orders}</td>
      <td>${z.shifts}</td>
      <td>${z.ranked ? z.orders_per_hour.toFixed(2) : '<span class="dlv-na" title="出现班次不足 3 次或停留时间太短，速率不可靠">样本少</span>'}</td>
      <td>${z.med_speed.toFixed(1)}</td>
      <td>${z.waits_per_km.toFixed(2)}</td>
      <td>${z.climb_per_km.toFixed(1)}</td>
      <td>${bar}<span class="flow-num">${z.flow.toFixed(0)}</span></td>
      <td>${z.worth == null ? '—' : z.worth.toFixed(0)}</td>
    </tr>`;
  }).join('');
}

function bindZoneTable() {
  const table = document.getElementById('zoneTable');
  if (!table) return;
  table.querySelectorAll('thead th[data-sort]').forEach(th => {
    th.addEventListener('click', () => {
      const key = th.dataset.sort;
      const cur = window.__dlvZoneSort || { key: 'orders', dir: 'desc' };
      const dir = cur.key === key ? (cur.dir === 'desc' ? 'asc' : 'desc') : (th.dataset.dir || 'desc');
      window.__dlvZoneSort = { key, dir };
      table.querySelectorAll('thead th').forEach(o => o.classList.remove('sorted'));
      th.classList.add('sorted');
      renderZoneTable();
    });
  });
}

// ============ 热点地图 / Hotspot map ============
// One Leaflet map, four swappable layers. Kept in a module-level handle so
// the corridor lists further down the page can pan it without rebuilding.
let dlvMap = null;
let dlvLayer = null;
let dlvCorridorRefs = [];

function renderDeliveryMap() {
  const D = dlvData();
  if (!D || typeof L === 'undefined') return;
  const host = document.getElementById('dlvMap');
  if (!host || dlvMap) return;

  const pts = D.hotspots.map(h => [h.lat, h.lon]);
  const center = pts.length
    ? [pts.reduce((a, p) => a + p[0], 0) / pts.length, pts.reduce((a, p) => a + p[1], 0) / pts.length]
    : [-33.89, 151.20];

  dlvMap = L.map('dlvMap', { zoomControl: true, scrollWheelZoom: false }).setView(center, 13);
  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; OpenStreetMap &copy; CARTO', maxZoom: 19,
  }).addTo(dlvMap);
  dlvLayer = L.layerGroup().addTo(dlvMap);

  dlvShowLayer('hotspots');

  const tabs = document.getElementById('dlvLayerTabs');
  if (tabs) {
    tabs.querySelectorAll('button.dlv-tab[data-layer]').forEach(btn => {
      btn.addEventListener('click', () => {
        tabs.querySelectorAll('button.dlv-tab').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        dlvShowLayer(btn.dataset.layer);
      });
    });
  }
  // Leaflet measures the container before the fonts settle; nudge it once.
  setTimeout(() => dlvMap && dlvMap.invalidateSize(), 300);
}

function dlvShowLayer(kind) {
  const D = dlvData();
  if (!D || !dlvMap) return;
  dlvLayer.clearLayers();
  dlvCorridorRefs = [];
  const title = document.getElementById('dlvPanelTitle');
  const count = document.getElementById('dlvPanelCount');
  const list = document.getElementById('dlvList');
  let bounds = [];

  if (kind === 'hotspots') {
    const maxV = Math.max(...D.hotspots.map(h => h.visits), 1);
    D.hotspots.forEach((h, i) => {
      const r = 6 + Math.sqrt(h.visits / maxV) * 18;
      L.circleMarker([h.lat, h.lon], {
        radius: r, color: DLV.amber, weight: 1.2, opacity: 0.9,
        fillColor: dlvRamp(h.visits / maxV), fillOpacity: 0.45,
      }).bindPopup(`<b>${dlvEsc(h.zone || '未知区')}</b><br>停 ${h.visits} 次 · ${h.shifts} 个班次<br>中位停留 ${h.dwell_med}s · 累计 ${h.dwell_total_min} min`)
        .addTo(dlvLayer);
      bounds.push([h.lat, h.lon]);
    });
    if (title) title.textContent = '停车热点';
    if (count) count.textContent = `${D.hotspots.length} 处`;
    if (list) {
      list.innerHTML = D.hotspots.slice(0, 40).map((h, i) => `
        <div class="dlv-row" data-lat="${h.lat}" data-lon="${h.lon}">
          <div class="dlv-row-main"><span class="dlv-rank">${i + 1}</span>${dlvEsc(h.zone || '未知区')}</div>
          <div class="dlv-row-meta">${h.visits} 次 · ${h.shifts} 班次 · 中位 ${h.dwell_med}s</div>
        </div>`).join('');
      list.querySelectorAll('.dlv-row').forEach(row => row.addEventListener('click', () => {
        dlvMap.setView([+row.dataset.lat, +row.dataset.lon], 17);
      }));
    }
  } else if (kind === 'zones') {
    const withRing = D.zones.filter(z => z.ring && z.orders > 0);
    const maxO = Math.max(...withRing.map(z => z.orders), 1);
    withRing.forEach(z => {
      const latlngs = z.ring.map(p => [p[1], p[0]]);
      L.polygon(latlngs, {
        color: DLV.amber, weight: 1, opacity: 0.5,
        fillColor: dlvRamp(z.orders / maxO), fillOpacity: 0.42,
      }).bindPopup(`<b>${dlvEsc(z.name)}</b><br>${z.orders} 单 · ${z.shifts} 个班次<br>好跑 ${z.flow} · 中位 ${z.med_speed} km/h`)
        .addTo(dlvLayer);
      latlngs.forEach(p => bounds.push(p));
    });
    if (title) title.textContent = '区域单量';
    if (count) count.textContent = `${withRing.length} 区`;
    if (list) {
      list.innerHTML = D.zones.filter(z => z.orders > 0).slice(0, 40).map((z, i) => `
        <div class="dlv-row" data-c="${z.c ? z.c.join(',') : ''}">
          <div class="dlv-row-main"><span class="dlv-rank">${i + 1}</span>${dlvEsc(z.name)}</div>
          <div class="dlv-row-meta">${z.orders} 单 · 好跑 ${z.flow} · ${z.med_speed} km/h</div>
        </div>`).join('');
      list.querySelectorAll('.dlv-row').forEach(row => row.addEventListener('click', () => {
        const c = (row.dataset.c || '').split(',').map(Number);
        if (c.length === 2 && c[0]) dlvMap.setView([c[1], c[0]], 15);
      }));
    }
  } else {
    const hard = kind === 'hard';
    const pool = hard
      ? [...D.corridors].filter(c => c.passes >= 3).sort((a, b) => b.lost_per_pass - a.lost_per_pass).slice(0, 25)
      : [...D.corridors].sort((a, b) => b.passes - a.passes).slice(0, 25);
    const key = hard ? 'lost_per_pass' : 'passes';
    const maxK = Math.max(...pool.map(c => c[key]), 1);
    pool.forEach((c, i) => {
      const line = L.polyline(c.track, {
        color: hard ? DLV.rose : DLV.amber,
        weight: 3 + (c[key] / maxK) * 6,
        opacity: 0.35 + (c[key] / maxK) * 0.55,
      }).bindPopup(`<b>${dlvEsc(c.zone || '—')}</b><br>${c.passes} 个班次经过 · 约 ${c.len_m} m<br>中位 ${c.med_speed} km/h · 停车占比 ${(c.stop_share * 100).toFixed(0)}% · 上坡 ${c.grade_up}%<br>每趟比 18 km/h 多花 ${c.lost_per_pass} min（累计 ${c.lost_min} min）`)
        .addTo(dlvLayer);
      dlvCorridorRefs[i] = line;
      c.track.forEach(p => bounds.push(p));
    });
    window.__dlvPool = pool;
    if (title) title.textContent = hard ? '最难走的路段' : '最常走的路段';
    if (count) count.textContent = `${pool.length} 段`;
    if (list) {
      const seen = {};
      list.innerHTML = pool.map((c, i) => {
        const n = (seen[c.zone] = (seen[c.zone] || 0) + 1);
        const label = n === 1 ? c.zone : `${c.zone} ${'②③④⑤⑥⑦⑧⑨'[n - 2] || n}`;
        return `
        <div class="dlv-row" data-i="${i}">
          <div class="dlv-row-main"><span class="dlv-rank">${i + 1}</span>${dlvEsc(label || '—')}</div>
          <div class="dlv-row-meta">${c.passes} 班次 · ${c.med_speed} km/h · ${hard ? `每趟 +${c.lost_per_pass} min` : `约 ${c.len_m} m`}</div>
        </div>`;
      }).join('');
      list.querySelectorAll('.dlv-row').forEach(row => row.addEventListener('click', () => {
        const line = dlvCorridorRefs[+row.dataset.i];
        if (line) { dlvMap.fitBounds(line.getBounds(), { padding: [40, 40] }); line.openPopup(); }
      }));
    }
  }

  if (bounds.length) dlvMap.fitBounds(bounds, { padding: [24, 24] });
}

// Called by the corridor lists below the map.
function dlvFocusCorridor(kind, index) {
  const tabs = document.getElementById('dlvLayerTabs');
  if (tabs) {
    tabs.querySelectorAll('button.dlv-tab').forEach(b => b.classList.toggle('active', b.dataset.layer === kind));
  }
  dlvShowLayer(kind);
  const line = dlvCorridorRefs[index];
  if (line && dlvMap) {
    dlvMap.fitBounds(line.getBounds(), { padding: [40, 40] });
    line.openPopup();
    document.getElementById('dlvMap').scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
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
      return `<div class="corridor-row" data-kind="${kind}" data-i="${i}">
        <div class="corridor-head">
          <span class="corridor-rank">${i + 1}</span>
          <span class="corridor-name">${dlvEsc(c.label || c.zone || '—')}</span>
          <span class="corridor-metric">${kind === 'hard' ? `+${c.lost_per_pass} min/趟` : `${c.passes} 班次`}</span>
        </div>
        <div class="corridor-bar"><span style="width:${w}%;background:${col}"></span></div>
        <div class="corridor-meta">${c.med_speed} km/h · 约 ${c.len_m} m · 停车 ${(c.stop_share * 100).toFixed(0)}% · 上坡 ${c.grade_up}%${c.zones.length > 1 ? ` · 途经 ${dlvEsc(c.zones.slice(0, 3).join('/'))}` : ''}</div>
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
      + `<title>${String(h).padStart(2, '0')}:00 · ${v} 单</title></rect>`
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
  const zones = D.zones.filter(z => z.orders >= 2).slice(0, 14);
  if (!zones.length) { host.innerHTML = '<div class="empty-range">还没有足够的单量画热力图</div>'; return; }

  // Trim the all-zero hours off both ends so the grid is not mostly empty.
  const totals = D.summary.hour_totals || [];
  let lo = 0, hi = 23;
  while (lo < 23 && !totals[lo]) lo++;
  while (hi > lo && !totals[hi]) hi--;
  const hours = [];
  for (let h = lo; h <= hi; h++) hours.push(h);

  const max = Math.max(...zones.flatMap(z => hours.map(h => z.hour_hist[h])), 1);
  const head = `<div class="hz-row hz-head"><div class="hz-label"></div>`
    + hours.map(h => `<div class="hz-cell hz-hour">${String(h).padStart(2, '0')}</div>`).join('') + `</div>`;
  const body = zones.map(z => `<div class="hz-row">
      <div class="hz-label" title="${dlvEsc(z.name)} · ${z.orders} 单">${dlvEsc(z.name)}</div>`
    + hours.map(h => {
      const v = z.hour_hist[h];
      return `<div class="hz-cell" style="background:${v ? dlvRamp(v / max) : '#1c1e25'}" title="${dlvEsc(z.name)} ${String(h).padStart(2, '0')}:00 · ${v} 单"></div>`;
    }).join('') + `</div>`).join('');
  host.innerHTML = head + body;

  const foot = document.getElementById('hzFoot');
  if (foot) {
    let best = { v: -1 };
    zones.forEach(z => hours.forEach(h => {
      if (z.hour_hist[h] > best.v) best = { v: z.hour_hist[h], z: z.name, h };
    }));
    foot.textContent = best.v > 0
      ? `最密：${best.z} ${String(best.h).padStart(2, '0')}:00 · ${best.v} 单`
      : '—';
  }
}
