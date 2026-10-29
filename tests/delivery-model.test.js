const {test} = require('node:test');
const assert = require('node:assert/strict');
const M = require('../assets/delivery-model.js');
const near = (a,b) => assert.ok(Math.abs(a-b)<1e-8, `${a} != ${b}`);

test('whole-cycle time, costs and delay determine required fare', () => {
  const r = M.estimate({fare: 15.27});
  assert.equal(r.service,20);
  assert.equal(r.minutes,25);
  near(r.rate,35.448);
  assert.equal(r.needed,13);
  assert.equal(r.neededSlow,15.5);
  assert.equal(r.verdict,'borderline');
  assert.equal(r.quest,0);
  assert.equal(M.estimate({fare:15.5}).verdict,'strong');
  assert.equal(M.estimate({fare:8}).verdict,'weak');
  near(M.estimate({recovery:10}).rate,15);
});
test('a batch uses one set of times and only confirmed eligible reward counts', () => {
  const r = M.estimate({fare:15,questMode:'per',bonus:2.25,eligible:2});
  assert.equal(r.minutes,25);
  assert.equal(r.quest,4.5);
  near(r.rate,45.6);
  assert.equal(M.estimate({questMode:'none',bonus:999,eligible:2}).quest,0);
});
test('milestone reward prices the difference from skipping, including opportunity loss', () => {
  const v = {questMode:'milestone',reward:30,remaining:2,eligible:1,deadline:60,pWith:60,pWithout:40};
  near(M.estimate(v).quest,6);
  near(M.estimate({...v,pWith:20}).quest,-6);
  assert.equal(M.estimate({...v,remaining:0}).quest,0);
  assert.equal(M.estimate({...v,eligible:0}).quest,0);
  assert.equal(M.estimate({...v,deadline:0}).quest,0);
});
test('delay crossing the deadline loses the milestone; recovery occurs after completion', () => {
  const r = M.estimate({questMode:'milestone',reward:20,remaining:1,eligible:1,deadline:22,pWithout:50,recovery:30});
  assert.equal(r.quest,10); // service completes at minute 20, before deadline
  assert.equal(r.slowQuest,-10); // delayed completion at minute 25
  assert.equal(r.minutes,50);
  near(r.neededSlow,38);
});
test('bad inputs clear rather than silently supplying optimistic defaults', () => {
  for (const v of [{fare:''},{wait:-1},{cost:NaN},{fare:Infinity},{target:0},
    {approach:0,wait:0,ride:0,handoff:0,recovery:0},{questMode:'unknown'},
    {questMode:'per',eligible:1.5},{questMode:'milestone',pWith:101},
    {questMode:'milestone',remaining:-1}]) assert.throws(()=>M.estimate(v));
});
test('minimum income compares the entire period including promotions, never adds a second floor', () => {
  assert.deepEqual(M.settlement({hours:10,rate:31.3,fare:200,promotions:50}),{eligible:250,minimum:313,topup:63});
  assert.equal(M.settlement({hours:10,rate:31.3,fare:200,promotions:150}).topup,0);
  assert.equal(M.settlement({hours:0,rate:31.3,fare:0,promotions:0}).topup,0);
  assert.throws(()=>M.settlement({hours:'',rate:31.3,fare:200,promotions:50}));
});
function fixture() {
  const cells = Array.from({length:4},(_,shift)=>({shift,zone:'A',date:'2026-08-29',weekday:5,hour:18,seconds:1800,pickups:2,drops:1,wait_s:[60]}));
  cells.push({shift:0,zone:'A',date:'2026-08-29',weekday:5,hour:19,seconds:7200,pickups:0,drops:0,wait_s:[]});
  cells.push({shift:4,zone:'A',date:'2026-08-02',weekday:6,hour:12,seconds:3600,pickups:10,drops:0,wait_s:[]});
  cells.push({shift:5,zone:'A',date:'2026-08-03',weekday:0,hour:12,seconds:3600,pickups:3,drops:0,wait_s:[]});
  cells.push({shift:6,zone:'B',date:'2026-08-29',weekday:5,hour:18,seconds:60,pickups:6,drops:0,wait_s:[]});
  return {zones:[{name:'A',label:'Area A'},{name:'B',label:'Area B'}],planning:{cells,min_hours:1,min_shifts:4,min_pickups:6,recent_days:28,recent_anchor:'2026-08-30'}};
}
test('filtered frequency retains zero-event exposure and distinct shifts', () => {
  const a = M.aggregate(fixture(),{period:'recent',day:'weekend',time:'dinner'})[0];
  assert.equal(a.hours,4);
  assert.equal(a.pickups,8);
  assert.equal(a.rate,2);
  assert.equal(a.shifts,4);
  assert.equal(a.wait,60);
  const b = M.aggregate(fixture())[1];
  assert.equal(b.name,'B');
  assert.equal(b.rate,null);
  assert.equal(b.enough,false);
});
test('recent cutoff includes day 28 and recomputes eligibility after hour or day filters', () => {
  const a = M.aggregate(fixture(),{period:'recent'})[0];
  assert.equal(a.hours,5);
  assert.equal(a.pickups,11);
  assert.equal(a.shifts,5);
  const weekday = M.aggregate(fixture(),{period:'recent',day:'weekday'})[0];
  assert.equal(weekday.pickups,3);
  assert.equal(weekday.rate,null);
  assert.equal(M.aggregate(fixture(),{hour:18})[0].rate,4);
  assert.equal(M.aggregate(fixture(),{hour:19})[0].rate,null);
  assert.deepEqual(M.aggregate(fixture(),{time:'late'}),[]);
});
test('city hourly bars count one shift across zones and keep quiet hours', () => {
  const d = fixture();
  d.planning.cells.push({...d.planning.cells[0],zone:'B',pickups:0,seconds:3600});
  const hours = M.hourly(d);
  assert.equal(hours.length,24);
  assert.equal(hours[18].shifts,5);
  near(hours[18].hours,3+1/60);
  assert.equal(hours[19].hours,2);
  assert.equal(hours[19].pickups,0);
  assert.equal(hours[19].rate,null);
});
test('delay comparisons start from the planned cycle, not from an already applied buffer', () => {
  const rows = M.sensitivity({fare:15.5,buffer:20,cost:.5},[0,5,10]);
  assert.deepEqual(rows.map(r=>r.minutes),[25,30,35]);
  assert.deepEqual(rows.map(r=>r.meetsTarget),[true,true,false]);
  near(rows[0].rate,36);
  near(rows[1].rate,30);
  near(rows[2].needed,18);
  assert.throws(()=>M.sensitivity({},[-1]));
});
test('delay comparison reprices a Quest deadline, including lost skipping opportunity', () => {
  const rows = M.sensitivity({fare:20,questMode:'milestone',reward:40,
    remaining:1,eligible:1,deadline:22,pWithout:50,recovery:30},[0,2,3]);
  assert.deepEqual(rows.map(r=>r.quest),[20,20,-20]);
  assert.deepEqual(rows.map(r=>r.minutes),[50,52,53]);
  near(rows[2].rate,-.5*60/53);
  assert.ok(rows[2].needed > rows[1].needed+40);
});
test('zone hourly comparison uses exactly the same date and meal exposure as its summary', () => {
  const data = fixture();
  const filters = {period:'recent',day:'weekend',time:'dinner',zone:'A'};
  const summary = M.aggregate(data,filters)[0];
  const hours = M.hourly(data,filters);
  near(hours.reduce((sum,h)=>sum+h.hours,0),summary.hours);
  assert.equal(hours.reduce((sum,h)=>sum+h.pickups,0),summary.pickups);
  assert.equal(summary.waitCount,4);
  assert.equal(hours[18].rate,4);
  assert.equal(hours[19].rate,null); // quiet exposure is retained, not shown as eligible
  assert.equal(hours[12].hours,0); // lunch and older dates cannot leak into dinner
  assert.equal(M.hourly(data,{...filters,zone:'B'})[18].rate,null);
  assert.equal(M.aggregate(data,{...filters,hour:'18'})[0].rate,4);
});
test('the recent record window ends at its displayed anchor and empty filters stay empty', () => {
  const data = fixture();
  data.planning.cells.push({...data.planning.cells[0],date:'2026-08-31',pickups:999});
  assert.equal(M.aggregate(data,{period:'recent',zone:'A'})[0].pickups,11);
  assert.deepEqual(M.aggregate(data,{zone:'unknown'}),[]);
  assert.ok(M.hourly(data,{zone:'unknown'}).every(h=>h.rate===null && h.hours===0));
  assert.deepEqual(M.hourly({zones:[]}),[]);
});

function history() {
  // Zone A is only ever visited at the busy hour, zone B only at the quiet one.
  const cells = [];
  for (let s = 0; s < 6; s++) {
    cells.push({shift:s,zone:'A',date:'2026-08-03',weekday:0,hour:18,seconds:3600,pickups:4,drops:0,wait_s:[]});
    cells.push({shift:s,zone:'B',date:'2026-08-04',weekday:1,hour:15,seconds:3600,pickups:1,drops:0,wait_s:[]});
    cells.push({shift:s,zone:'C',date:'2026-08-05',weekday:2,hour:18,seconds:3600,pickups:4,drops:0,wait_s:[]});
  }
  return {zones:[{name:'A',label:'A'},{name:'B',label:'B'},{name:'C',label:'C'}],
    planning:{cells,min_hours:1,min_shifts:4,min_pickups:6,recent_days:28,recent_anchor:'2026-08-30'}};
}
test('opportunity cost is optional and compares against declining', () => {
  const none = M.estimate({fare: 15.27});
  assert.equal(none.baseline, null); assert.equal(none.edge, null);
  const r = M.estimate({fare: 15.27, baseline: 40});
  near(r.edge, r.rate - 40);
  near(r.neededBaseline, 40 * 25 / 60 + 0.5);
  assert.equal(M.estimate({fare: 8, baseline: ''}).baseline, null);
});
test('slot ranking is exposure-adjusted and shrinks thin evidence', () => {
  const D = history();
  const rows = M.slots(D, {period: 'all'}, {value: 10, cost: 0});
  const a = rows.find(r => r.zone === 'A'), b = rows.find(r => r.zone === 'B');
  assert.ok(a.rate > b.rate * 2, 'busy slot ranks above quiet slot');
  assert.ok(a.rate < 4 && a.rate > 3, `shrunk toward the model, got ${a.rate}`);
  assert.ok(a.dollarsLo < a.dollars && a.dollars < a.dollarsHi);
  assert.equal(rows[0].dollars >= rows[rows.length - 1].dollars, true);
  assert.deepEqual(M.slots(D, {period: 'all'}, {value: 10, cost: 0, minHours: 100}), []);
});
test('advise reports baseline and destination pacing, and flags unknown hours', () => {
  const D = history();
  const a = M.advise(D, {zone: 'A', dest: 'C', weekend: false, hour: 18, service: 20, value: 10, cost: 0});
  assert.ok(a.known && a.baseline > 0 && a.cycleMin > 0);
  assert.equal(a.idle, Math.max(0, a.cycleMin - 20));
  assert.equal(M.advise(D, {weekend: false, hour: 3, service: 20, value: 10}).known, false);
});
test('suggested times use the rider\'s own pace and fall back to the city median', () => {
  const D = {zones: [{name:'A',min_per_km:4,hours:3,pickup_wait_med:120},{name:'B',min_per_km:6,hours:3,pickup_wait_med:0}],
    summary: {pickup_wait_med: 150, drop_wait_med: 90}};
  const t = M.suggestTimes(D, {pickupZone:'A', destZone:'B', approachKm:1, rideKm:2});
  assert.equal(t.approach, 4); assert.equal(t.ride, 12); assert.equal(t.wait, 2); assert.equal(t.handoff, 1.5);
  assert.equal(M.suggestTimes(D, {approachKm:1, rideKm:1}).approach, 5);
  assert.throws(() => M.suggestTimes(D, {approachKm:'', rideKm:1}));
});
test('offer fare reference uses only the self-account Uber daypart fare', () => {
  const D = {
    meta: {last: '2026-10-11'},
    offers: {
      by_daypart: {
        lunch: {n: 62, mean: 9.84, quest: 500, tips: 20, other: 30},
        afternoon: {n: 26, mean: 9.03},
        dinner: {n: 171, mean: 10.65},
        late: {n: 71, mean: 9.94},
      },
    },
    other_account: {offers: {by_daypart: {dinner: {n: 999, mean: 99}}}},
  };
  assert.equal(M.fareReference(D, {hour: 10, fare: 12}), null);
  assert.equal(M.fareReference(D, {hour: 11, fare: 12}).label, '午餐');
  assert.equal(M.fareReference(D, {hour: 13, fare: 12}).label, '午餐');
  assert.equal(M.fareReference(D, {hour: 14, fare: 12}).label, '下午');
  assert.equal(M.fareReference(D, {hour: 17, fare: 12}).label, '晚餐');
  assert.equal(M.fareReference(D, {hour: 20, fare: 12}).label, '夜宵');
  assert.equal(M.fareReference(D, {hour: 23, fare: 12}), null);
  assert.deepEqual(M.fareReference(D, {hour: 19, fare: 18}), {
    daypart: 'dinner', label: '晚餐', window: '17–20', n: 171, mean: 10.65,
    asOf: '2026-10-11', fare: 18, difference: 7.35, percent: 69, direction: 'higher',
  });
  assert.equal(M.fareReference(D, {hour: 19, fare: 8}).difference, -2.65);
  assert.equal(M.fareReference(D, {hour: 19, fare: 8}).direction, 'lower');
  assert.equal(M.fareReference(D, {hour: 19, fare: 10.65}).direction, 'equal');
  assert.equal(M.fareReference({offers: {}}, {hour: 19, fare: 18}), null,
    'missing source data must not fall back to an invented average');
  assert.equal(M.fareReference(D, {hour: 19, fare: ''}), null);
});
