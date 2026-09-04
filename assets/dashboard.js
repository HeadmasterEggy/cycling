/* Delivery console: shared planner controls and a linked, historical map. */
(function () {
  'use strict';
  const esc = s => dlvEsc(s);
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
    DeliveryPlanner.mountSettlement(document.getElementById('dashSettlement'), d);
    DeliveryPlanner.mountLedger(document.getElementById('dashLedger'), d);
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
