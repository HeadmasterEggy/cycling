'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const M = require('../assets/chart-model.js');
const point = (date, v) => ({ date, t: M.timestamp(date), v });
const workout = (date, values = {}) => ({ date, city: 'Sydney', distance_km: 10, duration_min: 30,
  active_kcal: 200, elev_gain_m: 80, hr_avg: 110, avg_speed_kmh: 20, ...values });

test('calendar includes leap day and remains daily across the Sydney DST boundary', () => {
  assert.deepEqual(M.calendar('2024-02-28', '2024-03-01'), ['2024-02-28', '2024-02-29', '2024-03-01']);
  assert.deepEqual(M.calendar('2026-10-03', '2026-10-05'), ['2026-10-03', '2026-10-04', '2026-10-05']);
  assert.deepEqual(M.calendar('2026-02-01', '2026-01-01'), []);
  assert.deepEqual(M.calendar(null, undefined), []);
});

test('rolling means use exactly seven calendar days and preserve measured zero', () => {
  const sparse = [point('2026-01-01', 700), point('2026-01-07', 70), point('2026-01-08', 0), point('2026-01-20', 20)];
  assert.deepEqual(M.rollingMean(sparse), [700, 385, 35, 20]);
  assert.deepEqual(M.rollingMean([point('2026-01-01', null)]), [null]);
});

test('line segments break at missing days or missing readings', () => {
  const points = ['01', '02', '04', '05', '06'].map((day, i) => point(`2026-01-${day}`, i));
  const groups = M.segments(points, [1, 2, 3, null, 5]);
  assert.deepEqual(groups.map(group => group.map(p => p.date.slice(-2))), [['01', '02'], ['04'], ['06']]);
  assert.equal(M.linePath(points, [1, 2, 3, null, 5], t => t / M.DAY, v => v).match(/M /g).length, 3);
});

test('workout aggregation uses the exported Health fields and counts each riding day once', () => {
  const data = [workout('2026-08-02'), workout('2026-08-01'), workout('2026-08-01', { hr_avg: null }),
    workout('2026-07-31', { active_kcal: 50, hr_avg: 160, avg_speed_kmh: 9 })];
  const result = M.aggregateWorkouts(data, { total_distance_km: 999, generated_at: 'export' });
  assert.equal(result.summary.total_distance_km, 40);
  assert.equal(result.summary.total_duration_h, 2);
  assert.equal(result.summary.total_kcal, 650);
  assert.equal(result.summary.total_elev_gain_m, 320);
  assert.equal(result.summary.active_days, 3);
  assert.equal(result.summary.longest_streak_days, 3);
  assert.equal(result.summary.generated_at, 'export');
  assert.equal(result.summary.hr_zones['100-120'], 2);
  assert.equal(result.summary.hr_zones['>=160'], 1);
  assert.equal(result.summary.speed_buckets['20-25'], 3);
  assert.equal(result.byDay.get('2026-08-01').rides, 2);
  assert.deepEqual(result.monthly.map(m => [m.month, m.kcal, m.rides]), [['2026-07', 50, 1], ['2026-08', 600, 3]]);
  const empty = M.aggregateWorkouts([], result.summary);
  assert.equal(empty.summary.total_kcal, 0);
  assert.equal(empty.summary.first_ride, null);
  assert.equal(empty.summary.longest_streak_days, 0);
});

test('sparse rolling distance does not accumulate seven riding days over multiple weeks', () => {
  const result = M.calendarLoad([{ date: '2026-01-01', distance_km: 100 }, { date: '2026-01-08', distance_km: 20 }]);
  assert.equal(result.length, 8);
  assert.equal(result[6].km, 100);
  assert.deepEqual(result[7], { date: '2026-01-08', km: 20, days: 1, observed: 1 });
});

test('period comparisons use disjoint calendar windows, not fourteen recorded samples', () => {
  const points = [point('2026-01-01', 10), point('2026-01-14', 20), point('2026-01-15', 30), point('2026-01-28', 40)];
  const result = M.periodComparison(points);
  assert.equal(result.comparable, true);
  assert.deepEqual(result.first.map(p => p.v), [10, 20]);
  assert.deepEqual(result.recent.map(p => p.v), [30, 40]);
  assert.equal(M.periodComparison(points.slice(0, -1)).comparable, false);
});

test('body summaries show selected endpoints and sample counts, excluding overlapping sleep totals', () => {
  const rows = [{ date: '2026-01-01', sleep_h: 8, hrv: 40, steps: 0 },
    { date: '2026-01-14', sleep_h: 16, hrv: 60 }, { date: '2026-01-28', sleep_h: 7, hrv: 60, steps: 1000 }];
  const result = M.bodySummary(rows, [{ date: '2026-01-28', value: 41 }], []);
  assert.equal(result.body_deltas.sleep_h.baseline, 8);
  assert.equal(result.body_deltas.sleep_h.delta, -1);
  assert.equal(result.body_deltas.sleep_h.baseline_n, 1);
  assert.equal(result.body_deltas.hrv.baseline, 50);
  assert.equal(result.body_deltas.steps.baseline, 0);
  assert.equal(result.weight_latest_kg, null);
  assert.equal(result.vo2max_latest, 41);
  assert.equal(M.bodySummary(rows.slice(0, 2)).body_deltas.hrv, null);
});

test('composite readouts show missing values instead of a nearby date', () => {
  const tracks = [{ pts: [point('2026-01-01', 60)] }, { pts: [point('2026-01-02', 8)] }];
  assert.deepEqual(M.readingsAt(tracks, '2026-01-01').map(r => r.p?.v ?? null), [60, null]);
});

function appContext(health, routes = [], storage = {}) {
  const nodes = new Map();
  const document = { querySelectorAll: () => [], querySelector: () => null,
    getElementById: id => {
      if (!nodes.has(id)) nodes.set(id, { tagName: id.endsWith('Chart') || id.endsWith('Scatter') ? 'svg' : 'div',
        innerHTML: '', textContent: '', style: {}, setAttribute() {}, querySelectorAll: () => [] });
      return nodes.get(id);
    } };
  const window = { HEALTH_DATA: health, ROUTES_DATA: routes, ChartModel: M, addEventListener() {} };
  const localStorage = { getItem: key => storage[key] || null, setItem: (key, value) => { storage[key] = value; }, removeItem: key => { delete storage[key]; } };
  const context = vm.createContext({ window, document, localStorage, console, Date, Set, Map });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../assets/app.js'), 'utf8'), context);
  return { window, nodes, context };
}

test('withRange rebuilds partial-month totals by exact city, filters health by stay, and restores originals on failure', () => {
  const health = { summary: { generated_at: 'source' }, daily: [
    { date: '2026-08-01', distance_km: 999, steps: 100 }, { date: '2026-08-02', distance_km: 999, steps: 200 }],
    workouts: [workout('2026-08-01'), workout('2026-08-02'), workout('2026-08-02', { city: 'Shanghai', distance_km: 500 })],
    monthly: [{ month: '2026-08', distance_km: 520 }], vo2max: [], weight: [],
    stays: [{ city: 'Sydney', from: '2026-08-01', to: '2026-08-31' }] };
  const originals = { ...health }, routes = [{ city: 'Sydney', start_date: '2026-08-02' }, { city: 'Sydney', start_date: '2026-08-01' }];
  const { window } = appContext(health, routes);
  window.activeCity = 'Sydney';
  window.activeRange = { from: new Date('2026-08-02'), to: new Date('2026-08-02') };
  assert.throws(() => window.withRange(() => {
    assert.equal(health.monthly[0].distance_km, 10);
    assert.equal(health.summary.ride_count, 1);
    assert.equal(health.daily[0].distance_km, 10);
    assert.equal(health.daily[0].steps, 200);
    assert.equal(window.ROUTES_DATA.length, 1);
    throw new Error('render failure');
  }), /render failure/);
  for (const key of Object.keys(originals)) assert.equal(health[key], originals[key]);
  assert.equal(window.ROUTES_DATA, routes);
});

test('empty filtered renders replace the previously drawn charts and summaries', () => {
  const health = { daily: [], workouts: [], weight: [], vo2max: [], monthly: [], summary: M.aggregateWorkouts([]).summary };
  const { context, nodes } = appContext(health);
  vm.runInContext('renderPersonalRecords(); renderLoadChart(); renderJourney(); renderClimbChart(); renderMonthlyChart(); renderTradePanel(); renderAnnotation(); renderEffortQuadrant(); renderFitnessForm();', context);
  for (const id of ['prGrid', 'loadChart', 'journeyChart', 'climbChart', 'monthlyChart', 'ffChart', 'effortChart']) assert.match(nodes.get(id).innerHTML, /没有/);
  assert.equal(nodes.get('climbFoot').innerHTML, '—');
  assert.match(nodes.get('tradePanel').innerHTML, /至少需 2 次/);
  assert.match(nodes.get('annotationQuote').textContent, /没有骑行记录/);
});

test('invalid saved range falls back to all records instead of breaking chart rendering', () => {
  const { window } = appContext({ daily: [], workouts: [], summary: {} }, [], { cyclingActiveRange: '{"from":"broken","to":"2026-01-01"}' });
  assert.equal(window.getUserRange(), null);
});

test('fitness chart retains preceding history when the selected day has no workout', () => {
  const health = { workouts: [workout('2026-08-30')], daily: [{ date: '2026-08-31', steps: 200 }], summary: {},
    vo2max: [], weight: [], monthly: [] };
  const { window, context, nodes } = appContext(health);
  window.activeRange = { from: new Date('2026-08-31'), to: new Date('2026-08-31') };
  window.withRange(() => vm.runInContext('renderFitnessForm()', context));
  assert.match(nodes.get('ffChart').innerHTML, /<path/);
  assert.match(nodes.get('ffFoot').textContent, /2026-08-31/);
  assert.doesNotMatch(nodes.get('ffChart').innerHTML, /NaN|Infinity/);
});

test('chart empty states target existing chart and summary elements', () => {
  const app = fs.readFileSync(path.join(__dirname, '../assets/app.js'), 'utf8');
  const markup = fs.readFileSync(path.join(__dirname, '../cycling-analysis.html'), 'utf8');
  const ids = new Set([...markup.matchAll(/\bid="([^"\s]+)"/g)].map(m => m[1]));
  for (const block of app.matchAll(/clearChart\(\[([^\]]+)\]/g)) {
    for (const id of block[1].matchAll(/'([^']+)'/g)) assert.ok(ids.has(id[1]), `Missing chart host: ${id[1]}`);
  }
});
