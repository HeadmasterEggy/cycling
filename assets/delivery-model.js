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
    return { ...values, service, minutes, pessimisticMinutes, quest, slowQuest, questNote,
      baseRate, rate, slowRate, needed, neededSlow,
      verdict: Math.min(rate, slowRate) >= values.target ? 'strong' : rate >= values.target ? 'borderline' : 'weak' };
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
  function sensitivity(input, delays = [0, 5, 10, 15]) {
    return delays.map(delay => {
      const extra = numeric(delay, '额外延误');
      const r = estimate({ ...input, buffer: extra });
      return { delay: extra, minutes: r.pessimisticMinutes, rate: r.slowRate,
        quest: r.slowQuest, needed: r.neededSlow, meetsTarget: r.slowRate >= r.target };
    });
  }
  const api = { DEFAULTS, estimate, sensitivity, settlement, aggregate, hourly, median };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.DeliveryModel = api;
})(typeof window !== 'undefined' ? window : this);
