/* Shared, local-only planning controls. History is evidence, inputs are scenarios. */
(function () {
  'use strict';
  const M = window.DeliveryModel;
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = n => '$' + n.toFixed(2);
  const field = (key, label, value, unit, max = 240, step = 1, required = true) => `<label class="plan-field"><span>${label}</span><div><input name="${key}" type="number" min="0" max="${max}" step="${step}" value="${value}" inputmode="decimal"${required ? ' required' : ''}><i>${unit}</i></div></label>`;
  function sydneyNow() {
    try {
      const parts = Object.fromEntries(new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Sydney', hour: 'numeric', hour12: false, weekday: 'short' })
        .formatToParts(new Date()).map(p => [p.type, p.value]));
      return { hour: Number(parts.hour) % 24, weekend: parts.weekday === 'Sat' || parts.weekday === 'Sun' };
    } catch (e) { return { hour: 18, weekend: false }; }
  }
  const zoneOptions = (data, blank) => `<option value="">${blank}</option>` + data.zones.slice().sort((a,b)=>a.label.localeCompare(b.label)).map(z => `<option value="${esc(z.name)}">${esc(z.label)}</option>`).join('');
  const hourOptions = from => Array.from({ length: 15 }, (_, i) => i + 9).map(h => `<option value="${h}"${h === from ? ' selected' : ''}>${String(h).padStart(2, '0')}:00–${String(h + 1).padStart(2, '0')}:00</option>`).join('');
  function focus(name) { if (typeof dlvSetFocus === 'function') dlvSetFocus(name); }
  function mountOffer(host, data) {
    if (!host || host.dataset.mounted) return;
    host.dataset.mounted = 'true';
    // Offer and reward assumptions intentionally reset on reload: yesterday's
    // Quest or another offer's ETA should never silently price today's order.
    const d = M.DEFAULTS, sydney = sydneyNow();
    host.classList.add('planner');
    host.innerHTML = `<form class="plan-form" novalidate>
        <div class="plan-fields plan-primary">
          ${field('fare', '本趟总报价', '', 'A$', 1000, .01)}
          ${field('target', '我的目标', d.target, '$/h', 500, 1)}
        </div>
        <div class="plan-result" aria-live="polite"></div>
        <div class="plan-offer-actions"><button type="button" class="plan-action plan-save-offer">暂存这份报价</button><span class="plan-save-status" role="status">最多比较 3 份，本次页面有效</span></div>
        <div class="plan-offer-insights"></div>
        <details class="plan-saved" hidden><summary>报价对照 <span class="plan-saved-count"></span></summary><div class="plan-saved-list"></div><p class="plan-help">保存当时全部时间与奖励假设；报价变化后可载入修改。刷新页面会清空。</p></details>
        <div class="plan-section-label"><span>整轮时间</span><em>按分钟填写，可直接修改</em></div>
        <div class="plan-fields plan-times">
          ${field('approach', '去餐厅', '', 'min')}${field('wait', '等出餐', '', 'min')}
          ${field('ride', '送餐骑行', '', 'min')}${field('handoff', '进楼交付', '', 'min')}
          ${field('recovery', '送完无单等待／转场', '', 'min')}${field('buffer', '额外延误情景', d.buffer, 'min')}
        </div>
        <p class="plan-help">填整趟实际总用时；拼单的重叠时间只算一次。转场不包含下一单接单后的去店时间，避免重复计时。</p>
        <label class="plan-select">送达区域参考<select name="destination"><option value="">选择落点，查看历史续接</option>${data.zones.slice().sort((a,b)=>a.label.localeCompare(b.label)).map(z => `<option value="${esc(z.name)}">${esc(z.label)}</option>`).join('')}</select></label>
        <div class="plan-destination plan-help">选择落点后查看续接区域样本；混合轨迹只用于比较历史 GPS 活动频率。</div>
        <details class="plan-details plan-history"><summary>查看该时段的 GPS 取餐频率 <span class="plan-history-status">仅作历史对照</span></summary>
          <p class="plan-help">Uber、DoorDash 和熊猫轨迹混在一起；这里只显示该时段历史上推断出的 GPS 取餐频率与记录时长。记录可能中断，因此不能换算成实际等单间隔、平台派单率或收入。实际时薪需要对应平台的在线时间和收入。</p>
          <div class="plan-fields">
            <label class="plan-select">现在所在／取餐区<select name="pickupZone">${zoneOptions(data, '不指定（全城平均）')}</select></label>
            <label class="plan-select">接单时段<select name="histHour">${hourOptions(Math.min(23, Math.max(9, sydney.hour)))}</select></label>
            <label class="plan-select">日期类型<select name="histDay"><option value="weekday"${sydney.weekend ? '' : ' selected'}>工作日</option><option value="weekend"${sydney.weekend ? ' selected' : ''}>周末</option></select></label>
          </div>
        <div class="plan-fields">${field('approachKm', '去店距离（可选）', '', 'km', 100, .1, false)}${field('rideKm', '送餐距离（可选）', '', 'km', 100, .1, false)}</div>
          <div class="plan-offer-actions"><button type="button" class="plan-action plan-fill-times">按距离和个人实测速度填时间</button><span class="plan-save-status plan-fill-status" role="status"></span></div>
          <div class="plan-history-out" aria-live="polite"></div>
        </details>
        <details class="plan-details"><summary>Quest 奖励 <span class="plan-quest-status">未计入</span></summary>
          <label class="plan-select">奖励模式<select name="questMode"><option value="none">不计奖励（默认）</option><option value="per">确认每次额外奖励</option><option value="milestone">冲单门槛：比较接与不接</option></select></label>
          <div class="plan-quest-per" hidden><div class="plan-fields">${field('bonus','每次额外奖励',0,'A$',1000,.01)}</div></div>
          <div class="plan-quest-count" hidden>${field('eligible','本趟符合条件次数',1,'次',20,1)}</div>
          <div class="plan-quest-milestone" hidden>
            <div class="plan-fields">${field('reward','尚未获得的这档奖金',0,'A$',10000,.01)}${field('remaining','距门槛还差',5,'次',1000,1)}${field('deadline','距截止时间',120,'min',10080,1)}${field('pWith','接这单后达标概率',0,'%',100,1)}${field('pWithout','跳过后达标概率',0,'%',100,1)}</div>
            <p class="plan-help">概率是你的情景假设，不是平台预测。已完成的奖励不再计入；若本趟即可达标，按时完成的情景取 100%。有多档奖励时只填写当前分析的一档。</p>
          </div><p class="plan-help plan-quest-note"></p>
        </details>
        <details class="plan-details"><summary>成本与计算说明</summary>
          ${field('cost','本趟增量成本',0,'A$',1000,.01)}
          <p class="plan-help">结果 =（报价 + 奖励增量 − 增量成本）÷ 整轮小时。成本可包含电费、磨损等；这里是税前贡献估算，不含固定租车费、税或保底补差。成本默认按 A$0 计算，记得补入自己的成本。</p>
        </details>
        <button type="reset" class="plan-reset">清空报价和时间</button>
      </form>`;
    const form = host.querySelector('form');
    const saved = [];
    let current = null, serial = 0;
    function renderSaved() {
      host.querySelector('.plan-saved').hidden = !saved.length;
      host.querySelector('.plan-saved-count').textContent = `${saved.length} / 3`;
      host.querySelector('.plan-saved-list').innerHTML = saved.map(s => `<article class="plan-saved-card">
        <div class="plan-saved-heading"><strong>报价 ${s.id} · ${money(s.result.fare)}</strong><button type="button" data-remove-offer="${s.id}" aria-label="移除报价 ${s.id}">×</button></div>
        <p>${esc(s.destination || '未选落点')} · ${s.result.minutes} min</p>
        <dl><div><dt>正常 / 延误</dt><dd>${money(s.result.rate)} / ${money(s.result.slowRate)}<small>$/h · 额外延误 ${s.result.buffer} min</small></dd></div><div><dt>奖励增量</dt><dd>${money(s.result.quest)}<small>目标 ${money(s.result.target)}/h</small></dd></div></dl>
        <button type="button" class="plan-action" data-load-offer="${s.id}">载入报价 ${s.id}</button></article>`).join('');
      host.querySelector('.plan-save-offer').disabled = !current || saved.length >= 3;
    }
    function renderHistory(adv) {
      const out = host.querySelector('.plan-history-out'), status = host.querySelector('.plan-history-status');
      if (!adv || !adv.known) {
        out.innerHTML = '<p class="plan-help">该时段 GPS 样本不足，无法估计取餐频率。</p>';
        status.textContent = '该时段无历史';
        return;
      }
      status.textContent = `${adv.rate.toFixed(1)} 次 / GPS 记录小时`;
      out.innerHTML = `<div class="plan-history-card"><span>历史 GPS 推断取餐频率</span><b>${adv.rate.toFixed(1)}<small> 次 / 记录小时</small></b>
        <small>80% 区间 ${adv.rateLo.toFixed(1)}–${adv.rateHi.toFixed(1)} · ${adv.hours.toFixed(1)} 个小时有记录；混合平台，不能代表在线派单或等单时间</small></div>`;
    }
    function renderInsights(values, r) {
      const parts = [['approach','去店'],['wait','等餐'],['ride','骑行'],['handoff','交付'],['recovery','送完等待／转场']];
      const delays = [...new Set([0, 5, 10, 15, r.buffer])].sort((a,b) => a-b);
      const scenarios = M.sensitivity(values, delays);
      host.querySelector('.plan-offer-insights').innerHTML = `<details class="plan-insights"><summary>时间构成与延误影响 <span>再等 5 分钟会怎样</span></summary>
        <div class="plan-time-bar" role="img" aria-label="${parts.map(([k,label])=>`${label} ${r[k]} 分钟`).join('，')}">${parts.filter(([k])=>r[k]>0).map(([k])=>`<span class="time-${k}" style="flex:${r[k]}"></span>`).join('')}</div>
        <div class="plan-time-legend">${parts.map(([k,label])=>`<span><i class="time-${k}"></i>${label}<b>${r[k]} min</b></span>`).join('')}</div>
        <p class="plan-help">在已填写的等餐时间之外再增加延误；Quest 同时按延后的完成时刻重算。点选情景可更新上方结果。</p>
        <div class="plan-delay-list">${scenarios.map(s=>`<button type="button" class="plan-delay ${s.meetsTarget?'meets':''}" data-delay="${s.delay}" aria-pressed="${s.delay===r.buffer}"><span>${s.delay ? '+'+s.delay+' min' : '按时完成'}</span><b>${money(s.rate)}<small>/h</small></b><em>${s.meetsTarget?'达到目标':'低于目标'}${s.quest !== r.quest?' · 奖励变化':''}</em></button>`).join('')}</div>
      </details>`;
    }
    function paint() {
      const insightsOpen = !!host.querySelector('.plan-insights[open]');
      const mode = form.elements.questMode.value;
      host.querySelector('.plan-quest-per').hidden = mode !== 'per';
      host.querySelector('.plan-quest-count').hidden = mode === 'none';
      host.querySelector('.plan-quest-milestone').hidden = mode !== 'milestone';
      host.querySelectorAll('.plan-quest-per input, .plan-quest-count input, .plan-quest-milestone input').forEach(el => { el.disabled = !!el.closest('[hidden]'); });
      const values = Object.fromEntries(new FormData(form));
      const dest = data.zones.find(z => z.name === values.destination);
      const ad = dest && dest.as_drop;
      host.querySelector('.plan-destination').innerHTML = ad
        ? `<strong>${esc(dest.label)}</strong> · 送达后到下一次取餐中位 <b>${ad.dead_min} min</b> / ${ad.dead_km} km · ${ad.legs} 段${ad.legs < 8 ? '，样本偏少' : ''}。<br>含等单和已接单去店，不能整段当无偿转场；全期数据，未按时段筛选。`
        : dest ? `<strong>${esc(dest.label)}</strong> · 这个区域暂无续接样本，时间请按当前情况填写。` : '选择区域后显示历史参考，时间由你判断并填写。';
      const result = host.querySelector('.plan-result');
      try {
        const invalid = [...form.querySelectorAll('input')].find(el => !el.disabled && !el.validity.valid);
        if (invalid) throw new Error(`请检查「${invalid.closest('label').querySelector('span').textContent}」的输入`);
        const service = ['approach', 'wait', 'ride', 'handoff'].reduce((t, k) => t + (Number(values[k]) || 0), 0);
        const adv = M.advise(data, { zone: values.pickupZone || null, dest: values.destination || null,
          weekend: values.histDay === 'weekend', hour: Number(values.histHour), service, value: 0 });
        renderHistory(adv);
        const r = M.estimate(values);
        const budget = M.delayBudget(values);
        // Round down: a displayed extra minute must not exceed the budget.
        const extra = budget.extraMinutes == null ? null : Math.floor((budget.extraMinutes + 1e-8) * 10) / 10;
        const budgetText = budget.belowTarget
          ? `按计划完成已低于目标；报价还需增加 ${money(budget.fareGap)}，才达到目标。`
          : extra === 0 ? '已到目标边界，按填写精度已无额外延误余量。'
          : `最多再增加 ${extra} 分钟${budget.limit === 'questDeadline' ? '，受 Quest 截止限制' : '，再久就低于目标'}。`;
        current = { values, result: r, destination: dest && dest.label };
        const labels = { strong: '延误后仍达到目标', borderline: '正常达到目标，延误后不足', weak: '当前情景低于目标' };
        result.className = 'plan-result ' + r.verdict;
        result.innerHTML = `<div class="plan-eyebrow">本趟税前贡献 · 情景估算</div><div class="plan-rate"><b>${money(r.rate)}</b><span>/ 小时</span></div>
          <p class="plan-verdict">${labels[r.verdict]}</p>
          <div class="plan-result-grid"><div><span>整轮用时</span><b>${r.minutes.toFixed(0)} <small>min</small></b></div><div><span>延误 ${r.buffer} 分钟后</span><b>${money(r.slowRate)} <small>/h</small></b></div></div>
          <div class="plan-threshold">达到 ${money(r.target)}/h，报价需 <strong>${money(r.needed)}</strong><span>延误情景需 ${money(r.neededSlow)}</span></div>
          <div class="plan-budget"><strong>${budgetText}</strong><small>从填写的整轮计划起算，包含额外等餐、骑行或转场延误；已填的等餐不重复加算。不是到店后重新开始的计时器，也不代表应取消订单。</small></div>
          <div class="plan-formula">报价 ${money(r.fare)} + 奖励增量 ${money(r.quest)} − 成本 ${money(r.cost)}<br>不计奖励时 ${money(r.baseRate)}/h · 不含保底补差</div>`;
        host.querySelector('.plan-quest-note').textContent = r.questNote;
        host.querySelector('.plan-quest-status').textContent = mode === 'none' ? '未计入' : '增量 ' + money(r.quest);
        renderInsights(values, r);
        host.querySelector('.plan-insights').open = insightsOpen;
      } catch (e) {
        current = null;
        host.querySelector('.plan-offer-insights').innerHTML = '';
        result.className = 'plan-result invalid';
        result.innerHTML = `<div class="plan-eyebrow">等待有效输入</div><p>${esc(e.message)}</p>`;
        host.querySelector('.plan-quest-note').textContent = '请补全本模式的输入后查看估算。';
        host.querySelector('.plan-quest-status').textContent = '待填写';
      }
      host.querySelector('.plan-save-offer').disabled = !current || saved.length >= 3;
    }
    host.addEventListener('click', e => {
      const save = e.target.closest('.plan-save-offer');
      const load = e.target.closest('[data-load-offer]');
      const remove = e.target.closest('[data-remove-offer]');
      const delay = e.target.closest('[data-delay]');
      const fill = e.target.closest('.plan-fill-times');
      if (fill) {
        const status = host.querySelector('.plan-fill-status');
        const aKm = form.elements.approachKm.value, rKm = form.elements.rideKm.value;
        if (aKm === '' && rKm === '') { status.textContent = '先填写去店或送餐距离'; return; }
        try {
        const t = M.suggestTimes(data, { pickupZone: form.elements.pickupZone.value, destZone: form.elements.destination.value, approachKm: aKm || 0, rideKm: rKm || 0 });
          if (aKm !== '') form.elements.approach.value = t.approach;
          if (rKm !== '') form.elements.ride.value = t.ride;
          if (t.wait != null) form.elements.wait.value = t.wait;
          if (t.handoff != null) form.elements.handoff.value = t.handoff;
          paint();
          status.textContent = `已按 GPS 实测 ${t.pace.toFixed(1)} / ${t.destPace.toFixed(1)} min/km 和停留中位填入，可修改`;
        } catch (err) { status.textContent = err.message; }
      } else if (save && current && saved.length < 3) {
        saved.push({ id: ++serial, ...current, values: { ...current.values } });
        renderSaved(); host.querySelector('.plan-saved').open = true;
        host.querySelector('.plan-save-status').textContent = `已暂存 ${saved.length} / 3 份${saved.length === 3 ? '，可移除后继续' : ''}`;
      } else if (load) {
        const selected = saved.find(s=>s.id===Number(load.dataset.loadOffer));
        if (selected) {
          Object.entries(selected.values).forEach(([key, value]) => { if (form.elements[key]) form.elements[key].value = value; });
          paint(); focus(selected.values.destination || null);
          host.querySelector('.plan-save-status').textContent = `已载入报价 ${selected.id}，可继续修改`;
          form.elements.fare.focus();
        }
      } else if (remove) {
        const index = saved.findIndex(s=>s.id===Number(remove.dataset.removeOffer));
        if (index >= 0) saved.splice(index, 1);
        renderSaved(); host.querySelector('.plan-save-status').textContent = `已暂存 ${saved.length} / 3 份`;
        (host.querySelector('[data-remove-offer]') || host.querySelector('.plan-save-offer')).focus();
      } else if (delay) {
        form.elements.buffer.value = delay.dataset.delay; paint();
        const next = host.querySelector(`[data-delay="${delay.dataset.delay}"]`); if (next) next.focus();
      }
    });
    form.addEventListener('submit', e => e.preventDefault());
    form.addEventListener('input', paint);
    form.addEventListener('change', e => { paint(); if(e.target.name === 'destination') focus(e.target.value || null); });
    form.addEventListener('reset', () => setTimeout(() => { focus(null); paint(); }, 0));
    window.addEventListener('delivery-zone-focus', e => {
      if ([...form.elements.destination.options].some(o => o.value === e.detail)) {
        form.elements.destination.value = e.detail; paint();
      }
    });
    paint();
  }
  function mountZones(host, data) {
    if (!host || host.dataset.mounted) return;
    host.dataset.mounted = 'true'; host.classList.add('planner');
    const p = data.planning;
    if (!p) { host.innerHTML = '<p class="plan-empty">暂无区域记录，请先生成配送数据。</p>'; return; }
    let selected = [], filters = { period: 'all', day: 'all', time: 'all' }, allRows = [];
    host.innerHTML = `<div class="plan-filters">
      <label>记录范围<select name="period"><option value="all">全部记录</option><option value="recent">最近有记录的 28 天</option></select></label>
      <label>日期类型<select name="day"><option value="all">每天</option><option value="weekday">工作日</option><option value="weekend">周末</option></select></label>
      <label>取餐时段<select name="time"><option value="all">全天</option><option value="lunch">午餐 11–14</option><option value="dinner">晚餐 17–20</option><option value="late">晚间 20–23</option></select></label>
    </div><p class="plan-scope"></p>
    <div class="plan-zone-toolbar"><label>查找区域<input name="zoneSearch" type="search" placeholder="输入区域名" autocomplete="off"></label><label>排序<select name="zoneSort"><option value="rate">取餐频率</option><option value="hours">记录时长</option><option value="wait">取餐停留较短</option></select></label></div>
    <div class="plan-zone-selection" aria-live="polite"></div><div class="plan-zone-comparison" hidden></div>
    <div class="plan-zone-list"></div><p class="plan-zone-status" role="status"></p>
    <p class="plan-help">取餐频率 = 推断取餐次数 ÷ 区内 GPS 记录小时。至少 ${p.min_hours} 小时、${p.min_shifts} 班次、${p.min_pickups} 次取餐才比较。取餐停留含交接，不全是等餐；至少 4 次停留样本才排序。跨平台记录不代表实时需求或派单概率。</p>`;
    function highlight() {
      host.querySelectorAll('[data-zone]').forEach(el => el.setAttribute('aria-pressed', String(el.dataset.zone === host.dataset.focus)));
    }
    function comparison() {
      const panel = host.querySelector('.plan-zone-comparison');
      const hoursOpen = !!panel.querySelector('.plan-hour-details[open]');
      panel.hidden = !selected.length;
      host.querySelector('.plan-zone-selection').innerHTML = `<span>区域对照 ${selected.length} / 3</span>${selected.map(name => `<button type="button" data-uncompare="${esc(name)}" aria-label="移除 ${esc((data.zones.find(z=>z.name===name)||{}).label || name)} 的比较">${esc((data.zones.find(z=>z.name===name)||{}).label || name)} <b>×</b></button>`).join('')}${!selected.length ? '<small>点区域右侧 + 加入对照</small>' : ''}`;
      if (!selected.length) { panel.innerHTML = ''; return; }
      const rows = selected.map(name => allRows.find(z=>z.name===name) || {name, label: (data.zones.find(z=>z.name===name)||{}).label || name, hours:0, pickups:0, shifts:0, rate:null, wait:null, waitCount:0});
      const series = rows.map(z => ({ zone:z, hours:M.hourly(data,{...filters,zone:z.name}) }));
      const recordedHours = series.flatMap(s => s.hours.filter(h=>h.hours>0).map(h=>h.hour));
      const minHour = recordedHours.length ? Math.min(...recordedHours) : 11;
      const maxHour = recordedHours.length ? Math.max(...recordedHours) : 22;
      const hours = Array.from({length:maxHour-minHour+1},(_,i)=>i+minHour);
      const maxRate = Math.max(1, ...series.flatMap(s=>s.hours.map(h=>h.rate || 0)));
      panel.innerHTML = `<div class="plan-table-scroll" tabindex="0" aria-label="区域比较，可横向滚动"><table class="plan-compare-table"><caption>同一日期与时段 · ${rows.length === 1 ? '再选一个区域即可对照' : '并排查看样本与频率'}</caption><thead><tr><th>指标</th>${rows.map(z=>`<th>${esc(z.label)}</th>`).join('')}</tr></thead><tbody>
        <tr><th>取餐 / 记录小时</th>${rows.map(z=>`<td class="plan-compare-rate">${z.rate == null ? '—' : z.rate.toFixed(1)}</td>`).join('')}</tr>
        <tr><th>记录与班次</th>${rows.map(z=>`<td>${z.hours.toFixed(1)} h / ${z.shifts} 班</td>`).join('')}</tr>
        <tr><th>取餐次数</th>${rows.map(z=>`<td>${z.pickups}</td>`).join('')}</tr>
        <tr><th>取餐停留中位</th>${rows.map(z=>`<td>${z.waitCount >= 4 ? (z.wait/60).toFixed(1)+' min' : '—'}<small>${z.waitCount} 个样本</small></td>`).join('')}</tr>
      </tbody></table></div>
      <details class="plan-hour-details"><summary>展开逐小时对照 <span>悉尼时间</span></summary>
        <p class="plan-help">同一色阶比较取餐频率；每个小时单独检查样本量。斜线为样本不足，空白为没有记录。</p>
        <div class="plan-hour-scroll" tabindex="0" aria-label="区域逐小时比较，可横向滚动"><div class="plan-hour-grid" style="--plan-hours:${hours.length}"><span class="plan-hour-zone">次 / 记录小时</span>${hours.map(h=>`<span class="plan-hour-tick">${String(h).padStart(2,'0')}</span>`).join('')}${series.map(s=>`<span class="plan-hour-zone">${esc(s.zone.label)}</span>${hours.map(hour=>{const h=s.hours[hour]; const label=`${s.zone.label}，${hour}:00–${hour+1}:00，${h.hours.toFixed(2)} 记录小时，${h.shifts} 班次，${h.pickups} 次取餐，${h.rate == null ? (h.hours>0?'样本不足，暂不计算频率':'没有记录') : h.rate.toFixed(1)+' 次每记录小时'}`;return `<button type="button" class="plan-hour-cell ${h.rate == null ? (h.hours>0?'thin':'empty') : ''}" style="--plan-intensity:${h.rate == null ? 0 : .2+.65*h.rate/maxRate}" data-hour-info="${esc(label)}" aria-label="${esc(label)}">${h.rate == null ? '·' : h.rate.toFixed(1)}</button>`;}).join('')}`).join('')}</div></div>
        <p class="plan-hour-info" role="status">点选一个小时，查看记录时长与样本量。</p>
      </details>`;
      panel.querySelector('.plan-hour-details').open = hoursOpen;
    }
    function renderList() {
      const search = host.querySelector('[name="zoneSearch"]').value.trim().toLowerCase();
      const sort = host.querySelector('[name="zoneSort"]').value;
      const rows = allRows.filter(z=>!search || `${z.name} ${z.label}`.toLowerCase().includes(search)).slice();
      rows.sort((a,b) => {
        if (sort === 'hours') return b.hours-a.hours || b.pickups-a.pickups;
        if (sort === 'wait') return Number(b.waitCount >= 4)-Number(a.waitCount >= 4) || (a.waitCount>=4 && b.waitCount>=4 ? a.wait-b.wait : 0) || b.hours-a.hours;
        return Number(b.enough)-Number(a.enough) || (b.rate || 0)-(a.rate || 0) || b.hours-a.hours;
      });
      const rowHtml = (z,i)=>`<div class="plan-zone-row"><button type="button" class="plan-zone ${z.enough?'':'thin'}" data-zone="${esc(z.name)}" aria-pressed="false">
        <span class="plan-zone-index">${String(i+1).padStart(2,'0')}</span><span class="plan-zone-main"><strong>${esc(z.label)}</strong><small>${z.pickups} 次取餐 · ${z.hours.toFixed(1)} h · ${z.shifts} 班次</small></span>
        <span class="plan-zone-rate">${sort === 'wait' ? (z.waitCount >= 4 ? (z.wait/60).toFixed(1) : '—') : sort === 'hours' ? z.hours.toFixed(1) : z.rate == null ? '—' : z.rate.toFixed(1)}<small>${sort === 'wait' ? '停留中位 / min' : sort === 'hours' ? '记录小时' : z.enough ? '次 / 记录小时' : '待积累样本'}</small></span></button><button type="button" class="plan-compare-toggle" data-compare="${esc(z.name)}" aria-pressed="${selected.includes(z.name)}" aria-label="${selected.includes(z.name)?'取消比较':'比较'} ${esc(z.label)}" ${selected.length>=3 && !selected.includes(z.name)?'disabled':''}>${selected.includes(z.name)?'✓':'+'}</button></div>`;
      const list = host.querySelector('.plan-zone-list');
      if (!rows.length) list.innerHTML = '<p class="plan-empty">没有匹配区域。可修改搜索词或扩大记录范围。</p>';
      else if (search) list.innerHTML = rows.map(rowHtml).join('');
      else {
        const primary = rows.slice(0, 5), more = rows.slice(5);
        list.innerHTML = primary.map(rowHtml).join('') + (more.length ? `<details class="plan-zone-more"><summary>查看其他 ${more.length} 个区域</summary>${more.map((z,i)=>rowHtml(z,i+5)).join('')}</details>` : '');
      }
      host.querySelector('.plan-zone-status').textContent = search
        ? `显示 ${rows.length} 个匹配区域 / ${allRows.length} 区`
        : `先显示前 ${Math.min(5, rows.length)} 区${selected.length === 3 ? ' · 已选满 3 区，移除后可换区' : ''}`;
      highlight();
    }
    function renderFilters() {
      filters = Object.fromEntries(['period','day','time'].map(name=>[name,host.querySelector(`[name="${name}"]`).value]));
      allRows = M.aggregate(data,filters);
      const enough = allRows.filter(z=>z.enough);
      host.querySelector('.plan-scope').textContent = `记录截至 ${p.recent_anchor} · ${enough.length} / ${allRows.length} 区样本可比较 · 地图、取餐频率与时段图同步筛选`;
      comparison(); renderList();
      window.dispatchEvent(new CustomEvent('delivery-filter-change',{detail:{...filters}}));
    }
    host.addEventListener('input',e=>{ if(e.target.name === 'zoneSearch') renderList(); });
    host.addEventListener('change',e=>{ if(['period','day','time'].includes(e.target.name)) renderFilters(); else if(e.target.name === 'zoneSort') renderList(); });
    host.addEventListener('click',e=>{
      const zone = e.target.closest('[data-zone]'), compare = e.target.closest('[data-compare]'), remove = e.target.closest('[data-uncompare]'), hour = e.target.closest('[data-hour-info]');
      if (zone) focus(zone.dataset.zone);
      if (compare || remove) {
        const name = compare ? compare.dataset.compare : remove.dataset.uncompare;
        if (selected.includes(name)) selected = selected.filter(n=>n!==name);
        else if (selected.length < 3) selected.push(name);
        comparison(); renderList();
        const next = [...host.querySelectorAll('[data-compare]')].find(el=>el.dataset.compare === name && !el.disabled)
          || host.querySelector('[data-uncompare]') || host.querySelector('[name="zoneSearch"]');
        if (next) next.focus();
      }
      if (hour) host.querySelector('.plan-hour-info').textContent = hour.dataset.hourInfo;
    });
    host.addEventListener('focusin',e=>{ if(e.target.dataset.hourInfo) host.querySelector('.plan-hour-info').textContent = e.target.dataset.hourInfo; });
    window.addEventListener('delivery-zone-focus',e=>{ host.dataset.focus = e.detail || ''; highlight(); });
    renderFilters();
  }
  function mountSlots(host, data) {
    if (!host || host.dataset.mounted) return;
    host.dataset.mounted = 'true'; host.classList.add('planner');
    const p = data.planning;
    if (!p) { host.innerHTML = '<p class="plan-empty">暂无区域记录，请先生成配送数据。</p>'; return; }
    const parts = M.DAYPARTS;
    host.innerHTML = `<div class="slot-headline" aria-live="polite"></div>
      <p class="plan-scope slot-scope" aria-live="polite"></p>
      <div class="plan-filters slot-filters">
        <label>记录范围<select name="period"><option value="all">全部记录</option><option value="recent">最近有记录的 28 天</option></select></label>
        <label>日期类型<select name="day"><option value="all">工作日与周末</option><option value="weekday">工作日</option><option value="weekend">周末</option></select></label>
        <label>餐段<select name="part"><option value="all">全部餐段</option>${parts.map(d => `<option value="${d.key}">${d.label} ${d.from}–${d.to}</option>`).join('')}</select></label>
      </div>
      <h3 class="slot-h">分餐段比较试跑区域</h3><div class="slot-matrix"></div>
      <details class="slot-more"><summary>查看其他时段候选</summary><div class="slot-rank"></div></details>
      <details class="plan-hour-details"><summary>查看全城逐小时分布 <span>悉尼时间 · 同一位置质量下</span></summary>
        <div class="plan-hour-scroll" tabindex="0" aria-label="逐小时推断取餐频率，可横向滚动"><div class="slot-hours"></div></div>
        <p class="plan-hour-info" role="status">点选一个小时，查看样本量。</p>
      </details>
      <details class="slot-method"><summary>估算口径和限制</summary>
        <p class="plan-help">这里只比较 GPS 推断取餐次数 ÷ GPS 记录小时，不估算收入。记录混合 Uber、DoorDash 和熊猫，且 GPS 小时不是平台在线小时；现有 Uber 账本无法给其他平台的取餐定价。要比较实际时薪，需要同一平台的有效在线时间、收入和成本。</p>
        <p class="plan-help">频率估计结合全局节奏、钟点、区域和该区域餐段记录；样本较少时会更多收缩到整体估计。区间为 80% 可信范围；取餐少于 4 次或班次少于 ${p.min_shifts} 个会标为样本少。</p>
      </details>`;
    const q = name => host.querySelector(`[name="${name}"]`);
    function filtered(rows) {
      const day = q('day').value, part = q('part').value;
      return rows.filter(r => (day === 'all' || (day === 'weekend') === r.weekend) && (part === 'all' || r.daypart === part));
    }
    const dayLabel = r => (r.weekend ? '周末' : '工作日');
    const range = r => `${r.rateLo.toFixed(2)}–${r.rateHi.toFixed(2)}`;
    function render() {
      const filters = { period: q('period').value };
      const opts = { value: 0, cost: 0 };
      const all = M.slots(data, filters, opts), rows = filtered(all);
      const curve = M.timeCurve(data, filters, opts);
      const settled = rows.filter(r => !r.thin);
      host.querySelector('.slot-scope').textContent = `${all.length} 个时间 × 地点组合达到最低记录时长 · 只比较跨平台 GPS 取餐频率，不估算平台收入 · 记录截至 ${p.recent_anchor}`;
      const top = settled[0] || rows[0];
      host.querySelector('.slot-headline').innerHTML = top
        ? `<span>取餐频率最高的试跑候选${top.thin ? ' · 样本少' : ''}</span><strong>${dayLabel(top)} ${top.daypartLabel} ${top.window} · ${esc(top.label)}</strong><b>${top.rate.toFixed(2)}<small> 次 / GPS 记录小时</small></b><small>80% 区间 ${range(top)} 次/小时 · ${top.pickups} 次推断取餐 / ${top.hours.toFixed(1)} 记录小时 / ${top.shifts} 班</small>`
        : '<span>没有满足条件的组合，放宽日期类型或餐段后再看。</span>';
      const days = q('day').value === 'weekday' ? [false] : q('day').value === 'weekend' ? [true] : [false, true];
      const usedParts = parts.filter(d => q('part').value === 'all' || d.key === q('part').value);
      host.querySelector('.slot-matrix').innerHTML = `<div class="slot-table-scroll" tabindex="0" aria-label="时段与地点对照，可横向滚动"><table class="slot-table"><thead><tr><th>餐段</th>${days.map(w => `<th>${w ? '周末' : '工作日'}</th>`).join('')}</tr></thead><tbody>${usedParts.map(d => `<tr><th>${d.label}<small>${d.from}–${d.to}</small></th>${days.map(w => {
        const cell = all.filter(r => r.daypart === d.key && r.weekend === w), best = cell.filter(r => !r.thin)[0] || cell[0], next = cell.filter(r => r !== best && !r.thin)[0];
        return best ? `<td><button type="button" class="slot-pick ${best.thin ? 'thin' : ''}" data-zone="${esc(best.zone)}"><strong>${esc(best.label)}</strong><b>${best.rate.toFixed(2)}<small> 次/记录小时</small></b><small>80% 区间 ${range(best)}${best.thin ? ' · 样本少' : ''}</small></button>${next ? `<small class="slot-next">其次 ${esc(next.label)} ${next.rate.toFixed(2)} 次/记录小时</small>` : ''}</td>` : '<td class="slot-none">记录不足</td>';
      }).join('')}</tr>`).join('')}</tbody></table></div>`;
      const top10 = rows.slice(0, 10), max = Math.max(1, ...top10.map(r => r.rateHi));
      host.querySelector('.slot-rank').innerHTML = top10.length ? top10.map((r, i) => `<button type="button" class="slot-row ${r.thin ? 'thin' : ''}" data-zone="${esc(r.zone)}">
          <span class="plan-zone-index">${String(i + 1).padStart(2, '0')}</span>
          <span class="slot-row-main"><strong>${esc(r.label)}</strong><small>${dayLabel(r)} ${r.daypartLabel} ${r.window} · ${r.pickups} 次取餐 / ${r.hours.toFixed(1)} h / ${r.shifts} 班${r.thin ? ' · 样本少' : ''}</small>
            <span class="slot-bar" role="img" aria-label="80% 区间 ${range(r)} 次/小时"><i style="left:${r.rateLo / max * 100}%;width:${Math.max(2, (r.rateHi - r.rateLo) / max * 100)}%"></i><em style="left:${r.rate / max * 100}%"></em></span></span>
          <span class="plan-zone-rate">${r.rate.toFixed(2)}<small>次/记录小时 · ${range(r)}</small></span></button>`).join('') : '<p class="plan-empty">没有匹配组合。</p>';
      const hoursAll = [...curve.weekday, ...curve.weekend].map(h => h.hour).filter(h => h >= 9);
      const lo = hoursAll.length ? Math.min(...hoursAll) : 11, hi = hoursAll.length ? Math.max(...hoursAll) : 22;
      const hourList = Array.from({ length: hi - lo + 1 }, (_, i) => i + lo);
      const maxD = Math.max(1, ...[...curve.weekday, ...curve.weekend].filter(h => h.enough).map(h => h.rate));
      const grid = [['工作日', curve.weekday], ['周末', curve.weekend]].filter(([label]) => days.length === 2 || (days[0] ? label === '周末' : label === '工作日'));
      host.querySelector('.slot-hours').innerHTML = `<div class="plan-hour-grid" style="--plan-hours:${hourList.length}"><span class="plan-hour-zone">次 / GPS h</span>${hourList.map(h => `<span class="plan-hour-tick">${String(h).padStart(2, '0')}</span>`).join('')}${grid.map(([label, list]) => `<span class="plan-hour-zone">${label}</span>${hourList.map(hour => {
        const h = list.find(x => x.hour === hour);
        const info = !h ? `${label} ${hour}:00，没有记录` : `${label} ${hour}:00–${hour + 1}:00，${h.rate.toFixed(2)} 次推断取餐 / GPS 记录小时（80% 区间 ${h.rateLo.toFixed(2)}–${h.rateHi.toFixed(2)}），${h.hours.toFixed(1)} 记录小时，${h.pickups} 次取餐${h.enough ? '' : '，样本不足'}`;
        return `<button type="button" class="plan-hour-cell ${!h ? 'empty' : h.enough ? '' : 'thin'}" style="--plan-intensity:${h && h.enough ? .2 + .65 * h.rate / maxD : 0}" data-hour-info="${esc(info)}" aria-label="${esc(info)}">${h && h.enough ? h.rate.toFixed(1) : '·'}</button>`;
      }).join('')}`).join('')}</div>`;
    }
    host.addEventListener('change', e => { if (['period', 'day', 'part'].includes(e.target.name)) render(); });
    host.addEventListener('click', e => {
      const zone = e.target.closest('[data-zone]'), hour = e.target.closest('[data-hour-info]');
      if (zone) focus(zone.dataset.zone);
      if (hour) host.querySelector('.plan-hour-info').textContent = hour.dataset.hourInfo;
    });
    host.addEventListener('focusin', e => { if (e.target.dataset && e.target.dataset.hourInfo) host.querySelector('.plan-hour-info').textContent = e.target.dataset.hourInfo; });
    render();
  }
  function mountSettlement(host, data) {
    if (!host || host.dataset.mounted) return;
    host.dataset.mounted = 'true'; host.classList.add('planner');
    const f = data.offers && data.offers.floor;
    if (!f) { host.innerHTML = '<p class="plan-empty">暂无最低标准资料。</p>'; return; }
    host.innerHTML = `<p class="plan-help">按同一 Uber 三周周期核算。请填写平台确认的有效接单小时；GPS 无法还原接单时刻，重叠订单的时间只计一次。</p>
      <form class="plan-settlement" novalidate>
        <label class="plan-select">车辆<select name="rate"><option value="31.3">自行车 / 电助力 · $31.30/h</option><option value="31.5">摩托车 · $31.50/h</option><option value="32">汽车（≤1 吨）· $32.00/h</option></select></label>
        <div class="plan-fields">${field('hours','周期有效接单小时',0,'h',1000,.1)}${field('fare','周期运费（扣平台费用后）',0,'A$',100000,.01)}${field('promotions','周期促销（含 Quest）',0,'A$',100000,.01)}</div>
        <div class="plan-settlement-result" aria-live="polite"></div>
      </form><p class="plan-help">补差 = max(0, 有效小时 × 标准 − 运费 − 促销)。不计小费、报销、临时调整款。先核对结算分类；这里不从单笔订单推断应付补差。</p>
      <p class="plan-help">2026 首个周期：8 月 17 日 04:00 → 9 月 7 日 04:00（悉尼时间），之后每 21 天一个周期。费率适用 ${f.from} 至 ${f.through}。<a href="${esc(f.url)}" target="_blank" rel="noreferrer">Uber 规则 ↗</a> · <a href="${esc(f.time_url)}" target="_blank" rel="noreferrer">有效时间口径 ↗</a></p>`;
    const form = host.querySelector('form');
    const paint = () => {
      const out = host.querySelector('.plan-settlement-result');
      try {
        if (![...form.querySelectorAll('input')].every(el => el.validity.valid)) throw new Error('请填写有效的周期金额与时间');
        const values = Object.fromEntries(new FormData(form)), r = M.settlement(values);
        out.innerHTML = Number(values.hours) === 0 && Number(values.fare) === 0 && Number(values.promotions) === 0
          ? '填入同一周期的实际数据后查看补差估算'
          : `<span>周期补差估算</span><strong>${money(r.topup)}</strong><small>最低金额 ${money(r.minimum)} · 纳入比较 ${money(r.eligible)}</small>`;
      } catch(e) { out.textContent = e.message; }
    };
    form.addEventListener('submit', e=>e.preventDefault()); form.addEventListener('input',paint); form.addEventListener('change',paint); paint();
  }
  function mountLedger(host, data) {
    if (!host) return;
    const o = data.offers;
    if (!o) { host.innerHTML = '<p class="plan-empty">没有可用的 Uber 账本。</p>'; return; }
    host.classList.add('planner');
    const checks = o.statement_checks || [];
    host.innerHTML = `<p class="plan-help"><strong>我的账号 · 原有账本</strong> — ${o.n} 条 Uber 活动记录。2026-10-19 扫描的其他账号数据未纳入本账本及配送分析。已核对的周采用网页账单金额；其他周显示日志分类，小费未知。Quest 单独列出，不平摊到下一单。</p>
      <div class="plan-table-scroll" tabindex="0" aria-label="每周收入，可横向滚动"><table class="plan-ledger"><caption>每周分类金额（A$）· 周一 04:00 起</caption><thead><tr><th>结算周</th><th>来源</th><th>运费</th><th>Quest</th><th>其他调整</th><th>小费</th><th>账单合计</th></tr></thead><tbody>${o.weeks.map(raw => {
        const checked = checks.find(c => c.week === raw.week), w = checked || raw;
        return `<tr><td>${esc(w.week)}</td><td>${checked ? '账单已核对' : '活动日志'}</td><td>${money(w.fare)}</td><td class="quest-cell">${money(w.quest)}</td><td>${money(w.other)}</td><td>${checked ? money(w.tips) : '—'}</td><td>${checked ? money(w.total) : '—'}</td></tr>`;
      }).join('')}</tbody></table></div>
      <p class="plan-help">日志按金额与时间排除 ${o.duplicates_removed} 笔疑似重复 MISC。大额调整另列：${o.large_adjustments.map(a => `${esc(a.on)} ${money(a.amt)}`).join('、') || '无'}，不按单摊销。未核对周的调整分类仍需账单确认。</p>
      <details class="plan-verified"><summary>账单核对与日志差异</summary>${checks.map(w => {
        const log = o.weeks.find(r => r.week === w.week);
        return `<p>${esc(w.week)}：运费 ${money(w.fare)} + Quest ${money(w.quest)} + 调整 ${money(w.other)} + 小费 ${money(w.tips)} = ${money(w.total)}</p>${log ? `<small>同周日志：运费 ${money(log.fare)}、Quest ${money(log.quest)}、其他 ${money(log.other)}。</small>` : ''}`;
      }).join('')}<p>Quest 已对齐；运费或调整项仍有差异，原因未确认，不将其解释为补差款。核对日期 2026-09-05。</p></details>`;
  }
  window.DeliveryPlanner = { mountOffer, mountZones, mountSlots, mountSettlement, mountLedger };
})();
