// Run a local static server on 127.0.0.1:8766, then:
// ego-browser nodejs < tests/browser/slot-to-offer.e2e.mjs
// Failure inventory: no eligible slot, wrong account scope, day/hour/zone
// mismatch, overwriting the real offer, a slot inventing a destination,
// zone selection throwing before it can drive the drop-zone reference, or
// leaving keyboard focus off the target.
const assert = (await import('node:assert/strict')).default;
const task = await taskSpace('cycling-slot-to-offer-e2e');
const page = task.page('p1');
console.log({ spaceId: task.spaceId });
await page.goto('http://127.0.0.1:8766/dashboard.html?slot-check=' + Date.now() + '#offer');
await page.waitForSelector('#dashSlots [name=period]');
await page.selectOption('#dashSlots [name=period]', 'recent');
await page.waitForSelector('#dashSlots .slot-pick[data-slot-offer]');
const candidate = await page.evaluate(() => {
  const el = document.querySelector('#dashSlots .slot-pick[data-slot-offer]');
  return { zone:el.dataset.zone, weekend:el.dataset.weekend, hour:el.dataset.hour, period:el.dataset.period };
});
assert.equal(candidate.period, 'recent');
await page.evaluate(() => document.querySelector('#dashSlots .slot-pick[data-slot-offer]').click());
await page.waitForFunction(({ zone }) => {
  const form = document.querySelector('#dashOffer form');
  return form && form.elements.pickupZone.value === zone && document.querySelector('#dashOffer .plan-history').open;
}, candidate);
const state = await page.evaluate(() => {
  const form = document.querySelector('#dashOffer form');
  return {
    zone: form.elements.pickupZone.value,
    destination: form.elements.destination.value,
    weekend: form.elements.histDay.value,
    hour: form.elements.histHour.value,
    status: document.querySelector('#dashOffer .plan-history-status').textContent,
    active: document.activeElement && document.activeElement.name,
    fare: form.elements.fare.value,
    wait: form.elements.wait.value,
  };
});
assert.equal(state.zone, candidate.zone);
assert.equal(state.destination, '', 'pickup slot must not invent a destination zone');
assert.equal(state.weekend, candidate.weekend === 'true' ? 'weekend' : 'weekday');
assert.equal(state.hour, candidate.hour);
assert.match(state.status, /最近有记录的 28 天/);
assert.equal(state.active, 'pickupZone');
assert.equal(state.fare, '', 'slot context must not invent a real offer fare');
assert.equal(state.wait, '', 'slot context must not invent a real wait time');
await page.evaluate(() => document.querySelector('#dashZones .plan-zone[data-zone]').click());
await page.waitForFunction(() => document.querySelector('#dashOffer form').elements.destination.value);
const zoneLink = await page.evaluate(() => {
  const button = document.querySelector('#dashZones .plan-zone[data-zone]');
  return { zone: button.dataset.zone, destination: document.querySelector('#dashOffer form').elements.destination.value };
});
assert.equal(zoneLink.destination, zoneLink.zone, 'zone selection must still drive the independent drop-zone reference');
console.log('PASS: eligible slot transfers history context; zone selection still drives the drop-zone reference');
await task.finish({ keep:[] });
