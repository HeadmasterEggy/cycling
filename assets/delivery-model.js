/* Pure arithmetic shared by the delivery page and console. No platform requests. */
(function (root) {
  'use strict';
  const DEFAULTS = Object.freeze({
    fare: 8, approach: 5, wait: 3, ride: 10, handoff: 2, recovery: 5,
    buffer: 5, cost: 0.5, target: 30,
    questMode: 'none', bonus: 0, eligible: 1, reward: 0, remaining: 5,
    deadline: 120, pWith: 0, pWithout: 0,
  });
  function numeric(value, name, min = 0, max = Infinity, integer = false) {
    if (value === '' || value == null || !Number.isFinite(Number(value))) throw new Error(`请填写${name}`);
    const n = Number(value);
    if (n < min || n > max || (integer && !Number.isInteger(n))) throw new Error(`${name}超出有效范围`);
    return n;
  }
  function estimate(input) {
    const v = { ...DEFAULTS, ...input };
    const values = {};
    const names = { fare: '报价', approach: '去店时间', wait: '等餐时间', ride: '送餐时间', handoff: '交付时间', recovery: '无单等待与转场', buffer: '额外延误', cost: '增量成本', target: '目标时薪' };
    Object.keys(names).forEach(k => { values[k] = numeric(v[k], names[k], k === 'target' ? 0.01 : 0); });
    const service = values.approach + values.wait + values.ride + values.handoff;
    const minutes = service + values.recovery;
    if (minutes <= 0) throw new Error('整轮用时必须大于 0');
    const pessimisticMinutes = minutes + values.buffer;
    let quest = 0, slowQuest = 0, questNote = '不计奖励；按当前报价估算。';
    if (v.questMode === 'per') {
      const bonus = numeric(v.bonus, '每次奖励');
      const count = numeric(v.eligible, '符合条件次数', 0, 20, true);
      quest = slowQuest = bonus * count;
      questNote = '仅填写派单报价之外、确认每次可获得的奖励。拼单次数以 App 实际计数为准。';
    } else if (v.questMode === 'milestone') {
      const reward = numeric(v.reward, '未获得的门槛奖励');
      const remaining = numeric(v.remaining, '距门槛还差次数', 0, 1000, true);
      const count = numeric(v.eligible, '本趟符合条件次数', 0, 20, true);
      const deadline = numeric(v.deadline, '奖励剩余分钟');
      const withP = numeric(v.pWith, '接单后达标概率', 0, 100) / 100;
      const withoutP = numeric(v.pWithout, '跳过后达标概率', 0, 100) / 100;
      const incremental = duration => {
        if (!remaining || !deadline || !count) return 0;
        const p = duration > deadline ? 0 : (count >= remaining ? 1 : withP);
        return reward * (p - withoutP);
      };
      quest = incremental(service);
      slowQuest = incremental(service + values.buffer);
      questNote = !remaining ? '门槛已完成；这档奖励的增量为 $0。'
        : service > deadline ? '本趟预计赶不上截止时间；接单后的达标概率按 0 计算。'
        : count >= remaining ? '本趟按时完成即可达标；仍扣除跳过这单也能达标的机会。'
        : `还差 ${remaining} 次，剩 ${deadline} 分钟；奖励增量 = $${reward.toFixed(2)} ×（接单后概率 − 跳过后概率）。概率由你估计。`;
    } else if (v.questMode !== 'none') throw new Error('请选择奖励模式');
    const contribution = values.fare + quest - values.cost;
    const baseRate = (values.fare - values.cost) * 60 / minutes;
    const rate = contribution * 60 / minutes;
    const slowRate = (values.fare + slowQuest - values.cost) * 60 / pessimisticMinutes;
    const needed = Math.max(0, values.target * minutes / 60 + values.cost - quest);
    const neededSlow = Math.max(0, values.target * pessimisticMinutes / 60 + values.cost - slowQuest);
    // Opportunity cost: what the same minutes earn if this offer is declined.
    // Optional, because it only exists when history can supply it.
    const hasBaseline = v.baseline !== '' && v.baseline != null && Number.isFinite(Number(v.baseline)) && Number(v.baseline) >= 0;
    const baseline = hasBaseline ? Number(v.baseline) : null;
    const edge = hasBaseline ? rate - baseline : null;
    const slowEdge = hasBaseline ? slowRate - baseline : null;
    const neededBaseline = hasBaseline ? Math.max(0, baseline * minutes / 60 + values.cost - quest) : null;
    return { ...values, service, minutes, pessimisticMinutes, quest, slowQuest, questNote,
      baseRate, rate, slowRate, needed, neededSlow, baseline, edge, slowEdge, neededBaseline,
      verdict: Math.min(rate, slowRate) >= values.target ? 'strong' : rate >= values.target ? 'borderline' : 'weak' };
  }
  // Extra delay affordable from the planned cycle, including a discontinuous
  // loss of milestone reward. It is a planning limit, not a cancellation rule.
  function delayBudget(input) {
    const r = estimate({ ...input, buffer: 0 });
    const budget = (r.fare + r.quest - r.cost) * 60 / r.target - r.minutes;
    const fareGap = Math.max(0, r.needed - r.fare);
    if (budget < -1e-9) return { belowTarget: true, extraMinutes: null, fareGap, limit: 'target' };
    let extraMinutes = Math.max(0, budget), limit = 'target';
    const delayed = estimate({ ...input, buffer: extraMinutes });
    if (delayed.slowQuest < r.quest) {
      const cutoff = Number(({ ...DEFAULTS, ...input }).deadline) - r.service;
      const afterCutoff = (r.fare + delayed.slowQuest - r.cost) * 60 / r.target - r.minutes;
      // Completing exactly at the deadline still qualifies. If the lower
      // reward can fund more time, the hourly target is the binding limit.
      extraMinutes = Math.max(cutoff, afterCutoff, 0);
      limit = afterCutoff > cutoff ? 'target' : 'questDeadline';
    }
    return { belowTarget: false, extraMinutes, fareGap, limit };
  }
  function settlement(input) {
    const hours = numeric(input.hours, '有效接单小时');
    const rate = numeric(input.rate, '最低标准', 0.01);
    const fare = numeric(input.fare, '周期运费');
    const promotions = numeric(input.promotions, '周期促销');
    const eligible = fare + promotions;
    const minimum = hours * rate;
    return { eligible, minimum, topup: Math.max(0, minimum - eligible) };
  }
  // Calibrate an accepted offer with the rider's own completed-order result.
  // This stays separate from GPS and from other accounts: only same-platform
  // amounts entered by the rider are eligible.
  function actualOutcome(input = {}) {
    const minutes = numeric(input.minutes, '实际整轮用时', 0.1, 10080);
    const fare = numeric(input.fare, '实际本趟运费', 0, 1000);
    const bonus = input.bonus === '' || input.bonus == null ? 0 : numeric(input.bonus, '已确认奖励', 0, 10000);
    const cost = input.cost === '' || input.cost == null ? 0 : numeric(input.cost, '实际增量成本', 0, 1000);
    const contribution = fare + bonus - cost;
    return { minutes, fare, bonus, cost, contribution, rate: contribution * 60 / minutes };
  }
  // Rank only completed, valid results. Incomplete drafts and malformed rows
  // stay out so a partial entry cannot appear to beat a finished trial.
  function outcomeReview(offers = []) {
    const rows = [];
    for (const offer of Array.isArray(offers) ? offers : []) {
      try {
        const actual = actualOutcome(offer.outcome || {});
        const plannedRate = offer.result && Number.isFinite(Number(offer.result.rate))
          ? Number(offer.result.rate) : null;
        rows.push({
          id: offer.id,
          context: (offer.context && offer.context.summary) || '',
          destination: offer.destination || '',
          ...actual,
          plannedRate,
          rateDelta: plannedRate == null ? null : actual.rate - plannedRate,
        });
      } catch (e) {
        // A saved offer becomes comparable only after all required outcome
        // fields are valid; the individual form still shows its own error.
      }
    }
    rows.sort((a, b) => b.rate - a.rate || Number(a.id) - Number(b.id));
    return {
      total: Array.isArray(offers) ? offers.length : 0,
      completed: rows.length,
      rows,
      best: rows[0] || null,
      gap: rows.length > 1 ? rows[0].rate - rows[1].rate : null,
    };
  }
  function median(a) {
    if (!a.length) return null;
    const s = a.slice().sort((x, y) => x - y), m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }
  function filteredCells(data, filters = {}) {
    const p = data.planning;
    if (!p) return [];
    const cutoff = new Date(p.recent_anchor + 'T00:00:00Z');
    cutoff.setUTCDate(cutoff.getUTCDate() - (p.recent_days - 1));
    const since = cutoff.toISOString().slice(0, 10);
    const ranges = { lunch: [11, 14], dinner: [17, 20], late: [20, 23] };
    return p.cells.filter(c => {
      if (filters.period === 'recent' && (c.date < since || c.date > p.recent_anchor)) return false;
      if (filters.day === 'weekday' && c.weekday >= 5) return false;
      if (filters.day === 'weekend' && c.weekday < 5) return false;
      if (filters.hour != null && c.hour !== Number(filters.hour)) return false;
      if (filters.zone && c.zone !== filters.zone) return false;
      const range = ranges[filters.time];
      return !range || (c.hour >= range[0] && c.hour < range[1]);
    });
  }
  function aggregate(data, filters = {}) {
    const p = data.planning;
    if (!p) return [];
    const groups = new Map();
    for (const c of filteredCells(data, filters)) {
      if (!groups.has(c.zone)) groups.set(c.zone, { name: c.zone, seconds: 0, pickups: 0, drops: 0, shifts: new Set(), waits: [] });
      const z = groups.get(c.zone);
      z.seconds += c.seconds; z.pickups += c.pickups; z.drops += c.drops;
      z.shifts.add(c.shift); z.waits.push(...c.wait_s);
    }
    return [...groups.values()].map(g => {
      const meta = data.zones.find(z => z.name === g.name) || {};
      const hours = g.seconds / 3600;
      const enough = hours >= p.min_hours && g.shifts.size >= p.min_shifts && g.pickups >= p.min_pickups;
      return { name: g.name, label: meta.label || g.name, pickups: g.pickups, drops: g.drops,
        hours, shifts: g.shifts.size, enough, rate: enough ? g.pickups / hours : null,
        wait: median(g.waits), waitCount: g.waits.length, flow: meta.flow, as_drop: meta.as_drop };
    }).sort((a, b) => Number(b.enough) - Number(a.enough) || (b.rate || 0) - (a.rate || 0) || b.pickups - a.pickups || a.name.localeCompare(b.name));
  }
  function hourly(data, filters = {}) {
    const p = data.planning;
    if (!p) return [];
    const rows = Array.from({length: 24}, (_, hour) => ({hour, seconds: 0, pickups: 0, shifts: new Set()}));
    for (const c of filteredCells(data, filters)) {
      const r = rows[c.hour];
      r.seconds += c.seconds; r.pickups += c.pickups; r.shifts.add(c.shift);
    }
    return rows.map(r => {
      const hours = r.seconds / 3600, shifts = r.shifts.size;
      const enough = hours >= p.min_hours && shifts >= p.min_shifts && r.pickups >= p.min_pickups;
      return {hour: r.hour, hours, pickups: r.pickups, shifts, enough, rate: enough ? r.pickups / hours : null};
    });
  }

  // ---- historical expectations --------------------------------------------
  // Pickups per recorded hour is a thin, noisy statistic: most zone-hours have
  // a handful of events. Treating every zone × time cell on its own ranks luck.
  // Instead, fit one multiplicative Poisson model
  //     rate(zone, daytype, hour) = base × timeFactor × zoneFactor
  // so a zone's quiet Tuesday is judged against how busy that hour usually is,
  // and a Friday dinner is not credited to the zone just because it was visited then.
  // Both factors are shrunk toward 1 with a gamma prior (iterative fitting).
  const DAYPARTS = Object.freeze([
    { key: 'lunch', label: '午餐', from: 11, to: 14 },
    { key: 'afternoon', label: '下午', from: 14, to: 17 },
    { key: 'dinner', label: '晚餐', from: 17, to: 20 },
    { key: 'late', label: '夜宵', from: 20, to: 23 },
  ]);
  const daypartOf = hour => DAYPARTS.find(d => hour >= d.from && hour < d.to) || null;
  const dayKey = weekend => (weekend ? 'we' : 'wd');
  // Wilson–Hilferty approximation of a gamma quantile; z is a normal quantile.
  function gammaQuantile(shape, rate, z) {
    if (!(shape > 0) || !(rate > 0)) return 0;
    const t = 1 / (9 * shape);
    return Math.max(0, shape * Math.pow(1 - t + z * Math.sqrt(t), 3) / rate);
  }
  const Z80 = 1.2815515655446004;
  function fitRates(data, filters = {}, opts = {}) {
    if (!data.planning) return null;
    const kTime = opts.kTime == null ? 4 : opts.kTime, kZone = opts.kZone == null ? 4 : opts.kZone;
    const cells = filteredCells(data, { period: filters.period }).filter(c => c.seconds > 0);
    let hours = 0, pickups = 0;
    const byTime = new Map(), byZone = new Map();
    const tag = c => ({ h: c.seconds / 3600, p: c.pickups, t: dayKey(c.weekday >= 5) + c.hour, z: c.zone, hour: c.hour, weekend: c.weekday >= 5 });
    const rows = cells.map(tag);
    for (const r of rows) {
      hours += r.h; pickups += r.p;
      const t = byTime.get(r.t) || { h: 0, p: 0 }; t.h += r.h; t.p += r.p; byTime.set(r.t, t);
      const z = byZone.get(r.z) || { h: 0, p: 0 }; z.h += r.h; z.p += r.p; byZone.set(r.z, z);
    }
    if (!hours) return null;
    const base = pickups / hours;
    const f = new Map([...byTime.keys()].map(k => [k, 1])), g = new Map([...byZone.keys()].map(k => [k, 1]));
    const expT = new Map(), expZ = new Map();
    for (let i = 0; i < 12; i++) {
      expZ.clear();
      for (const r of rows) expZ.set(r.z, (expZ.get(r.z) || 0) + r.h * base * f.get(r.t));
      for (const [k, v] of byZone) g.set(k, (v.p + kZone) / (expZ.get(k) + kZone));
      expT.clear();
      for (const r of rows) expT.set(r.t, (expT.get(r.t) || 0) + r.h * base * g.get(r.z));
      for (const [k, v] of byTime) f.set(k, (v.p + kTime) / (expT.get(k) + kTime));
    }
    const zoneFactor = zone => (g.has(zone) ? g.get(zone) : 1);
    return {
      base, hours, pickups, kTime, kZone,
      zoneFactor,
      rate: (zone, weekend, hour) => base * (f.get(dayKey(weekend) + hour) || 1) * (zone ? zoneFactor(zone) : 1),
      known: (weekend, hour) => (byTime.get(dayKey(weekend) + hour) || { h: 0 }).h,
      timeStats: (weekend, hour) => {
        const key = dayKey(weekend) + hour, t = byTime.get(key);
        if (!t) return null;
        const shape = kTime + t.p, rate = kTime + (expT.get(key) || 0);
        return { hours: t.h, pickups: t.p, mean: base * shape / rate,
          lo: base * gammaQuantile(shape, rate, -Z80), hi: base * gammaQuantile(shape, rate, Z80) };
      },
    };
  }
  // Mean income per order, from the ledger. Quest is optional because it is
  // not a per-order promise; the page labels which assumption is in use.
  function orderValue(data) {
    const o = data.offers || {}, weeks = o.weeks || [];
    const n = weeks.reduce((s, w) => s + (w.records || 0), 0);
    const fare = n ? weeks.reduce((s, w) => s + w.fare, 0) / n : (o.median_fare != null ? o.median_fare : 7.5);
    const checks = (o.statement_checks || []).map(c => ({ c, log: weeks.find(w => w.week === c.week) })).filter(x => x.log && x.log.records);
    const cn = checks.reduce((s, x) => s + x.log.records, 0);
    const withQuest = cn ? checks.reduce((s, x) => s + x.c.fare + x.c.quest, 0) / cn : null;
    return { fare, withQuest, records: n, questRecords: cn };
  }
  // Mean order value for a daypart, shrunk toward the overall mean. Only
  // present when analyze_delivery.py saw the private order log.
  function valueByDaypart(data, perOrder) {
    const dp = data.offers && data.offers.by_daypart;
    if (!dp) return () => perOrder;
    const rows = Object.values(dp), n = rows.reduce((s, r) => s + r.n, 0);
    const overall = n ? rows.reduce((s, r) => s + r.n * r.mean, 0) / n : 0, k = 8;
    return key => {
      const r = dp[key];
      if (!r || !overall) return perOrder;
      return perOrder * ((r.n * r.mean + k * overall) / (r.n + k)) / overall;
    };
  }
  // Compare the quoted fare with the rider's own historical Uber fares for
  // the same meal window. This stays separate from the whole-cycle estimate:
  // it has no distance, duration, Quest, tip or live-demand information.
  function fareReference(data, input = {}) {
    const dp = daypartOf(Number(input.hour));
    const row = dp && data && data.offers && data.offers.by_daypart && data.offers.by_daypart[dp.key];
    const n = Number(row && row.n), mean = Number(row && row.mean), fare = Number(input.fare);
    if (!dp || input.fare === '' || input.fare == null ||
      !Number.isFinite(n) || n <= 0 || !Number.isFinite(mean) || mean <= 0 ||
      !Number.isFinite(fare) || fare < 0) return null;
    const difference = Math.round((fare - mean) * 100) / 100;
    return {
      daypart: dp.key, label: dp.label, window: `${dp.from}–${dp.to}`,
      n, mean, asOf: (data.offers && data.offers.as_of) || (data.meta && data.meta.last) || null,
      fare, difference, percent: Math.round(Math.abs(difference) / mean * 100),
      direction: difference > 0 ? 'higher' : difference < 0 ? 'lower' : 'equal',
    };
  }
  function slots(data, filters = {}, opts = {}) {
    const fit = fitRates(data, filters, opts);
    if (!fit) return [];
    const valueOf = typeof opts.value === 'function' ? opts.value : () => opts.value;
    const cost = opts.cost || 0, kSlot = opts.kSlot == null ? 2 : opts.kSlot;
    const minHours = opts.minHours == null ? 0.75 : opts.minHours, minShifts = opts.minShifts == null ? 3 : opts.minShifts;
    const thinShifts = data.planning.min_shifts || 4, thinPickups = 4;
    const groups = new Map();
    for (const c of filteredCells(data, { period: filters.period })) {
      const dp = daypartOf(c.hour);
      if (!dp || c.seconds <= 0) continue;
      const weekend = c.weekday >= 5, key = `${c.zone}|${dayKey(weekend)}|${dp.key}`;
      if (!groups.has(key)) groups.set(key, { zone: c.zone, weekend, dp, h: 0, p: 0, prior: 0, shifts: new Set() });
      const x = groups.get(key), h = c.seconds / 3600;
      x.h += h; x.p += c.pickups; x.prior += h * fit.rate(c.zone, weekend, c.hour); x.shifts.add(c.shift);
    }
    const zoneMeta = new Map((data.zones || []).map(z => [z.name, z]));
    const rows = [];
    for (const x of groups.values()) {
      if (x.h < minHours || x.shifts.size < minShifts) continue;
      const shape = (x.prior / x.h) * kSlot + x.p, rate = kSlot + x.h;
      const value = valueOf(x.dp.key) - cost;
      const mean = shape / rate, lo = gammaQuantile(shape, rate, -Z80), hi = gammaQuantile(shape, rate, Z80);
      rows.push({
        zone: x.zone, label: (zoneMeta.get(x.zone) || {}).label || x.zone, weekend: x.weekend, daypart: x.dp.key, daypartLabel: x.dp.label,
        window: `${x.dp.from}–${x.dp.to}`, hours: x.h, pickups: x.p, shifts: x.shifts.size,
        observed: x.p / x.h, rate: mean, rateLo: lo, rateHi: hi,
        value, dollars: mean * value, dollarsLo: lo * value, dollarsHi: hi * value,
        thin: x.p < thinPickups || x.shifts.size < thinShifts,
      });
    }
    // Rank by the observed proxy the source data supports. Dollar fields remain
    // available only as a user-entered scenario; GPS activity is cross-platform
    // and recorded time is not platform online time.
    return rows.sort((a, b) => Number(a.thin) - Number(b.thin) || b.rate - a.rate || b.hours - a.hours || a.label.localeCompare(b.label));
  }
  function timeCurve(data, filters = {}, opts = {}) {
    const fit = fitRates(data, filters, opts);
    if (!fit) return null;
    const valueOf = typeof opts.value === 'function' ? opts.value : () => opts.value;
    const cost = opts.cost || 0, minHours = opts.minHours == null ? 0.75 : opts.minHours;
    const out = { base: fit.base, weekday: [], weekend: [] };
    for (const weekend of [false, true]) {
      for (let hour = 0; hour < 24; hour++) {
        const s = fit.timeStats(weekend, hour);
        if (!s || s.hours <= 0) continue;
        const dp = daypartOf(hour), value = (dp ? valueOf(dp.key) : valueOf(null)) - cost;
        out[weekend ? 'weekend' : 'weekday'].push({ hour, hours: s.hours, pickups: s.pickups, enough: s.hours >= minHours,
          rate: s.mean, rateLo: s.lo, rateHi: s.hi, value, dollars: s.mean * value, dollarsLo: s.lo * value, dollarsHi: s.hi * value });
      }
    }
    return out;
  }
  // Context for one offer: what declining would earn, and how long the next
  // order is likely to take to arrive after this one ends.
  function advise(data, input = {}) {
    const fit = fitRates(data, { period: input.period || 'all' }, input);
    if (!fit) return null;
    const weekend = !!input.weekend, hour = Math.min(23, Math.max(0, Math.floor(Number(input.hour))));
    const valueOf = typeof input.value === 'function' ? input.value : () => input.value;
    const cost = input.cost || 0;
    const stats = fit.timeStats(weekend, hour);
    const dp = daypartOf(hour), net = valueOf(dp ? dp.key : null) - cost;
    const g = input.zone ? fit.zoneFactor(input.zone) : 1;
    const known = !!stats && stats.hours >= 0.5;
    const service = Number(input.service) || 0;
    const endHour = Math.min(23, Math.floor(hour + service / 60));
    const endStats = fit.timeStats(weekend, endHour);
    const endKnown = !!endStats && endStats.hours >= 0.5;
    const destRate = input.dest && endKnown ? fit.rate(input.dest, weekend, endHour) : (endKnown ? fit.rate(null, weekend, endHour) : null);
    return {
      known, rate: known ? stats.mean * g : null, rateLo: known ? stats.lo * g : null, rateHi: known ? stats.hi * g : null,
      baseline: known ? stats.mean * g * net : null, baselineLo: known ? stats.lo * g * net : null, baselineHi: known ? stats.hi * g * net : null,
      hours: stats ? stats.hours : 0, net, endHour, endKnown, destRate,
      cycleMin: destRate ? 60 / destRate : null,
      idle: destRate ? Math.max(0, 60 / destRate - service) : null,
    };
  }
  // Minutes for each leg from the rider's own measured pace instead of guesses.
  function suggestTimes(data, input = {}) {
    const zones = data.zones || [], byName = new Map(zones.map(z => [z.name, z]));
    const paces = zones.filter(z => z.min_per_km > 0 && z.hours >= 1).map(z => z.min_per_km);
    const fallback = median(paces) || 4.8;
    const pace = name => { const z = byName.get(name); return z && z.min_per_km > 0 && z.hours >= 1 ? z.min_per_km : fallback; };
    const zone = byName.get(input.pickupZone);
    const waitS = zone && zone.pickup_wait_med > 0 ? zone.pickup_wait_med : (data.summary || {}).pickup_wait_med;
    const handS = (data.summary || {}).drop_wait_med;
    const km = (v, name) => numeric(v, name, 0, 100);
    return {
      approach: Math.round(km(input.approachKm, '去店距离') * pace(input.pickupZone) * 10) / 10,
      ride: Math.round(km(input.rideKm, '送餐距离') * pace(input.destZone || input.pickupZone) * 10) / 10,
      wait: waitS ? Math.round(waitS / 6) / 10 : null,
      handoff: handS ? Math.round(handS / 6) / 10 : null,
      pace: pace(input.pickupZone), destPace: pace(input.destZone || input.pickupZone), fallback,
    };
  }
  function sensitivity(input, delays = [0, 5, 10, 15]) {
    return delays.map(delay => {
      const extra = numeric(delay, '额外延误');
      const r = estimate({ ...input, buffer: extra });
      return { delay: extra, minutes: r.pessimisticMinutes, rate: r.slowRate,
        quest: r.slowQuest, needed: r.neededSlow, meetsTarget: r.slowRate >= r.target };
    });
  }
  // The whole decision in one line: an order is worth taking while its
  // whole-cycle minutes stay under (fare + Quest share - cost) x 60 / target.
  function acceptLine(input = {}) {
    const fare = numeric(input.fare, '运费'), quest = numeric(input.quest == null ? 0 : input.quest, '每单 Quest');
    const target = numeric(input.target, '目标时薪', 0.01), cost = numeric(input.cost == null ? 0 : input.cost, '增量成本');
    const value = Math.max(0, fare + quest - cost);
    const maxMinutes = value * 60 / target;
    const hasMinutes = input.minutes !== '' && input.minutes != null;
    const minutes = hasMinutes ? numeric(input.minutes, '整轮分钟', 0.01) : null;
    const rate = hasMinutes ? value * 60 / minutes : null;
    return { fare, quest, target, cost, value, maxMinutes, minutes, rate,
      slack: hasMinutes ? maxMinutes - minutes : null,
      take: hasMinutes ? rate >= target : null };
  }
  // Ledger totals from a start week on, split into fare, Quest and other.
  // Quest is shared per completed order because it pays per completion.
  function ledgerSince(data, from) {
    const weeks = ((data.offers || {}).weeks || []).filter(w => !from || w.week >= from);
    const sum = k => weeks.reduce((s, w) => s + (w[k] || 0), 0);
    const records = sum('records'), fare = sum('fare'), quest = sum('quest'), other = sum('other');
    const total = fare + quest + other;
    return { from, weeks, records, fare, quest, other, total,
      farePer: records ? fare / records : null, questPer: records ? quest / records : null,
      questShare: total ? quest / total : null,
      questRange: weeks.filter(w => w.records >= 10).map(w => w.quest / w.records) };
  }
  const api = { DEFAULTS, acceptLine, ledgerSince, DAYPARTS, estimate, delayBudget, sensitivity, settlement, actualOutcome, outcomeReview, aggregate, hourly, median,
    fitRates, orderValue, valueByDaypart, fareReference, slots, timeCurve, advise, suggestTimes, daypartOf };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.DeliveryModel = api;
})(typeof window !== 'undefined' ? window : this);
