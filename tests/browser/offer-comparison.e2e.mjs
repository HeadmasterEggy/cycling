// Run a local static server on 127.0.0.1:8766, then:
// ego-browser nodejs < tests/browser/offer-comparison.e2e.mjs
// Failure inventory: comparing fewer than two offers, ranking each card's
// separately entered delay instead of one common +5 minute stress case,
// hiding whether the leader reaches its target, stale rankings after saving,
// and leaving a recommendation visible after the comparison drops to one offer.
const assert = (await import('node:assert/strict')).default;
const task = await taskSpace('cycling-offer-comparison-e2e');
const page = task.page('p1');
console.log({ spaceId: task.spaceId });
await page.goto('http://127.0.0.1:8766/dashboard.html?comparison-check=' + Date.now() + '#offer');
await page.waitForSelector('#dashOffer form [name=fare]');
const form = '#dashOffer form';

async function fillOffer({ fare, buffer }) {
  for (const [name, value] of Object.entries({ fare, buffer, target: 30, approach: 5, wait: 3, ride: 10, handoff: 2, recovery: 5 })) {
    await page.fill(`${form} [name=${name}]`, String(value));
  }
}

async function saveOffer(values) {
  await fillOffer(values);
  await page.click(`${form} .plan-save-offer`);
}

await saveOffer({ fare: 20, buffer: 0 });
assert.equal(await page.evaluate(() => !document.querySelector('#dashOffer .plan-saved-comparison').hidden), false,
  'one saved offer has nothing to rank');
await saveOffer({ fare: 18, buffer: 15 });
await page.waitForFunction(() => !document.querySelector('#dashOffer .plan-saved-comparison').hidden);

const comparison = await page.evaluate(() => {
  const host = document.querySelector('#dashOffer .plan-saved-comparison');
  return {
    text: host.textContent.replace(/\s+/g, ' ').trim(),
    rows: [...host.querySelectorAll('[data-offer-rank]')].map(row => ({
      offer: row.dataset.offerRank,
      stressRate: Number(row.dataset.stressRate),
    })),
  };
});
assert.match(comparison.text, /统一压力测试 · 整轮再延误 5 分钟/);
assert.match(comparison.text, /报价 1/);
assert.deepEqual(comparison.rows, [
  { offer: '1', stressRate: 40 },
  { offer: '2', stressRate: 36 },
], 'rank every offer at the same +5 minute delay, not each card buffer');
assert.match(comparison.text, /达到目标/);

await page.click('#dashOffer [data-remove-offer="2"]');
assert.equal(await page.evaluate(() => document.querySelector('#dashOffer .plan-saved-comparison').hidden), true,
  'remove the recommendation when only one offer remains');
console.log('PASS: saved offers rank under a common +5 minute delay and disappear below two offers');
await task.finish({ keep:[] });
