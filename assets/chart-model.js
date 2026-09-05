/* Calendar-based chart calculations shared by the static pages. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ChartModel = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';
  const DAY = 86400000;
  const finite = value => typeof value === 'number' && Number.isFinite(value);
  const timestamp = value => Date.parse(String(value).slice(0, 10) + 'T00:00:00Z');
  const dateKey = value => new Date(value).toISOString().slice(0, 10);
  function calendar(from, to) {
    const start = timestamp(from), end = timestamp(to), result = [];
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) return result;
    for (let t = start; t <= end; t += DAY) result.push(dateKey(t));
    return result;
  }
  function rollingMean(points, days = 7) {
    // Include today and the preceding days - 1 calendar days, never 8 days.
    return points.map(point => {
      const values = points.filter(p => p.t <= point.t && p.t >= point.t - (days - 1) * DAY && finite(p.v));
      return values.length ? values.reduce((sum, p) => sum + p.v, 0) / values.length : null;
    });
  }
  function segments(points, values, maxGapDays = 1) {
    const groups = []; let group = [], previous = null;
    points.forEach((point, index) => {
      if (!finite(values[index])) { if (group.length) groups.push(group); group = []; previous = null; return; }
      if (previous && point.t - previous.t > maxGapDays * DAY) { groups.push(group); group = []; }
      group.push({ ...point, v: values[index] }); previous = point;
    });
    if (group.length) groups.push(group);
    return groups;
  }
  function linePath(points, values, X, Y, maxGapDays = 1) {
    return segments(points, values, maxGapDays).map(group => group.map((p, i) => `${i ? 'L' : 'M'} ${X(p.t).toFixed(2)} ${Y(p.v).toFixed(2)}`).join(' ')).join(' ');
  }
  function monthTicks(from, to, maxLabels = 8) {
    if (!finite(from) || !finite(to) || from > to) return [];
    const ticks = [], date = new Date(from);
    date.setUTCDate(1); date.setUTCHours(0, 0, 0, 0);
    while (date.getTime() <= to) {
      if (date.getTime() >= from) ticks.push({ t: date.getTime(), label: dateKey(date).slice(2, 7) });
      date.setUTCMonth(date.getUTCMonth() + 1);
    }
    if (ticks.length < 2) return [...new Set([from, to])].map(t => ({ t, label: dateKey(t).slice(5) }));
    const step = Math.ceil(ticks.length / maxLabels);
    return ticks.filter((_, i) => i % step === 0);
  }
  function aggregateWorkouts(workouts, base = {}) {
    const monthly = new Map(), byDay = new Map();
    const summary = { ...base, ride_count: workouts.length, active_days: 0, total_distance_km: 0,
      total_duration_min: 0, total_duration_h: 0, total_kcal: 0, total_elev_gain_m: 0,
      first_ride: null, last_ride: null, longest_streak_days: 0,
      hr_zones: { '<100': 0, '100-120': 0, '120-140': 0, '140-160': 0, '>=160': 0 },
      speed_buckets: { '<10': 0, '10-15': 0, '15-20': 0, '20-25': 0, '>=25': 0 } };
    workouts.forEach(w => {
      const date = w.date, month = date.slice(0, 7);
      const m = monthly.get(month) || { month, distance_km: 0, duration_min: 0, rides: 0, kcal: 0, elev_gain_m: 0 };
      const daily = byDay.get(date) || { date, distance_km: 0, rides: 0, duration_min: 0 };
      const number = key => finite(w[key]) ? w[key] : 0;
      m.distance_km += number('distance_km'); m.duration_min += number('duration_min'); m.rides++;
      m.kcal += number('active_kcal'); m.elev_gain_m += number('elev_gain_m');
      daily.distance_km += number('distance_km'); daily.duration_min += number('duration_min'); daily.rides++;
      monthly.set(month, m); byDay.set(date, daily);
      summary.total_distance_km += number('distance_km'); summary.total_duration_min += number('duration_min');
      summary.total_kcal += number('active_kcal'); summary.total_elev_gain_m += number('elev_gain_m');
      if (finite(w.hr_avg)) summary.hr_zones[w.hr_avg < 100 ? '<100' : w.hr_avg < 120 ? '100-120' : w.hr_avg < 140 ? '120-140' : w.hr_avg < 160 ? '140-160' : '>=160']++;
      if (finite(w.avg_speed_kmh)) summary.speed_buckets[w.avg_speed_kmh < 10 ? '<10' : w.avg_speed_kmh < 15 ? '10-15' : w.avg_speed_kmh < 20 ? '15-20' : w.avg_speed_kmh < 25 ? '20-25' : '>=25']++;
    });
    const dates = [...byDay.keys()].sort(); let streak = 0;
    dates.forEach((date, i) => {
      streak = i && timestamp(date) - timestamp(dates[i - 1]) === DAY ? streak + 1 : 1;
      summary.longest_streak_days = Math.max(streak, summary.longest_streak_days);
    });
    summary.first_ride = dates[0] || null; summary.last_ride = dates.at(-1) || null;
    summary.active_days = dates.length; summary.total_duration_h = summary.total_duration_min / 60;
    return { summary, monthly: [...monthly.values()].sort((a, b) => a.month.localeCompare(b.month)), byDay };
  }
  function bodySummary(daily, vo2max = [], weight = []) {
    const metrics = ['resting_hr', 'hrv', 'sleep_h', 'resp_rate', 'spo2', 'steps'];
    const points = daily.map(d => ({ ...d, t: timestamp(d.date) })).sort((a, b) => a.t - b.t);
    const comparison = periodComparison(points, 14);
    const body_deltas = Object.fromEntries(metrics.map(key => {
      const valid = p => finite(p[key]) && p[key] >= 0 && (key !== 'sleep_h' || (p[key] > 0 && p[key] < 14));
      const first = comparison.first.filter(valid), recent = comparison.recent.filter(valid);
      if (!comparison.comparable || !first.length || !recent.length) return [key, null];
      const mean = rows => rows.reduce((sum, p) => sum + p[key], 0) / rows.length;
      const baseline = mean(first), value = mean(recent);
      return [key, { baseline, recent: value, delta: value - baseline, baseline_n: first.length, recent_n: recent.length }];
    }));
    const vo2 = vo2max.filter(p => finite(p.value)).sort((a, b) => a.date.localeCompare(b.date));
    const weights = weight.filter(p => finite(p.kg)).sort((a, b) => a.date.localeCompare(b.date));
    return { body_deltas, vo2max_first: vo2[0]?.value ?? null, vo2max_latest: vo2.at(-1)?.value ?? null,
      weight_first_kg: weights[0]?.kg ?? null, weight_latest_kg: weights.at(-1)?.kg ?? null };
  }
  function calendarLoad(daily) {
    if (!daily.length) return [];
    const lookup = new Map(daily.map(d => [d.date, d]));
    const dates = [...lookup.keys()].sort();
    const days = calendar(dates[0], dates.at(-1));
    return days.map((date, i) => {
      const window = days.slice(Math.max(0, i - 6), i + 1).map(d => lookup.get(d));
      return { date, km: window.reduce((sum, d) => sum + (d?.distance_km || 0), 0),
        days: window.filter(d => d?.distance_km > 0.01).length, observed: window.filter(Boolean).length };
    });
  }
  function periodComparison(points, days = 14) {
    if (!points.length) return { first: [], recent: [], comparable: false };
    const firstT = points[0].t, lastT = points.at(-1).t;
    return { first: points.filter(p => p.t <= firstT + (days - 1) * DAY),
      recent: points.filter(p => p.t >= lastT - (days - 1) * DAY),
      comparable: lastT - firstT >= (2 * days - 1) * DAY };
  }
  function readingsAt(tracks, date) {
    return tracks.map(track => ({ tr: track, p: track.pts.find(p => p.date === date) || null }));
  }
  const enhanced = new WeakMap();
  function enhance(svg) {
    if (!svg || svg.tagName.toLowerCase() !== 'svg' || svg.dataset.chartInteractive === 'delivery') return;
    const items = [...svg.querySelectorAll('title')].filter(title => title.parentNode !== svg).map(title => ({ node: title.parentNode, text: title.textContent }));
    const previous = enhanced.get(svg);
    if (previous && previous.output.isConnected && previous.items.length === items.length
      && items.every((item, i) => item.node === previous.items[i].node && item.text === previous.items[i].text)) return;
    const old = svg.parentElement.querySelector(`[data-chart-readout="${svg.id}"]`);
    if (old) old.remove();
    if (!items.length) { svg.removeAttribute('tabindex'); svg.onkeydown = null; svg.onfocus = null; svg.onclick = null; svg.onpointerdown = null; svg.onpointerup = null; svg.ontouchstart = null; svg.ontouchend = null; enhanced.delete(svg); return; }
    const output = document.createElement('div'); output.className = 'chart-readout';
    output.dataset.chartReadout = svg.id;
    const reading = document.createElement('span'); reading.className = 'chart-reading';
    reading.setAttribute('aria-live', 'polite');
    reading.textContent = `${items.length} 个记录 · 用右侧按钮逐条读取，也可聚焦图表按 ← →`;
    const controls = document.createElement('span'); controls.className = 'chart-record-controls';
    const previousButton = document.createElement('button'), nextButton = document.createElement('button');
    [[previousButton, '←', '上一条图表记录'], [nextButton, '→', '下一条图表记录']].forEach(([button, text, label]) => {
      button.type = 'button'; button.textContent = text; button.setAttribute('aria-label', label); controls.append(button);
    });
    output.append(reading, controls);
    svg.insertAdjacentElement('afterend', output);
    enhanced.set(svg, { items, output });
    svg.setAttribute('tabindex', '0'); svg.setAttribute('role', 'group');
    svg.setAttribute('aria-label', '交互图表，左右方向键切换记录，Home 和 End 跳到首尾');
    let index = 0, active = null;
    const show = i => {
      index = Math.max(0, Math.min(items.length - 1, i));
      if (active) active.classList.remove('chart-point-active');
      active = items[index].node; active.classList.add('chart-point-active');
      reading.textContent = `${index + 1} / ${items.length} · ${items[index].text}`;
    };
    previousButton.addEventListener('click', () => show(active ? index - 1 : 0));
    nextButton.addEventListener('click', () => show(active ? index + 1 : 0));
    svg.onkeydown = event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault(); show(event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : index + (event.key === 'ArrowLeft' ? -1 : 1));
    };
    svg.onfocus = () => show(index);
    // Inspection also works through the transparent hover/brush overlays.
    // Keep each chart's original handlers and ignore a dragged selection.
    let pointerStart = null;
    svg.onpointerdown = event => { pointerStart = { x: event.clientX, y: event.clientY }; };
    const inspect = event => {
      if (pointerStart && Math.hypot(event.clientX - pointerStart.x, event.clientY - pointerStart.y) > 6) return;
      const direct = items.findIndex(item => item.node === event.target || item.node.contains(event.target));
      if (direct >= 0) { show(direct); return; }
      let closest = 0, distance = Infinity;
      items.forEach((item, i) => {
        const rect = item.node.getBoundingClientRect();
        const d = Math.hypot(event.clientX - rect.left - rect.width / 2, event.clientY - rect.top - rect.height / 2);
        if (d < distance) { distance = d; closest = i; }
      });
      show(closest);
    };
    svg.onclick = inspect;
    svg.onpointerup = inspect;
    // Brushable charts cancel touchstart to draw a selection, suppressing
    // the browser's synthetic click. A stationary touch still reads a point.
    svg.ontouchstart = event => {
      const touch = event.touches[0];
      if (touch) pointerStart = { x: touch.clientX, y: touch.clientY };
    };
    svg.ontouchend = event => {
      const touch = event.changedTouches[0];
      if (touch) inspect({ clientX: touch.clientX, clientY: touch.clientY, target: event.target });
    };
  }
  return { DAY, finite, timestamp, dateKey, calendar, rollingMean, segments, linePath,
    monthTicks, aggregateWorkouts, bodySummary, calendarLoad, periodComparison, readingsAt, enhance };
});
