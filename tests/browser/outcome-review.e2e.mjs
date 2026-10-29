// Failure inventory: absent post-run review, treating an incomplete form as
// a completed result, mixing one saved offer's outcome into another, using
// GPS or another account as actual platform revenue, or showing an incorrect
// realized hourly contribution.
const assert = (await import('node:assert/strict')).default;
const task = await taskSpace('cycling-outcome-review-e2e');
const page = task.page('p1');
await page.goto('http://127.0.0.1:8766/dashboard.html?outcome-check=' + Date.now() + '#offer');
await page.waitForSelector('#dashOffer form [name=fare]');
const form = '#dashOffer form';

async function offer({fare, hour, zone}) {
  for (const [name, value] of Object.entries({ fare, buffer: 5, target: 30, approach: 5, wait: 3, ride: 10, handoff: 2, recovery: 5 })) {
    await page.fill(`${form} [name=${name}]`, String(value));
  }
  await page.selectOption(`${form} [name=pickupZone]`, zone);
  await page.selectOption(`${form} [name=histHour]`, String(hour));
  await page.click(`${form} .plan-save-offer`);
}

await offer({fare: 20, hour: 19, zone: 'Newtown'});
await offer({fare: 18, hour: 12, zone: 'Glebe'});

const cards = await page.evaluate(() => document.querySelectorAll('#dashOffer .plan-saved-card').length);
assert.equal(cards, 2);
const first = '#dashOffer .plan-saved-card:nth-of-type(1)';
const second = '#dashOffer .plan-saved-card:nth-of-type(2)';
const read = selector => page.evaluate(selector => document.querySelector(selector)?.textContent || '', selector);
await page.click(`${first} .plan-outcome summary`);
const blank = await read(`${first} .plan-outcome-result`);
assert.match(blank, /填写实际用时和运费/);

await page.fill(`${first} [data-outcome-input=minutes]`, '30');
let partial = await read(`${first} .plan-outcome-result`);
assert.match(partial, /请填写实际本趟运费/);

await page.fill(`${first} [data-outcome-input=fare]`, '20');
await page.fill(`${first} [data-outcome-input=bonus]`, '2');
await page.fill(`${first} [data-outcome-input=cost]`, '1');
const firstResult = await read(`${first} .plan-outcome-result`);
assert.match(firstResult, /42\.00\/h/);
assert.match(firstResult, /落在计划与延误情景之间/);
assert.match(firstResult, /比接单估算 低 \$6\.00\/h/);
assert.match(firstResult, /用时多 5\.0 min/);
assert.match(firstResult, /不含保底补差和未到账小费/);
assert.match(await read('#dashOffer .plan-outcome-ranking'), /已完成 1 \/ 2 份报价/);
assert.match(await read('#dashOffer .plan-outcome-ranking'), /未完成或无效输入不参与排名/);

const secondBlank = await read(`${second} .plan-outcome-result`);
assert.match(secondBlank, /填写实际用时和运费/);
assert.doesNotMatch(secondBlank, /42\.00/);
await page.click(`${second} .plan-outcome summary`);
await page.fill(`${second} [data-outcome-input=minutes]`, '20');
await page.fill(`${second} [data-outcome-input=fare]`, '18');
await page.fill(`${second} [data-outcome-input=cost]`, '1');
const ranked = await page.evaluate(() => [...document.querySelectorAll('#dashOffer [data-outcome-rank]')].map(row => ({
  offer: row.dataset.outcomeRank,
  rate: Number(row.dataset.outcomeRate),
  text: row.textContent,
})));
assert.deepEqual(ranked.map(row => row.offer), ['2', '1'],
  'completed trial results must rank by actual hourly contribution');
assert.equal(ranked[0].rate, 51);
assert.match(ranked[0].text, /Glebe/);
assert.match(ranked[1].text, /Newtown/);
assert.match(await read('#dashOffer .plan-outcome-ranking'), /报价 2 实绩最高/);
assert.match(await read('#dashOffer .plan-outcome-ranking'), /已录入 2 \/ 2 份/);

await page.fill(`${first} [data-outcome-input=minutes]`, '20');
assert.match(await read(`${first} .plan-outcome-result`), /高于接单估算/);
await page.fill(`${first} [data-outcome-input=minutes]`, '40');
assert.match(await read(`${first} .plan-outcome-result`), /低于延误情景/);
await page.fill(`${first} [data-outcome-input=minutes]`, '0');
assert.match(await read(`${first} .plan-outcome-result`), /实际整轮用时超出有效范围/);

await page.focus(`${first} .plan-outcome summary`);
await page.keyboard.press('Tab');
assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-outcome-input')), 'minutes',
  'keyboard focus must enter the first review field');

await page.cdp('Emulation.setDeviceMetricsOverride', {width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false});
await page.waitForFunction(() => innerWidth === 1440);
const desktopLayout = await page.evaluate(() => {
  const fields = document.querySelector('#dashOffer .plan-outcome-fields');
  const rank = document.querySelector('#dashOffer .plan-outcome-rank-row');
  return { columns: getComputedStyle(fields).gridTemplateColumns, rankDisplay: getComputedStyle(rank).display, overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth };
});
assert.equal(desktopLayout.columns.trim().split(/\s+/).length, 2);
assert.equal(desktopLayout.rankDisplay, 'grid');
assert.equal(desktopLayout.overflow, false);

await page.cdp('Emulation.setDeviceMetricsOverride', {width: 390, height: 844, deviceScaleFactor: 1, mobile: true});
await page.waitForFunction(() => innerWidth === 390);
const mobileLayout = await page.evaluate(() => {
  const fields = document.querySelector('#dashOffer .plan-outcome-fields');
  const rank = document.querySelector('#dashOffer .plan-outcome-rank-row');
  return { columns: getComputedStyle(fields).gridTemplateColumns, rankDisplay: getComputedStyle(rank).display, overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth };
});
assert.equal(mobileLayout.columns.trim().split(/\s+/).length, 1);
assert.equal(mobileLayout.rankDisplay, 'grid');
assert.equal(mobileLayout.overflow, false);
console.log('PASS: completed-order review validates, calculates, ranks and isolates each saved offer');
await task.finish({ keep:[] });
