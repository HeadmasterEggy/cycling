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

function dlvData() {
  const D = window.DELIVERY_DATA || null;
  if (D && !D._indexed) {
    // Stable ids so the panel, the map and the corridor lists further down
    // the page can all point at the same feature after any amount of
    // filtering or re-sorting.
    D.hotspots.forEach((h, i) => { h._i = i; });
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
// One map, four layers that stack rather than replace each other, a panel
// wired to it in both directions, an hour scrubber, and a click-a-suburb
// drill-down. The old version swapped one layer at a time and refit the
// bounds on every switch, which threw away whatever you had zoomed into.

const DLVMAP = {
  map: null,
  panes: {},                 // kind -> L.LayerGroup
  refs: {},                  // "kind:id" -> leaflet layer
  items: { hotspots: [], zones: [], common: [], hard: [] },
  visible: { hotspots: true, zones: true, common: false, hard: false },
  panel: 'hotspots',
  hour: -1,                  // -1 = 全天
  focus: null,               // suburb name being drilled into
  selected: null,            // { kind, id }
  play: null,
  fitted: false,
};

const DLV_KIND_LABEL = { hotspots: '停车热点', zones: '区域单量', common: '最常走的路段', hard: '最难走的路段' };
const DLV_KIND_UNIT = { hotspots: '处', zones: '区', common: '段', hard: '段' };

// Hour filtering only makes sense for things counted per order. Corridors are
// aggregated over whole shifts, so the scrubber leaves them alone — said out
// loud under the slider rather than silently doing nothing.
const DLV_HOURLY = new Set(['hotspots', 'zones']);

function dlvHourCount(kind, item) {
  if (DLVMAP.hour < 0) return kind === 'zones' ? item.orders : item.visits;
  const hist = kind === 'zones' ? item.hour_hist : item.hours;
  return (hist && hist[DLVMAP.hour]) || 0;
}

// The lists behind each layer, after the hour scrubber and the suburb focus.
function dlvItems(kind) {
  const D = dlvData();
  if (!D) return [];
  const focus = DLVMAP.focus;
  if (kind === 'hotspots') {
    return D.hotspots.filter(h => (!focus || h.zone === focus) && dlvHourCount('hotspots', h) > 0);
  }
  if (kind === 'zones') {
    // Keep every polygon while focused — the neighbours are the context that
    // makes the focused one mean something — and dim them at draw time.
    return D.zones.filter(z => z.ring && (focus ? true : dlvHourCount('zones', z) > 0));
  }
  const pool = kind === 'hard'
    ? D.corridors.filter(c => c.passes >= 3).sort((a, b) => b.lost_per_pass - a.lost_per_pass).slice(0, 25)
    : [...D.corridors].sort((a, b) => b.passes - a.passes).slice(0, 25);
  return focus ? pool.filter(c => (c.zones || []).includes(focus)) : pool;
}

function dlvBaseStyle(kind, item, max) {
  if (kind === 'hotspots') {
    const v = dlvHourCount('hotspots', item);
    return { radius: 6 + Math.sqrt(v / max) * 18, color: DLV.amber, weight: 1.2,
             opacity: 0.9, fillColor: dlvRamp(v / max), fillOpacity: 0.45 };
  }
  if (kind === 'zones') {
    const v = dlvHourCount('zones', item);
    const focused = DLVMAP.focus === item.name;
    const muted = DLVMAP.focus && !focused;
    // The focused suburb trades fill for outline: a solid amber wash hid the
    // hotspot circles sitting inside it, which are the reason to drill in.
    return {
      color: focused ? DLV.amberBright : DLV.amber,
      weight: focused ? 2.5 : (muted ? 0.6 : 1),
      opacity: focused ? 0.95 : (muted ? 0.18 : 0.45),
      fillColor: v ? dlvRamp(v / max) : '#1c1e25',
      fillOpacity: focused ? 0.16 : (muted ? 0.05 : (v ? 0.32 : 0.1)),
      dashArray: focused ? null : undefined,
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
    if (base.weight != null) lift.weight = base.weight + (kind === 'hotspots' || kind === 'zones' ? 1.2 : 2.5);
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
  if (kind === 'hotspots' || kind === 'zones') {
    return Math.max(...items.map(i => dlvHourCount(kind, i)), 1);
  }
  const key = kind === 'hard' ? 'lost_per_pass' : 'passes';
  return Math.max(...items.map(i => i[key]), 1);
}

function dlvPopupHtml(kind, item) {
  if (kind === 'hotspots') {
    const v = dlvHourCount('hotspots', item);
    return `<b>${dlvEsc(item.zone || '未知区')}</b><br>`
      + (DLVMAP.hour >= 0 ? `${String(DLVMAP.hour).padStart(2, '0')}:00 停 ${v} 次<br>` : '')
      + `合计停 ${item.visits} 次 · ${item.shifts} 个班次<br>中位停留 ${item.dwell_med}s · 累计 ${item.dwell_total_min} min`;
  }
  if (kind === 'zones') {
    const v = dlvHourCount('zones', item);
    return `<b>${dlvEsc(item.name)}</b><br>`
      + (DLVMAP.hour >= 0 ? `${String(DLVMAP.hour).padStart(2, '0')}:00 有 ${v} 单<br>` : '')
      + `合计 ${item.orders} 单 · ${item.shifts} 个班次<br>好跑 ${item.flow} · 中位 ${item.med_speed} km/h<br>`
      + `<span class="dlv-pop-hint">点一下只看这个区</span>`;
  }
  return `<b>${dlvEsc(item.zone || '—')}</b><br>${item.passes} 个班次经过 · 约 ${item.len_m} m<br>`
    + `中位 ${item.med_speed} km/h · 停车占比 ${(item.stop_share * 100).toFixed(0)}% · 上坡 ${item.grade_up}%<br>`
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
    if (kind === 'hotspots') {
      layer = L.circleMarker([item.lat, item.lon], dlvBaseStyle(kind, item, max));
    } else if (kind === 'zones') {
      layer = L.polygon(item.ring.map(p => [p[1], p[0]]), dlvBaseStyle(kind, item, max));
    } else {
      layer = L.polyline(item.track, dlvBaseStyle(kind, item, max));
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
  dlvRedraw();
  dlvRenderFocusBar();
  if (name) {
    const layer = DLVMAP.refs[`zones:${(dlvData().zones.find(z => z.name === name) || {})._i}`];
    if (layer && DLVMAP.map) DLVMAP.map.fitBounds(layer.getBounds(), { padding: [40, 40] });
  } else {
    dlvFitAll();
  }
}

function dlvRenderFocusBar() {
  const bar = document.getElementById('dlvFocusBar');
  if (!bar) return;
  if (!DLVMAP.focus) { bar.hidden = true; bar.innerHTML = ''; return; }
  const z = dlvData().zones.find(s => s.name === DLVMAP.focus);
  if (!z) { bar.hidden = true; return; }
  const peak = z.hour_hist.indexOf(Math.max(...z.hour_hist));
  const stats = [
    ['单量', z.orders],
    ['出现班次', z.shifts],
    ['单/小时', z.ranked ? z.orders_per_hour.toFixed(2) : '样本少'],
    ['中位速度', `${z.med_speed} km/h`],
    ['红灯/km', z.waits_per_km.toFixed(2)],
    ['爬升', `${z.climb_per_km} m/km`],
    ['好跑指数', z.flow.toFixed(0)],
    ['最密时段', Math.max(...z.hour_hist) ? `${String(peak).padStart(2, '0')}:00` : '—'],
  ];
  bar.hidden = false;
  bar.innerHTML = `<div class="dlv-focus-name">${dlvEsc(z.name)}<span class="dlv-focus-lga">${dlvEsc(z.lga || '')}</span></div>`
    + `<div class="dlv-focus-stats">${stats.map(([k, v]) => `<span><em>${k}</em>${dlvEsc(v)}</span>`).join('')}</div>`
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
  if (title) title.textContent = DLV_KIND_LABEL[kind] + (DLVMAP.focus ? ` · ${DLVMAP.focus}` : '');
  if (!list) return;

  const shown = kind === 'zones'
    ? items.filter(z => dlvHourCount('zones', z) > 0)
        .sort((a, b) => dlvHourCount('zones', b) - dlvHourCount('zones', a))
    : items;
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
    if (kind === 'hotspots') {
      main = item.zone || '未知区';
      meta = DLVMAP.hour >= 0
        ? `${String(DLVMAP.hour).padStart(2, '0')}:00 停 ${dlvHourCount('hotspots', item)} 次 · 合计 ${item.visits} 次`
        : `${item.visits} 次 · ${item.shifts} 班次 · 中位 ${item.dwell_med}s`;
    } else if (kind === 'zones') {
      main = item.name;
      meta = `${dlvHourCount('zones', item)} 单 · 好跑 ${item.flow} · ${item.med_speed} km/h`;
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
}

function dlvFitAll() {
  if (!DLVMAP.map) return;
  const pts = [];
  Object.keys(DLVMAP.items).forEach(kind => {
    (DLVMAP.items[kind] || []).forEach(item => {
      if (kind === 'hotspots') pts.push([item.lat, item.lon]);
      else if (kind === 'zones') item.ring.forEach(p => pts.push([p[1], p[0]]));
      else item.track.forEach(p => pts.push(p));
    });
  });
  if (pts.length) DLVMAP.map.fitBounds(pts, { padding: [24, 24] });
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

function dlvTogglePlay() {
  const btn = document.getElementById('dlvPlay');
  if (DLVMAP.play) {
    clearInterval(DLVMAP.play);
    DLVMAP.play = null;
    if (btn) { btn.textContent = '▶'; btn.classList.remove('playing'); }
    return;
  }
  // Step only through hours that actually have orders — most of the night is
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
  ['zones', 'common', 'hard', 'hotspots'].forEach(kind => {
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
