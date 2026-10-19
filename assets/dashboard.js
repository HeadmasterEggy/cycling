/* Delivery console: shared planner controls and a linked, historical map. */
(function () {
  'use strict';
  const esc = s => dlvEsc(s);
  const money = value => new Intl.NumberFormat('en-AU', { style:'currency', currency:'AUD' }).format(value);
  function mountActivity() {
    const host = document.getElementById('dashActivity');
    if (!host) return;
    host.innerHTML = `<div class="activity-head"><div><h3>独立账号 · Activity 周收入</h3><p>每次只查看一个文件的账号。与上方我的账本分开，不参与作战台的收入、区域或接单分析。只在当前浏览器内读取，不上传、不保存。</p></div><label class="activity-load">选择本机文件<input type="file" accept="application/json,.json" aria-label="选择 Uber Activity JSON 文件"></label></div>
      <div class="activity-feedback" role="status" aria-live="polite">2026-10-19 新扫描的数据属于其他账号。选择本机 JSON 后查看其归属；未标记的文件显示为账号未确认。</div>
      <div class="activity-results" hidden></div>`;
    const input = host.querySelector('input[type=file]'), feedback = host.querySelector('.activity-feedback'), results = host.querySelector('.activity-results');
    input.addEventListener('change', async () => {
      const file = input.files && input.files[0];
      if (!file) return;
      try {
        const data = JSON.parse(await file.text());
        if (data.source !== 'Uber Driver Activity' || !Array.isArray(data.weeks) || !data.weeks.length || data.weeks.length > 104) throw new Error('文件格式不符合 Uber Activity 周记录。');
        const weeks = data.weeks.map(w => {
          if (!Array.isArray(w.rows) || !Array.isArray(w.range) || w.range.length !== 2) throw new Error('周记录缺少日期范围或明细。');
          const rows = w.rows;
          // Uber sometimes shows a Quest summary and its trip-quest detail at the same timestamp and amount.
          const summaries = new Set(rows.filter(r => r.event === 'Quest').map(r => `${r.date}|${r.time}|${r.earnings}`));
          let duplicateQuestRows = 0;
          const totals = { fare:0, quest:0, other:0, deliveries:0, entries:0 };
          for (const row of rows) {
            if (!row || typeof row.event !== 'string' || typeof row.earnings !== 'string') throw new Error('记录缺少事件或金额字段。');
            const parsed = Number(row.earnings.replace(/[^\d.-]/g, ''));
            if (!Number.isFinite(parsed)) continue;
            if (/Trip Quest$/i.test(row.event) && summaries.has(`${row.date}|${row.time}|${row.earnings}`)) { duplicateQuestRows++; continue; }
            totals.entries++;
            if (/^DELIVERY$/i.test(row.event)) { totals.fare += parsed; totals.deliveries++; }
            else if (/quest/i.test(row.event)) totals.quest += parsed;
            else totals.other += parsed;
          }
          return { label:w.range.join(' — '), ...totals, duplicateQuestRows, total:totals.fare+totals.quest+totals.other };
        });
        const owner = data.account && data.account.owner;
        const ownership = owner === 'other' ? '其他账号' : owner === 'self' ? '我的账号' : '账号未确认';
        const label = data.account && typeof data.account.label === 'string' ? data.account.label : '';
        renderActivity(results, weeks, data.retrieved_at || '', ownership, label);
        results.hidden = false;
        feedback.textContent = `已在本机载入${ownership}的 ${weeks.length} 周；排除了 ${weeks.reduce((n,w)=>n+w.duplicateQuestRows,0)} 条与 Quest 汇总重复的 Trip Quest 展示。`;
      } catch (error) {
        results.hidden = true;
        feedback.textContent = error instanceof SyntaxError ? '无法读取 JSON，请选择有效的 Uber Activity 文件。' : (error.message || '无法读取这个文件。');
      }
    });
  }
  function renderActivity(host, weeks, retrievedAt, ownership, accountLabel) {
    const max = Math.max(1, ...weeks.map(w=>w.total));
    const totals = weeks.reduce((a,w)=>({fare:a.fare+w.fare,quest:a.quest+w.quest,other:a.other+w.other,total:a.total+w.total,deliveries:a.deliveries+w.deliveries}),{fare:0,quest:0,other:0,total:0,deliveries:0});
    const bars = weeks.map(w=>`<div class="activity-week"><div class="activity-bar" role="img" aria-label="${esc(w.label)}：总计 ${money(w.total)}"><i class="fare" style="width:${Math.max(0,w.fare/max*100)}%"></i><i class="quest" style="width:${Math.max(0,w.quest/max*100)}%"></i><i class="other" style="width:${Math.max(0,w.other/max*100)}%"></i></div><div class="activity-week-meta"><span>${esc(w.label)}</span><b>${money(w.total)}</b></div></div>`).join('');
    const rows = [...weeks].reverse().map(w=>`<tr><td>${esc(w.label)}</td><td>${w.deliveries}</td><td>${money(w.fare)}</td><td>${money(w.quest)}</td><td>${money(w.other)}</td><td><strong>${money(w.total)}</strong></td></tr>`).join('');
    host.innerHTML = `<div class="activity-account"><strong>${esc(ownership)}</strong>${accountLabel ? `<span>${esc(accountLabel)}</span>` : ''}<p>以下图表仅汇总当前文件，不与我的原有账本合并，也不用于作战台建议。</p></div><div class="activity-kpis"><div><span>载入期间合计</span><b>${money(totals.total)}</b></div><div><span>配送记录</span><b>${totals.deliveries}</b></div><div><span>配送平均金额</span><b>${money(totals.deliveries ? totals.fare/totals.deliveries : 0)}</b></div><div><span>Activity 周数</span><b>${weeks.length}</b></div></div>
      <div class="activity-chart-title"><strong>每周入账构成</strong><span><i class="fare"></i>配送 <i class="quest"></i>Quest <i class="other"></i>其他</span></div><div class="activity-chart">${bars}</div>
      <div class="activity-table-wrap" tabindex="0" aria-label="Uber Activity 周收入分类表"><table class="activity-table"><thead><tr><th>周区间</th><th>配送条数</th><th>配送</th><th>Quest</th><th>其他</th><th>Activity 合计</th></tr></thead><tbody>${rows}</tbody><tfoot><tr><th>合计</th><th>${totals.deliveries}</th><th>${money(totals.fare)}</th><th>${money(totals.quest)}</th><th>${money(totals.other)}</th><th>${money(totals.total)}</th></tr></tfoot></table></div>
      <p class="activity-caveat">按 Activity 行项目汇总；Quest 汇总与同一时间、同金额的 Trip Quest 明细只计一次。它反映页面显示的入账记录，不等于净收入或有效时薪；缺少在线时长、里程、订单地点。数据记录日期：${esc(retrievedAt || '未提供')}。</p>`;
  }
  function renderDrop(data, name) {
    const host = document.getElementById('dashDrop'), c = data.chain;
    const z = data.zones.find(z => z.name === name), ad = z && z.as_drop;
    if (!z) {
      host.innerHTML = `<div class="drop-empty"><span>↗</span><h3>选一个区域，看看下一步。</h3><p>点候选区或地图区域，查看送完后的续接时间。落点也会同步到接单计算器。</p></div>`;
    } else {
      host.innerHTML = `<div class="drop-title"><h3>${esc(z.label)}</h3><span>全期历史参考</span></div>` + (ad
        ? `<div class="drop-metrics"><div><span>到下次取餐</span><b>${ad.dead_min}<small> min</small></b></div><div><span>中位移动距离</span><b>${ad.dead_km}<small> km</small></b></div><div><span>观察样本</span><b>${ad.legs}<small> 段</small></b></div></div>
           <p class="drop-description">${ad.legs < 8 ? '样本偏少，先作为参考。' : ''}${ad.dead_min >= 8 ? '续接时间较长，接送入单时多留转场余量。' : '历史续接较短，仍需结合当前等单情况。'}${ad.next_zone ? `跨区后续取餐较常见于 <strong>${esc(ad.next_zone)}</strong>。` : ''}</p>`
        : '<p class="drop-description">还没有足够的取送链条判断这个落点。</p>');
    }
    host.innerHTML += `<div class="drop-basis"><span>样本边界</span> ${c.dead_legs} 段续接 · 匹配链条覆盖总里程 ${c.coverage_pct}%。送达后到下一次取餐包含已接单去店；无法据此计算无偿空驶。</div>`;
  }
  function boot() {
    const d = dlvData();
    if (!d) { document.getElementById('dashStatus').textContent = '配送数据未加载，请刷新后重试。'; return; }
    const s = d.summary, v = d.validation;
    document.getElementById('dashStats').innerHTML = [
      [d.meta.shifts, '推定班次'], [s.hours.toFixed(0) + ' h', '骑行记录'], [s.pickups, '推断取餐'], [v ? v.recall_drop + '%' : '—', '送达召回率'],
    ].map(([n,k])=>`<div><b>${n}</b><span>${k}</span></div>`).join('');
    document.getElementById('dashStatus').innerHTML = `<span class="dash-history-tag">历史数据</span><span>${d.meta.first} — ${d.meta.last}</span><span>悉尼时间 · 非实时派单热力图</span><a href="#offer">输入一单 ↓</a>`;
    document.getElementById('dashMapNote').textContent = d.meta.shifts + ' 班次';
    DeliveryPlanner.mountOffer(document.getElementById('dashOffer'), d);
    DeliveryPlanner.mountZones(document.getElementById('dashZones'), d);
    DeliveryPlanner.mountSlots(document.getElementById('dashSlots'), d);
    DeliveryPlanner.mountSettlement(document.getElementById('dashSettlement'), d);
    DeliveryPlanner.mountLedger(document.getElementById('dashLedger'), d);
    mountActivity();
    renderDrop(d, null);
    window.addEventListener('delivery-zone-focus', e => renderDrop(d, e.detail));
    try {
      if (typeof L === 'undefined') throw new Error('Leaflet unavailable');
      renderDeliveryMap();
    } catch(e) { document.getElementById('dlvMap').textContent = '地图暂时无法加载；仍可使用区域列表和接单计算器。'; }
    const kick = () => { if (typeof DLVMAP !== 'undefined' && DLVMAP.map) DLVMAP.map.invalidateSize(); };
    setTimeout(kick, 250);
    let timer;
    window.addEventListener('resize', () => { clearTimeout(timer); timer = setTimeout(kick, 120); });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
