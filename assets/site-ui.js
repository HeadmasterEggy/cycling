/* Shared navigation and chart inspection. Existing chart nodes keep their handlers. */
(function () {
  'use strict';
  const $ = (s, root = document) => root.querySelector(s);
  const all = (s, root = document) => [...root.querySelectorAll(s)];
  const button = (label, className) => {
    const el = document.createElement('button');
    el.type = 'button'; el.className = className; el.textContent = label;
    return el;
  };
  function navigation() {
    const nav = $('#topNav');
    if (!nav) return;
    const links = all('a', nav);
    const brand = document.createElement('a');
    brand.href = 'index.html'; brand.className = 'atlas-brand';
    brand.innerHTML = '<span aria-hidden="true">↗</span><b>CYCLING ATLAS<small>RIDE · OBSERVE · DECIDE</small></b>';
    const group = document.createElement('div'); group.className = 'atlas-pages';
    links.forEach(a => { group.append(a); if(a.classList.contains('top-nav-link--active')) a.setAttribute('aria-current','page'); });
    const mobile = document.createElement('label'); mobile.className = 'atlas-page-picker';
    const label = document.createElement('span'); label.className = 'site-sr-only'; label.textContent = '切换页面';
    const select = document.createElement('select');
    links.forEach(a => {
      const o = new Option($('.top-nav-cn',a)?.textContent || a.textContent,a.getAttribute('href'));
      o.selected = a.classList.contains('top-nav-link--active'); select.add(o);
    });
    select.addEventListener('change',()=>{ location.href = select.value; });
    mobile.append(label,select);
    nav.replaceChildren(brand,group,mobile);
    const skip = document.createElement('a'); skip.className = 'site-skip'; skip.href = '#mainContent'; skip.textContent = '跳到内容';
    const main = $('main'); if(main) { main.id ||= 'mainContent'; skip.href = '#'+main.id; document.body.prepend(skip); }
  }
  function sections() {
    const main = $('main'); if(!main || document.body.dataset.page === 'dashboard') return;
    const sections = all(':scope > section',main).filter(s=>$('.section-title',s));
    if(sections.length<2) return;
    const nav = document.createElement('nav'); nav.className='section-index'; nav.setAttribute('aria-label','本页章节');
    const intro = document.createElement('span'); intro.className='section-index-label'; intro.textContent = '本页'; nav.append(intro);
    sections.forEach((s,i)=>{
      s.id ||= 'section-'+i;
      const title=$('.section-title',s);
      title.setAttribute('role','heading'); title.setAttribute('aria-level','2');
      const a=document.createElement('a'); a.href='#'+s.id;
      a.textContent=title.firstChild.textContent.trim(); nav.append(a);
    });
    main.before(nav);
    // The chapter strip works with a keyboard and on phones; retire the div-only sidebar.
    $('#sideNav')?.remove();
    const links=all('a',nav);
    let queued=false;
    const update=()=>{
      queued=false;
      let active=0;
      sections.forEach((s,i)=>{if(s.getBoundingClientRect().top<180)active=i;});
      links.forEach((a,i)=>{a.classList.toggle('active',i===active);if(i===active)a.setAttribute('aria-current','location');else a.removeAttribute('aria-current');});
    };
    window.addEventListener('scroll',()=>{if(!queued){queued=true;requestAnimationFrame(update);}},{passive:true}); update();
  }
  function chartTools() {
    const main=$('main'); if(!main) return;
    let dialog=null, current=null;
    const restore=()=>{
      if(!current)return;
      const {svg,placeholder,readout,readoutPlaceholder,trigger}=current;
      placeholder.replaceWith(svg);
      if(readoutPlaceholder)readoutPlaceholder.replaceWith(readout);
      current=null; document.body.classList.remove('chart-is-open');
      trigger.focus({preventScroll:true});
    };
    function open(svg,title,trigger){
      if(!dialog){
        dialog=document.createElement('dialog');dialog.className='chart-dialog';dialog.setAttribute('aria-labelledby','chartDialogTitle');
        dialog.innerHTML='<header><div><span>图表细看</span><h2 id="chartDialogTitle"></h2></div><button type="button" class="chart-dialog-close" aria-label="关闭图表">关闭 ×</button></header><p class="chart-dialog-hint">横向滚动查看完整图表；保留原图的读数操作。按 Esc 关闭。</p><div class="chart-dialog-body"></div>';
        document.body.append(dialog);
        $('.chart-dialog-close',dialog).addEventListener('click',()=>dialog.close());
        dialog.addEventListener('close',restore);
        dialog.addEventListener('click',e=>{if(e.target===dialog){const r=dialog.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)dialog.close();}});
      }
      const placeholder=document.createComment('chart position');svg.before(placeholder);
      const readout=document.getElementById(svg.id+'Readout')
        || all('.chart-readout',svg.parentElement).find(el=>el.dataset.chartReadout===svg.id);
      let readoutPlaceholder=null;
      if(readout){readoutPlaceholder=document.createComment('chart readout position');readout.before(readoutPlaceholder);}
      current={svg,placeholder,readout,readoutPlaceholder,trigger};
      $('#chartDialogTitle',dialog).textContent=title;
      const host=$('.chart-dialog-body',dialog);host.replaceChildren(svg);if(readout)host.append(readout);
      document.body.classList.add('chart-is-open');dialog.showModal();
    }
    function scan(){
      all('svg[id][viewBox]',main).forEach(svg=>{
        if(svg.dataset.siteChart||svg.closest('.leaflet-container, .planner, .detail-panel, .latest-band'))return;
        const box=svg.viewBox.baseVal;
        if(box.width<450 && svg.id!=='hourClock')return;
        svg.dataset.siteChart='true';
        const title=$('.chart-title',svg.closest('.chart-card')||svg.parentElement)?.textContent.trim()
          || $('.section-title',svg.closest('section')||svg.parentElement)?.textContent.trim() || '图表';
        if(!svg.hasAttribute('aria-label')&&!svg.hasAttribute('aria-labelledby'))svg.setAttribute('aria-label',title);
        const toolbar=document.createElement('div');toolbar.className='chart-toolbar';
        const context=document.createElement('span');context.textContent='趋势与读数';
        const expand=button('放大图表 ↗','chart-expand');expand.setAttribute('aria-label','放大图表：'+title);expand.addEventListener('click',()=>open(svg,title,expand));
        toolbar.append(context,expand);svg.before(toolbar);
      });
    }
    scan();
    let scheduled=false;
    new MutationObserver(records=>{
      if(!records.some(r=>[...r.addedNodes].some(n=>n.nodeType===1 && (n.matches?.('svg[id][viewBox]')||n.querySelector?.('svg[id][viewBox]')))))return;
      if(!scheduled){scheduled=true;requestAnimationFrame(()=>{scheduled=false;scan();});}
    }).observe(main,{childList:true,subtree:true});
  }
  function scrollingTables(){
    all('.rides-table-wrap, .hz-wrap, .zp-wrap, .heatmap-wrap, .plan-table-scroll').forEach(host=>{
      host.tabIndex=0;host.setAttribute('role','region');
      if(!host.hasAttribute('aria-label'))host.setAttribute('aria-label','数据明细，可横向滚动');
    });
  }
  function boot(){ navigation();sections();chartTools();scrollingTables(); }
  if(document.readyState==='loading')window.addEventListener('DOMContentLoaded',boot);else boot();
})();
