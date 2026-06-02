// ============================================================
// Recovery page renders — sleep / HRV / RHR / respiration / SpO2
// ============================================================
// All five functions read from window.HEALTH_DATA.daily (filtered by
// withRange() in app.js boot) and draw into #hrvChart, #rhrChart,
// #respChart, #sleepChart, #recoveryComposite.
//
// Two of the dense timelines (#hrvChart and #sleepChart) support a
// click-and-drag brush — selecting a sub-range updates a stats box.
// Brush state is local to the chart and lives until the chart re-renders
// (e.g. range-filter changes).

(function () {
  'use strict';

  // ----- shared helpers --------------------------------------------------
  const COL = {
    amber: '#e8b76d', amberDim: 'rgba(232,183,109,0.4)', amberFaint: 'rgba(232,183,109,0.18)',
    cyan: '#6cc4d9', cyanDim: 'rgba(108,196,217,0.4)', cyanFaint: 'rgba(108,196,217,0.14)',
    rose: '#d97a8a', roseDim: 'rgba(217,122,138,0.4)', roseFaint: 'rgba(217,122,138,0.14)',
    text: '#ebe8e1', textDim: '#908d85', textFaint: '#5d5b55', border: '#2a2c35',
  };

  const ts = d => new Date(d).getTime();
  const fmtDate = t => new Date(t).toISOString().slice(0, 10);

  // 7-day rolling mean over a sparse series of {t, v}.
  function rollingMean(points, windowDays) {
    const out = [];
    const ms = windowDays * 86400000;
    for (let i = 0; i < points.length; i++) {
      const cutoff = points[i].t - ms;
      let sum = 0, n = 0;
      for (let j = i; j >= 0 && points[j].t >= cutoff; j--) {
        sum += points[j].v;
        n++;
      }
      out.push(n ? sum / n : null);
    }
    return out;
  }

  // Month tick generator — emits {t, label} for each month boundary in range.
  function monthTicks(tMin, tMax) {
    const out = [];
    const d = new Date(tMin);
    d.setDate(1); d.setHours(0, 0, 0, 0);
    while (d.getTime() <= tMax) {
      if (d.getTime() >= tMin) {
        out.push({ t: d.getTime(), label: `${String(d.getFullYear()).slice(2)}-${String(d.getMonth() + 1).padStart(2, '0')}` });
      }
      d.setMonth(d.getMonth() + 1);
    }
    return out;
  }

  // Module-scope active brush so window listeners are registered ONCE rather
  // than per render. Each render swaps the active config; the global listeners
  // route move/end events to whichever brush is currently dragging.
  let _activeBrush = null;
  function _installBrushListeners() {
    if (_installBrushListeners.done) return;
    _installBrushListeners.done = true;
    const moveHandler = e => {
      if (!_activeBrush || !_activeBrush.dragging) return;
      const pt = _activeBrush.eventToX(e);
      if (pt == null) return;
      const { startX, brushRect } = _activeBrush;
      const lo = Math.min(startX, pt), hi = Math.max(startX, pt);
      brushRect.setAttribute('x', lo);
      brushRect.setAttribute('width', Math.max(0, hi - lo));
      if (e.cancelable) e.preventDefault();
    };
    const endHandler = e => {
      if (!_activeBrush || !_activeBrush.dragging) return;
      const a = _activeBrush;
      a.dragging = false;
      const pt = a.eventToX(e) ?? a.lastX;
      const lo = Math.min(a.startX, pt), hi = Math.max(a.startX, pt);
      if (hi - lo < 8) {
        a.brushRect.style.display = 'none';
        a.onSelect(null);
        return;
      }
      a.onSelect({ fromT: a.X_to_T(lo), toT: a.X_to_T(hi), fromX: lo, toX: hi });
    };
    window.addEventListener('mousemove', moveHandler);
    window.addEventListener('mouseup', endHandler);
    window.addEventListener('touchmove', moveHandler, { passive: false });
    window.addEventListener('touchend', endHandler);
    window.addEventListener('touchcancel', endHandler);
  }

  // Generic brush helper. Wires `hot` (a transparent <rect>) for mousedown +
  // touchstart; window-level move/end listeners (installed once) carry the
  // drag. Calls onSelect({fromT, toT, fromX, toX}) — or onSelect(null) for a
  // dismissed selection. Mobile-friendly.
  function attachBrush(svg, hot, brushRect, X_to_T, onSelect) {
    _installBrushListeners();
    function pageToSvgX(clientX) {
      const r = svg.getBoundingClientRect();
      const vb = svg.viewBox.baseVal;
      return ((clientX - r.left) / r.width) * vb.width;
    }
    function eventToX(e) {
      const cx = e.touches && e.touches[0] ? e.touches[0].clientX
               : e.changedTouches && e.changedTouches[0] ? e.changedTouches[0].clientX
               : e.clientX;
      if (cx == null) return null;
      const x = pageToSvgX(cx);
      if (_activeBrush) _activeBrush.lastX = x;
      return x;
    }
    function startDrag(e) {
      const x = eventToX(e);
      if (x == null) return;
      _activeBrush = {
        dragging: true, startX: x, lastX: x,
        brushRect, X_to_T, onSelect, eventToX,
      };
      brushRect.setAttribute('x', x);
      brushRect.setAttribute('width', 0);
      brushRect.style.display = '';
      if (e.cancelable) e.preventDefault();
    }
    hot.addEventListener('mousedown', startDrag);
    hot.addEventListener('touchstart', startDrag, { passive: false });
  }

  // Take a list of {t, v} points and a [fromT, toT] window — return stats.
  function windowStats(points, fromT, toT) {
    const sub = points.filter(p => p.t >= fromT && p.t <= toT);
    if (!sub.length) return null;
    const vs = sub.map(p => p.v);
    const mean = vs.reduce((a, b) => a + b, 0) / vs.length;
    const min = Math.min(...vs), max = Math.max(...vs);
    return { mean, min, max, n: sub.length, fromT, toT };
  }

  // ----- HRV Recovery ----------------------------------------------------
  // Daily HRV with 7-day rolling mean. Healthy band 40-60ms shaded. Ride
  // days marked with a vertical orange tick at the top. Brushable.
  window.renderHrvRecovery = function () {
    const H = window.HEALTH_DATA;
    const host = document.getElementById('hrvChart');
    const statsBox = document.getElementById('hrvStats');
    const brushSummary = document.getElementById('hrvBrushSummary');
    if (!H || !H.daily || !host) return;

    const points = H.daily
      .filter(d => d.hrv != null && d.hrv > 0)
      .map(d => ({ t: ts(d.date), v: d.hrv, date: d.date }));
    if (!points.length) {
      host.innerHTML = '<text x="50%" y="50%" text-anchor="middle" fill="#5d5b55" font-family="JetBrains Mono" font-size="12">这个时间段没有 HRV 数据</text>';
      if (statsBox) statsBox.innerHTML = '';
      if (brushSummary) brushSummary.textContent = '—';
      return;
    }

    const W = 900, Ht = 300, padL = 52, padR = 24, padT = 28, padB = 38;
    const cw = W - padL - padR, ch = Ht - padT - padB;
    host.setAttribute('viewBox', `0 0 ${W} ${Ht}`);

    const tMin = points[0].t, tMax = points[points.length - 1].t;
    const vAll = points.map(p => p.v);
    const vMin = Math.floor(Math.min(...vAll) / 10) * 10;
    const vMax = Math.ceil(Math.max(...vAll) / 10) * 10;
    const X = t => padL + ((t - tMin) / Math.max(1, tMax - tMin)) * cw;
    const Y = v => padT + (1 - (v - vMin) / Math.max(1, vMax - vMin)) * ch;
    const Xinv = x => tMin + ((x - padL) / cw) * (tMax - tMin);

    const roll = rollingMean(points, 7);

    let svg = '';

    // healthy band 40-60ms (typical adult HRV)
    const bandLo = Math.max(40, vMin), bandHi = Math.min(60, vMax);
    if (bandHi > bandLo) {
      svg += `<rect x="${padL}" y="${Y(bandHi)}" width="${cw}" height="${Y(bandLo)-Y(bandHi)}" fill="${COL.cyanFaint}"/>`;
      svg += `<text x="${padL+6}" y="${Y(bandHi)+12}" font-family="JetBrains Mono" font-size="9" fill="${COL.cyanDim}">健康区间 40–60ms</text>`;
    }

    // y-axis grid + labels
    const step = (vMax - vMin) <= 40 ? 10 : 20;
    for (let v = vMin; v <= vMax; v += step) {
      svg += `<line x1="${padL}" y1="${Y(v)}" x2="${W-padR}" y2="${Y(v)}" stroke="${COL.border}" stroke-width="0.5" stroke-dasharray="2 4"/>`;
      svg += `<text x="${padL-8}" y="${Y(v)+3}" text-anchor="end" font-family="JetBrains Mono" font-size="9" fill="${COL.textFaint}">${v}</text>`;
    }
    svg += `<text x="14" y="${padT+ch/2}" text-anchor="middle" font-family="JetBrains Mono" font-size="9" fill="${COL.cyan}" transform="rotate(-90 14 ${padT+ch/2})">HRV ms</text>`;

    // month ticks
    monthTicks(tMin, tMax).forEach((m, i, arr) => {
      const x = X(m.t);
      svg += `<line x1="${x}" y1="${padT+ch}" x2="${x}" y2="${padT+ch+4}" stroke="${COL.border}" stroke-width="0.5"/>`;
      if (arr.length <= 12 || i % 2 === 0) {
        svg += `<text x="${x}" y="${padT+ch+18}" text-anchor="middle" font-family="JetBrains Mono" font-size="9" fill="${COL.textFaint}">${m.label}</text>`;
      }
    });

    // ride-day markers (orange tick at top of chart)
    const rideDays = new Set((H.workouts || []).map(w => w.date));
    rideDays.forEach(d => {
      const t = ts(d);
      if (t < tMin || t > tMax) return;
      const x = X(t);
      svg += `<line x1="${x}" y1="${padT}" x2="${x}" y2="${padT+6}" stroke="${COL.amber}" stroke-width="1.2" opacity="0.8"/>`;
    });

    // raw daily dots
    points.forEach(p => {
      svg += `<circle cx="${X(p.t)}" cy="${Y(p.v)}" r="1.3" fill="rgba(108,196,217,0.45)"/>`;
    });

    // 7-day rolling line
    let line = '';
    points.forEach((p, i) => {
      if (roll[i] == null) return;
      line += `${i === 0 ? 'M' : 'L'} ${X(p.t).toFixed(2)} ${Y(roll[i]).toFixed(2)} `;
    });
    svg += `<path d="${line}" fill="none" stroke="${COL.cyan}" stroke-width="1.6" opacity="0.95"/>`;

    // brush + crosshair layer
    svg += `<rect id="hrvBrushRect" x="${padL}" y="${padT}" width="0" height="${ch}" fill="rgba(232,183,109,0.12)" stroke="${COL.amberDim}" stroke-width="0.5" style="display:none;pointer-events:none;"/>`;
    svg += `<line id="hrvCrossLine" x1="${padL}" x2="${padL}" y1="${padT}" y2="${padT+ch}" stroke="${COL.amberDim}" stroke-width="0.8" stroke-dasharray="3 3" style="display:none;pointer-events:none;"/>`;
    svg += `<text id="hrvCrossText" font-family="JetBrains Mono" font-size="10" fill="${COL.text}" style="display:none;pointer-events:none;"></text>`;
    svg += `<rect id="hrvHot" x="${padL}" y="${padT}" width="${cw}" height="${ch}" fill="transparent" style="cursor:crosshair"/>`;

    host.innerHTML = svg;

    // global stats
    const all = points.map(p => p.v);
    const mean = all.reduce((a, b) => a + b, 0) / all.length;
    const low = all.filter(v => v < 40).length;
    const high = all.filter(v => v > 60).length;
    const rec = roll[roll.length - 1];
    if (statsBox) {
      statsBox.innerHTML = `
        <div class="recovery-stat"><div class="rs-label">Days · 天数</div><div class="rs-value">${points.length}</div></div>
        <div class="recovery-stat"><div class="rs-label">Mean · 平均</div><div class="rs-value">${mean.toFixed(1)}<small>ms</small></div></div>
        <div class="recovery-stat"><div class="rs-label">7-day · 最近</div><div class="rs-value">${rec != null ? rec.toFixed(1) : '—'}<small>ms</small></div></div>
        <div class="recovery-stat"><div class="rs-label">Range · 区间</div><div class="rs-value">${Math.min(...all).toFixed(0)}–${Math.max(...all).toFixed(0)}<small>ms</small></div></div>
        <div class="recovery-stat"><div class="rs-label">Below 40 · 偏低</div><div class="rs-value">${low}<small>天</small></div></div>
        <div class="recovery-stat"><div class="rs-label">Above 60 · 偏高</div><div class="rs-value">${high}<small>天</small></div></div>
      `;
    }
    if (brushSummary) brushSummary.innerHTML = '拖动选区查看子区间统计 · drag to brush a window';

    // hover crosshair
    const hot = host.querySelector('#hrvHot');
    const cline = host.querySelector('#hrvCrossLine');
    const ctext = host.querySelector('#hrvCrossText');
    const brushRect = host.querySelector('#hrvBrushRect');

    function pageToVbX(clientX) {
      const r = host.getBoundingClientRect();
      const vb = host.viewBox.baseVal;
      return ((clientX - r.left) / r.width) * vb.width;
    }

    hot.addEventListener('mousemove', e => {
      const x = pageToVbX(e.clientX);
      const t = Xinv(x);
      // find nearest data point
      let nearest = points[0], best = Infinity;
      for (const p of points) {
        const d = Math.abs(p.t - t);
        if (d < best) { best = d; nearest = p; }
      }
      cline.setAttribute('x1', X(nearest.t));
      cline.setAttribute('x2', X(nearest.t));
      cline.style.display = '';
      const tx = X(nearest.t) > W - 200 ? X(nearest.t) - 12 : X(nearest.t) + 8;
      const anchor = X(nearest.t) > W - 200 ? 'end' : 'start';
      ctext.setAttribute('x', tx);
      ctext.setAttribute('y', padT + 14);
      ctext.setAttribute('text-anchor', anchor);
      ctext.textContent = `${nearest.date} · ${nearest.v.toFixed(1)} ms`;
      ctext.style.display = '';
    });
    hot.addEventListener('mouseleave', () => {
      cline.style.display = 'none';
      ctext.style.display = 'none';
    });

    attachBrush(host, hot, brushRect, Xinv, sel => {
      if (!sel) {
        if (brushSummary) brushSummary.innerHTML = '拖动选区查看子区间统计 · drag to brush a window';
        return;
      }
      const s = windowStats(points, sel.fromT, sel.toT);
      if (!s || !brushSummary) return;
      const span = Math.round((s.toT - s.fromT) / 86400000) + 1;
      brushSummary.innerHTML = `
        <span class="hrv-brush-label">选区 · brushed</span>
        <strong>${fmtDate(s.fromT)} → ${fmtDate(s.toT)}</strong>
        · ${span} 天 · ${s.n} 测量 ·
        平均 <strong style="color:var(--cyan)">${s.mean.toFixed(1)}</strong> ms
        · ${s.min.toFixed(0)}–${s.max.toFixed(0)} ms
      `;
    });
  };

  // ----- Resting HR Trend ------------------------------------------------
  // Daily RHR with 7-day rolling. Reference shows "before deliveries" vs
  // "delivery period" mean — captures training effect on autonomic tone.
  window.renderRestingHrTrend = function () {
    const H = window.HEALTH_DATA;
    const host = document.getElementById('rhrChart');
    const stats = document.getElementById('rhrStats');
    if (!H || !H.daily || !host) return;

    const points = H.daily
      .filter(d => d.resting_hr && d.resting_hr > 30)
      .map(d => ({ t: ts(d.date), v: d.resting_hr, date: d.date }));
    if (!points.length) {
      host.innerHTML = '<text x="50%" y="50%" text-anchor="middle" fill="#5d5b55" font-family="JetBrains Mono" font-size="12">这个时间段没有静息心率</text>';
      if (stats) stats.innerHTML = '';
      return;
    }

    const W = 900, Ht = 260, padL = 52, padR = 24, padT = 24, padB = 38;
    const cw = W - padL - padR, ch = Ht - padT - padB;
    host.setAttribute('viewBox', `0 0 ${W} ${Ht}`);

    const tMin = points[0].t, tMax = points[points.length - 1].t;
    const vMin = Math.max(40, Math.floor(Math.min(...points.map(p => p.v)) / 5) * 5 - 5);
    const vMax = Math.ceil(Math.max(...points.map(p => p.v)) / 5) * 5 + 5;
    const X = t => padL + ((t - tMin) / Math.max(1, tMax - tMin)) * cw;
    const Y = v => padT + (1 - (v - vMin) / Math.max(1, vMax - vMin)) * ch;

    let svg = '';

    // y grid
    for (let v = vMin; v <= vMax; v += 10) {
      svg += `<line x1="${padL}" y1="${Y(v)}" x2="${W-padR}" y2="${Y(v)}" stroke="${COL.border}" stroke-width="0.5" stroke-dasharray="2 4"/>`;
      svg += `<text x="${padL-8}" y="${Y(v)+3}" text-anchor="end" font-family="JetBrains Mono" font-size="9" fill="${COL.textFaint}">${v}</text>`;
    }
    svg += `<text x="14" y="${padT+ch/2}" text-anchor="middle" font-family="JetBrains Mono" font-size="9" fill="${COL.rose}" transform="rotate(-90 14 ${padT+ch/2})">Resting HR bpm</text>`;

    // month ticks
    monthTicks(tMin, tMax).forEach((m, i, arr) => {
      const x = X(m.t);
      svg += `<line x1="${x}" y1="${padT+ch}" x2="${x}" y2="${padT+ch+4}" stroke="${COL.border}" stroke-width="0.5"/>`;
      if (arr.length <= 12 || i % 2 === 0) {
        svg += `<text x="${x}" y="${padT+ch+18}" text-anchor="middle" font-family="JetBrains Mono" font-size="9" fill="${COL.textFaint}">${m.label}</text>`;
      }
    });

    // raw dots
    points.forEach(p => {
      svg += `<circle cx="${X(p.t)}" cy="${Y(p.v)}" r="1.2" fill="rgba(217,122,138,0.35)"/>`;
    });

    // rolling area + line
    const roll = rollingMean(points, 7);
    let line = '', area = '';
    points.forEach((p, i) => {
      if (roll[i] == null) return;
      const x = X(p.t), y = Y(roll[i]);
      line += `${line ? 'L' : 'M'} ${x.toFixed(2)} ${y.toFixed(2)} `;
      if (!area) area += `M ${x.toFixed(2)} ${padT+ch} L ${x.toFixed(2)} ${y.toFixed(2)} `;
      else area += `L ${x.toFixed(2)} ${y.toFixed(2)} `;
    });
    if (area) area += `L ${X(points[points.length-1].t).toFixed(2)} ${padT+ch} Z`;
    svg += `<path d="${area}" fill="${COL.roseFaint}"/>`;
    svg += `<path d="${line}" fill="none" stroke="${COL.rose}" stroke-width="1.6" opacity="0.95"/>`;

    host.innerHTML = svg;

    if (stats) {
      const all = points.map(p => p.v);
      const mean = all.reduce((a, b) => a + b, 0) / all.length;
      const recent = points.slice(-14);
      const recentMean = recent.length ? recent.reduce((a, b) => a + b.v, 0) / recent.length : 0;
      const first14 = points.slice(0, 14);
      const firstMean = first14.length ? first14.reduce((a, b) => a + b.v, 0) / first14.length : 0;
      const delta = recentMean - firstMean;
      const dir = delta < 0 ? '↓' : '↑';
      const dirCol = delta < 0 ? 'var(--cyan)' : 'var(--rose)';
      stats.innerHTML = `
        <div class="recovery-stat"><div class="rs-label">Days · 天数</div><div class="rs-value">${points.length}</div></div>
        <div class="recovery-stat"><div class="rs-label">Mean · 平均</div><div class="rs-value">${mean.toFixed(1)}<small>bpm</small></div></div>
        <div class="recovery-stat"><div class="rs-label">First 14d · 初期</div><div class="rs-value">${firstMean.toFixed(1)}<small>bpm</small></div></div>
        <div class="recovery-stat"><div class="rs-label">Last 14d · 近期</div><div class="rs-value">${recentMean.toFixed(1)}<small>bpm</small></div></div>
        <div class="recovery-stat"><div class="rs-label">Δ · 变化</div><div class="rs-value" style="color:${dirCol}">${dir}${Math.abs(delta).toFixed(1)}<small>bpm</small></div></div>
        <div class="recovery-stat"><div class="rs-label">Range · 区间</div><div class="rs-value">${Math.min(...all)}–${Math.max(...all)}<small>bpm</small></div></div>
      `;
    }
  };

  // ----- Respiration + SpO2 ----------------------------------------------
  // Resp rate line + SpO2 inline mini-track. The two metrics live on
  // different scales — drawn as two stacked rows in one chart.
  window.renderRespRateBand = function () {
    const H = window.HEALTH_DATA;
    const host = document.getElementById('respChart');
    const stats = document.getElementById('respStats');
    if (!H || !H.daily || !host) return;

    const respPts = H.daily.filter(d => d.resp_rate && d.resp_rate > 0)
      .map(d => ({ t: ts(d.date), v: d.resp_rate, date: d.date }));
    const spo2Pts = H.daily.filter(d => d.spo2 && d.spo2 > 0)
      .map(d => ({ t: ts(d.date), v: d.spo2 * 100, date: d.date }));

    if (!respPts.length && !spo2Pts.length) {
      host.innerHTML = '<text x="50%" y="50%" text-anchor="middle" fill="#5d5b55" font-family="JetBrains Mono" font-size="12">这个时间段没有呼吸 / SpO₂ 数据</text>';
      if (stats) stats.innerHTML = '';
      return;
    }

    const W = 900, Ht = 280, padL = 56, padR = 56, padT = 22, padB = 42;
    const cw = W - padL - padR, ch = Ht - padT - padB;
    const respRow = { y0: padT, y1: padT + ch * 0.5 };
    const spo2Row = { y0: padT + ch * 0.58, y1: padT + ch };
    host.setAttribute('viewBox', `0 0 ${W} ${Ht}`);

    const allTs = [...respPts.map(p => p.t), ...spo2Pts.map(p => p.t)];
    const tMin = Math.min(...allTs), tMax = Math.max(...allTs);
    const X = t => padL + ((t - tMin) / Math.max(1, tMax - tMin)) * cw;

    let svg = '';

    // resp scale
    if (respPts.length) {
      const vMin = Math.floor(Math.min(...respPts.map(p => p.v)) - 1);
      const vMax = Math.ceil(Math.max(...respPts.map(p => p.v)) + 1);
      const Y = v => respRow.y1 - ((v - vMin) / Math.max(1, vMax - vMin)) * (respRow.y1 - respRow.y0);

      svg += `<text x="${padL-8}" y="${respRow.y0+8}" text-anchor="end" font-family="JetBrains Mono" font-size="9" fill="${COL.textFaint}">${vMax}</text>`;
      svg += `<text x="${padL-8}" y="${respRow.y1+4}" text-anchor="end" font-family="JetBrains Mono" font-size="9" fill="${COL.textFaint}">${vMin}</text>`;
      svg += `<text x="14" y="${(respRow.y0+respRow.y1)/2}" text-anchor="middle" font-family="JetBrains Mono" font-size="9" fill="${COL.amber}" transform="rotate(-90 14 ${(respRow.y0+respRow.y1)/2})">Resp /min</text>`;
      svg += `<line x1="${padL}" y1="${respRow.y1}" x2="${W-padR}" y2="${respRow.y1}" stroke="${COL.border}" stroke-width="0.5"/>`;

      respPts.forEach(p => {
        svg += `<circle cx="${X(p.t)}" cy="${Y(p.v)}" r="1.1" fill="rgba(232,183,109,0.32)"/>`;
      });
      const roll = rollingMean(respPts, 7);
      let line = '';
      respPts.forEach((p, i) => {
        if (roll[i] == null) return;
        line += `${line ? 'L' : 'M'} ${X(p.t).toFixed(2)} ${Y(roll[i]).toFixed(2)} `;
      });
      svg += `<path d="${line}" fill="none" stroke="${COL.amber}" stroke-width="1.4" opacity="0.95"/>`;
    }

    // spo2 scale
    if (spo2Pts.length) {
      const vMin = Math.floor(Math.min(...spo2Pts.map(p => p.v)));
      const vMax = Math.ceil(Math.max(...spo2Pts.map(p => p.v)));
      const Y = v => spo2Row.y1 - ((v - vMin) / Math.max(1, vMax - vMin)) * (spo2Row.y1 - spo2Row.y0);

      svg += `<text x="${padL-8}" y="${spo2Row.y0+8}" text-anchor="end" font-family="JetBrains Mono" font-size="9" fill="${COL.textFaint}">${vMax}%</text>`;
      svg += `<text x="${padL-8}" y="${spo2Row.y1+4}" text-anchor="end" font-family="JetBrains Mono" font-size="9" fill="${COL.textFaint}">${vMin}%</text>`;
      svg += `<text x="14" y="${(spo2Row.y0+spo2Row.y1)/2}" text-anchor="middle" font-family="JetBrains Mono" font-size="9" fill="${COL.cyan}" transform="rotate(-90 14 ${(spo2Row.y0+spo2Row.y1)/2})">SpO₂ %</text>`;
      svg += `<line x1="${padL}" y1="${spo2Row.y1}" x2="${W-padR}" y2="${spo2Row.y1}" stroke="${COL.border}" stroke-width="0.5"/>`;

      spo2Pts.forEach(p => {
        const col = p.v < 95 ? COL.rose : COL.cyan;
        svg += `<circle cx="${X(p.t)}" cy="${Y(p.v)}" r="1.6" fill="${col}" opacity="0.7"/>`;
      });
    }

    // month ticks
    monthTicks(tMin, tMax).forEach((m, i, arr) => {
      const x = X(m.t);
      svg += `<line x1="${x}" y1="${padT+ch}" x2="${x}" y2="${padT+ch+4}" stroke="${COL.border}" stroke-width="0.5"/>`;
      if (arr.length <= 12 || i % 2 === 0) {
        svg += `<text x="${x}" y="${padT+ch+18}" text-anchor="middle" font-family="JetBrains Mono" font-size="9" fill="${COL.textFaint}">${m.label}</text>`;
      }
    });

    host.innerHTML = svg;

    if (stats) {
      const respMean = respPts.length ? respPts.reduce((a, b) => a + b.v, 0) / respPts.length : 0;
      const spo2Mean = spo2Pts.length ? spo2Pts.reduce((a, b) => a + b.v, 0) / spo2Pts.length : 0;
      const spo2Low = spo2Pts.filter(p => p.v < 95).length;
      stats.innerHTML = `
        <div class="recovery-stat"><div class="rs-label">Resp days · 呼吸天</div><div class="rs-value">${respPts.length}</div></div>
        <div class="recovery-stat"><div class="rs-label">Resp mean · 平均</div><div class="rs-value">${respMean.toFixed(1)}<small>/min</small></div></div>
        <div class="recovery-stat"><div class="rs-label">SpO₂ days · 血氧天</div><div class="rs-value">${spo2Pts.length}</div></div>
        <div class="recovery-stat"><div class="rs-label">SpO₂ mean · 平均</div><div class="rs-value">${spo2Mean.toFixed(1)}<small>%</small></div></div>
        <div class="recovery-stat"><div class="rs-label">SpO₂ &lt; 95% · 偏低</div><div class="rs-value">${spo2Low}<small>天</small></div></div>
      `;
    }
  };

  // ----- Sleep Story -----------------------------------------------------
  // Sleep duration timeline + reference 7-9h band + histogram. Brushable.
  // Outlier filter: cap at 14h since Apple Health sometimes double-counts.
  window.renderSleepStory = function () {
    const H = window.HEALTH_DATA;
    const host = document.getElementById('sleepChart');
    const distHost = document.getElementById('sleepDist');
    const stats = document.getElementById('sleepStats');
    const brushSummary = document.getElementById('sleepBrushSummary');
    if (!H || !H.daily || !host) return;

    const points = H.daily
      .filter(d => d.sleep_h && d.sleep_h > 0 && d.sleep_h < 14)
      .map(d => ({ t: ts(d.date), v: d.sleep_h, date: d.date }));
    if (!points.length) {
      host.innerHTML = '<text x="50%" y="50%" text-anchor="middle" fill="#5d5b55" font-family="JetBrains Mono" font-size="12">这个时间段没有睡眠数据</text>';
      if (distHost) distHost.innerHTML = '';
      if (stats) stats.innerHTML = '';
      if (brushSummary) brushSummary.textContent = '—';
      return;
    }

    const W = 900, Ht = 300, padL = 50, padR = 24, padT = 22, padB = 38;
    const cw = W - padL - padR, ch = Ht - padT - padB;
    host.setAttribute('viewBox', `0 0 ${W} ${Ht}`);

    const tMin = points[0].t, tMax = points[points.length - 1].t;
    const vMin = 0, vMax = Math.max(11, Math.ceil(Math.max(...points.map(p => p.v))));
    const X = t => padL + ((t - tMin) / Math.max(1, tMax - tMin)) * cw;
    const Y = v => padT + (1 - (v - vMin) / (vMax - vMin)) * ch;
    const Xinv = x => tMin + ((x - padL) / cw) * (tMax - tMin);

    let svg = '';

    // healthy band 7-9h
    if (7 <= vMax && 9 >= vMin) {
      svg += `<rect x="${padL}" y="${Y(9)}" width="${cw}" height="${Y(7)-Y(9)}" fill="${COL.cyanFaint}"/>`;
      svg += `<text x="${padL+6}" y="${Y(9)+12}" font-family="JetBrains Mono" font-size="9" fill="${COL.cyanDim}">建议 7–9h</text>`;
    }

    // y grid
    for (let v = 0; v <= vMax; v += 2) {
      svg += `<line x1="${padL}" y1="${Y(v)}" x2="${W-padR}" y2="${Y(v)}" stroke="${COL.border}" stroke-width="0.5" stroke-dasharray="2 4"/>`;
      svg += `<text x="${padL-8}" y="${Y(v)+3}" text-anchor="end" font-family="JetBrains Mono" font-size="9" fill="${COL.textFaint}">${v}h</text>`;
    }
    svg += `<text x="14" y="${padT+ch/2}" text-anchor="middle" font-family="JetBrains Mono" font-size="9" fill="${COL.amber}" transform="rotate(-90 14 ${padT+ch/2})">Sleep h</text>`;

    // month ticks
    monthTicks(tMin, tMax).forEach((m, i, arr) => {
      const x = X(m.t);
      svg += `<line x1="${x}" y1="${padT+ch}" x2="${x}" y2="${padT+ch+4}" stroke="${COL.border}" stroke-width="0.5"/>`;
      if (arr.length <= 12 || i % 2 === 0) {
        svg += `<text x="${x}" y="${padT+ch+18}" text-anchor="middle" font-family="JetBrains Mono" font-size="9" fill="${COL.textFaint}">${m.label}</text>`;
      }
    });

    // ride-day markers
    const rideDays = new Set((H.workouts || []).map(w => w.date));
    rideDays.forEach(d => {
      const t = ts(d);
      if (t < tMin || t > tMax) return;
      const x = X(t);
      svg += `<line x1="${x}" y1="${padT+ch-3}" x2="${x}" y2="${padT+ch}" stroke="${COL.amber}" stroke-width="1" opacity="0.8"/>`;
    });

    // daily bars (faint)
    points.forEach(p => {
      const x = X(p.t), yTop = Y(p.v);
      const col = p.v >= 7 && p.v <= 9 ? COL.cyan : (p.v < 6 ? COL.rose : COL.amber);
      svg += `<line x1="${x}" y1="${padT+ch}" x2="${x}" y2="${yTop}" stroke="${col}" stroke-width="0.9" opacity="0.45"/>`;
    });

    // 7-day rolling line
    const roll = rollingMean(points, 7);
    let line = '';
    points.forEach((p, i) => {
      if (roll[i] == null) return;
      line += `${line ? 'L' : 'M'} ${X(p.t).toFixed(2)} ${Y(roll[i]).toFixed(2)} `;
    });
    svg += `<path d="${line}" fill="none" stroke="${COL.amber}" stroke-width="1.6" opacity="0.95"/>`;

    // brush + crosshair
    svg += `<rect id="sleepBrushRect" x="${padL}" y="${padT}" width="0" height="${ch}" fill="rgba(108,196,217,0.12)" stroke="${COL.cyanDim}" stroke-width="0.5" style="display:none;pointer-events:none;"/>`;
    svg += `<line id="sleepCrossLine" x1="${padL}" x2="${padL}" y1="${padT}" y2="${padT+ch}" stroke="${COL.cyanDim}" stroke-width="0.8" stroke-dasharray="3 3" style="display:none;pointer-events:none;"/>`;
    svg += `<text id="sleepCrossText" font-family="JetBrains Mono" font-size="10" fill="${COL.text}" style="display:none;pointer-events:none;"></text>`;
    svg += `<rect id="sleepHot" x="${padL}" y="${padT}" width="${cw}" height="${ch}" fill="transparent" style="cursor:crosshair"/>`;

    host.innerHTML = svg;

    // histogram in distHost
    if (distHost) {
      const bins = new Array(14).fill(0);
      points.forEach(p => {
        const b = Math.min(13, Math.floor(p.v));
        bins[b]++;
      });
      const maxB = Math.max(...bins, 1);
      const dW = 360, dH = 120, dPadL = 30, dPadR = 10, dPadT = 8, dPadB = 22;
      const dcw = dW - dPadL - dPadR, dch = dH - dPadT - dPadB;
      const barW = dcw / bins.length;
      let dhtml = `<svg viewBox="0 0 ${dW} ${dH}" preserveAspectRatio="none" style="width:100%;max-width:420px;display:block;">`;
      bins.forEach((c, i) => {
        const x = dPadL + i * barW;
        const h = (c / maxB) * dch;
        const y = dPadT + dch - h;
        const col = i >= 7 && i <= 9 ? COL.cyan : (i < 6 ? COL.rose : COL.amber);
        dhtml += `<rect x="${x+1}" y="${y}" width="${Math.max(1, barW-2)}" height="${h}" fill="${col}" opacity="0.7"><title>${i}–${i+1}h · ${c} 天</title></rect>`;
      });
      // x axis
      [0, 4, 7, 9, 12].forEach(v => {
        const x = dPadL + v * barW;
        dhtml += `<text x="${x}" y="${dH-6}" text-anchor="middle" font-family="JetBrains Mono" font-size="8" fill="${COL.textFaint}">${v}h</text>`;
      });
      dhtml += '</svg>';
      distHost.innerHTML = dhtml;
    }

    if (stats) {
      const vs = points.map(p => p.v);
      const mean = vs.reduce((a, b) => a + b, 0) / vs.length;
      const inRange = points.filter(p => p.v >= 7 && p.v <= 9).length;
      const under6 = points.filter(p => p.v < 6).length;
      // Sleep on ride days vs non-ride days
      const rideDayPts = points.filter(p => rideDays.has(p.date));
      const offDayPts = points.filter(p => !rideDays.has(p.date));
      const rideMean = rideDayPts.length ? rideDayPts.reduce((a, b) => a + b.v, 0) / rideDayPts.length : 0;
      const offMean = offDayPts.length ? offDayPts.reduce((a, b) => a + b.v, 0) / offDayPts.length : 0;
      stats.innerHTML = `
        <div class="recovery-stat"><div class="rs-label">Days · 天数</div><div class="rs-value">${points.length}</div></div>
        <div class="recovery-stat"><div class="rs-label">Mean · 平均</div><div class="rs-value">${mean.toFixed(1)}<small>h</small></div></div>
        <div class="recovery-stat"><div class="rs-label">In 7–9h · 健康</div><div class="rs-value">${inRange}<small>天 · ${(inRange/points.length*100).toFixed(0)}%</small></div></div>
        <div class="recovery-stat"><div class="rs-label">Below 6h · 偏少</div><div class="rs-value">${under6}<small>天</small></div></div>
        <div class="recovery-stat"><div class="rs-label">Ride days · 骑行</div><div class="rs-value">${rideMean.toFixed(1)}<small>h · ${rideDayPts.length} 天</small></div></div>
        <div class="recovery-stat"><div class="rs-label">Off days · 非骑行</div><div class="rs-value">${offMean.toFixed(1)}<small>h · ${offDayPts.length} 天</small></div></div>
      `;
    }
    if (brushSummary) brushSummary.innerHTML = '拖动选区查看子区间睡眠 · drag to brush a window';

    // crosshair + brush wiring
    const hot = host.querySelector('#sleepHot');
    const cline = host.querySelector('#sleepCrossLine');
    const ctext = host.querySelector('#sleepCrossText');
    const brushRect = host.querySelector('#sleepBrushRect');

    function pageToVbX(clientX) {
      const r = host.getBoundingClientRect();
      const vb = host.viewBox.baseVal;
      return ((clientX - r.left) / r.width) * vb.width;
    }
    hot.addEventListener('mousemove', e => {
      const x = pageToVbX(e.clientX);
      const t = Xinv(x);
      let nearest = points[0], best = Infinity;
      for (const p of points) {
        const d = Math.abs(p.t - t);
        if (d < best) { best = d; nearest = p; }
      }
      cline.setAttribute('x1', X(nearest.t));
      cline.setAttribute('x2', X(nearest.t));
      cline.style.display = '';
      const tx = X(nearest.t) > W - 200 ? X(nearest.t) - 12 : X(nearest.t) + 8;
      ctext.setAttribute('x', tx);
      ctext.setAttribute('y', padT + 14);
      ctext.setAttribute('text-anchor', X(nearest.t) > W - 200 ? 'end' : 'start');
      ctext.textContent = `${nearest.date} · ${nearest.v.toFixed(1)} h`;
      ctext.style.display = '';
    });
    hot.addEventListener('mouseleave', () => {
      cline.style.display = 'none';
      ctext.style.display = 'none';
    });

    attachBrush(host, hot, brushRect, Xinv, sel => {
      if (!sel) {
        if (brushSummary) brushSummary.innerHTML = '拖动选区查看子区间睡眠 · drag to brush a window';
        return;
      }
      const s = windowStats(points, sel.fromT, sel.toT);
      if (!s || !brushSummary) return;
      const span = Math.round((s.toT - s.fromT) / 86400000) + 1;
      brushSummary.innerHTML = `
        <span class="hrv-brush-label">选区 · brushed</span>
        <strong>${fmtDate(s.fromT)} → ${fmtDate(s.toT)}</strong>
        · ${span} 天 · ${s.n} 测量 ·
        平均 <strong style="color:var(--amber)">${s.mean.toFixed(1)}</strong> h
        · ${s.min.toFixed(1)}–${s.max.toFixed(1)} h
      `;
    });
  };

  // ----- Walking HR Reserve ---------------------------------------------
  // Reserve = walking_hr - resting_hr per day. Low values mean the body
  // moves through ordinary life with little headroom spent; a downward
  // trend tracks aerobic adaptation in real life (not just on the bike).
  // Renders both raw lines + the shaded reserve gap + 7-day rolling
  // average of the reserve. Brushable.
  window.renderWalkingReserve = function () {
    const H = window.HEALTH_DATA;
    const host = document.getElementById('walkingReserveChart');
    const statsBox = document.getElementById('walkingReserveStats');
    const brushSummary = document.getElementById('walkingReserveBrush');
    if (!H || !H.daily || !host) return;

    // pair walking_hr with resting_hr on the same day
    const points = H.daily
      .filter(d => d.walking_hr && d.resting_hr && d.walking_hr > d.resting_hr)
      .map(d => ({
        t: ts(d.date),
        walk: d.walking_hr,
        rest: d.resting_hr,
        v: d.walking_hr - d.resting_hr,
        date: d.date,
      }));
    if (!points.length) {
      host.innerHTML = '<text x="50%" y="50%" text-anchor="middle" fill="#5d5b55" font-family="JetBrains Mono" font-size="12">这个时间段没有步行心率数据</text>';
      if (statsBox) statsBox.innerHTML = '';
      if (brushSummary) brushSummary.textContent = '—';
      return;
    }

    const W = 900, Ht = 280, padL = 52, padR = 24, padT = 28, padB = 38;
    const cw = W - padL - padR, ch = Ht - padT - padB;
    host.setAttribute('viewBox', `0 0 ${W} ${Ht}`);

    const tMin = points[0].t, tMax = points[points.length - 1].t;
    // y range covers both walking + resting HR; pad +/- 5
    const allV = points.flatMap(p => [p.walk, p.rest]);
    const vMin = Math.floor(Math.min(...allV) / 10) * 10 - 5;
    const vMax = Math.ceil(Math.max(...allV) / 10) * 10 + 5;
    const X = t => padL + ((t - tMin) / Math.max(1, tMax - tMin)) * cw;
    const Y = v => padT + (1 - (v - vMin) / Math.max(1, vMax - vMin)) * ch;
    const Xinv = x => tMin + ((x - padL) / cw) * (tMax - tMin);

    let svg = '';

    // y-axis grid
    for (let v = Math.ceil(vMin/10)*10; v <= vMax; v += 10) {
      svg += `<line x1="${padL}" y1="${Y(v)}" x2="${W-padR}" y2="${Y(v)}" stroke="${COL.border}" stroke-width="0.5" stroke-dasharray="2 4"/>`;
      svg += `<text x="${padL-8}" y="${Y(v)+3}" text-anchor="end" font-family="JetBrains Mono" font-size="9" fill="${COL.textFaint}">${v}</text>`;
    }
    svg += `<text x="14" y="${padT+ch/2}" text-anchor="middle" font-family="JetBrains Mono" font-size="9" fill="${COL.text}" transform="rotate(-90 14 ${padT+ch/2})">bpm</text>`;

    // month ticks
    monthTicks(tMin, tMax).forEach((m, i, arr) => {
      const x = X(m.t);
      svg += `<line x1="${x}" y1="${padT+ch}" x2="${x}" y2="${padT+ch+4}" stroke="${COL.border}" stroke-width="0.5"/>`;
      if (arr.length <= 12 || i % 2 === 0) {
        svg += `<text x="${x}" y="${padT+ch+18}" text-anchor="middle" font-family="JetBrains Mono" font-size="9" fill="${COL.textFaint}">${m.label}</text>`;
      }
    });

    // ride-day markers at the top
    const rideDays = new Set((H.workouts || []).map(w => w.date));
    rideDays.forEach(d => {
      const t = ts(d);
      if (t < tMin || t > tMax) return;
      const x = X(t);
      svg += `<line x1="${x}" y1="${padT}" x2="${x}" y2="${padT+6}" stroke="${COL.amber}" stroke-width="1.2" opacity="0.8"/>`;
    });

    // shaded reserve band: between walking_hr and resting_hr (per day vertical strokes)
    points.forEach(p => {
      const x = X(p.t);
      svg += `<line x1="${x}" y1="${Y(p.walk)}" x2="${x}" y2="${Y(p.rest)}" stroke="rgba(168,156,107,0.35)" stroke-width="1.1"/>`;
    });

    // rolling walking-HR line (cyan) and resting-HR line (rose)
    const wRoll = rollingMean(points.map(p => ({t: p.t, v: p.walk})), 7);
    const rRoll = rollingMean(points.map(p => ({t: p.t, v: p.rest})), 7);
    let wLine = '', rLine = '';
    points.forEach((p, i) => {
      if (wRoll[i] != null) wLine += `${wLine ? 'L' : 'M'} ${X(p.t).toFixed(2)} ${Y(wRoll[i]).toFixed(2)} `;
      if (rRoll[i] != null) rLine += `${rLine ? 'L' : 'M'} ${X(p.t).toFixed(2)} ${Y(rRoll[i]).toFixed(2)} `;
    });
    svg += `<path d="${wLine}" fill="none" stroke="${COL.cyan}" stroke-width="1.5" opacity="0.95"/>`;
    svg += `<path d="${rLine}" fill="none" stroke="${COL.rose}" stroke-width="1.5" opacity="0.95"/>`;

    // brush + crosshair
    svg += `<rect id="wrBrushRect" x="${padL}" y="${padT}" width="0" height="${ch}" fill="rgba(232,183,109,0.12)" stroke="${COL.amberDim}" stroke-width="0.5" style="display:none;pointer-events:none;"/>`;
    svg += `<line id="wrCrossLine" x1="${padL}" x2="${padL}" y1="${padT}" y2="${padT+ch}" stroke="${COL.amberDim}" stroke-width="0.8" stroke-dasharray="3 3" style="display:none;pointer-events:none;"/>`;
    svg += `<text id="wrCrossText" font-family="JetBrains Mono" font-size="10" fill="${COL.text}" style="display:none;pointer-events:none;"></text>`;
    svg += `<rect id="wrHot" x="${padL}" y="${padT}" width="${cw}" height="${ch}" fill="transparent" style="cursor:crosshair"/>`;

    host.innerHTML = svg;

    // global stats
    if (statsBox) {
      const reserves = points.map(p => p.v);
      const walks = points.map(p => p.walk);
      const rests = points.map(p => p.rest);
      const meanR = reserves.reduce((a, b) => a + b, 0) / reserves.length;
      const meanW = walks.reduce((a, b) => a + b, 0) / walks.length;
      const meanRest = rests.reduce((a, b) => a + b, 0) / rests.length;
      const first14 = points.slice(0, 14);
      const last14  = points.slice(-14);
      const firstMean = first14.reduce((a, b) => a + b.v, 0) / first14.length;
      const lastMean  = last14.reduce((a, b) => a + b.v, 0) / last14.length;
      const delta = lastMean - firstMean;
      const dir = delta < 0 ? '↓' : '↑';
      const dirCol = delta < 0 ? 'var(--cyan)' : 'var(--rose)';
      statsBox.innerHTML = `
        <div class="recovery-stat"><div class="rs-label">Days · 天数</div><div class="rs-value">${points.length}</div></div>
        <div class="recovery-stat"><div class="rs-label">Reserve mean · 平均储备</div><div class="rs-value">${meanR.toFixed(1)}<small>bpm</small></div></div>
        <div class="recovery-stat"><div class="rs-label">Walking HR · 步行</div><div class="rs-value">${meanW.toFixed(1)}<small>bpm</small></div></div>
        <div class="recovery-stat"><div class="rs-label">Resting HR · 静息</div><div class="rs-value">${meanRest.toFixed(1)}<small>bpm</small></div></div>
        <div class="recovery-stat"><div class="rs-label">First 14d · 初期</div><div class="rs-value">${firstMean.toFixed(1)}<small>bpm</small></div></div>
        <div class="recovery-stat"><div class="rs-label">Last 14d · 近期</div><div class="rs-value" style="color:${dirCol}">${dir}${Math.abs(delta).toFixed(1)}<small> vs 初期</small></div></div>
      `;
    }
    if (brushSummary) brushSummary.innerHTML = '拖动选区查看子区间心率储备 · drag to brush a window';

    // hover crosshair (shows walk / rest / reserve at nearest date)
    const hot = host.querySelector('#wrHot');
    const cline = host.querySelector('#wrCrossLine');
    const ctext = host.querySelector('#wrCrossText');
    const brushRect = host.querySelector('#wrBrushRect');

    function pageToVbX(clientX) {
      const r = host.getBoundingClientRect();
      const vb = host.viewBox.baseVal;
      return ((clientX - r.left) / r.width) * vb.width;
    }
    hot.addEventListener('mousemove', e => {
      const x = pageToVbX(e.clientX);
      const t = Xinv(x);
      let nearest = points[0], best = Infinity;
      for (const p of points) {
        const d = Math.abs(p.t - t);
        if (d < best) { best = d; nearest = p; }
      }
      cline.setAttribute('x1', X(nearest.t));
      cline.setAttribute('x2', X(nearest.t));
      cline.style.display = '';
      const tx = X(nearest.t) > W - 240 ? X(nearest.t) - 12 : X(nearest.t) + 8;
      const anchor = X(nearest.t) > W - 240 ? 'end' : 'start';
      ctext.setAttribute('x', tx);
      ctext.setAttribute('y', padT + 14);
      ctext.setAttribute('text-anchor', anchor);
      ctext.textContent = `${nearest.date} · 步 ${nearest.walk}, 静 ${nearest.rest}, 储 ${nearest.v}`;
      ctext.style.display = '';
    });
    hot.addEventListener('mouseleave', () => {
      cline.style.display = 'none';
      ctext.style.display = 'none';
    });

    attachBrush(host, hot, brushRect, Xinv, sel => {
      if (!sel) {
        if (brushSummary) brushSummary.innerHTML = '拖动选区查看子区间心率储备 · drag to brush a window';
        return;
      }
      const sub = points.filter(p => p.t >= sel.fromT && p.t <= sel.toT);
      if (!sub.length || !brushSummary) return;
      const reserves = sub.map(p => p.v);
      const walks = sub.map(p => p.walk);
      const rests = sub.map(p => p.rest);
      const meanR = reserves.reduce((a, b) => a + b, 0) / reserves.length;
      const meanW = walks.reduce((a, b) => a + b, 0) / walks.length;
      const meanRest = rests.reduce((a, b) => a + b, 0) / rests.length;
      const span = Math.round((sel.toT - sel.fromT) / 86400000) + 1;
      brushSummary.innerHTML = `
        <span class="hrv-brush-label">选区</span>
        <strong>${fmtDate(sel.fromT)} → ${fmtDate(sel.toT)}</strong>
        · ${span} 天 · ${sub.length} 测量 ·
        储备 <strong style="color:${meanR < 30 ? 'var(--cyan)' : 'var(--amber)'}">${meanR.toFixed(1)}</strong> bpm ·
        步行 <span style="color:var(--cyan)">${meanW.toFixed(1)}</span> ·
        静息 <span style="color:var(--rose)">${meanRest.toFixed(1)}</span>
      `;
    });
  };

  // ----- Recovery Composite ---------------------------------------------
  // 4 stacked mini timelines sharing the same x-axis. Synced vertical
  // crosshair lets the user read all four metrics for the same date at once.
  window.renderRecoveryComposite = function () {
    const H = window.HEALTH_DATA;
    const host = document.getElementById('recoveryComposite');
    const readout = document.getElementById('compositeReadout');
    if (!H || !H.daily || !host) return;

    const tracks = [
      { key: 'hrv',         label: 'HRV ms',      col: COL.cyan,
        pts: H.daily.filter(d => d.hrv).map(d => ({ t: ts(d.date), v: d.hrv, date: d.date })) },
      { key: 'resting_hr',  label: 'Resting HR',  col: COL.rose,
        pts: H.daily.filter(d => d.resting_hr).map(d => ({ t: ts(d.date), v: d.resting_hr, date: d.date })) },
      { key: 'resp_rate',   label: 'Resp /min',   col: COL.amber,
        pts: H.daily.filter(d => d.resp_rate).map(d => ({ t: ts(d.date), v: d.resp_rate, date: d.date })) },
      { key: 'sleep_h',     label: 'Sleep h',     col: '#a89c6b',
        pts: H.daily.filter(d => d.sleep_h && d.sleep_h < 14).map(d => ({ t: ts(d.date), v: d.sleep_h, date: d.date })) },
    ].filter(tr => tr.pts.length);

    if (!tracks.length) {
      host.innerHTML = '<text x="50%" y="50%" text-anchor="middle" fill="#5d5b55" font-family="JetBrains Mono" font-size="12">这个时间段没有恢复数据</text>';
      if (readout) readout.textContent = '—';
      return;
    }

    // shared time axis spans union of all tracks
    const allT = tracks.flatMap(tr => tr.pts.map(p => p.t));
    const tMin = Math.min(...allT), tMax = Math.max(...allT);

    const W = 900, rowH = 70, padL = 60, padR = 24, padT = 14, padB = 36;
    const Ht = padT + padB + rowH * tracks.length;
    const cw = W - padL - padR;
    host.setAttribute('viewBox', `0 0 ${W} ${Ht}`);

    const X = t => padL + ((t - tMin) / Math.max(1, tMax - tMin)) * cw;
    const Xinv = x => tMin + ((x - padL) / cw) * (tMax - tMin);

    let svg = '';

    tracks.forEach((tr, idx) => {
      const y0 = padT + idx * rowH;
      const y1 = y0 + rowH - 8;
      const vs = tr.pts.map(p => p.v);
      const vMin = Math.min(...vs), vMax = Math.max(...vs);
      const Y = v => y1 - ((v - vMin) / Math.max(0.001, vMax - vMin)) * (y1 - y0 - 4);

      // row label
      svg += `<text x="${padL-8}" y="${y0+rowH/2-2}" text-anchor="end" font-family="JetBrains Mono" font-size="10" fill="${tr.col}">${tr.label}</text>`;
      svg += `<text x="${padL-8}" y="${y0+rowH/2+12}" text-anchor="end" font-family="JetBrains Mono" font-size="8" fill="${COL.textFaint}">${vMin.toFixed(0)}–${vMax.toFixed(0)}</text>`;
      // baseline
      svg += `<line x1="${padL}" y1="${y1}" x2="${W-padR}" y2="${y1}" stroke="${COL.border}" stroke-width="0.5"/>`;

      // dots
      tr.pts.forEach(p => {
        svg += `<circle cx="${X(p.t)}" cy="${Y(p.v)}" r="1" fill="${tr.col}" opacity="0.32"/>`;
      });
      // rolling line
      const roll = rollingMean(tr.pts, 7);
      let line = '';
      tr.pts.forEach((p, i) => {
        if (roll[i] == null) return;
        line += `${line ? 'L' : 'M'} ${X(p.t).toFixed(2)} ${Y(roll[i]).toFixed(2)} `;
      });
      svg += `<path d="${line}" fill="none" stroke="${tr.col}" stroke-width="1.3" opacity="0.95"/>`;
    });

    // month ticks at bottom
    monthTicks(tMin, tMax).forEach((m, i, arr) => {
      const x = X(m.t);
      svg += `<line x1="${x}" y1="${Ht-padB+4}" x2="${x}" y2="${Ht-padB+8}" stroke="${COL.border}" stroke-width="0.5"/>`;
      if (arr.length <= 12 || i % 2 === 0) {
        svg += `<text x="${x}" y="${Ht-padB+22}" text-anchor="middle" font-family="JetBrains Mono" font-size="9" fill="${COL.textFaint}">${m.label}</text>`;
      }
    });

    // shared crosshair + brush (full-height across all 4 tracks)
    svg += `<rect id="compBrushRect" x="${padL}" y="${padT}" width="0" height="${Ht-padB-padT}" fill="rgba(232,183,109,0.10)" stroke="${COL.amberDim}" stroke-width="0.5" style="display:none;pointer-events:none;"/>`;
    svg += `<line id="compCrossLine" x1="${padL}" x2="${padL}" y1="${padT}" y2="${Ht-padB}" stroke="${COL.amberDim}" stroke-width="0.8" stroke-dasharray="3 3" style="display:none;pointer-events:none;"/>`;
    svg += `<rect id="compHot" x="${padL}" y="${padT}" width="${cw}" height="${Ht-padB-padT}" fill="transparent" style="cursor:crosshair"/>`;

    host.innerHTML = svg;

    const hot = host.querySelector('#compHot');
    const cline = host.querySelector('#compCrossLine');
    const brushRect = host.querySelector('#compBrushRect');

    function pageToVbX(clientX) {
      const r = host.getBoundingClientRect();
      const vb = host.viewBox.baseVal;
      return ((clientX - r.left) / r.width) * vb.width;
    }
    hot.addEventListener('mousemove', e => {
      const x = pageToVbX(e.clientX);
      const t = Xinv(x);
      // find nearest for each track
      const lookups = tracks.map(tr => {
        let nearest = null, best = Infinity;
        for (const p of tr.pts) {
          const d = Math.abs(p.t - t);
          if (d < best) { best = d; nearest = p; }
        }
        return { tr, p: nearest };
      });
      const dateStr = lookups[0].p ? lookups[0].p.date : fmtDate(t);
      cline.setAttribute('x1', X(t));
      cline.setAttribute('x2', X(t));
      cline.style.display = '';
      if (readout) {
        const parts = lookups.map(({ tr, p }) =>
          `<span style="color:${tr.col}">${tr.label.split(' ')[0]}</span> <strong>${p ? p.v.toFixed(1) : '—'}</strong>`
        ).join(' &nbsp; ');
        readout.innerHTML = `<span style="color:var(--text-dim)">${dateStr}</span> · ${parts}`;
      }
    });
    hot.addEventListener('mouseleave', () => {
      cline.style.display = 'none';
      if (readout) readout.textContent = '悬停同步读取四项 · hover to read all four';
    });

    // brush across all 4 tracks — selecting a window shows per-track stats.
    attachBrush(host, hot, brushRect, Xinv, sel => {
      if (!sel) {
        if (readout) readout.textContent = '悬停同步读取四项 · hover to read all four';
        return;
      }
      const span = Math.round((sel.toT - sel.fromT) / 86400000) + 1;
      const lines = tracks.map(tr => {
        const s = windowStats(tr.pts, sel.fromT, sel.toT);
        if (!s) return `<span style="color:${tr.col}">${tr.label.split(' ')[0]}</span> <span style="color:var(--text-faint)">—</span>`;
        return `<span style="color:${tr.col}">${tr.label.split(' ')[0]}</span> <strong>${s.mean.toFixed(1)}</strong> <span style="color:var(--text-faint)">(${s.min.toFixed(0)}–${s.max.toFixed(0)}, n=${s.n})</span>`;
      }).join(' &nbsp; ');
      if (readout) {
        readout.innerHTML = `<span class="hrv-brush-label">选区</span> <strong>${fmtDate(sel.fromT)} → ${fmtDate(sel.toT)}</strong> · ${span} 天 · ${lines}`;
      }
    });
  };
})();
