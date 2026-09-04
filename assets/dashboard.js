// ============================================================
// 配送作战台 / Delivery console
//
// A single-screen arrangement of the same data the 配送 page tells as a
// story. Nothing is recomputed here — every number comes out of
// window.DELIVERY_DATA exactly as analyze_delivery.py wrote it.
//
// The map machinery (DLVMAP, renderDeliveryMap, dlvSetFocus, the layer and
// metric chips, the side list) is reused wholesale from delivery.js, which is
// why the markup keeps that page's element ids. Only the panels around it are
// written again, denser: no section headers, no prose, numbers in mono, and
// every panel scrolls inside its own box so the grid never moves.
// ============================================================

(function () {
  'use strict';

  const D = () => window.DELIVERY_DATA;
  const esc = s => (typeof dlvEsc === 'function' ? dlvEsc(s) : String(s == null ? '' : s));
  const ramp = t => (typeof dlvRamp === 'function' ? dlvRamp(t) : '#e8b76d');
  const C = (typeof DLV !== 'undefined') ? DLV
    : { amber: '#e8b76d', amberBright: '#ffd897', cyan: '#6cc4d9', rose: '#d97a8a', axis: '#5d5b55' };

  // Jumping to the map from any panel. On the dashboard the map is already on
  // screen, so unlike the long page this must not scroll anything — it just
  // drills in and lets the eye travel.
  //
  // Every panel is a different view of the same suburbs, so a suburb picked in
  // one of them lights up in all of them. Without this the console is seven
  // charts that happen to share a page; with it, it is one instrument.
  function focusZone(name) {
    // DLVMAP is a `const` in delivery.js, so it is a lexical global and never
    // appears on `window` — reading it as window.DLVMAP yields undefined and
    // silently turns this toggle into a no-op.
    const cur = (typeof DLVMAP !== 'undefined') ? DLVMAP.focus : null;
    const next = (cur === name) ? null : name;
    if (typeof dlvSetFocus === 'function') dlvSetFocus(next);
    markFocus(next);
  }

  function markFocus(name) {
    document.querySelectorAll('[data-zone]').forEach(el => {
      el.classList.toggle('is-focused', !!name && el.dataset.zone === name);
    });
  }

  // The map's own polygons can also set the focus, and the panels have to
  // follow. dlvSetFocus is delivery.js's, so wrap it rather than edit it.
  function hookMapFocus() {
    if (typeof window.dlvSetFocus !== 'function' || window.__dashHooked) return;
    const inner = window.dlvSetFocus;
    window.__dashHooked = true;
    window.dlvSetFocus = function (name) {
      inner.apply(this, arguments);
      markFocus(name || null);
    };
  }

  // ============ top bar ============
  function renderStats() {
    const d = D();
    const host = document.getElementById('dashStats');
    if (!d || !host) return;
    const s = d.summary, c = d.chain || {}, v = d.validation || {}, fb = d.meta.flow_basis || {};
    const dir = c.direction || {};
    // Three groups, divided by a heavier rule: what the work produced, what it
    // cost, and how much of it to believe. Nine numbers in an undifferentiated
    // row is a wall; three groups of three is a sentence.
    const cards = [
      ['送达', s.orders, '单', ''],
      ['取餐', s.pickups, '次', ''],
      ['单 / 小时', s.orders_per_hour.toFixed(2), '', ''],
      ['在岗', s.hours.toFixed(0), 'h', ''],
      ['空驶占比', c.dead_share, '%', 'warn group'],
      ['要骑回市区', dir.inward_pct, '%', 'warn'],
      ['等红灯', s.light_min_per_hour, 'min/h', ''],
      ['好跑指数中位', medianFlow(), '', 'hot group'],
      ['送达召回率', v.recall_drop, '%', ''],
    ];
    const tips = {
      '空驶占比': `${c.dead_km_total} km 送完了还没接到下一单，一分钱不挣`,
      '要骑回市区': `这些空驶中位 ${dir.inward_km} km / ${dir.inward_min} min，是就地续单的三倍`,
      '好跑指数中位': `自由通行耗时 ÷ 实际耗时。100 = 全程跑出 ${fb.v_free_kmh} km/h`,
      '送达召回率': `对照 ${v.orders} 单真实订单记录，只算召回率`,
      '单 / 小时': `平均每 ${s.min_per_order} 分钟一单`,
    };
    host.innerHTML = cards.map(([label, val, unit, cls]) => `
      <div class="dash-stat ${cls}"${tips[label] ? ` title="${esc(tips[label])}"` : ''}>
        <i>${label}</i>
        <b>${val == null ? '—' : val}${unit ? `<u>${unit}</u>` : ''}</b>
      </div>`).join('');

    const note = document.getElementById('dashMapNote');
    if (note) {
      note.textContent = `${d.meta.shifts} 个班次 · ${d.meta.first} → ${d.meta.last}`;
    }
  }

  function medianFlow() {
    const zs = D().zones.filter(z => z.ranked && z.flow != null).map(z => z.flow).sort((a, b) => a - b);
    if (!zs.length) return null;
    return Math.round(zs[Math.floor(zs.length / 2)]);
  }

  // ============ zone ranking ============
  // Two things at once: the bar is the rideability score with its bootstrap
  // interval drawn inside it, and the row can be re-sorted to whichever
  // column the rider is actually asking about.
  const ZONE_MODES = {
    flow: { label: '好跑指数', get: z => z.flow, max: () => 100, fmt: v => v.toFixed(0) },
    jobs: { label: '活的数量', get: z => z.jobs, fmt: v => v },
    worth: { label: '值得去', get: z => z.worth, fmt: v => v.toFixed(1) },
    pickups: { label: '取餐次数', get: z => z.pickups, fmt: v => v },
    orders: { label: '送达次数', get: z => z.orders, fmt: v => v },
  };
  let zoneMode = 'flow';

  function renderZones() {
    const d = D();
    const host = document.getElementById('dashZones');
    if (!d || !host) return;
    const m = ZONE_MODES[zoneMode];
    const rows = d.zones.filter(z => z.ranked && m.get(z) != null)
      .sort((a, b) => m.get(b) - m.get(a));
    const max = m.max ? m.max() : Math.max(...rows.map(m.get), 1);
    // A tick at the middle of the pack. The flow bar runs a true 0-100 scale
    // — truncating it would exaggerate small gaps — so the median is what
    // makes "above or below average" readable at a glance.
    const sorted = rows.map(m.get).slice().sort((a, b) => a - b);
    const med = sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;

    const chips = Object.entries(ZONE_MODES).map(([k, v]) =>
      `<button class="dz-toggle${k === zoneMode ? ' active' : ''}" data-mode="${k}"
        style="${k === zoneMode ? 'color:var(--amber);border-color:var(--amber-dim)' : ''}">${v.label}</button>`).join('');

    host.innerHTML = `<div class="dz-legend"><span>按 ${m.label} 排</span>${chips}</div>`
      + rows.map(z => {
        const val = m.get(z);
        const w = (val / max) * 100;
        // Only the flow bar carries an interval; the counts are exact.
        const ci = (zoneMode === 'flow' && z.ci)
          ? `<span class="dz-ci" style="left:${z.ci[0]}%;width:${z.ci[1] - z.ci[0]}%"></span>` : '';
        const tick = med == null ? ''
          : `<span class="dz-med" style="left:${(med / max) * 100}%"></span>`;
        return `<div class="dz-row" data-zone="${esc(z.name)}" title="${esc(z.label)} · ${m.label} ${m.fmt(val)}${z.ci && zoneMode === 'flow' ? ` (90% 区间 ${z.ci[0]}–${z.ci[1]})` : ''} · ${z.shifts} 个班次 · ${z.km} km · 中位 ${med == null ? '—' : m.fmt(med)}">
          <span class="dz-name">${esc(z.label)}</span>
          <span class="dz-track"><span class="dz-fill" style="width:${w}%;background:${ramp(val / max)}"></span>${ci}${tick}</span>
          <span class="dz-val">${m.fmt(val)}</span>
        </div>`;
      }).join('');

    host.querySelectorAll('.dz-toggle').forEach(b => b.addEventListener('click', ev => {
      ev.stopPropagation();
      zoneMode = b.dataset.mode;
      renderZones();
    }));
    host.querySelectorAll('.dz-row').forEach(r =>
      r.addEventListener('click', () => focusZone(r.dataset.zone)));

    const note = document.getElementById('dashZonesNote');
    if (note) {
      const fb = d.meta.flow_basis || {};
      const hidden = d.zones.filter(z => !z.ranked && z.jobs > 0).length;
      note.textContent = `${rows.length} 区 · 另 ${hidden} 区样本不足`;
      note.title = `好跑指数的 90% bootstrap 区间宽度必须在 ${fb.max_ci_width} 分以内才上榜`;
    }
  }

  // ============ after the drop ============
  function renderChain() {
    const d = D();
    const host = document.getElementById('dashChain');
    if (!d || !d.chain || !host) return;
    const c = d.chain, dir = c.direction || {};
    const total = (dir.inward + dir.outward + dir.local) || 1;

    const dirs = [
      ['往回骑', dir.inward, C.rose, dir.inward_km, dir.inward_min],
      ['就地续上', dir.local, C.cyan, dir.local_km, dir.local_min],
      ['继续往外', dir.outward, C.amber, null, null],
    ].map(([label, n, col, km, min]) => `
      <div class="dc-dir">
        <div class="dc-dir-head">
          <span class="dc-dir-n" style="color:${col}">${Math.round(100 * n / total)}<em style="font-size:9px">%</em></span>
          <span class="dc-dir-label">${label}</span>
          <span class="dc-dir-cost">${km == null ? `${n} 段` : `${km} km / ${min} min`}</span>
        </div>
        <div class="dc-bar"><span style="width:${(n / total) * 100}%;background:${col}"></span></div>
      </div>`).join('');

    // The suburbs worth knowing by name: the ones that hand you the next job,
    // and the ones that make you ride back for it.
    const pool = d.zones.filter(z => z.as_drop && z.as_drop.legs >= 4);
    const traps = pool.filter(z => z.as_drop.back_pct >= 50)
      .sort((a, b) => b.as_drop.dead_km - a.as_drop.dead_km).slice(0, 5);
    const hubs = pool.filter(z => z.as_drop.back_pct < 50
        && (z.as_drop.same_pct >= 40 || z.as_drop.dead_km <= 0.8))
      .sort((a, b) => a.as_drop.dead_km - b.as_drop.dead_km).slice(0, 5);

    const row = (z, kind) => {
      const a = z.as_drop;
      return `<div class="dc-zone" data-zone="${esc(z.name)}" title="${esc(z.label)} · ${a.legs} 段空驶 · 同区续单 ${a.same_pct}% · 往回骑 ${a.back_pct}% · 常去 ${esc(a.next_zone || '—')}">
        <span class="dc-pill ${kind}">${kind === 'trap' ? '往回' : '接上'}</span>
        <b>${esc(z.label)}</b>
        <span class="dc-num">${a.dead_km} km · ${a.dead_min} min</span>
      </div>`;
    };

    host.innerHTML = dirs
      + (hubs.length ? `<div class="dc-split">落在这儿接得上</div>` + hubs.map(z => row(z, 'hub')).join('') : '')
      + (traps.length ? `<div class="dc-split">落在这儿要往回骑</div>` + traps.map(z => row(z, 'trap')).join('') : '')
      + `<div class="dc-split">空驶总账</div>`
      + `<div class="dt-line">全部里程的 <b>${c.dead_share}%</b> 花在送完了还没接到下一单的路上 ——
          <b>${c.dead_km_total} km</b> 不挣钱。往回骑那 ${dir.inward_pct}% 的中位代价是
          <em>${dir.inward_km} km / ${dir.inward_min} min</em>，就地续上只要 ${dir.local_km} km。</div>`;

    host.querySelectorAll('.dc-zone').forEach(r =>
      r.addEventListener('click', () => focusZone(r.dataset.zone)));
  }

  // ============ hour x zone ============
  function renderHours() {
    const d = D();
    const host = document.getElementById('dashHours');
    if (!d || !host) return;
    const zones = d.zones.filter(z => z.ranked && z.jobs >= 3).slice(0, 18);
    if (!zones.length) { host.innerHTML = '<div class="empty-range">样本不足</div>'; return; }

    const totals = d.summary.hour_totals || [];
    let lo = 0, hi = 23;
    while (lo < 23 && !totals[lo]) lo++;
    while (hi > lo && !totals[hi]) hi--;
    const hours = [];
    for (let h = lo; h <= hi; h++) hours.push(h);

    // Row-normalised: each suburb against its own busiest hour, so a quiet one
    // still shows *when* it is busy instead of just being dark.
    const head = `<div class="dh-row dh-head"><span class="dh-label"></span>`
      + hours.map(h => `<span class="dh-cell">${h % 2 === 0 ? String(h).padStart(2, '0') : ''}</span>`).join('')
      + `</div>`;
    const body = zones.map(z => {
      const rowMax = Math.max(...hours.map(h => z.hour_hist[h]), 1);
      return `<div class="dh-row" data-zone="${esc(z.name)}">
        <span class="dh-label" title="${esc(z.label)} · ${z.jobs} 次活">${esc(z.label)}</span>`
        + hours.map(h => {
          const v = z.hour_hist[h];
          return `<span class="dh-cell" style="background:${v ? ramp(v / rowMax) : '#1c1e25'}" title="${esc(z.label)} ${String(h).padStart(2, '0')}:00 · ${v} 次活"></span>`;
        }).join('') + `</div>`;
    }).join('');
    host.innerHTML = head + body;
    host.querySelectorAll('.dh-row[data-zone]').forEach(r =>
      r.addEventListener('click', () => focusZone(r.dataset.zone)));

    const note = document.getElementById('dashHoursNote');
    if (note) note.textContent = `峰值 ${String(d.summary.peak_hour).padStart(2, '0')}:00 · 每行各自归一`;
  }

  // ============ corridors ============
  function renderRoads() {
    const d = D();
    const host = document.getElementById('dashRoads');
    if (!d || !host) return;
    const rows = d.corridors.filter(c => c.passes >= 3)
      .sort((a, b) => b.lost_per_pass - a.lost_per_pass).slice(0, 14);
    const max = Math.max(...rows.map(r => r.lost_per_pass), 1);
    const seen = {};
    host.innerHTML = rows.map(c => {
      const n = (seen[c.zone] = (seen[c.zone] || 0) + 1);
      const label = n === 1 ? c.zone : `${c.zone} ${'②③④⑤⑥⑦⑧⑨'[n - 2] || n}`;
      return `<div class="dr-row" data-i="${c._i}">
        <div class="dr-top">
          <span class="dr-name">${esc(label)}</span>
          <span class="dr-metric">+${c.lost_per_pass}<span style="font-size:8px"> min/趟</span></span>
        </div>
        <div class="dr-bar"><span style="width:${(c.lost_per_pass / max) * 100}%;background:${C.rose}"></span></div>
        <div class="dr-meta">${c.passes} 班次 · ${c.med_speed} km/h · 红灯占 ${(c.light_share * 100).toFixed(0)}% · 上坡 ${c.grade_up}%</div>
      </div>`;
    }).join('');
    host.querySelectorAll('.dr-row').forEach(r => r.addEventListener('click', () => {
      if (typeof dlvFocusCorridor === 'function') dlvFocusCorridor('hard', +r.dataset.i);
    }));
  }

  // ============ ground truth ============
  function renderTruth() {
    const d = D();
    const host = document.getElementById('dashTruth');
    if (!d || !host) return;
    const v = d.validation;
    if (!v) { host.innerHTML = '<div class="empty-range">没有可对照的订单记录</div>'; return; }
    const cells = [
      ['送达召回', v.recall_drop, '%'],
      ['取餐召回', v.recall_pickup, '%'],
      ['区域判对', v.zone_pct, '%'],
      ['时间偏差', v.align_median_s, 's'],
    ].map(([label, val, unit]) => `
      <div class="dt-cell"><i>${label}</i><b>${val == null ? '—' : val}<u>${unit}</u></b></div>`).join('');

    host.innerHTML = `<div class="dt-grid">${cells}</div>`
      + `<div class="dt-line"><b>只有召回率。</b>对照的是三个平台里的一个（Uber，${v.orders} 单）。
          我判出的 ${v.total_drops} 个送达里只有 ${v.matched_drops} 个能在这份记录里找到，约
          <em>${v.platform_share_pct}%</em> —— 剩下的是熊猫和 DoorDash 的单，不是误判。</div>`
      + `<div class="dt-line"><b>对得很齐。</b>订单时间戳其实是取餐时刻；用「时间戳 + 时长」去对，
          送达停留的中位偏差只有 <em>${Math.abs(v.align_median_s)} 秒</em>。</div>`
      + `<div class="dt-line"><b>${100 - v.coverage_pct}% 对不上是因为没录。</b>
          ${v.orders - v.in_window} 单发生在手表没记录的时段，已从分母剔除。</div>`
      + `<div class="dt-line" style="color:var(--text-faint)">客户地址不在这个站的任何地方，也不在代码仓库里。</div>`;
  }


  // ============ 这单接不接 ============
  // The narrow console twin of the offer calculator on 配送. Same arithmetic
  // — it calls delivery.js's ofMinutes/ofNeeded rather than re-deriving the
  // fit — but no scatter: at this width a plot would be decoration, while
  // three sliders and a verdict are the thing you would actually reach for
  // mid-shift.
  const OFP = { amt: 8, ap: 2, km: 3, batched: false, target: 20 };


  // The 143 orders, sorted into what they earned per ridden kilometre. It is
  // the same axis the sliders move along, so the reader can see which band
  // the offer they are typing in would have landed in.
  function ofBandStrip(O) {
    if (!O.bands || !O.bands.length) return '';
    const max = Math.max(...O.bands.map(b => b.rate), 1);
    return `<div class="do-bands">
      <div class="do-bands-t">真实记录里，每骑一公里挣到</div>
      ${O.bands.map(b => `
        <div class="do-band">
          <span class="do-band-k">$${b.lo}${b.hi ? '–' + b.hi : '+'}</span>
          <span class="do-band-bar"><i style="width:${100 * b.rate / max}%"></i></span>
          <span class="do-band-r">$${b.rate}</span>
        </div>`).join('')}
    </div>`;
  }

  function renderOffer() {
    const d = D();
    const host = document.getElementById('dashOffer');
    if (!host) return;
    const O = d && d.offers;
    if (!O || typeof ofMinutes !== 'function') {
      host.innerHTML = '<div class="empty-range">没有可用的订单价格记录</div>';
      return;
    }
    const note = document.getElementById('dashOfferNote');
    if (note) note.textContent = `${O.n} 单拟合 · 实测 $${O.engaged_rate}/h`;

    host.innerHTML = `
      <div class="do-sliders">
        <label><span>单价<b id="doAmtV"></b></span><input type="range" id="doAmt" min="4" max="30" step="0.5" value="${OFP.amt}"></label>
        <label><span>去餐厅<b id="doApV"></b></span><input type="range" id="doAp" min="0" max="7" step="0.1" value="${OFP.ap}"></label>
        <label><span>送到客人<b id="doKmV"></b></span><input type="range" id="doKm" min="0.3" max="9" step="0.1" value="${OFP.km}"></label>
      </div>
      <div class="do-row">
        <label class="do-check"><input type="checkbox" id="doBatch"><span>拼单</span></label>
        <div class="do-targets" id="doTargets">
          ${[15, 18, 20, 22, 25].map(t => `<button data-t="${t}"${t === OFP.target ? ' class="on"' : ''}>$${t}</button>`).join('')}
        </div>
      </div>
      ${ofBandStrip(O)}
      <div class="do-out" id="doOut"></div>`;

    const paint = () => {
      const totK = OFP.ap + OFP.km;
      const mins = ofMinutes(O, OFP.ap, OFP.km, OFP.batched);
      const rate = OFP.amt / mins * 60;
      const need = ofNeeded(O, OFP.target, totK, OFP.batched);
      const gap = OFP.amt - need;
      const near = Math.abs(gap) < 1;
      const cls = near ? 'edge' : (gap > 0 ? 'take' : 'skip');
      document.getElementById('doAmtV').textContent = '$' + OFP.amt.toFixed(2);
      document.getElementById('doApV').textContent = OFP.ap.toFixed(1) + ' km';
      document.getElementById('doKmV').textContent = OFP.km.toFixed(1) + ' km';
      document.getElementById('doOut').innerHTML = `
        <div class="do-vd ${cls}"><b>${near ? '在线上' : (gap > 0 ? '接' : '别接')}</b><span>$${rate.toFixed(1)}<u>/h</u></span></div>
        <div class="do-math">
          骑 ${totK.toFixed(1)} km · ${mins.toFixed(0)} min<br>
          $${OFP.target}/h 的门槛是 <em>$${need.toFixed(2)}</em>，${gap >= 0 ? '多' : '差'} $${Math.abs(gap).toFixed(2)}
        </div>`;
    };
    const on = (id, key, num) => document.getElementById(id).addEventListener(
      num ? 'input' : 'change', e => { OFP[key] = num ? +e.target.value : e.target.checked; paint(); });
    on('doAmt', 'amt', true); on('doAp', 'ap', true); on('doKm', 'km', true);
    on('doBatch', 'batched', false);
    document.getElementById('doTargets').addEventListener('click', ev => {
      const b = ev.target.closest('button[data-t]');
      if (!b) return;
      OFP.target = +b.dataset.t;
      [...ev.currentTarget.children].forEach(c => c.classList.toggle('on', c === b));
      paint();
    });
    paint();
  }

  // ============ boot ============
  function boot() {
    if (!D()) return;
    renderStats();
    renderZones();
    renderChain();
    renderOffer();
    renderHours();
    renderRoads();
    renderTruth();
    if (typeof renderDeliveryMap === 'function') renderDeliveryMap();
    hookMapFocus();

    // The map is laid out by the grid, so Leaflet measures it before the
    // fonts and the panel widths settle. Nudge it once, then again on resize.
    const kick = () => {
      if (typeof DLVMAP !== 'undefined' && DLVMAP.map) DLVMAP.map.invalidateSize();
    };
    setTimeout(kick, 60);
    setTimeout(kick, 400);
    let t = null;
    window.addEventListener('resize', () => { clearTimeout(t); t = setTimeout(kick, 150); });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
