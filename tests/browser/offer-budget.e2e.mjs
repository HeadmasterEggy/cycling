// Run a local static server on 127.0.0.1:8766, then:
// ego-browser nodejs < tests/browser/offer-budget.e2e.mjs
// Failure inventory: missing/cleared inputs, cost reducing headroom, zero
// headroom, already below target, and reward lost immediately after deadline.
const assert = (await import('node:assert/strict')).default;
const task = await taskSpace('cycling-offer-budget-e2e');
const page = task.page('p1');
console.log({ spaceId: task.spaceId });
await page.goto('http://127.0.0.1:8766/dashboard.html?budget-check=' + Date.now() + '#offer');
await page.waitForSelector('#dashOffer form [name=fare]');
console.log(await page.snapshot());
const form = '#dashOffer form';
const read = () => page.evaluate(() => document.querySelector('#dashOffer .plan-budget')?.textContent || '');
await page.fill(`${form} [name=fare]`, '20');
for (const [name, value] of Object.entries({approach:5,wait:3,ride:10,handoff:2,recovery:5,target:30})) {
  await page.fill(`${form} [name=${name}]`, String(value));
}
assert.match(await read(), /15 分钟/);
await page.click(`${form} > details:last-of-type > summary`);
await page.fill(`${form} [name=cost]`, '2');
assert.match(await read(), /11 分钟/);
await page.fill(`${form} [name=fare]`, '14.50');
assert.match(await read(), /已到目标边界/);
await page.fill(`${form} [name=fare]`, '10');
assert.match(await read(), /低于目标/);
assert.match(await read(), /4\.50/);
await page.fill(`${form} [name=wait]`, '');
assert.equal(await read(), '', 'cleared required input must remove previous advice');
await page.fill(`${form} [name=wait]`, '3');
await page.click(`${form} .plan-quest-status`);
await page.selectOption(`${form} [name=questMode]`, 'milestone');
for (const [name,value] of Object.entries({fare:10,cost:0,reward:20,remaining:1,eligible:1,deadline:22,pWithout:0})) {
  await page.fill(`${form} [name=${name}]`, String(value));
}
assert.match(await read(), /2 分钟/);
assert.match(await read(), /Quest 截止/);
await page.selectOption(`${form} [name=questMode]`, 'none');
assert.match(await read(), /低于目标/);
await page.click(`${form} button[type=reset]`);
await page.waitForFunction(() => !document.querySelector('#dashOffer [name=fare]').value);
assert.equal(await read(), '', 'reset must clear previous advice');
console.log('PASS: offer budget, cost, zero boundary, shortfall, missing input, Quest cliff, mode switch and reset');
await task.finish({keep:[]});
