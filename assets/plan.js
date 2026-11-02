/* Three decisions on one screen: accept line, when to ride, where to wait. */
(function () {
  'use strict';
  const D = window.DELIVERY_DATA, M = window.DeliveryModel;
  if (!D || !M) return;
  const $ = id => document.getElementById(id);
  const money = (v, d = 2) => '$' + Number(v).toFixed(d);
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const median = a => { const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length ? (s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) : null; };

  // Quest is counted from the week the minimum standards order took effect;
  // earlier weeks paid a different Quest scheme.
  const floor = (D.offers || {}).floor || {};
  const since = floor.from ? weekStart(floor.from) : null;
  const L = M.ledgerSince(D, since);
  const S = D.summary || {};

  function weekStart(iso) {
    const d = new Date(iso + 'T00:00:00Z'), back = (d.getUTCDay() + 6) % 7;
    d.setUTCDate(d.getUTCDate() - back);
    return d.toISOString().slice(0, 10);
  }

  // ---------- hero ----------
  const perOrder = (L.farePer || 0) + (L.questPer || 0);
  const pace = S.min_per_order || null;
  $('plStats').innerHTML = [
    [money(L.farePer || 0), '平均运费 / 单'],
    [money(L.questPer || 0), '平均 Quest / 单'],
    [pace ? money(perOrder * 60 / pace, 0) : '—', `按你 ${pace ? pace.toFixed(0) : '—'} 分钟一单`],
  ].map(([b, s]) => `<div><b>${b}</b><span>${s}</span></div>`).join('');
  if (L.total > 0) {
    const parts = [['fare', '运费', L.fare], ['quest', 'Quest', L.quest], ['other', '其他调整', L.other]];
    $('plMix').innerHTML = `<div class="pl-mix-label">自 ${since.slice(5).replace('-', '/')} 起 Uber 账本 ${money(L.total, 0)} · ${L.records} 单</div>
      <div class="pl-mix-bar">${parts.map(([k, , v]) => `<i class="m-${k}" style="flex:${v}"></i>`).join('')}</div>
      <div class="pl-mix-keys">${parts.map(([k, n, v]) => `<span><b class="m-${k}"></b>${n} ${Math.round(v / L.total * 100)}%</span>`).join('')}</div>`;
  }

  // ---------- 01 accept line ----------
  const range = L.questRange.length ? L.questRange : [L.questPer || 0];
  const qLow = Math.min(...range), qMid = L.questPer || median(range) || 0, qHigh = Math.max(...range);
  const questChips = [['淡周', qLow], ['平均', qMid], ['旺周', qHigh], ['不算', 0]];
  const targetChips = [['保底', floor.rate || 31.3], ['$35', 35], ['$40', 40]];
  const state = { quest: round1(qMid), target: 35 };
  function round1(v) { return Math.round(v * 2) / 2; }

  // Quest chips snap to 50c so the typed value and the chip agree; targets
  // keep their exact value because the floor is $31.30, not $31.50.
  const snap = (key, v) => key === 'quest' ? round1(v) : v;
  function chips(el, list, key) {
    el.innerHTML = list.map(([label, v]) => {
      const val = snap(key, v), shown = money(val, val % 1 ? (key === 'quest' ? 1 : 2) : 0);
      return `<button type="button" data-v="${val}">${label}${label === shown ? '' : `<small>${shown}</small>`}</button>`;
    }).join('');
    el.addEventListener('click', e => {
      const b = e.target.closest('button'); if (!b) return;
      state[key] = Number(b.dataset.v); $(key === 'quest' ? 'plQuest' : 'plTarget').value = state[key]; render();
    });
  }
  chips($('plQuestChips'), questChips, 'quest');
  chips($('plTargetChips'), targetChips, 'target');
  $('plQuest').value = state.quest; $('plTarget').value = state.target;
  $('plFare').placeholder = (L.farePer || 9).toFixed(0);
  $('plMin').placeholder = pace ? Math.round(pace) : 25;

  document.querySelectorAll('[data-step]').forEach(b => b.addEventListener('click', () => {
    const el = $('plMin'), cur = Number(el.value || el.placeholder);
    el.value = Math.max(1, cur + Number(b.dataset.step)); render();
  }));
  ['plFare', 'plMin'].forEach(id => $(id).addEventListener('input', render));
  $('plQuest').addEventListener('input', e => { state.quest = Number(e.target.value) || 0; render(); });
  $('plTarget').addEventListener('input', e => { state.target = Number(e.target.value); render(); });

  function render() {
    const fareRaw = $('plFare').value, minRaw = $('plMin').value;
    const target = state.target > 0 ? state.target : 35;
    document.querySelectorAll('#plQuestChips button').forEach(b => b.classList.toggle('on', Number(b.dataset.v) === state.quest));
    document.querySelectorAll('#plTargetChips button').forEach(b => b.classList.toggle('on', Number(b.dataset.v) === target));
    const v = $('plVerdict');
    if (fareRaw === '') {
      v.className = 'pl-verdict idle';
      v.innerHTML = `<div class="pl-v-main"><b>填运费</b><span>看这单最多值几分钟</span></div>`;
    } else {
      try {
        const r = M.acceptLine({ fare: fareRaw, quest: state.quest, target, minutes: minRaw === '' ? null : minRaw });
        const limit = Math.floor(r.maxMinutes);
        if (r.minutes == null) {
          v.className = 'pl-verdict limit';
          v.innerHTML = `<div class="pl-v-main"><b>≤ ${limit}<small>分钟</small></b><span>整轮在 ${limit} 分钟内就接</span></div>
            <div class="pl-v-side">${money(r.fare)} 运费 ＋ ${money(r.quest)} Quest<br>按 ${money(target, 0)}/h 计</div>`;
        } else {
          const pct = Math.min(100, r.minutes / Math.max(r.maxMinutes, r.minutes) * 100);
          const lim = Math.min(100, r.maxMinutes / Math.max(r.maxMinutes, r.minutes) * 100);
          v.className = 'pl-verdict ' + (r.take ? 'take' : 'skip');
          v.innerHTML = `<div class="pl-v-main"><b>${r.take ? '接' : '不接'}</b><span>${money(r.rate, 0)}/h · ${r.take ? `还有 ${Math.floor(r.slack)} 分钟余量` : `超出 ${Math.ceil(-r.slack)} 分钟`}</span></div>
            <div class="pl-v-bar" role="img" aria-label="这单 ${r.minutes} 分钟，上限 ${limit} 分钟"><i style="width:${pct}%"></i><em style="left:${lim}%"><span>上限 ${limit}′</span></em></div>`;
        }
      } catch (err) {
        v.className = 'pl-verdict idle';
        v.innerHTML = `<div class="pl-v-main"><b>？</b><span>${esc(err.message)}</span></div>`;
      }
    }
    sheet(target, fareRaw === '' ? null : Number(fareRaw));
  }

  function sheet(target, current) {
    const fares = [5, 6, 7, 8, 9, 10, 12, 14, 16, 20];
    const near = current == null ? null : fares.reduce((a, f) => Math.abs(f - current) < Math.abs(a - current) ? f : a, fares[0]);
    $('plSheet').innerHTML = fares.map(f => {
      const m = Math.floor(M.acceptLine({ fare: f, quest: state.quest, target }).maxMinutes);
      return `<div class="${f === near ? 'on' : ''}"><span>${money(f, 0)}</span><b>${m}′</b></div>`;
    }).join('');
    $('plSheetNote').textContent = `运费 → 整轮最多分钟 · Quest ${money(state.quest, 1)} · 目标 ${money(target, target % 1 ? 2 : 0)}/h`;
  }
  render();

  // ---------- 02 when ----------
  const curve = M.timeCurve(D, { period: 'all' }, { value: 1, minHours: 1.5 });
  const HOURS = Array.from({ length: 15 }, (_, i) => i + 9);
  if (curve) {
    const all = [...curve.weekday, ...curve.weekend].filter(r => r.enough);
    const lo = Math.min(...all.map(r => r.rate)), hi = Math.max(...all.map(r => r.rate));
    const row = (label, list) => {
      const by = new Map(list.map(r => [r.hour, r]));
      return `<div class="pl-heat-row"><span class="pl-heat-label">${label}</span>${HOURS.map(h => {
        const r = by.get(h);
        if (!r) return `<i class="none" title="${h} 点 无记录"></i>`;
        const t = hi > lo ? (r.rate - lo) / (hi - lo) : .5;
        return `<i class="${r.enough ? '' : 'thin'}" style="--t:${r.enough ? t.toFixed(3) : 0}" title="${label} ${h}:00 · 约 ${r.rate.toFixed(1)} 次取餐/记录小时 · ${r.hours.toFixed(1)} h 样本"></i>`;
      }).join('')}</div>`;
    };
    $('plHeat').innerHTML = row('工作日', curve.weekday) + row('周末', curve.weekend) +
      `<div class="pl-heat-row pl-heat-axis"><span class="pl-heat-label"></span>${HOURS.map(h => `<em>${h % 3 === 0 ? h : ''}</em>`).join('')}</div>`;
    const windows = bestWindows(curve.weekday, '工作日').concat(bestWindows(curve.weekend, '周末'));
    $('plTimeAnswer').innerHTML = windows.map(w => `<b>${w.label} ${w.from}–${w.to} 点</b>`).join('，') +
      '。热的格子取餐更密，单与单之间等得少。';
  }
  // Best two-hour run per day type, among hours with enough record time.
  function bestWindows(list, label) {
    const by = new Map(list.filter(r => r.enough).map(r => [r.hour, r.rate]));
    let best = null;
    for (const h of by.keys()) if (by.has(h + 1)) {
      const s = by.get(h) + by.get(h + 1);
      if (!best || s > best.s) best = { s, from: h, to: h + 2, label };
    }
    return best ? [best] : [];
  }

  // ---------- 03 where ----------
  const rows = M.slots(D, { period: 'all' }, { value: 1 }).filter(r => !r.thin).slice(0, 6);
  if (rows.length) {
    const top = rows[0].rate;
    $('plRank').innerHTML = rows.map((r, i) => `<li><span class="pl-rank-n">${i + 1}</span>
      <div class="pl-rank-main"><b>${esc(r.label)}</b><small>${r.weekend ? '周末' : '工作日'} · ${r.daypartLabel} ${r.window}</small>
      <div class="pl-rank-bar"><i style="width:${(r.rate / top * 100).toFixed(1)}%"></i></div></div>
      <span class="pl-rank-v">${r.rate.toFixed(1)}<small>次/h</small></span></li>`).join('');
    const names = [...new Set(rows.map(r => r.label))].slice(0, 3);
    $('plZoneAnswer').innerHTML = `先去 <b>${names.map(esc).join(' · ')}</b>。送完落在别处，就往最近的这几个区骑回来等。`;
  }

  // ---------- basis ----------
  const last = (D.validation || {}).last || (D.planning || {}).recent_anchor || '';
  $('plBasis').textContent = `口径：运费与 Quest 来自 Uber 账本（截至 ${last}，Quest 按周平摊到每单，是平均值不是承诺）；时段与区域来自跨平台 GPS 推断的取餐频率，只用来排先后，不是收入。`;
})();
