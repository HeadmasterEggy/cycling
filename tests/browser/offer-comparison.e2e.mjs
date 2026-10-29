// Run a local static server on 127.0.0.1:8766, then:
// ego-browser nodejs < tests/browser/offer-comparison.e2e.mjs
// Failure inventory: comparing fewer than two offers, ranking each card's
// separately entered delay instead of one common +5 minute stress case,
// hiding whether the leader reaches its target, stale rankings after saving,
// leaving a recommendation visible after the comparison drops to one offer,
// omitting the self-account Uber fare reference, keeping a stale reference
// after changing fare/hour, or silently inventing one when the source is absent.
const assert = (await import('node:assert/strict')).default;
const task = await taskSpace('cycling-offer-comparison-e2e');
const page = task.page('p1');
console.log({ spaceId: task.spaceId });
await page.goto('http://127.0.0.1:8766/dashboard.html?comparison-check=' + Date.now() + '#offer');
await page.waitForSelector('#dashOffer form [name=fare]');
const form = '#dashOffer form';

async function fillOffer({ fare, buffer, zone, day = 'weekday', hour = 12 }) {
  for (const [name, value] of Object.entries({ fare, buffer, target: 30, approach: 5, wait: 3, ride: 10, handoff: 2, recovery: 5 })) {
    await page.fill(`${form} [name=${name}]`, String(value));
  }
  await page.selectOption(`${form} [name=pickupZone]`, zone);
  await page.selectOption(`${form} [name=histDay]`, day);
  await page.selectOption(`${form} [name=histHour]`, String(hour));
}

async function saveOffer(values) {
  await fillOffer(values);
  await page.click(`${form} .plan-save-offer`);
}
const readFareReference = () => page.evaluate(() => {
  const host = document.querySelector('#dashOffer .plan-fare-reference');
  return { hidden: !host || host.hidden, text: host ? host.textContent.replace(/\s+/g, ' ').trim() : '' };
});

await saveOffer({ fare: 20, buffer: 0, zone: 'Newtown', day: 'weekend', hour: 19 });
let reference = await readFareReference();
assert.equal(reference.hidden, false);
assert.match(reference.text, /我的账号 · Uber 原有账本/);
assert.match(reference.text, /晚餐 17–20/);
assert.match(reference.text, /\$10\.65/);
assert.match(reference.text, /171 笔/);
assert.match(reference.text, /高 \$9\.35/);
assert.match(reference.text, /88%/);
assert.match(reference.text, /只比较 Fare/);
assert.match(reference.text, /Quest、小费和 Other 均未计入/);
assert.match(reference.text, /不参与时薪/);
assert.equal(await page.evaluate(() => !document.querySelector('#dashOffer .plan-saved-comparison').hidden), false,
  'one saved offer has nothing to rank');
await saveOffer({ fare: 18, buffer: 15, zone: 'Glebe', day: 'weekday', hour: 12 });
await page.waitForFunction(() => !document.querySelector('#dashOffer .plan-saved-comparison').hidden);
reference = await readFareReference();
assert.match(reference.text, /午餐 11–14/);
assert.match(reference.text, /\$9\.84/);
assert.match(reference.text, /62 笔/);

await page.fill(`${form} [name=fare]`, '8');
reference = await readFareReference();
assert.match(reference.text, /低 \$1\.84/, 'fare changes must update the comparison immediately');
assert.match(reference.text, /19%/);
await page.selectOption(`${form} [name=histHour]`, '19');
reference = await readFareReference();
assert.match(reference.text, /晚餐 17–20/, 'hour changes must update the daypart immediately');
assert.match(reference.text, /低 \$2\.65/);
await page.fill(`${form} [name=fare]`, '10.65');
reference = await readFareReference();
assert.match(reference.text, /与历史平均持平/);

const comparison = await page.evaluate(() => {
  const host = document.querySelector('#dashOffer .plan-saved-comparison');
  return {
    text: host.textContent.replace(/\s+/g, ' ').trim(),
    rows: [...host.querySelectorAll('[data-offer-rank]')].map(row => ({
      offer: row.dataset.offerRank,
      stressRate: Number(row.dataset.stressRate),
      context: row.dataset.offerContext,
    })),
  };
});
assert.match(comparison.text, /统一压力测试 · 整轮再延误 5 分钟/);
assert.match(comparison.text, /报价 1/);
assert.deepEqual(comparison.rows, [
  { offer: '1', stressRate: 40, context: 'Newtown · 周末 19:00 · 全部记录' },
  { offer: '2', stressRate: 36, context: 'Glebe · 工作日 12:00 · 全部记录' },
], 'rank every offer at the same +5 minute delay, not each card buffer');
assert.match(comparison.text, /达到目标/);
assert.match(comparison.text, /不同试跑情景/);

await fillOffer({ fare: 20, buffer: 0, zone: 'Newtown', day: 'weekend', hour: 19 });
assert.match(await page.evaluate(() => document.querySelector('#dashOffer .plan-context').textContent), /Newtown · 周末 19:00 · 全部记录/);
const preservedContexts = await page.evaluate(() => [...document.querySelectorAll('#dashOffer [data-offer-rank]')]
  .map(row => row.dataset.offerContext));
assert.deepEqual(preservedContexts, [
  'Newtown · 周末 19:00 · 全部记录',
  'Glebe · 工作日 12:00 · 全部记录',
], 'changing the next offer must not rewrite saved trial contexts');
const savedReferences = await page.evaluate(() => [...document.querySelectorAll('#dashOffer .plan-saved-card')]
  .map(card => card.textContent.replace(/\s+/g, ' ').trim()));
assert.match(savedReferences[0], /历史晚餐 \$10\.65/);
assert.match(savedReferences[0], /171 笔 Fare/);
assert.match(savedReferences[1], /历史午餐 \$9\.84/);
assert.match(savedReferences[1], /62 笔 Fare/);

await page.evaluate(() => { window.DELIVERY_DATA.offers.by_daypart = null; });
await page.fill(`${form} [name=fare]`, '11');
reference = await readFareReference();
assert.equal(reference.hidden, true, 'missing source data must hide rather than invent a reference');

await page.click('#dashOffer [data-remove-offer="2"]');
assert.equal(await page.evaluate(() => document.querySelector('#dashOffer .plan-saved-comparison').hidden), true,
  'remove the recommendation when only one offer remains');
console.log('PASS: fare references update by daypart and saved offers preserve their trial contexts');
await task.finish({ keep:[] });
