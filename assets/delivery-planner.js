/* Shared, local-only planning controls. History is evidence, inputs are scenarios. */
(function () {
  'use strict';
  const M = window.DeliveryModel;
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = n => '$' + n.toFixed(2);
  const field = (key, label, value, unit, max = 240, step = 1) => `<label class="plan-field"><span>${label}</span><div><input name="${key}" type="number" min="0" max="${max}" step="${step}" value="${value}" inputmode="decimal" required><i>${unit}</i></div></label>`;
  function focus(name) { if (typeof dlvSetFocus === 'function') dlvSetFocus(name); }
  function mountOffer(host, data) {
    if (!host || host.dataset.mounted) return;
    host.dataset.mounted = 'true';
    // Offer and reward assumptions intentionally reset on reload: yesterday's
    // Quest or another offer's ETA should never silently price today's order.
    const d = M.DEFAULTS;
    host.classList.add('planner');
    host.innerHTML = `<form class="plan-form" novalidate>
        <div class="plan-fields plan-primary">
          ${field('fare', '本趟总报价', d.fare, 'A$', 1000, .01)}
          ${field('target', '我的目标', d.target, '$/h', 500, 1)}
        </div>
        <div class="plan-result" aria-live="polite"></div>
        <div class="plan-section-label"><span>整轮时间</span><em>按分钟填写，可直接修改</em></div>
        <div class="plan-fields plan-times">
          ${field('approach', '去餐厅', d.approach, 'min')}${field('wait', '等出餐', d.wait, 'min')}
          ${field('ride', '送餐骑行', d.ride, 'min')}${field('handoff', '进楼交付', d.handoff, 'min')}
          ${field('recovery', '送完无单等待／转场', d.recovery, 'min')}${field('buffer', '额外延误情景', d.buffer, 'min')}
        </div>
        <p class="plan-help">填整趟实际总用时；拼单的重叠时间只算一次。转场不包含下一单接单后的去店时间，避免重复计时。</p>
        <label class="plan-select">送达区域参考<select name="destination"><option value="">选择落点，查看历史续接</option>${data.zones.slice().sort((a,b)=>a.label.localeCompare(b.label)).map(z => `<option value="${esc(z.name)}">${esc(z.label)}</option>`).join('')}</select></label>
        <div class="plan-destination plan-help">选择区域后显示历史参考，时间由你判断并填写。</div>
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
          ${field('cost','本趟增量成本',d.cost,'A$',1000,.01)}
          <p class="plan-help">结果 =（报价 + 奖励增量 − 增量成本）÷ 整轮小时。成本可包含电费、磨损等；这里是税前贡献估算，不含固定租车费、税或保底补差。默认值只是演示，请按当前派单修改。</p>
        </details>
        <button type="reset" class="plan-reset">恢复演示输入</button>
      </form>`;
    const form = host.querySelector('form');
    function paint() {
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
        const r = M.estimate(values);
        const labels = { strong: '延误后仍达到目标', borderline: '正常达到目标，延误后不足', weak: '当前情景低于目标' };
        result.className = 'plan-result ' + r.verdict;
        result.innerHTML = `<div class="plan-eyebrow">本趟税前贡献 · 情景估算</div><div class="plan-rate"><b>${money(r.rate)}</b><span>/ 小时</span></div>
          <p class="plan-verdict">${labels[r.verdict]}</p>
          <div class="plan-result-grid"><div><span>整轮用时</span><b>${r.minutes.toFixed(0)} <small>min</small></b></div><div><span>延误 ${r.buffer} 分钟后</span><b>${money(r.slowRate)} <small>/h</small></b></div></div>
          <div class="plan-threshold">达到 ${money(r.target)}/h，报价需 <strong>${money(r.needed)}</strong><span>延误情景需 ${money(r.neededSlow)}</span></div>
          <div class="plan-formula">报价 ${money(r.fare)} + 奖励增量 ${money(r.quest)} − 成本 ${money(r.cost)}<br>不计奖励时 ${money(r.baseRate)}/h · 不含保底补差</div>`;
        host.querySelector('.plan-quest-note').textContent = r.questNote;
        host.querySelector('.plan-quest-status').textContent = mode === 'none' ? '未计入' : '增量 ' + money(r.quest);
      } catch (e) {
        result.className = 'plan-result invalid';
        result.innerHTML = `<div class="plan-eyebrow">等待有效输入</div><p>${esc(e.message)}</p>`;
        host.querySelector('.plan-quest-note').textContent = '请补全本模式的输入后查看估算。';
        host.querySelector('.plan-quest-status').textContent = '待填写';
      }
    }
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
    host.innerHTML = `<div class="plan-filters">
      <label>记录范围<select name="period"><option value="recent">最近有记录的 28 天</option><option value="all">全部记录</option></select></label>
      <label>日期类型<select name="day"><option value="all">每天</option><option value="weekday">工作日</option><option value="weekend">周末</option></select></label>
      <label>取餐时段<select name="time"><option value="all">全天</option><option value="lunch">午餐 11–14</option><option value="dinner">晚餐 17–20</option><option value="late">晚间 20–23</option></select></label>
    </div><p class="plan-scope"></p><div class="plan-zone-list"></div>
    <p class="plan-help">取餐频率 = 推断取餐次数 ÷ 区内 GPS 记录小时。至少 ${p.min_hours} 小时、${p.min_shifts} 班次、${p.min_pickups} 次取餐才比较。跨平台混合记录，不代表实时需求或派单概率。</p>`;
    const render = () => {
      const filters = Object.fromEntries([...host.querySelectorAll('select')].map(el => [el.name, el.value]));
      const rows = M.aggregate(data, filters);
      const enough = rows.filter(z => z.enough);
      host.querySelector('.plan-scope').textContent = `记录截至 ${p.recent_anchor} · ${enough.length} 区可比较 · 地图与落点参考仍显示全期记录`;
      const list = host.querySelector('.plan-zone-list');
      const shown = [...enough, ...rows.filter(z => !z.enough && z.pickups > 0)].slice(0, 16);
      list.innerHTML = (!enough.length ? '<div class="plan-empty">当前筛选样本不足。可扩大范围，或把下列区域作为试跑候选。</div>' : '') + shown.map((z, i) => `<button type="button" class="plan-zone ${z.enough ? '' : 'thin'}" data-zone="${esc(z.name)}" aria-pressed="false">
        <span class="plan-zone-index">${z.enough ? String(i + 1).padStart(2,'0') : '·'}</span><span class="plan-zone-main"><strong>${esc(z.label)}</strong><small>${z.pickups} 次取餐 · ${z.hours.toFixed(1)} h · ${z.shifts} 班次</small></span>
        <span class="plan-zone-rate">${z.enough ? z.rate.toFixed(1) : '—'}<small>${z.enough ? '次 / 记录小时' : '待积累样本'}</small></span></button>`).join('');
      list.querySelectorAll('button').forEach(b => b.addEventListener('click', () => focus(b.dataset.zone)));
      host.querySelectorAll('[data-zone]').forEach(el => el.setAttribute('aria-pressed', String(el.dataset.zone === host.dataset.focus)));
    };
    host.addEventListener('change', render);
    window.addEventListener('delivery-zone-focus', e => { host.dataset.focus = e.detail || ''; host.querySelectorAll('[data-zone]').forEach(el => el.setAttribute('aria-pressed', String(el.dataset.zone === e.detail))); });
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
    host.innerHTML = `<p class="plan-help">${o.n} 条 Uber 活动记录。已核对的周采用网页账单金额；其他周显示日志分类，小费未知。Quest 单独列出，不平摊到下一单。</p>
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
  window.DeliveryPlanner = { mountOffer, mountZones, mountSettlement, mountLedger };
})();
