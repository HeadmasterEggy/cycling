// ============ 状态 ============
let map;
let currentCity = "Sydney";
let routePolylines = []; // {polyline, route}
let selectedPolyline = null;
let selectedRouteName = null;

// City info computed from ROUTES_DATA so counts stay fresh
function cityStats(city) {
  const routes = window.ROUTES_DATA || [];
  const subset = city === 'all' ? routes : routes.filter(r => r.city === city);
  const km = subset.reduce((a, r) => a + (r.distance_km || 0), 0);
  const dates = subset.map(r => r.start_date).filter(Boolean).sort();
  return { count: subset.length, km, first: dates[0], last: dates[dates.length - 1] };
}
function cityRange(stats) {
  if (!stats.first || !stats.last) return '';
  const f = stats.first.replace(/-/g, '.'), l = stats.last.replace(/-/g, '.');
  return f === l ? f : `${f} → ${l}`;
}
function cityInfo(city) {
  const s = cityStats(city);
  const km = s.km.toFixed(1);
  const range = cityRange(s);
  switch (city) {
    case 'Sydney': return {
      title: '悉尼',
      text: `<strong>${s.count} 条路线 · ${km} km</strong>。覆盖悉尼中部城区，以 -33.91°N, 151.17°E 为中心。绝大部分在 2026 年送外卖期间产生。 <span style="color:var(--text-faint)">${range}</span>`
    };
    case 'Shanghai': return {
      title: '上海',
      text: `<strong>${s.count} 条路线 · ${km} km</strong>。短期回国期间的代步出行。 <span style="color:var(--text-faint)">${range}</span>`
    };
    case 'Ningbo': return {
      title: '宁波',
      text: `<strong>${s.count} 条路线 · ${km} km</strong>。早期回国记录，坐标在江北 / 海曙一带。 <span style="color:var(--text-faint)">${range}</span>`
    };
    case 'Henan': return {
      title: '华北',
      text: `<strong>${s.count} 条路线 · ${km} km</strong>。坐标约 36°N 115°E，河南 — 河北交界一带。 <span style="color:var(--text-faint)">${range}</span>`
    };
    case 'all': return {
      title: '全部地点',
      text: `<strong>${s.count} 条路线 · ${km} km</strong>。所有 GPS 轨迹合集，横跨中澳两国 4 个城市群。 <span style="color:var(--text-faint)">${range}</span>`
    };
    default: return { title: city, text: `${s.count} 条路线 · ${km} km` };
  }
}

// ============ 工具函数 ============
function formatDuration(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function formatTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleString("zh-CN", {
    month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit",
    hour12: false
  });
}

function formatDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" });
}

// ============ 地图初始化 ============
function initMap() {
  map = L.map('map', {
    zoomControl: true,
    attributionControl: true,
  }).setView([-33.91, 151.17], 13);

  // CartoDB Dark Matter tiles - 适合暗色主题
  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}{r}.png', {
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OSM</a> · © <a href="https://carto.com/">CARTO</a>',
    subdomains: 'abcd',
    maxZoom: 19
  }).addTo(map);

  // 标签层(单独叠加,可以更亮)
  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_only_labels/{z}/{x}/{y}{r}.png', {
    subdomains: 'abcd',
    maxZoom: 19,
    pane: 'shadowPane'
  }).addTo(map);
}

// ============ 渲染路线 ============
function clearPolylines() {
  routePolylines.forEach(({polyline}) => map.removeLayer(polyline));
  routePolylines = [];
  selectedPolyline = null;
  selectedRouteName = null;
}

function renderRoutes(city) {
  clearPolylines();
  const filtered = city === "all" 
    ? window.ROUTES_DATA 
    : window.ROUTES_DATA.filter(r => r.city === city);

  // 按距离从短到长画,这样长的(更重要)在上面
  const sorted = [...filtered].sort((a, b) => a.distance_km - b.distance_km);
  
  const bounds = [];
  sorted.forEach((route, idx) => {
    if (route.track.length < 2) return;
    const polyline = L.polyline(route.track, {
      color: '#e8b76d',
      weight: 2,
      opacity: 0.55,
      lineCap: 'round',
      lineJoin: 'round'
    }).addTo(map);
    
    polyline.on('click', () => selectRoute(route));
    polyline.on('mouseover', function() {
      if (selectedRouteName !== route.name) {
        this.setStyle({ weight: 4, opacity: 0.9, color: '#ffd897' });
      }
    });
    polyline.on('mouseout', function() {
      if (selectedRouteName !== route.name) {
        this.setStyle({ weight: 2, opacity: 0.55, color: '#e8b76d' });
      }
    });
    
    routePolylines.push({polyline, route});
    route.track.forEach(p => bounds.push(p));
  });

  if (bounds.length > 0) {
    map.fitBounds(bounds, { padding: [40, 40] });
  }
}

// ============ 列表 ============
function renderList(city) {
  const filtered = city === "all" 
    ? window.ROUTES_DATA 
    : window.ROUTES_DATA.filter(r => r.city === city);

  // 按时间倒序
  const sorted = [...filtered].sort((a, b) => 
    new Date(b.start_time) - new Date(a.start_time)
  );

  const listEl = document.getElementById('routeList');
  listEl.innerHTML = sorted.map(r => `
    <div class="route-item" data-name="${r.name}" onclick="selectRouteByName('${r.name}')">
      <div class="route-item-time">${formatTime(r.start_local)}</div>
      <div class="route-item-title">${r.distance_km.toFixed(1)} km · ${formatDuration(r.duration_sec)}</div>
      <div class="route-item-stats">
        <span><strong>${r.avg_speed_kmh.toFixed(1)}</strong> 均</span>
        <span><strong>${r.max_speed_kmh.toFixed(0)}</strong> 峰</span>
        <span><strong>${r.ele_gain_m.toFixed(0)}</strong>m 爬升</span>
      </div>
    </div>
  `).join('');

  document.getElementById('panelTitle').textContent = (cityInfo(city) || {}).title + '路线';
  document.getElementById('panelCount').textContent = sorted.length;
}

// ============ 选择路线 ============
function selectRoute(route) {
  // 重置之前
  routePolylines.forEach(({polyline, route: r}) => {
    if (r.name === route.name) {
      polyline.setStyle({ weight: 5, opacity: 1, color: '#ffd897' });
      polyline.bringToFront();
      selectedPolyline = polyline;
    } else {
      polyline.setStyle({ weight: 1.5, opacity: 0.25, color: '#a87f3e' });
    }
  });
  selectedRouteName = route.name;

  // 移到此路线
  if (route.track.length > 0) {
    map.fitBounds(route.track, { padding: [60, 60], maxZoom: 16 });
  }

  // 高亮列表项
  document.querySelectorAll('.route-item').forEach(el => {
    el.classList.toggle('active', el.dataset.name === route.name);
    if (el.dataset.name === route.name) {
      el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  });

  // 显示详情
  showDetail(route);
}

function selectRouteByName(name) {
  const route = window.ROUTES_DATA.find(r => r.name === name);
  if (!route) return;
  
  // 如果不在当前城市,切换
  if (currentCity !== route.city && currentCity !== "all") {
    currentCity = route.city;
    document.querySelectorAll('.city-tab').forEach(t => {
      t.classList.toggle('active', t.dataset.city === route.city);
    });
    renderRoutes(route.city);
    renderList(route.city);
    updateCityInfo(route.city);
    // 等待渲染完成再选择
    setTimeout(() => selectRoute(route), 100);
  } else {
    selectRoute(route);
  }
}

function showDetail(route) {
  const panel = document.getElementById('detailPanel');
  panel.classList.add('visible');
  document.getElementById('detailTitle').textContent = 
    `${route.distance_km.toFixed(1)} km · ${formatDuration(route.duration_sec)}`;
  document.getElementById('detailTime').textContent = 
    `${formatTime(route.start_local)} → ${formatTime(route.end_local)} · ${route.city}`;

  const stats = [
    { label: "距离", value: route.distance_km.toFixed(2), unit: "km" },
    { label: "时长", value: formatDuration(route.duration_sec), unit: "" },
    { label: "均速", value: route.avg_speed_kmh.toFixed(1), unit: "km/h" },
    { label: "峰值速度", value: route.max_speed_kmh.toFixed(1), unit: "km/h" },
    { label: "累计爬升", value: route.ele_gain_m.toFixed(0), unit: "m" },
    { label: "采样点", value: route.num_points.toLocaleString(), unit: "" },
  ];

  // 健康指标 (Apple Health workout 配对)
  const w = workoutByRouteFile(route.filename);
  if (w) {
    if (w.hr_avg != null)
      stats.push({ label: "平均心率", value: w.hr_avg.toFixed(0), unit: "bpm", cls: "health" });
    if (w.hr_max != null)
      stats.push({ label: "最高心率", value: w.hr_max.toFixed(0), unit: "bpm", cls: "health" });
    if (w.active_kcal != null)
      stats.push({ label: "活动卡路里", value: w.active_kcal.toFixed(0), unit: "kcal", cls: "health" });
    if (w.mets != null)
      stats.push({ label: "METs", value: w.mets.toFixed(1), unit: "", cls: "health" });
    if (w.weather_temp_c != null)
      stats.push({ label: "气温", value: w.weather_temp_c.toFixed(1), unit: "℃", cls: "health" });
    if (w.weather_humidity != null)
      stats.push({ label: "湿度", value: Math.round(w.weather_humidity*100), unit: "%", cls: "health" });
  }

  document.getElementById('detailStats').innerHTML = stats.map(s => `
    <div class="detail-stat${s.cls ? ' ' + s.cls : ''}">
      <div class="detail-stat-label">${s.label}</div>
      <div class="detail-stat-value">${s.value}<small>${s.unit}</small></div>
    </div>
  `).join('');

  // 海拔曲线 (from paired Apple Health workout's elev_series)
  renderDetailElevation(route);

  // 滚动到详情
  panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function closeDetail() {
  document.getElementById('detailPanel').classList.remove('visible');
  // 恢复所有路线样式
  routePolylines.forEach(({polyline}) => {
    polyline.setStyle({ weight: 2, opacity: 0.55, color: '#e8b76d' });
  });
  selectedRouteName = null;
  document.querySelectorAll('.route-item').forEach(el => el.classList.remove('active'));
}

// ============ 城市计数 ============
// Fill the per-city route counts in the tab bar from ROUTES_DATA so the
// tabs never sit on their "—" placeholder.
function renderCityCounts() {
  const routes = window.ROUTES_DATA || [];
  document.querySelectorAll('[data-city-count]').forEach(el => {
    const city = el.dataset.cityCount;
    el.textContent = city === 'all'
      ? routes.length
      : routes.filter(r => r.city === city).length;
  });
}

// ============ 城市说明 ============
function updateCityInfo(city) {
  const info = cityInfo(city);
  document.getElementById('cityInfo').innerHTML = info.text;
}

// ============ 城市切换 ============
document.querySelectorAll('.city-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.city-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    currentCity = tab.dataset.city;
    closeDetail();
    renderRoutes(currentCity);
    renderList(currentCity);
    updateCityInfo(currentCity);
  });
});

// ============ 时段时钟 ============
function renderHourClock() {
  const svg = document.getElementById('hourClock');
  const cx = 170, cy = 170, R = 130;
  
  const sydneyRoutes = window.ROUTES_DATA.filter(r => r.city === "Sydney");
  const hourCounts = new Array(24).fill(0);
  sydneyRoutes.forEach(r => {
    hourCounts[Math.floor(r.start_hour)] += 1;
  });
  const maxCount = Math.max(...hourCounts);

  let html = '';
  
  // 同心圆背景
  for (let i = 1; i <= 3; i++) {
    html += `<circle cx="${cx}" cy="${cy}" r="${R*i/3}" fill="none" stroke="#2a2c35" stroke-width="0.5"/>`;
  }

  // 24 小时分隔线
  for (let h = 0; h < 24; h++) {
    const angle = (h / 24) * Math.PI * 2 - Math.PI / 2;
    const x1 = cx + Math.cos(angle) * 15;
    const y1 = cy + Math.sin(angle) * 15;
    const x2 = cx + Math.cos(angle) * R;
    const y2 = cy + Math.sin(angle) * R;
    if (h % 6 === 0) {
      html += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#3a3d48" stroke-width="0.5"/>`;
    }
  }

  // 时段柱
  for (let h = 0; h < 24; h++) {
    const count = hourCounts[h];
    if (count === 0) continue;
    const r = 15 + (count / maxCount) * (R - 15);
    const angle1 = ((h - 0.4) / 24) * Math.PI * 2 - Math.PI / 2;
    const angle2 = ((h + 0.4) / 24) * Math.PI * 2 - Math.PI / 2;
    
    const x1 = cx + Math.cos(angle1) * 15;
    const y1 = cy + Math.sin(angle1) * 15;
    const x2 = cx + Math.cos(angle1) * r;
    const y2 = cy + Math.sin(angle1) * r;
    const x3 = cx + Math.cos(angle2) * r;
    const y3 = cy + Math.sin(angle2) * r;
    const x4 = cx + Math.cos(angle2) * 15;
    const y4 = cy + Math.sin(angle2) * 15;
    
    const intensity = count / maxCount;
    const color = h >= 16 && h <= 19 ? '#ffd897' : '#e8b76d';
    html += `<path d="M ${x1} ${y1} L ${x2} ${y2} A ${r} ${r} 0 0 1 ${x3} ${y3} L ${x4} ${y4} A 15 15 0 0 0 ${x1} ${y1} Z"
      fill="${color}" fill-opacity="${0.3 + intensity * 0.6}" stroke="${color}" stroke-width="0.5"/>`;
  }

  // 小时数字
  for (let h = 0; h < 24; h += 3) {
    const angle = (h / 24) * Math.PI * 2 - Math.PI / 2;
    const x = cx + Math.cos(angle) * (R + 16);
    const y = cy + Math.sin(angle) * (R + 16);
    html += `<text x="${x}" y="${y}" text-anchor="middle" dominant-baseline="middle"
      fill="#908d85" font-family="JetBrains Mono" font-size="10">${h.toString().padStart(2, '0')}</text>`;
  }

  // 中心
  html += `<circle cx="${cx}" cy="${cy}" r="13" fill="#14151a" stroke="#3a3d48" stroke-width="0.5"/>`;
  html += `<text x="${cx}" y="${cy-2}" text-anchor="middle" font-family="Fraunces" font-size="14" fill="#e8b76d">${sydneyRoutes.length}</text>`;
  html += `<text x="${cx}" y="${cy+10}" text-anchor="middle" font-family="JetBrains Mono" font-size="7" fill="#5d5b55" letter-spacing="0.1em">RIDES</text>`;

  svg.innerHTML = html;
}

// ============ 周分布 ============
function renderWeekday() {
  const weekdayNames = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
  const sydneyRoutes = window.ROUTES_DATA.filter(r => r.city === "Sydney");
  const counts = new Array(7).fill(0);
  sydneyRoutes.forEach(r => counts[r.weekday] += 1);
  const maxCount = Math.max(...counts);

  const html = weekdayNames.map((name, i) => `
    <div class="weekday-row">
      <div class="weekday-label">${name}</div>
      <div class="weekday-bar-bg">
        <div class="weekday-bar-fill" style="width: ${(counts[i] / maxCount * 100).toFixed(0)}%"></div>
      </div>
      <div class="weekday-count">${counts[i]}</div>
    </div>
  `).join('');
  document.getElementById('weekdayChart').innerHTML = html;
}

// ============ 每日柱状图 ============
function renderDailyChart() {
  // Range-aware: when active range is set, use that window over H.daily;
  // otherwise fall back to the original 2026-04-25→2026-05-19 Sydney window.
  const r = window.getActiveRange && window.getActiveRange();
  const HD = window.HEALTH_DATA;
  let startDate, endDate, dailyFromHealth = null;
  if (r && r.from && r.to) {
    startDate = new Date(r.from);
    endDate = new Date(r.to);
    if (HD && HD.daily) {
      dailyFromHealth = {};
      HD.daily.forEach(d => { dailyFromHealth[d.date] = (d.distance_km || 0); });
    }
  } else {
    startDate = new Date("2026-04-25");
    endDate = new Date("2026-05-19");
  }

  // Build per-day km map. Prefer ROUTES_DATA (Sydney GPS) for the default
  // window, otherwise fall back to H.daily aggregates.
  const daily = {};
  if (dailyFromHealth) {
    Object.assign(daily, dailyFromHealth);
  } else {
    window.ROUTES_DATA.filter(rt => rt.city === "Sydney").forEach(rt => {
      const d = rt.start_date;
      if (d >= startDate.toISOString().slice(0,10) && d <= endDate.toISOString().slice(0,10)) {
        daily[d] = (daily[d] || 0) + rt.distance_km;
      }
    });
  }

  // 生成完整日期序列
  const days = [];
  for (let d = new Date(startDate); d <= endDate; d.setDate(d.getDate() + 1)) {
    const ds = d.toISOString().slice(0, 10);
    days.push({ date: ds, km: daily[ds] || 0, dayObj: new Date(d) });
  }
  if (!days.length) {
    document.getElementById('dailyChart').innerHTML = '';
    return;
  }

  const W = 800, H = 200;
  const padL = 30, padR = 10, padT = 20, padB = 30;
  const chartW = W - padL - padR;
  const chartH = H - padT - padB;
  const barW = chartW / days.length;
  const maxKm = Math.max(...days.map(d => d.km), 50);

  let html = '';
  
  // 网格线
  [0, 25, 50, 75].forEach(v => {
    if (v > maxKm) return;
    const y = padT + chartH - (v / maxKm) * chartH;
    html += `<line x1="${padL}" y1="${y}" x2="${W-padR}" y2="${y}" stroke="#2a2c35" stroke-width="0.5" stroke-dasharray="2 4"/>`;
    html += `<text x="${padL-6}" y="${y+3}" text-anchor="end" font-family="JetBrains Mono" font-size="9" fill="#5d5b55">${v}</text>`;
  });

  // 柱
  days.forEach((d, i) => {
    if (d.km === 0) {
      // 空日:细灰线
      const x = padL + i * barW + barW/2;
      html += `<line x1="${x}" y1="${padT + chartH}" x2="${x}" y2="${padT + chartH - 4}" stroke="#3a3d48" stroke-width="1"/>`;
    } else {
      const h = (d.km / maxKm) * chartH;
      const x = padL + i * barW + 1;
      const y = padT + chartH - h;
      const isWeekend = d.dayObj.getDay() === 0 || d.dayObj.getDay() === 6;
      html += `<rect x="${x}" y="${y}" width="${barW-2}" height="${h}" 
        fill="${isWeekend ? '#ffd897' : '#e8b76d'}" fill-opacity="0.85"/>`;
      // 顶部数字(可选)
      if (d.km > 40) {
        html += `<text x="${x + barW/2}" y="${y-4}" text-anchor="middle" font-family="JetBrains Mono" font-size="8" fill="#e8b76d">${d.km.toFixed(0)}</text>`;
      }
    }
  });

  // x 轴标签(每隔几天)
  days.forEach((d, i) => {
    if (i % 4 === 0 || i === days.length - 1) {
      const x = padL + i * barW + barW/2;
      const label = (d.dayObj.getMonth()+1) + '/' + d.dayObj.getDate();
      html += `<text x="${x}" y="${H - 10}" text-anchor="middle" font-family="JetBrains Mono" font-size="9" fill="#5d5b55">${label}</text>`;
    }
  });

  document.getElementById('dailyChart').innerHTML = html;
}

// ============ 健康数据辅助 ============
function workoutByRouteFile(filename) {
  if (!window.HEALTH_DATA || !window.HEALTH_DATA.workouts) return null;
  return window.HEALTH_DATA.workouts.find(w => w.route_file === filename) || null;
}

// ============ 月度图 ============
const MONTH_METRICS = {
  distance_km: { unit: 'km', color: 'amber', fmt: v => v.toFixed(1) },
  duration_min: { unit: 'min', color: 'amber', fmt: v => v.toFixed(0) },
  rides: { unit: '次', color: 'rides', fmt: v => v.toString() },
  kcal: { unit: 'kcal', color: 'amber', fmt: v => v.toFixed(0) },
  elev_gain_m: { unit: 'm', color: 'amber', fmt: v => v.toFixed(0) },
};

let currentMonthMetric = 'distance_km';

function renderMonthlyChart() {
  if (!window.HEALTH_DATA) return;
  const monthly = window.HEALTH_DATA.monthly;
  const cfg = MONTH_METRICS[currentMonthMetric];
  const maxV = Math.max(...monthly.map(m => m[currentMonthMetric]));
  const fillClass = cfg.color === 'rides' ? 'rides' : '';

  const monthLabel = ym => {
    const [y, mm] = ym.split('-');
    return `${y.slice(2)}'${mm}`;
  };

  const html = monthly.map(m => {
    const v = m[currentMonthMetric];
    const pct = (v / maxV * 100).toFixed(1);
    return `
      <div class="monthly-row">
        <div class="month-label">${monthLabel(m.month)}</div>
        <div class="month-bar-bg">
          <div class="month-bar-fill ${fillClass}" style="width: ${pct}%"></div>
        </div>
        <div class="month-value">${cfg.fmt(v)} <span style="color: var(--text-faint); font-size: 10px;">${cfg.unit}</span></div>
      </div>
    `;
  }).join('');
  document.getElementById('monthlyChart').innerHTML = html;
}

function bindMonthlyTabs() {
  document.querySelectorAll('.monthly-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.monthly-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      currentMonthMetric = tab.dataset.metric;
      renderMonthlyChart();
    });
  });
}

function renderMonthlyStats() {
  if (!window.HEALTH_DATA) return;
  const s = window.HEALTH_DATA.summary;
  document.getElementById('mActiveDays').textContent = s.active_days;
  document.getElementById('mStreak').innerHTML = `${s.longest_streak_days}<small>天</small>`;
  document.getElementById('mKcal').textContent = (s.total_kcal / 1000).toFixed(1) + 'k';
  document.getElementById('mClimb').innerHTML = `${(s.total_elev_gain_m / 1000).toFixed(1)}<small>k m</small>`;
}

// ============ HR 区间 ============
function renderHrZones() {
  if (!window.HEALTH_DATA) return;
  const z = window.HEALTH_DATA.summary.hr_zones;
  const labels = ['<100', '100-120', '120-140', '140-160', '≥160'];
  const keys = ['<100', '100-120', '120-140', '140-160', '>=160'];
  const counts = keys.map(k => z[k] || 0);
  const max = Math.max(...counts, 1);
  const html = labels.map((label, i) => {
    const h = (counts[i] / max) * 130;
    const cold = i <= 1;
    return `
      <div class="hr-zone">
        <div class="hr-zone-count">${counts[i]}</div>
        <div class="hr-zone-bar ${cold ? 'cold' : ''}" style="height: ${h}px;" title="${label} bpm: ${counts[i]} rides"></div>
        <div class="hr-zone-label">${label}</div>
      </div>
    `;
  }).join('');
  document.getElementById('hrZones').innerHTML = html;
}

// ============ 天气 × 心率 散点 ============
function renderWeatherScatter() {
  if (!window.HEALTH_DATA) return;
  const W = 600, H = 220;
  const padL = 44, padR = 16, padT = 16, padB = 32;
  const chartW = W - padL - padR;
  const chartH = H - padT - padB;

  const data = window.HEALTH_DATA.workouts
    .filter(w => w.weather_temp_c != null && w.hr_avg != null);

  if (data.length === 0) {
    document.getElementById('weatherScatter').innerHTML =
      `<text x="${W/2}" y="${H/2}" text-anchor="middle" fill="#5d5b55" font-family="JetBrains Mono" font-size="11">暂无气象 + 心率配对数据</text>`;
    return;
  }

  const xs = data.map(d => d.weather_temp_c);
  const ys = data.map(d => d.hr_avg);
  const xMin = Math.floor(Math.min(...xs) - 1), xMax = Math.ceil(Math.max(...xs) + 1);
  const yMin = Math.floor(Math.min(...ys) / 10) * 10 - 5;
  const yMax = Math.ceil(Math.max(...ys) / 10) * 10 + 5;
  const xScale = x => padL + (x - xMin) / (xMax - xMin) * chartW;
  const yScale = y => padT + chartH - (y - yMin) / (yMax - yMin) * chartH;

  const maxDist = Math.max(...data.map(d => d.distance_km));

  let html = '';
  // axes grid
  for (let y = Math.ceil(yMin/10)*10; y <= yMax; y += 10) {
    const yy = yScale(y);
    html += `<line x1="${padL}" y1="${yy}" x2="${W-padR}" y2="${yy}" stroke="#2a2c35" stroke-width="0.5" stroke-dasharray="2 4"/>`;
    html += `<text x="${padL-6}" y="${yy+3}" text-anchor="end" font-family="JetBrains Mono" font-size="9" fill="#5d5b55">${y}</text>`;
  }
  for (let x = Math.ceil(xMin/5)*5; x <= xMax; x += 5) {
    const xx = xScale(x);
    html += `<line x1="${xx}" y1="${padT}" x2="${xx}" y2="${padT+chartH}" stroke="#2a2c35" stroke-width="0.5" stroke-dasharray="2 4"/>`;
    html += `<text x="${xx}" y="${H-12}" text-anchor="middle" font-family="JetBrains Mono" font-size="9" fill="#5d5b55">${x}°</text>`;
  }
  // axis labels
  html += `<text x="${padL-30}" y="${padT+chartH/2}" text-anchor="middle" font-family="JetBrains Mono" font-size="9" fill="#908d85" transform="rotate(-90 ${padL-30} ${padT+chartH/2})">Avg HR bpm</text>`;
  html += `<text x="${padL+chartW/2}" y="${H-2}" text-anchor="middle" font-family="JetBrains Mono" font-size="9" fill="#908d85">Temp ℃</text>`;

  // points
  data.forEach(d => {
    const r = 3 + (d.distance_km / maxDist) * 9;
    const cx = xScale(d.weather_temp_c);
    const cy = yScale(d.hr_avg);
    html += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="#6cc4d9" fill-opacity="0.42" stroke="#6cc4d9" stroke-width="0.6"><title>${d.date} · ${d.weather_temp_c}℃ · HR ${d.hr_avg.toFixed(0)} · ${d.distance_km.toFixed(1)}km</title></circle>`;
  });

  document.getElementById('weatherScatter').innerHTML = html;
}

// ============ 活动日历 (heatmap) ============
function renderCalendar() {
  if (!window.HEALTH_DATA) return;

  // Index daily by date for fast lookup
  const dailyMap = {};
  window.HEALTH_DATA.daily.forEach(d => { dailyMap[d.date] = d; });

  // Build span: first ride to last ride, aligned to week (Mon-Sun)
  const first = new Date(window.HEALTH_DATA.summary.first_ride + 'T00:00:00');
  const last = new Date(window.HEALTH_DATA.summary.last_ride + 'T00:00:00');
  // Align to Monday
  const start = new Date(first);
  const dow = (start.getDay() + 6) % 7; // 0=Mon ... 6=Sun
  start.setDate(start.getDate() - dow);
  const end = new Date(last);
  end.setDate(end.getDate() + (6 - ((end.getDay() + 6) % 7)));

  // Buckets by max distance
  const maxKm = Math.max(...window.HEALTH_DATA.daily.map(d => d.distance_km), 1);
  const bucket = km => {
    if (!km) return 0;
    const r = km / maxKm;
    if (r < 0.12) return 1;
    if (r < 0.30) return 2;
    if (r < 0.60) return 3;
    return 4;
  };

  const cells = [];
  const monthLabels = []; // { col, label }
  let lastMonth = -1;
  let col = 0;
  const cur = new Date(start);
  while (cur <= end) {
    const ds = cur.toISOString().slice(0, 10);
    const data = dailyMap[ds];
    const bk = bucket(data ? data.distance_km : 0);
    const cls = bk ? `cal-cell l${bk}` : 'cal-cell';
    const title = data
      ? `${ds} · ${data.distance_km.toFixed(1)} km · ${data.rides} rides`
      : `${ds} · rest`;
    cells.push(`<div class="${cls}" title="${title}"></div>`);

    // Month label at start of each new month (first row only)
    if ((cur.getDay() + 6) % 7 === 0) {
      // start of new column (Mon)
      if (cur.getMonth() !== lastMonth) {
        monthLabels.push({ col, label: `${(cur.getMonth()+1).toString().padStart(2,'0')}` });
        lastMonth = cur.getMonth();
      }
      col++;
    }

    cur.setDate(cur.getDate() + 1);
  }

  document.getElementById('calGrid').innerHTML = cells.join('');

  // Month label header — using grid columns
  // We need to position labels above their starting columns
  // Use a flex/grid mapping by col index. We'll just space them by col.
  const totalCols = col;
  const monthHtml = monthLabels.map((m, i) => {
    const left = (m.col / totalCols) * 100;
    return `<span style="grid-column-start: ${m.col + 1};">${m.label}</span>`;
  }).join('');
  const monthHeader = document.getElementById('calMonths');
  monthHeader.style.gridTemplateColumns = `repeat(${totalCols}, 15px)`;
  monthHeader.innerHTML = monthHtml;
}

// ============ VO₂max 曲线 ============
function renderVo2() {
  if (!window.HEALTH_DATA || !window.HEALTH_DATA.vo2max) return;
  const data = window.HEALTH_DATA.vo2max;
  if (data.length < 2) return;
  const W = 700, H = 240;
  const padL = 40, padR = 20, padT = 22, padB = 30;
  const chartW = W - padL - padR;
  const chartH = H - padT - padB;

  const xs = data.map(d => new Date(d.date).getTime());
  const ys = data.map(d => d.value);
  const xMin = Math.min(...xs), xMax = Math.max(...xs);
  const yMin = Math.floor(Math.min(...ys) - 2);
  const yMax = Math.ceil(Math.max(...ys) + 2);
  const xs2 = x => padL + ((x - xMin) / (xMax - xMin)) * chartW;
  const ys2 = y => padT + chartH - ((y - yMin) / (yMax - yMin)) * chartH;

  let html = '';
  // y grid
  for (let y = Math.ceil(yMin); y <= yMax; y += 2) {
    if (y < yMin) continue;
    const yy = ys2(y);
    html += `<line x1="${padL}" y1="${yy}" x2="${W - padR}" y2="${yy}" stroke="#2a2c35" stroke-width="0.5" stroke-dasharray="2 4"/>`;
    html += `<text x="${padL - 6}" y="${yy + 3}" text-anchor="end" font-family="JetBrains Mono" font-size="9" fill="#5d5b55">${y}</text>`;
  }
  // x ticks (months)
  const seen = new Set();
  data.forEach(d => {
    const m = d.date.slice(0, 7);
    if (seen.has(m)) return;
    seen.add(m);
    const xx = xs2(new Date(d.date).getTime());
    html += `<text x="${xx}" y="${H - 12}" text-anchor="middle" font-family="JetBrains Mono" font-size="9" fill="#5d5b55">${m.slice(2)}</text>`;
  });

  // area under curve
  const pathD = data.map((d, i) => {
    const x = xs2(new Date(d.date).getTime()), y = ys2(d.value);
    return (i === 0 ? 'M' : 'L') + x + ' ' + y;
  }).join(' ');
  const areaD = pathD + ` L ${xs2(xMax)} ${padT + chartH} L ${xs2(xMin)} ${padT + chartH} Z`;
  html += `<path d="${areaD}" fill="url(#vo2grad)" opacity="0.6"/>`;
  html += `<defs><linearGradient id="vo2grad" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0%" stop-color="#e8b76d" stop-opacity="0.5"/>
    <stop offset="100%" stop-color="#e8b76d" stop-opacity="0"/>
    </linearGradient></defs>`;
  html += `<path d="${pathD}" fill="none" stroke="#e8b76d" stroke-width="1.6" stroke-linejoin="round"/>`;

  // points + endpoints highlight
  data.forEach((d, i) => {
    const x = xs2(new Date(d.date).getTime()), y = ys2(d.value);
    const isEdge = i === 0 || i === data.length - 1;
    const fill = isEdge ? '#ffd897' : '#a87f3e';
    const r = isEdge ? 4 : 2;
    html += `<circle cx="${x}" cy="${y}" r="${r}" fill="${fill}" stroke="#0a0a0c" stroke-width="1"><title>${d.date} · ${d.value} mL/min·kg</title></circle>`;
  });
  // annotate endpoints
  const first = data[0], last = data[data.length - 1];
  const fx = xs2(new Date(first.date).getTime()), fy = ys2(first.value);
  const lx = xs2(new Date(last.date).getTime()), ly = ys2(last.value);
  html += `<text x="${fx + 6}" y="${fy - 8}" font-family="JetBrains Mono" font-size="10" fill="#ffd897">${first.value}</text>`;
  html += `<text x="${lx - 6}" y="${ly - 8}" text-anchor="end" font-family="JetBrains Mono" font-size="10" fill="#ffd897">${last.value}</text>`;

  document.getElementById('vo2Chart').innerHTML = html;

  document.getElementById('vo2First').textContent = first.value;
  document.getElementById('vo2Last').textContent = last.value;
  const delta = last.value - first.value;
  const trendEl = document.getElementById('vo2Trend');
  if (Math.abs(delta) < 0.5) {
    trendEl.innerHTML = `变化 <strong>${delta >= 0 ? '+' : ''}${delta.toFixed(1)}</strong>`;
  } else if (delta < 0) {
    trendEl.innerHTML = `变化 <strong class="drop">▼ ${Math.abs(delta).toFixed(1)}</strong>`;
  } else {
    trendEl.innerHTML = `变化 <strong class="rise">▲ ${delta.toFixed(1)}</strong>`;
  }
  document.getElementById('vo2Sub').textContent = `${first.date} → ${last.date} · ${data.length} 次估算`;
}

// ============ 体重卡 ============
function renderWeight() {
  if (!window.HEALTH_DATA || !window.HEALTH_DATA.weight) return;
  const w = window.HEALTH_DATA.weight;
  if (!w.length) {
    document.querySelector('.weight-card').style.display = 'none';
    return;
  }
  const first = w[0], last = w[w.length - 1];
  document.getElementById('weightFrom').textContent =
    `${first.date} · 起点 ${first.kg} kg`;
  document.getElementById('weightNow').innerHTML =
    `${last.kg}<small>kg</small>`;
  const d = last.kg - first.kg;
  const el = document.getElementById('weightDelta');
  if (Math.abs(d) < 0.1) {
    el.textContent = '持平';
    el.style.color = 'var(--text-faint)';
  } else if (d < 0) {
    el.textContent = `▼ ${Math.abs(d).toFixed(1)} kg`;
    el.style.color = 'var(--cyan)';
  } else {
    el.textContent = `▲ ${d.toFixed(1)} kg`;
    el.style.color = 'var(--rose)';
  }
  // Position dot on a 75-100 kg axis (approximate human range).
  const lo = Math.min(first.kg, last.kg) - 4;
  const hi = Math.max(first.kg, last.kg) + 4;
  const pct = ((last.kg - lo) / (hi - lo)) * 100;
  document.getElementById('weightBarCur').style.left = pct.toFixed(1) + '%';
}

// ============ 身体 deltas ============
function renderBodyDeltas() {
  if (!window.HEALTH_DATA) return;
  const d = window.HEALTH_DATA.summary.body_deltas || {};
  const items = [
    { key: 'resting_hr', label: '静息心率', unit: 'bpm', goodDirection: 'down' },
    { key: 'hrv',        label: 'HRV (SDNN)', unit: 'ms', goodDirection: 'up' },
    { key: 'sleep_h',    label: '夜均睡眠', unit: 'h', goodDirection: 'up' },
    { key: 'resp_rate',  label: '睡眠呼吸', unit: '/min', goodDirection: 'down' },
    { key: 'spo2',       label: '血氧', unit: '%', goodDirection: 'up', scale: 100 },
    { key: 'steps',      label: '日均步数', unit: '步', goodDirection: 'up', formatter: v => Math.round(v).toLocaleString() },
  ];
  const html = items.map(it => {
    const stat = d[it.key];
    if (!stat) {
      return `<div class="delta-card">
        <div class="delta-label">${it.label}</div>
        <div class="delta-value" style="color: var(--text-faint);">—</div>
        <div class="delta-meta">数据缺失</div>
      </div>`;
    }
    const scale = it.scale || 1;
    const fmt = it.formatter || (v => (v * scale).toFixed(it.unit === 'h' ? 1 : (Math.abs(v) < 10 ? 1 : 0)));
    const recentFmt = fmt(stat.recent);
    const baseFmt = fmt(stat.baseline);
    const deltaAbs = stat.delta * scale;
    const isUp = stat.delta > 0.001;
    const isDown = stat.delta < -0.001;
    const arrow = isUp ? '▲' : isDown ? '▼' : '◆';
    const good = (it.goodDirection === 'up' && isUp) || (it.goodDirection === 'down' && isDown);
    const arrowCls = !isUp && !isDown ? 'flat' : (good ? 'down' : 'up');
    const barColor = good ? '' : 'rose';
    const barPct = Math.min(100, Math.abs(deltaAbs) / Math.max(Math.abs(baseFmt - 0) || 1, 1) * 200);
    return `<div class="delta-card">
      <div class="delta-label">${it.label}</div>
      <div class="delta-value">${recentFmt}<small>${it.unit}</small></div>
      <div class="delta-meta">
        基线 ${baseFmt}${it.unit} ·
        <span class="delta-arrow ${arrowCls}">${arrow} ${Math.abs(deltaAbs).toFixed(Math.abs(deltaAbs) < 10 ? 2 : 0)}${it.unit}</span>
      </div>
      <div class="delta-bar"><div class="delta-bar-inner ${barColor}" style="width: ${barPct.toFixed(1)}%;"></div></div>
    </div>`;
  }).join('');
  document.getElementById('deltaGrid').innerHTML = html;
}

// ============ 配速分布 ============
function renderSpeedDist() {
  if (!window.HEALTH_DATA) return;
  const buckets = window.HEALTH_DATA.summary.speed_buckets;
  const order = ['<10', '10-15', '15-20', '20-25', '>=25'];
  const max = Math.max(...order.map(k => buckets[k] || 0), 1);
  const html = order.map(k => {
    const c = buckets[k] || 0;
    const h = (c / max) * 130;
    return `<div class="speed-col">
      <div class="speed-count">${c}</div>
      <div class="speed-bar" style="height: ${h}px;" title="${k} km/h: ${c} rides"></div>
      <div class="speed-label">${k}</div>
    </div>`;
  }).join('');
  document.getElementById('speedDist').innerHTML = html;
}

// ============ 代价与回报 (Body Adaptation 引子) ============
function renderTradePanel() {
  const el = document.getElementById('tradePanel');
  if (!el || !window.HEALTH_DATA) return;
  const s = window.HEALTH_DATA.summary;

  const weightDelta = (s.weight_latest_kg || 0) - (s.weight_first_kg || 0); // -8
  const vo2Delta = (s.vo2max_latest || 0) - (s.vo2max_first || 0);          // -7.6
  const buckets = s.speed_buckets || {};
  const slowCount = (buckets['<10'] || 0) + (buckets['10-15'] || 0);
  const slowShare = s.ride_count ? (slowCount / s.ride_count * 100) : 0;

  const tiles = [
    {
      label: 'Body Mass',
      sign: weightDelta < 0 ? '▼' : '▲',
      value: Math.abs(weightDelta).toFixed(1),
      unit: 'kg',
      cls: weightDelta < 0 ? 'up' : 'down',          // weight down = positive outcome
      foot: `${s.weight_first_kg} → ${s.weight_latest_kg} kg`,
    },
    {
      label: 'VO₂max',
      sign: vo2Delta < 0 ? '▼' : '▲',
      value: Math.abs(vo2Delta).toFixed(1),
      unit: '',
      cls: vo2Delta < 0 ? 'down' : 'up',             // VO2max down = negative
      foot: `${s.vo2max_first.toFixed(1)} → ${s.vo2max_latest.toFixed(1)} ml/kg/min`,
    },
    {
      label: 'Pace < 15 km/h',
      sign: '◆',
      value: Math.round(slowShare),
      unit: '%',
      cls: 'flat',
      foot: `${slowCount} / ${s.ride_count} 次 · 停-走式骑行`,
    },
  ];

  el.innerHTML = `
    <div class="trade-story">
      <div class="trade-eyebrow">Trade-off · 一年的代价与回报</div>
      <div class="trade-headline">
        瘦了 <em>8 公斤</em>，VO₂max 却 <em>掉了 7.6</em>。
      </div>
      <div class="trade-body">
        2026 年 4 月起的送外卖周期把骑行变成了高量、低强度的代步动作 —— 心肺没有被推到训练区间，却被长时间的低速 + 站立踩踏不断消耗。Apple Watch 把这个故事写成了三条曲线。
      </div>
    </div>
    ${tiles.map(t => `
      <div class="trade-tile ${t.cls}">
        <div class="t-label">${t.label}</div>
        <div class="t-value"><span class="t-sign">${t.sign}</span>${t.value}<small>${t.unit}</small></div>
        <div class="t-foot">${t.foot}</div>
      </div>
    `).join('')}
  `;
}

// ============ 爬升 × 配速 散点 ============
function renderClimbChart() {
  const svg = document.getElementById('climbChart');
  if (!svg || !window.HEALTH_DATA) return;
  const workouts = (window.HEALTH_DATA.workouts || [])
    .filter(w => w.distance_km > 0.5 && w.avg_speed_kmh != null && w.elev_gain_m != null);
  if (!workouts.length) return;

  const W = 900, H = 320;
  const padL = 64, padR = 24, padT = 28, padB = 50;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  // Axes domains
  const xMax = Math.max(50, Math.ceil(Math.max(...workouts.map(w => w.elev_gain_m)) / 100) * 100);
  const yMax = Math.max(20, Math.ceil(Math.max(...workouts.map(w => w.avg_speed_kmh)) / 5) * 5);
  const xScale = v => padL + (v / xMax) * plotW;
  const yScale = v => padT + plotH - (v / yMax) * plotH;

  const deliveryFrom = '2026-04-01';
  const isDelivery = w => w.date >= deliveryFrom;

  // Radius scale
  const maxDist = Math.max(...workouts.map(w => w.distance_km));
  const rScale = km => 4 + Math.sqrt(km / maxDist) * 14;

  // X ticks
  const xTicks = [0, xMax * 0.25, xMax * 0.5, xMax * 0.75, xMax];
  const yTicks = [0, 5, 10, 15, 20].filter(v => v <= yMax);
  if (yTicks[yTicks.length - 1] < yMax) yTicks.push(yMax);

  // Linear regression for trend line (delivery rides only — that's the dominant cohort)
  const delivery = workouts.filter(isDelivery);
  const reg = delivery.length >= 2 ? linReg(delivery.map(w => [w.elev_gain_m, w.avg_speed_kmh])) : null;

  const gridLines = yTicks.map(v => `<line class="grid-line" x1="${padL}" x2="${W - padR}" y1="${yScale(v)}" y2="${yScale(v)}"/>`).join('');
  const xTickEls = xTicks.map(v =>
    `<text class="tick" x="${xScale(v)}" y="${H - padB + 18}" text-anchor="middle">${Math.round(v)}</text>`
  ).join('');
  const yTickEls = yTicks.map(v =>
    `<text class="tick" x="${padL - 10}" y="${yScale(v) + 4}" text-anchor="end">${v}</text>`
  ).join('');

  const dots = workouts.map(w => {
    const cx = xScale(w.elev_gain_m);
    const cy = yScale(w.avg_speed_kmh);
    const r = rScale(w.distance_km);
    const color = isDelivery(w) ? 'var(--amber)' : 'var(--cyan)';
    const title = `${w.date} · ${w.distance_km.toFixed(1)} km · ${w.avg_speed_kmh.toFixed(1)} km/h · 爬升 ${Math.round(w.elev_gain_m)} m · HR ${Math.round(w.hr_avg || 0)} bpm`;
    return `<circle class="ride-dot" cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${r.toFixed(1)}"
      fill="${color}" fill-opacity="0.22" stroke="${color}" stroke-opacity="0.85" stroke-width="1.2"><title>${title}</title></circle>`;
  }).join('');

  let trend = '';
  if (reg) {
    const x1 = 0, y1 = reg.intercept;
    const x2 = xMax, y2 = reg.intercept + reg.slope * xMax;
    // clamp y to plot range
    const clampY = y => Math.max(0, Math.min(yMax, y));
    trend = `<line class="trend-line" x1="${xScale(x1)}" x2="${xScale(x2)}" y1="${yScale(clampY(y1))}" y2="${yScale(clampY(y2))}"/>`;
  }

  svg.innerHTML = `
    ${gridLines}
    <line class="axis" x1="${padL}" x2="${W - padR}" y1="${H - padB}" y2="${H - padB}"/>
    <line class="axis-y" x1="${padL}" x2="${padL}" y1="${padT}" y2="${H - padB}"/>
    ${xTickEls}
    ${yTickEls}
    <text class="axis-label" x="${padL}" y="${padT - 12}">km/h</text>
    <text class="axis-label" x="${W - padR}" y="${H - 8}" text-anchor="end">elev gain · m</text>
    ${trend}
    ${dots}
  `;

  // Foot caption with correlation
  const corr = pearson(workouts.map(w => w.elev_gain_m), workouts.map(w => w.avg_speed_kmh));
  const slowest = workouts.reduce((a, b) => a.avg_speed_kmh < b.avg_speed_kmh ? a : b);
  document.getElementById('climbFoot').innerHTML =
    `Pearson r = <strong style="color:var(--text);font-family:var(--serif);">${corr.toFixed(2)}</strong> · 最慢 ${slowest.date} ${slowest.avg_speed_kmh.toFixed(1)} km/h`;
}

function linReg(pairs) {
  const n = pairs.length;
  const sx = pairs.reduce((a,p)=>a+p[0],0);
  const sy = pairs.reduce((a,p)=>a+p[1],0);
  const sxy = pairs.reduce((a,p)=>a+p[0]*p[1],0);
  const sxx = pairs.reduce((a,p)=>a+p[0]*p[0],0);
  const denom = n * sxx - sx * sx;
  if (!denom) return null;
  const slope = (n * sxy - sx * sy) / denom;
  const intercept = (sy - slope * sx) / n;
  return { slope, intercept };
}
function pearson(xs, ys) {
  const n = xs.length;
  const mx = xs.reduce((a,b)=>a+b,0) / n;
  const my = ys.reduce((a,b)=>a+b,0) / n;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) {
    const a = xs[i] - mx, b = ys[i] - my;
    num += a * b; dx += a * a; dy += b * b;
  }
  return dx && dy ? num / Math.sqrt(dx * dy) : 0;
}

// ============ 日活动叠加图 ============
let overlayMetric = 'resting_hr';
const OVERLAY_META = {
  resting_hr: { label: '静息心率', unit: 'bpm', round: 0 },
  hrv:        { label: 'HRV (SDNN)', unit: 'ms', round: 0 },
  sleep_h:    { label: '睡眠 (h)', unit: 'h', round: 1 },
  steps:      { label: '总步数', unit: '步', round: 0 },
};

function renderOverlayChart() {
  if (!window.HEALTH_DATA) return;
  const meta = OVERLAY_META[overlayMetric];
  document.getElementById('overlayLegendLabel').textContent = meta.label;

  // Build day list 2026-04-25 → 2026-05-24
  const start = new Date('2026-04-25T00:00:00');
  const end = new Date('2026-05-24T00:00:00');
  const days = [];
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    days.push(d.toISOString().slice(0, 10));
  }
  const byDate = {};
  window.HEALTH_DATA.daily.forEach(r => { byDate[r.date] = r; });

  const W = 800, H = 280;
  const padL = 44, padR = 50, padT = 22, padB = 36;
  const chartW = W - padL - padR;
  const chartH = H - padT - padB;
  const barW = chartW / days.length;

  // Distance scale (left axis)
  const maxKm = Math.max(...days.map(d => (byDate[d] && byDate[d].distance_km) || 0), 30);
  const yKm = v => padT + chartH - (v / maxKm) * chartH;

  // Metric scale (right axis)
  const metricVals = days.map(d => byDate[d] ? byDate[d][overlayMetric] : null).filter(v => v != null);
  if (!metricVals.length) {
    document.getElementById('overlayChart').innerHTML =
      `<text x="${W/2}" y="${H/2}" text-anchor="middle" fill="#5d5b55" font-family="JetBrains Mono" font-size="11">暂无 ${meta.label} 数据</text>`;
    return;
  }
  const mMin = Math.min(...metricVals);
  const mMax = Math.max(...metricVals);
  const pad = (mMax - mMin) * 0.15 || 1;
  const yMmin = mMin - pad, yMmax = mMax + pad;
  const yM = v => padT + chartH - ((v - yMmin) / (yMmax - yMmin)) * chartH;

  let html = '';
  // y grid (left = km)
  [0, maxKm/4, maxKm/2, 3*maxKm/4, maxKm].forEach(v => {
    const yy = yKm(v);
    html += `<line x1="${padL}" y1="${yy}" x2="${W-padR}" y2="${yy}" stroke="#2a2c35" stroke-width="0.5" stroke-dasharray="2 4"/>`;
    html += `<text x="${padL-6}" y="${yy+3}" text-anchor="end" font-family="JetBrains Mono" font-size="9" fill="#5d5b55">${v.toFixed(0)}</text>`;
  });
  // right axis labels
  [yMmin, (yMmin+yMmax)/2, yMmax].forEach(v => {
    const yy = yM(v);
    html += `<text x="${W-padR+8}" y="${yy+3}" text-anchor="start" font-family="JetBrains Mono" font-size="9" fill="#6cc4d9">${v.toFixed(meta.round)}</text>`;
  });
  // axis titles
  html += `<text x="${padL-30}" y="${padT+chartH/2}" text-anchor="middle" font-family="JetBrains Mono" font-size="9" fill="#908d85" transform="rotate(-90 ${padL-30} ${padT+chartH/2})">km</text>`;
  html += `<text x="${W-padR+30}" y="${padT+chartH/2}" text-anchor="middle" font-family="JetBrains Mono" font-size="9" fill="#6cc4d9" transform="rotate(90 ${W-padR+30} ${padT+chartH/2})">${meta.label}</text>`;

  // bars (km)
  days.forEach((ds, i) => {
    const r = byDate[ds];
    const km = (r && r.distance_km) || 0;
    if (km > 0) {
      const h = (km / maxKm) * chartH;
      const x = padL + i * barW + 1;
      const y = padT + chartH - h;
      html += `<rect x="${x}" y="${y}" width="${barW-2}" height="${h}" fill="#e8b76d" fill-opacity="0.7"><title>${ds} · ${km.toFixed(1)} km</title></rect>`;
    }
  });

  // overlay line + dots (only where data exists)
  let prev = null;
  days.forEach((ds, i) => {
    const r = byDate[ds];
    if (!r || r[overlayMetric] == null) { prev = null; return; }
    const x = padL + i * barW + barW / 2;
    const y = yM(r[overlayMetric]);
    if (prev) {
      html += `<line x1="${prev.x}" y1="${prev.y}" x2="${x}" y2="${y}" stroke="#6cc4d9" stroke-width="1.4" stroke-opacity="0.8"/>`;
    }
    prev = { x, y };
  });
  days.forEach((ds, i) => {
    const r = byDate[ds];
    if (!r || r[overlayMetric] == null) return;
    const x = padL + i * barW + barW / 2;
    const y = yM(r[overlayMetric]);
    html += `<circle cx="${x}" cy="${y}" r="3" fill="#6cc4d9" stroke="#0a0a0c" stroke-width="1"><title>${ds} · ${meta.label} ${r[overlayMetric]}</title></circle>`;
  });

  // x labels (every 4 days)
  days.forEach((ds, i) => {
    if (i % 4 === 0 || i === days.length - 1) {
      const x = padL + i * barW + barW / 2;
      const label = ds.slice(5);
      html += `<text x="${x}" y="${H - 14}" text-anchor="middle" font-family="JetBrains Mono" font-size="9" fill="#5d5b55">${label}</text>`;
    }
  });

  document.getElementById('overlayChart').innerHTML = html;
}

function bindOverlayTabs() {
  document.querySelectorAll('.overlay-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.overlay-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      overlayMetric = tab.dataset.overlay;
      renderOverlayChart();
    });
  });
}

// ============ 动态注解 ============
function renderAnnotation() {
  if (!window.HEALTH_DATA) return;
  const s = window.HEALTH_DATA.summary;
  const d = s.body_deltas || {};
  const wt = (s.weight_latest_kg && s.weight_first_kg)
    ? (s.weight_latest_kg - s.weight_first_kg) : null;
  const vo2 = (s.vo2max_latest && s.vo2max_first)
    ? (s.vo2max_latest - s.vo2max_first) : null;

  const parts = [];
  parts.push(`平均速度只有 10 km/h —— 这不是训练,是工作。`);
  if (wt != null && wt < -1) {
    parts.push(`但 ${Math.abs(wt).toFixed(0)} 公斤体重悄悄消失了 (${s.weight_first_kg} → ${s.weight_latest_kg} kg),`);
  }
  if (vo2 != null && vo2 < -1) {
    parts.push(`VO₂max 反而从 ${s.vo2max_first} 滑到 ${s.vo2max_latest} mL/min·kg —— 长时间低强度有氧+睡眠不足,身体在「省着用」。`);
  } else if (vo2 != null && vo2 > 1) {
    parts.push(`VO₂max 从 ${s.vo2max_first} 抬升到 ${s.vo2max_latest} mL/min·kg —— 持续有氧的红利,慢慢发酵。`);
  }
  if (d.steps && d.steps.delta > 2000) {
    parts.push(`日均步数从 ${Math.round(d.steps.baseline).toLocaleString()} 跳到 ${Math.round(d.steps.recent).toLocaleString()},`);
  }
  if (d.sleep_h && d.sleep_h.delta > 0.3) {
    parts.push(`身体也在用更长的睡眠 (${d.sleep_h.recent.toFixed(1)}h) 自己回血。`);
  }
  document.getElementById('annotationQuote').textContent = parts.join('');
}

// ============ 中文数字 ============
function chineseDigit(n) {
  const digits = ['零','一','二','三','四','五','六','七','八','九'];
  const units = ['','十','百','千'];
  // up to 9999 — sufficient for kilometres
  n = Math.round(n);
  if (n === 0) return '零';
  let s = '';
  const str = String(n);
  for (let i = 0; i < str.length; i++) {
    const d = parseInt(str[i], 10);
    const u = units[str.length - 1 - i];
    s += d === 0 ? '零' : digits[d] + u;
  }
  // collapse repeated 零
  s = s.replace(/零+/g, '零').replace(/零$/, '');
  if (s.startsWith('一十')) s = s.slice(1); // 一十 → 十
  return s;
}

// ============ Hero & Stats 动态注入 ============
function renderHero() {
  const s = window.HEALTH_DATA && window.HEALTH_DATA.summary;
  if (!s) return;
  const routes = window.ROUTES_DATA || [];
  const totalGpsKm = routes.reduce((a, r) => a + (r.distance_km || 0), 0);
  const sydneyKm = routes.filter(r => r.city === 'Sydney')
                          .reduce((a, r) => a + (r.distance_km || 0), 0);
  const share = totalGpsKm > 0 ? (sydneyKm / totalGpsKm * 100) : 0;

  // TOTAL = Apple Health workouts only (839 km). GPS-only tracks (walks / pre-watch /
  // unpaired loops) appear as the larger 898 km figure in the foot label so the two
  // numbers don't look contradictory.
  const workoutsKm = Math.round(s.total_distance_km || 0);
  const gpsKm = Math.round(totalGpsKm);
  const gpsExtra = Math.max(0, gpsKm - workoutsKm);

  const el = id => document.getElementById(id);
  el('statTotalDistance').textContent = workoutsKm;
  if (gpsExtra > 0) {
    el('statTotalDistanceFoot').innerHTML =
      `34 次正式骑行 · GPS 全部 <span style="color:var(--text-dim)">${gpsKm} km</span>`;
  } else {
    el('statTotalDistanceFoot').textContent = '34 次正式骑行';
  }
  el('statSydneyDistance').textContent = Math.round(sydneyKm);
  el('statSydneyShare').textContent = `送餐期 ${share.toFixed(1)}% 占比`;
  el('statRideTime').textContent = Math.round(s.total_duration_h || (s.total_duration_min/60));
  el('statRoutes').textContent = routes.length;
  const climb = Math.round(s.total_elev_gain_m || 0);
  el('statClimb').textContent = climb.toLocaleString();
  el('statClimbE').textContent = (climb / 8848).toFixed(2);

  // H1 with computed total
  el('heroH1').innerHTML = `${chineseDigit(Math.round(s.total_distance_km || 0))}公里的<br><em>夜色与坐垫</em>`;

  el('heroSub').innerHTML =
    `19 个月，<strong>${routes.length}</strong> 条 GPS 轨迹，4 个城市。`
    + ` Apple Health 记录 <strong>${s.ride_count}</strong> 次正式骑行，累计 ${Math.round(s.total_distance_km)} km、${Math.round(s.total_duration_h)} 小时、爬升 ${climb.toLocaleString()} m。`
    + ` 这是你在悉尼下午到深夜骑出的城市，也是早期在宁波、上海、河南留下的零星记号。每一条线，都是一次出门。`;

  // Freshness pill (data age + days since last ride)
  const gen = s.generated_at ? new Date(s.generated_at) : null;
  if (gen) {
    const now = new Date();
    const ageDays = Math.max(0, Math.floor((now - gen) / 86400000));
    const ageLabel = ageDays === 0 ? '今日更新'
                   : ageDays === 1 ? '昨日更新'
                   : `${ageDays} 天前更新`;
    let bits = `${ageLabel} · ${gen.toISOString().slice(0,10)}`;
    if (s.last_ride) {
      const rideAge = Math.max(0, Math.floor((now - new Date(s.last_ride + 'T00:00:00')) / 86400000));
      bits += rideAge === 0 ? ' · 今日已骑'
            : rideAge === 1 ? ' · 昨日已骑'
            : ` · 上次骑行 ${rideAge} 天前`;
    }
    el('heroFresh').textContent = bits;
  }
}

// ============ Personal Records ============
function renderPersonalRecords() {
  const w = (window.HEALTH_DATA && window.HEALTH_DATA.workouts) || [];
  if (!w.length) return;

  const pickMax = (arr, key) => arr.filter(r => r[key] != null)
                                    .reduce((best, r) => (!best || r[key] > best[key]) ? r : best, null);
  const pickMin = (arr, key) => arr.filter(r => r[key] != null)
                                    .reduce((best, r) => (!best || r[key] < best[key]) ? r : best, null);

  const longest    = pickMax(w, 'distance_km');
  const fastest    = pickMax(w, 'avg_speed_kmh');
  const longestT   = pickMax(w, 'duration_min');
  const hottest    = pickMax(w, 'weather_temp_c');
  const coldest    = pickMin(w, 'weather_temp_c');
  const hardestHR  = pickMax(w, 'hr_max');
  const mostKcal   = pickMax(w, 'active_kcal');
  const hardestMet = pickMax(w, 'mets');

  // Top speed from GPS — bikes max ~60 km/h on descents; cap at 65 to filter GPS noise spikes.
  const routes = (window.ROUTES_DATA || []).filter(r =>
    r.max_speed_kmh != null && r.max_speed_kmh > 0 && r.max_speed_kmh < 65
  );
  const topSpeed = routes.reduce((best, r) => (!best || r.max_speed_kmh > best.max_speed_kmh) ? r : best, null);

  // Best week (7-day rolling) from daily
  const daily = (window.HEALTH_DATA && window.HEALTH_DATA.daily) || [];
  let bestWeek = { km: 0, end: '' };
  for (let i = 6; i < daily.length; i++) {
    let sum = 0;
    for (let j = i - 6; j <= i; j++) sum += (daily[j].distance_km || 0);
    if (sum > bestWeek.km) bestWeek = { km: sum, end: daily[i].date };
  }

  const fmtDate = d => d ? d.slice(5) : '—';

  const cards = [
    longest && {
      tag: '最长单次', value: longest.distance_km.toFixed(1), unit: 'km',
      meta: `${longest.date} · ${(longest.duration_min/60).toFixed(1)} 小时 · 均速 ${(longest.avg_speed_kmh||0).toFixed(1)} km/h`
    },
    longestT && {
      tag: '最久单次', value: (longestT.duration_min/60).toFixed(2), unit: '小时',
      meta: `${longestT.date} · 距离 ${(longestT.distance_km||0).toFixed(1)} km`
    },
    fastest && {
      tag: '最快均速', value: fastest.avg_speed_kmh.toFixed(2), unit: 'km/h',
      meta: `${fastest.date} · 仅 ${fastest.duration_min.toFixed(0)} 分钟的短程`
    },
    topSpeed && {
      tag: '瞬时顶速', value: topSpeed.max_speed_kmh.toFixed(1), unit: 'km/h',
      meta: `${topSpeed.start_date} · GPS 记录 · ${topSpeed.distance_km.toFixed(1)} km · ${topSpeed.city}`,
      route: topSpeed.name,
    },
    mostKcal && {
      tag: '消耗最高', value: Math.round(mostKcal.active_kcal), unit: 'kcal',
      meta: `${mostKcal.date} · ${mostKcal.distance_km.toFixed(1)} km · ${(mostKcal.duration_min/60).toFixed(1)} 小时`
    },
    hardestHR && {
      tag: '心率峰值', value: Math.round(hardestHR.hr_max), unit: 'bpm',
      meta: `${hardestHR.date} · 均 ${Math.round(hardestHR.hr_avg)} · 最低 ${Math.round(hardestHR.hr_min)}`
    },
    hardestMet && {
      tag: '强度最高', value: hardestMet.mets.toFixed(2), unit: 'METs',
      meta: `${hardestMet.date} · 等效约 ${(hardestMet.mets * 1.05).toFixed(1)} 倍静息代谢`
    },
    hottest && hottest.weather_temp_c != null && {
      tag: '最高温度', value: hottest.weather_temp_c.toFixed(1), unit: '℃',
      meta: `${hottest.date} · 湿度 ${(hottest.weather_humidity*100).toFixed(0)}%`
    },
    coldest && coldest.weather_temp_c != null && {
      tag: '最低温度', value: coldest.weather_temp_c.toFixed(1), unit: '℃',
      meta: `${coldest.date} · 湿度 ${(coldest.weather_humidity*100).toFixed(0)}%`
    },
    bestWeek.km > 0 && {
      tag: '最强一周', value: bestWeek.km.toFixed(0), unit: 'km / 7d',
      meta: `至 ${bestWeek.end} 的 7 天滚动累计`
    },
  ].filter(Boolean);

  document.getElementById('prGrid').innerHTML = cards.map(c => {
    const click = c.route ? ` onclick="selectRouteByName('${c.route}'); document.querySelector('.map-section').scrollIntoView({behavior:'smooth'});" style="cursor:pointer"` : '';
    return `
    <div class="pr-card"${click}>
      <div class="pr-tag">${c.tag}</div>
      <div class="pr-value">${c.value}<small>${c.unit}</small></div>
      <div class="pr-meta">${c.meta}</div>
    </div>`;
  }).join('');
}

// ============ 7-Day Rolling Load ============
function renderLoadChart() {
  const daily = (window.HEALTH_DATA && window.HEALTH_DATA.daily) || [];
  if (!daily.length) return;

  // Compute 7-day rolling distance + ride-day count
  const points = [];
  for (let i = 6; i < daily.length; i++) {
    let kmSum = 0;
    let rideDays = 0;
    for (let j = i - 6; j <= i; j++) {
      const km = daily[j].distance_km || 0;
      kmSum += km;
      if (km > 0.01) rideDays += 1;
    }
    points.push({ date: daily[i].date, km: kmSum, days: rideDays });
  }

  const W = 900, H = 260;
  const padL = 48, padR = 48, padT = 18, padB = 32;
  const chartW = W - padL - padR;
  const chartH = H - padT - padB;

  const maxKm = Math.max(...points.map(p => p.km), 30);
  const maxDays = 7;

  const x = i => padL + (i / (points.length - 1)) * chartW;
  const yKm = v => padT + chartH - (v / maxKm) * chartH;
  const yDays = v => padT + chartH - (v / maxDays) * chartH;

  let html = '';

  // grid + left axis (km)
  [0, maxKm/4, maxKm/2, 3*maxKm/4, maxKm].forEach(v => {
    const yy = yKm(v);
    html += `<line x1="${padL}" y1="${yy}" x2="${W-padR}" y2="${yy}" stroke="#2a2c35" stroke-width="0.5" stroke-dasharray="2 4"/>`;
    html += `<text x="${padL-6}" y="${yy+3}" text-anchor="end" font-family="JetBrains Mono" font-size="9" fill="#5d5b55">${v.toFixed(0)}</text>`;
  });

  // right axis (days)
  [0, 2, 4, 6].forEach(v => {
    const yy = yDays(v);
    html += `<text x="${W-padR+8}" y="${yy+3}" text-anchor="start" font-family="JetBrains Mono" font-size="9" fill="#6cc4d9">${v}</text>`;
  });
  html += `<text x="${padL-30}" y="${padT+chartH/2}" text-anchor="middle" font-family="JetBrains Mono" font-size="9" fill="#908d85" transform="rotate(-90 ${padL-30} ${padT+chartH/2})">km / 7d</text>`;
  html += `<text x="${W-padR+30}" y="${padT+chartH/2}" text-anchor="middle" font-family="JetBrains Mono" font-size="9" fill="#6cc4d9" transform="rotate(90 ${W-padR+30} ${padT+chartH/2})">days / 7d</text>`;

  // Area for km
  let area = `M ${x(0)} ${padT+chartH} `;
  points.forEach((p, i) => { area += `L ${x(i)} ${yKm(p.km)} `; });
  area += `L ${x(points.length-1)} ${padT+chartH} Z`;
  html += `<defs><linearGradient id="loadGrad" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0%" stop-color="#e8b76d" stop-opacity="0.55"/>
    <stop offset="100%" stop-color="#e8b76d" stop-opacity="0.03"/>
  </linearGradient></defs>`;
  html += `<path d="${area}" fill="url(#loadGrad)" stroke="#e8b76d" stroke-width="1.4"/>`;

  // Days line (cyan)
  let line = '';
  points.forEach((p, i) => {
    line += (i === 0 ? 'M ' : 'L ') + `${x(i)} ${yDays(p.days)} `;
  });
  html += `<path d="${line}" fill="none" stroke="#6cc4d9" stroke-width="1.2" stroke-opacity="0.85"/>`;

  // Highlight delivery period span (2026-04-25 → 2026-05-19)
  const deliveryStart = points.findIndex(p => p.date >= '2026-04-25');
  const deliveryEnd = points.findIndex(p => p.date >= '2026-05-19');
  if (deliveryStart > 0 && deliveryEnd > 0) {
    const dx1 = x(deliveryStart), dx2 = x(deliveryEnd);
    html += `<rect x="${dx1}" y="${padT}" width="${Math.max(2, dx2-dx1)}" height="${chartH}" fill="#e8b76d" fill-opacity="0.06" stroke="#a87f3e" stroke-opacity="0.4" stroke-width="0.5" stroke-dasharray="3 3"/>`;
    html += `<text x="${(dx1+dx2)/2}" y="${padT+10}" text-anchor="middle" font-family="JetBrains Mono" font-size="9" fill="#a87f3e" letter-spacing="0.12em">DELIVERY 4/25 → 5/19</text>`;
  }

  // x labels — sample by month
  const monthSeen = new Set();
  points.forEach((p, i) => {
    const ym = p.date.slice(0, 7);
    if (!monthSeen.has(ym) && (i === 0 || i % 30 === 0 || i === points.length - 1)) {
      monthSeen.add(ym);
      html += `<text x="${x(i)}" y="${H - 12}" text-anchor="middle" font-family="JetBrains Mono" font-size="9" fill="#5d5b55">${ym}</text>`;
    }
  });

  document.getElementById('loadChart').innerHTML = html;
}

// ============ All Rides Table ============
let _ridesSort = { key: 'date', dir: 'desc' };

function renderRidesTable() {
  const w = (window.HEALTH_DATA && window.HEALTH_DATA.workouts) || [];
  if (!w.length) return;

  const sorted = [...w].sort((a, b) => {
    const k = _ridesSort.key;
    let av = a[k], bv = b[k];
    if (av == null) av = -Infinity;
    if (bv == null) bv = -Infinity;
    if (typeof av === 'string') return _ridesSort.dir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av);
    return _ridesSort.dir === 'asc' ? av - bv : bv - av;
  });

  const maxKm = Math.max(...w.map(r => r.distance_km || 0), 1);
  const fmt = (v, d = 1) => v == null ? '—' : v.toFixed(d);

  const elevSpark = (series, gain) => {
    if (!series || series.length < 2) {
      return `<span class="elev-spark-none">—</span>`;
    }
    const W = 80, H = 22;
    const mn = Math.min(...series), mx = Math.max(...series);
    const span = (mx - mn) || 1;
    const stepX = W / (series.length - 1);
    let path = '';
    let area = `M 0 ${H} `;
    series.forEach((v, i) => {
      const x = +(i * stepX).toFixed(2);
      const y = +((H - 2) - ((v - mn) / span) * (H - 4)).toFixed(2);
      path += (i === 0 ? `M ${x} ${y}` : ` L ${x} ${y}`);
      area += ` L ${x} ${y}`;
    });
    area += ` L ${W} ${H} Z`;
    const gainTxt = gain != null ? `↗ ${Math.round(gain)} m` : '';
    return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-label="${gainTxt}">
      <path d="${area}" class="elev-spark-fill"/>
      <path d="${path}" class="elev-spark-line"/>
    </svg>`;
  };

  const html = sorted.map(r => {
    const km = r.distance_km || 0;
    const barW = (km / maxKm) * 60;
    const hour = r.hour != null ? String(r.hour).padStart(2, '0') + ':00' : '—';
    const routeName = r.route_file ? r.route_file.replace('route_', '').replace('.gpx', '') : '';
    return `<tr data-route="${routeName}">
      <td class="col-date">${r.date}</td>
      <td class="col-distance">${fmt(r.distance_km, 2)}<span class="bar-cell"><span class="bar-fill" style="width:${barW}px"></span></span></td>
      <td class="col-elev">${elevSpark(r.elev_series, r.elev_gain_m)}</td>
      <td>${fmt(r.duration_min, 1)}</td>
      <td>${fmt(r.avg_speed_kmh, 1)}</td>
      <td class="col-hr">${r.hr_avg ? Math.round(r.hr_avg) : '—'}</td>
      <td>${r.active_kcal ? Math.round(r.active_kcal) : '—'}</td>
      <td>${fmt(r.weather_temp_c, 1)}</td>
      <td>${hour}</td>
    </tr>`;
  }).join('');

  document.getElementById('ridesTbody').innerHTML = html;

  // Header sorted state
  document.querySelectorAll('#ridesTable thead th').forEach(th => {
    th.classList.toggle('sorted', th.dataset.sort === _ridesSort.key);
    th.classList.toggle('asc', _ridesSort.dir === 'asc');
  });
}

function bindRidesTable() {
  document.querySelectorAll('#ridesTable thead th').forEach(th => {
    th.addEventListener('click', () => {
      const key = th.dataset.sort;
      if (_ridesSort.key === key) {
        _ridesSort.dir = _ridesSort.dir === 'asc' ? 'desc' : 'asc';
      } else {
        _ridesSort.key = key;
        _ridesSort.dir = (key === 'date') ? 'desc' : 'desc';
      }
      renderRidesTable();
    });
  });
  document.getElementById('ridesTbody').addEventListener('click', (e) => {
    const tr = e.target.closest('tr');
    if (!tr || !tr.dataset.route) return;
    // Try to find a matching route by date prefix
    const date = tr.querySelector('.col-date').textContent;
    const match = (window.ROUTES_DATA || []).find(r => r.start_date === date);
    if (match) {
      selectRouteByName(match.name);
      document.querySelector('.map-section').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  });
}

// ============ 最近一次骑行 + 恢复状态 ============
function renderLatestBand() {
  const H = window.HEALTH_DATA;
  if (!H || !H.workouts || !H.workouts.length) return;

  // ---- 最近一次骑行 (most recent workout) ----
  const wo = [...H.workouts].sort((a, b) => a.start_iso.localeCompare(b.start_iso));
  const latest = wo[wo.length - 1];
  const startDt = new Date(latest.start_iso);
  const today = new Date();
  const daysAgo = Math.max(0, Math.floor((today - startDt) / 86400000));
  const hoursMin = `${Math.floor(latest.duration_min / 60)}h ${Math.round(latest.duration_min % 60)}m`;
  const startStr = startDt.toLocaleString('zh-CN', {
    month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const dayLabel = daysAgo === 0 ? '今天' : daysAgo === 1 ? '昨天' : `${daysAgo} 天前`;

  document.getElementById('latestHeadline').innerHTML =
    `<em>${(latest.distance_km || 0).toFixed(1)}</em> km · ${hoursMin}`;
  document.getElementById('latestWhen').textContent =
    `${dayLabel} · ${startStr} 出发${latest.indoor ? ' · 室内' : ''}`;

  const lcStats = [
    { v: (latest.avg_speed_kmh ?? 0).toFixed(1), u: 'km/h', l: '均速' },
    latest.hr_avg != null ? { v: Math.round(latest.hr_avg), u: 'bpm', l: '心率均值' } : null,
    latest.active_kcal != null ? { v: Math.round(latest.active_kcal), u: 'kcal', l: '活动消耗' } : null,
    latest.elev_gain_m != null ? { v: Math.round(latest.elev_gain_m), u: 'm', l: '爬升' } : null,
    latest.weather_temp_c != null ? { v: latest.weather_temp_c.toFixed(1), u: '℃', l: '气温' } : null,
  ].filter(Boolean);
  document.getElementById('latestStats').innerHTML = lcStats.map(s => `
    <div class="lc-stat"><strong>${s.v}<small>${s.u}</small></strong>${s.l}</div>
  `).join('');

  // Elevation sparkline for latest ride
  const elevHost = document.getElementById('latestElev');
  if (latest.elev_series && latest.elev_series.length > 2) {
    elevHost.innerHTML = sparkSvg(latest.elev_series, {
      width: 600, height: 60, stroke: '#e8b76d', fill: 'rgba(232,183,109,0.18)',
      annotate: true,
    });
  } else {
    elevHost.innerHTML = '';
  }

  // ---- 恢复状态 (recovery snapshot) ----
  // Use the most recent day where each metric exists.
  const daily = H.daily || [];
  const lastDay = daily.length ? daily[daily.length - 1] : null;
  const pickLatest = key => {
    for (let i = daily.length - 1; i >= 0; i--) {
      if (daily[i][key] != null) return { value: daily[i][key], date: daily[i].date };
    }
    return null;
  };
  const rhrLatest = pickLatest('resting_hr');
  const hrvLatest = pickLatest('hrv');
  const sleepLatest = pickLatest('sleep_h');
  const stepsLatest = pickLatest('steps');
  const bd = H.summary.body_deltas || {};

  // baseline for normalization (use body_deltas baselines if available)
  const baseRHR = bd.resting_hr ? bd.resting_hr.baseline : 62;
  const baseHRV = bd.hrv ? bd.hrv.baseline : 46;
  const baseSleep = bd.sleep_h ? bd.sleep_h.baseline : 8;

  // Recovery rows: visually compare latest reading vs baseline
  // For each metric, bar fill width = current/(baseline*1.6), so baseline marker sits near middle.
  const rows = [];
  let recoveryScore = 0; let recoveryCount = 0;
  function addRow(label, latest, base, unit, lowerIsBetter, range) {
    if (!latest) {
      rows.push(`<div class="recovery-row"><span class="recovery-label">${label}</span><div class="recovery-bar"></div><span class="recovery-val">—</span></div>`);
      return;
    }
    const max = range || base * 1.6;
    const fillPct = Math.min(1, Math.max(0.02, latest.value / max));
    const basePct = Math.min(1, Math.max(0, base / max));
    // determine if current is "good" relative to baseline direction
    const isGood = lowerIsBetter ? latest.value <= base * 1.02 : latest.value >= base * 0.98;
    const isBad = lowerIsBetter ? latest.value >= base * 1.12 : latest.value <= base * 0.88;
    const cls = isGood ? 'good' : isBad ? 'warn' : '';
    if (isGood) recoveryScore += 1;
    if (isBad) recoveryScore -= 1;
    recoveryCount += 1;
    rows.push(`
      <div class="recovery-row">
        <span class="recovery-label">${label}</span>
        <div class="recovery-bar">
          <div class="recovery-bar-fill ${cls}" style="--bar: ${fillPct.toFixed(3)};"></div>
          <div class="recovery-bar-base" style="left: ${(basePct*100).toFixed(1)}%;"></div>
        </div>
        <span class="recovery-val">${formatRecoveryVal(label, latest.value)}<small>${unit}</small></span>
      </div>
    `);
  }
  addRow('静息心率', rhrLatest, baseRHR, ' bpm', true, 90);
  addRow('HRV',     hrvLatest, baseHRV, ' ms', false, 90);
  addRow('睡眠',    sleepLatest, baseSleep, ' h', false, 12);
  // Steps row uses baseline from deltas
  const baseSteps = (bd.steps && bd.steps.baseline) || 12000;
  addRow('步数',    stepsLatest, baseSteps, '', false, baseSteps * 2);

  document.getElementById('recoveryRows').innerHTML = rows.join('');

  // Status pill
  let statusLabel = '平稳', statusCls = 'flat';
  if (recoveryCount) {
    const ratio = recoveryScore / recoveryCount;
    if (ratio >= 0.5) { statusLabel = '良好'; statusCls = 'good'; }
    else if (ratio <= -0.4) { statusLabel = '需休息'; statusCls = 'warn'; }
  }
  const statusEl = document.getElementById('recoveryStatus');
  statusEl.textContent = statusLabel;
  statusEl.className = `recovery-status ${statusCls}`;

  // Readout text
  const parts = [];
  if (rhrLatest) {
    const diff = rhrLatest.value - baseRHR;
    parts.push(`静息心率 <strong>${rhrLatest.value.toFixed(0)} bpm</strong>，相比基线 ${diff >= 0 ? '+' : ''}${diff.toFixed(0)}`);
  }
  if (sleepLatest) {
    parts.push(`最近一晚睡了 <strong>${sleepLatest.value.toFixed(1)} h</strong>`);
  }
  if (lastDay) {
    parts.push(`最新一天 ${lastDay.date}`);
  }
  document.getElementById('recoveryReadout').innerHTML = parts.join(' · ');

  // ---- 本周节奏 (this week) ----
  // Sum recent 7 days from daily
  const recent7 = daily.slice(-7);
  const km7 = recent7.reduce((a, d) => a + (d.distance_km || 0), 0);
  const ride7 = recent7.reduce((a, d) => a + (d.rides || 0), 0);
  const sleepVals = recent7.map(d => d.sleep_h).filter(v => v != null);
  const sleepAvg = sleepVals.length ? sleepVals.reduce((a,b)=>a+b,0) / sleepVals.length : null;
  const stepVals = recent7.map(d => d.steps).filter(v => v != null);
  const stepAvg = stepVals.length ? stepVals.reduce((a,b)=>a+b,0) / stepVals.length : null;
  const rhrVals = recent7.map(d => d.resting_hr).filter(v => v != null);
  const rhrAvg = rhrVals.length ? rhrVals.reduce((a,b)=>a+b,0) / rhrVals.length : null;

  // Daysince last ride
  let daysSinceRide = null;
  for (let i = daily.length - 1; i >= 0; i--) {
    if ((daily[i].rides || 0) > 0) {
      daysSinceRide = Math.floor((new Date(daily[daily.length-1].date) - new Date(daily[i].date)) / 86400000);
      break;
    }
  }

  // Compose rows with a "max for week" scale
  const weekRows = [];
  function wRow(label, val, max, unit, fmt) {
    if (val == null) {
      weekRows.push(`<div class="recovery-row"><span class="recovery-label">${label}</span><div class="recovery-bar"></div><span class="recovery-val">—</span></div>`);
      return;
    }
    const pct = Math.min(1, val / max);
    weekRows.push(`
      <div class="recovery-row">
        <span class="recovery-label">${label}</span>
        <div class="recovery-bar">
          <div class="recovery-bar-fill" style="--bar: ${pct.toFixed(3)}; background: linear-gradient(90deg, var(--amber-bright), var(--amber));"></div>
        </div>
        <span class="recovery-val">${fmt(val)}<small>${unit}</small></span>
      </div>
    `);
  }
  wRow('骑行距离', km7, Math.max(km7 * 1.5, 60), ' km', v => v.toFixed(1));
  wRow('骑行天数', ride7, 7, ' / 7', v => v.toString());
  wRow('夜均睡眠', sleepAvg, 12, ' h', v => v.toFixed(1));
  wRow('日均步数', stepAvg, Math.max(stepAvg * 1.5, 20000), '', v => Math.round(v).toLocaleString());
  document.getElementById('weekRows').innerHTML = weekRows.join('');

  const weekParts = [];
  if (daysSinceRide != null) {
    weekParts.push(daysSinceRide === 0
      ? `今日已骑`
      : `上次骑行 <strong>${daysSinceRide} 天前</strong>`);
  }
  if (rhrAvg != null) {
    weekParts.push(`周均静息心率 <strong>${rhrAvg.toFixed(0)} bpm</strong>`);
  }
  document.getElementById('weekReadout').innerHTML = weekParts.join(' · ');
}

function formatRecoveryVal(label, v) {
  if (label === '步数') return Math.round(v).toLocaleString();
  if (label === '睡眠') return v.toFixed(1);
  if (label === 'HRV') return v.toFixed(0);
  return v.toFixed(0);
}

// SVG sparkline generator used by latest-elev + detail-elev
function sparkSvg(series, opts) {
  const W = opts.width || 600;
  const H = opts.height || 60;
  const padL = 4, padR = 4, padT = 4, padB = 4;
  const w = W - padL - padR;
  const h = H - padT - padB;
  if (!series || series.length < 2) return '';
  const mn = Math.min(...series), mx = Math.max(...series);
  const span = mx - mn || 1;
  const x = i => padL + (i / (series.length - 1)) * w;
  const y = v => padT + h - ((v - mn) / span) * h;
  const stroke = opts.stroke || '#e8b76d';
  const fill = opts.fill || 'rgba(232,183,109,0.18)';
  const linePath = series.map((v, i) => `${i === 0 ? 'M' : 'L'} ${x(i).toFixed(2)} ${y(v).toFixed(2)}`).join(' ');
  const areaPath = `${linePath} L ${x(series.length-1).toFixed(2)} ${padT+h} L ${x(0).toFixed(2)} ${padT+h} Z`;
  let svg = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="width:100%;height:${H}px;display:block">`;
  svg += `<path d="${areaPath}" fill="${fill}"/>`;
  svg += `<path d="${linePath}" fill="none" stroke="${stroke}" stroke-width="1.4" stroke-linejoin="round"/>`;
  if (opts.annotate) {
    svg += `<text x="${padL}" y="${padT + 9}" font-family="JetBrains Mono" font-size="9" fill="#5d5b55">${Math.round(mx)}m</text>`;
    svg += `<text x="${padL}" y="${H - 2}" font-family="JetBrains Mono" font-size="9" fill="#5d5b55">${Math.round(mn)}m</text>`;
    svg += `<text x="${W-padR}" y="${H - 2}" text-anchor="end" font-family="JetBrains Mono" font-size="9" fill="#a87f3e">+${Math.round(mx-mn)}m range</text>`;
  }
  svg += `</svg>`;
  return svg;
}

// ============ 海拔曲线 (route detail panel) ============
function renderDetailElevation(route) {
  const wo = workoutByRouteFile(route.filename);
  const host = document.getElementById('detailElev');
  const svg = document.getElementById('detailElevSvg');
  const ends = document.getElementById('detailElevEnds');
  if (!wo || !wo.elev_series || wo.elev_series.length < 2) {
    host.classList.add('empty');
    svg.innerHTML = '';
    ends.innerHTML = '';
    return;
  }
  const series = wo.elev_series;
  const mn = Math.min(...series), mx = Math.max(...series);
  host.classList.remove('empty');
  // Build mini chart matching detail panel width (800x70 viewBox)
  const W = 800, H = 70;
  const padL = 32, padR = 6, padT = 8, padB = 14;
  const w = W - padL - padR;
  const h = H - padT - padB;
  const span = (mx - mn) || 1;
  const x = i => padL + (i / (series.length - 1)) * w;
  const y = v => padT + h - ((v - mn) / span) * h;
  const linePath = series.map((v, i) => `${i === 0 ? 'M' : 'L'} ${x(i).toFixed(2)} ${y(v).toFixed(2)}`).join(' ');
  const areaPath = `${linePath} L ${x(series.length-1).toFixed(2)} ${padT+h} L ${x(0).toFixed(2)} ${padT+h} Z`;

  let html = '';
  // gridlines + y labels
  [mn, (mn+mx)/2, mx].forEach(v => {
    const yy = y(v);
    html += `<line x1="${padL}" y1="${yy}" x2="${W-padR}" y2="${yy}" stroke="#2a2c35" stroke-width="0.5" stroke-dasharray="2 4"/>`;
    html += `<text x="${padL-4}" y="${yy+3}" text-anchor="end" font-family="JetBrains Mono" font-size="9" fill="#5d5b55">${Math.round(v)}</text>`;
  });
  html += `<defs><linearGradient id="elevGradD" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0%" stop-color="#e8b76d" stop-opacity="0.5"/>
    <stop offset="100%" stop-color="#e8b76d" stop-opacity="0"/>
  </linearGradient></defs>`;
  html += `<path d="${areaPath}" fill="url(#elevGradD)"/>`;
  html += `<path d="${linePath}" fill="none" stroke="#e8b76d" stroke-width="1.4" stroke-linejoin="round"/>`;
  // start/end dot
  html += `<circle cx="${x(0)}" cy="${y(series[0])}" r="2" fill="#ffd897"/>`;
  html += `<circle cx="${x(series.length-1)}" cy="${y(series[series.length-1])}" r="2" fill="#ffd897"/>`;
  svg.innerHTML = html;

  ends.innerHTML = `起点 <b>${Math.round(series[0])}m</b> · 最低 <b>${Math.round(mn)}m</b> · 最高 <b>${Math.round(mx)}m</b> · 落差 <b>${Math.round(mx - mn)}m</b>`;
}

// ============ 训练效率 (Training Efficiency Trend) ============
function renderEfficiencyChart() {
  const H = window.HEALTH_DATA;
  if (!H || !H.workouts) return;
  // Use rides with valid hr_avg and avg_speed
  const rides = H.workouts
    .filter(w => w.hr_avg && w.avg_speed_kmh && w.avg_speed_kmh > 1)
    .map(w => ({
      date: w.date,
      ts: new Date(w.start_iso).getTime(),
      // bpm·min/km — heartbeats per km of riding (intuitive efficiency metric)
      efficiency: w.hr_avg / w.avg_speed_kmh * 60 / 60,  // bpm / (km/h) = beats per (km/min equivalent)
      // Actually keep it simple: heartbeats per km = hr_avg * duration_min / distance_km
      beatsPerKm: (w.hr_avg * w.duration_min) / Math.max(w.distance_km, 0.01),
      hrAvg: w.hr_avg,
      avg: w.avg_speed_kmh,
      km: w.distance_km,
    }))
    .sort((a, b) => a.ts - b.ts);
  if (rides.length < 3) {
    document.getElementById('effiChart').innerHTML =
      `<text x="450" y="140" text-anchor="middle" fill="#5d5b55" font-family="JetBrains Mono" font-size="11">骑行样本不足</text>`;
    return;
  }

  const W = 900, Ht = 280;
  const padL = 54, padR = 24, padT = 22, padB = 36;
  const chartW = W - padL - padR;
  const chartH = Ht - padT - padB;

  const xs = rides.map(r => r.ts);
  const ys = rides.map(r => r.beatsPerKm);
  const xMin = Math.min(...xs), xMax = Math.max(...xs);
  const yMin = Math.floor(Math.min(...ys) / 50) * 50;
  const yMax = Math.ceil(Math.max(...ys) / 50) * 50;
  const X = t => padL + ((t - xMin) / (xMax - xMin || 1)) * chartW;
  const Y = v => padT + chartH - ((v - yMin) / ((yMax - yMin) || 1)) * chartH;
  const maxKm = Math.max(...rides.map(r => r.km));

  let html = '';
  // grid
  const gridStep = Math.max(50, Math.round((yMax - yMin) / 5 / 50) * 50);
  for (let v = yMin; v <= yMax; v += gridStep) {
    const yy = Y(v);
    html += `<line x1="${padL}" y1="${yy}" x2="${W-padR}" y2="${yy}" stroke="#2a2c35" stroke-width="0.5" stroke-dasharray="2 4"/>`;
    html += `<text x="${padL-6}" y="${yy+3}" text-anchor="end" font-family="JetBrains Mono" font-size="9" fill="#5d5b55">${v}</text>`;
  }
  // axis labels
  html += `<text x="${padL-40}" y="${padT+chartH/2}" text-anchor="middle" font-family="JetBrains Mono" font-size="9" fill="#908d85" transform="rotate(-90 ${padL-40} ${padT+chartH/2})">beats / km</text>`;

  // month ticks on x axis
  const seenMonth = new Set();
  rides.forEach((r) => {
    const ym = r.date.slice(0, 7);
    if (seenMonth.has(ym)) return;
    seenMonth.add(ym);
    const xx = X(r.ts);
    html += `<text x="${xx}" y="${Ht - 14}" text-anchor="middle" font-family="JetBrains Mono" font-size="9" fill="#5d5b55">${ym.slice(2)}</text>`;
    html += `<line x1="${xx}" y1="${padT+chartH}" x2="${xx}" y2="${padT+chartH+4}" stroke="#3a3d48" stroke-width="0.5"/>`;
  });

  // 7-point rolling average line
  const win = 7;
  const rolling = rides.map((r, i) => {
    const start = Math.max(0, i - win + 1);
    const slice = rides.slice(start, i + 1);
    return slice.reduce((a, b) => a + b.beatsPerKm, 0) / slice.length;
  });
  const rollPath = rides.map((r, i) => `${i === 0 ? 'M' : 'L'} ${X(r.ts).toFixed(2)} ${Y(rolling[i]).toFixed(2)}`).join(' ');
  html += `<path d="${rollPath}" fill="none" stroke="#6cc4d9" stroke-width="1.6" stroke-opacity="0.85" stroke-linejoin="round"/>`;

  // bubbles
  rides.forEach(r => {
    const cx = X(r.ts), cy = Y(r.beatsPerKm);
    const radius = 2.6 + (r.km / maxKm) * 9;
    html += `<circle cx="${cx}" cy="${cy}" r="${radius.toFixed(2)}" fill="#e8b76d" fill-opacity="0.4" stroke="#e8b76d" stroke-width="0.8">
      <title>${r.date} · ${r.km.toFixed(1)} km · ${Math.round(r.hrAvg)} bpm · ${r.avg.toFixed(1)} km/h · ${Math.round(r.beatsPerKm)} beats/km</title>
    </circle>`;
  });

  // Endpoint annotations
  const first = rides[0], last = rides[rides.length - 1];
  html += `<circle cx="${X(first.ts)}" cy="${Y(rolling[0])}" r="3" fill="#ffd897" stroke="#0a0a0c" stroke-width="1"/>`;
  html += `<circle cx="${X(last.ts)}" cy="${Y(rolling[rolling.length-1])}" r="3" fill="#ffd897" stroke="#0a0a0c" stroke-width="1"/>`;
  html += `<text x="${X(first.ts) + 6}" y="${Y(rolling[0]) - 8}" font-family="JetBrains Mono" font-size="10" fill="#ffd897">${Math.round(rolling[0])}</text>`;
  html += `<text x="${X(last.ts) - 6}" y="${Y(rolling[rolling.length-1]) - 8}" text-anchor="end" font-family="JetBrains Mono" font-size="10" fill="#ffd897">${Math.round(rolling[rolling.length-1])}</text>`;

  document.getElementById('effiChart').innerHTML = html;

  // Foot
  const startMean = rolling.slice(0, Math.max(3, Math.floor(rolling.length * 0.2))).reduce((a,b)=>a+b,0) / Math.max(3, Math.floor(rolling.length * 0.2));
  const endMean = rolling.slice(-Math.max(3, Math.floor(rolling.length * 0.2))).reduce((a,b)=>a+b,0) / Math.max(3, Math.floor(rolling.length * 0.2));
  const delta = endMean - startMean;
  const pct = startMean ? Math.abs(delta / startMean) * 100 : 0;
  const direction = delta < 0
    ? `<span class="effi-tag">心率代价降低</span> — 同样的距离，心脏更省力了`
    : `心率代价上升 — 同样的距离心脏跳得更多`;
  document.getElementById('effiFoot').innerHTML =
    `共 <strong>${rides.length}</strong> 次有效骑行 · 起始平均 <strong>${Math.round(startMean)}</strong> beats/km · 最近 <strong>${Math.round(endMean)}</strong> beats/km · ${direction} (${delta >= 0 ? '+' : ''}${delta.toFixed(0)}, ${pct.toFixed(1)}%)`;
}

// ============ City Atlas ============
function renderCityAtlas() {
  const routes = window.ROUTES_DATA || [];
  if (!routes.length) return;
  const byCity = {};
  for (const r of routes) {
    const c = r.city || 'Other';
    if (!byCity[c]) byCity[c] = { rides: 0, km: 0, durSec: 0, firstDate: null, lastDate: null };
    byCity[c].rides += 1;
    byCity[c].km += r.distance_km || 0;
    byCity[c].durSec += r.duration_sec || 0;
    if (r.start_date) {
      if (!byCity[c].firstDate || r.start_date < byCity[c].firstDate) byCity[c].firstDate = r.start_date;
      if (!byCity[c].lastDate || r.start_date > byCity[c].lastDate) byCity[c].lastDate = r.start_date;
    }
  }
  const cn = { Sydney: '悉尼', Ningbo: '宁波', Shanghai: '上海', Henan: '河南' };
  const totalKm = Object.values(byCity).reduce((a, b) => a + b.km, 0) || 1;
  const ordered = Object.entries(byCity).sort((a, b) => b[1].km - a[1].km);
  const maxKm = ordered[0][1].km;
  const html = ordered.map(([city, s]) => {
    const pct = s.km / totalKm * 100;
    const barW = (s.km / maxKm) * 100;
    const hours = Math.round(s.durSec / 360) / 10;
    const range = s.firstDate && s.lastDate
      ? (s.firstDate === s.lastDate
          ? s.firstDate
          : `${s.firstDate.slice(2, 10)} → ${s.lastDate.slice(2, 10)}`)
      : '—';
    return `<div class="city-row">
      <div class="cr-bar" style="width:${barW}%"></div>
      <div class="cr-name">${cn[city] || city}<small>${city}</small></div>
      <div class="cr-meta">${s.rides} 次骑行 · ${hours} 小时<small>${range}</small></div>
      <div class="cr-km">${s.km.toFixed(1)}<small>km</small></div>
      <div class="cr-share">${pct.toFixed(1)}%</div>
    </div>`;
  }).join('');
  document.getElementById('cityAtlas').innerHTML = html;
}

// ============ Cumulative Journey ============
function renderJourney() {
  const ws = (window.HEALTH_DATA && window.HEALTH_DATA.workouts) || [];
  if (!ws.length) return;
  const sorted = [...ws].sort((a, b) => (a.start_iso || a.date).localeCompare(b.start_iso || b.date));
  let cum = 0;
  const series = sorted.map(w => {
    cum += w.distance_km || 0;
    return { date: w.date, dateMs: new Date(w.date + 'T00:00:00').getTime(), cum, km: w.distance_km || 0 };
  });
  const final = series[series.length - 1].cum;

  const svg = document.getElementById('journeyChart');
  if (!svg) return;
  const W = 900, H = 320, P = { l: 60, r: 30, t: 30, b: 40 };
  const xMin = series[0].dateMs;
  const xMax = Math.max(series[series.length - 1].dateMs, new Date().getTime());
  const yMax = Math.max(1000, Math.ceil(final / 100) * 100);
  const xs = ms => P.l + (ms - xMin) / (xMax - xMin) * (W - P.l - P.r);
  const ys = v => H - P.b - v / yMax * (H - P.t - P.b);

  let line = `M ${xs(xMin)} ${ys(0)} `;
  series.forEach(s => { line += `L ${xs(s.dateMs)} ${ys(s.cum)} `; });
  const lastX = xs(series[series.length - 1].dateMs);
  const area = line + `L ${lastX} ${ys(0)} Z`;

  const ticks = [0, yMax * 0.25, yMax * 0.5, yMax * 0.75, yMax];
  const yAxis = ticks.map(t =>
    `<line x1="${P.l}" x2="${W - P.r}" y1="${ys(t)}" y2="${ys(t)}" stroke="${t === 0 ? '#2a2c35' : '#1c1e25'}" stroke-width="1"/>` +
    `<text x="${P.l - 8}" y="${ys(t) + 4}" text-anchor="end" fill="#5d5b55" font-family="JetBrains Mono" font-size="10">${Math.round(t)}</text>`
  ).join('');

  const monthSet = new Set();
  series.forEach(s => monthSet.add(s.date.slice(0, 7)));
  const months = [...monthSet];
  const xAxis = months.map(m => {
    const ms = new Date(m + '-01T00:00:00').getTime();
    if (ms < xMin || ms > xMax) return '';
    return `<text x="${xs(ms)}" y="${H - P.b + 18}" text-anchor="middle" fill="#5d5b55" font-family="JetBrains Mono" font-size="9">${m.slice(2)}</text>`;
  }).join('');

  const milestones = [100, 250, 500, 1000].filter(m => m <= yMax);
  const milestoneMarks = milestones.map(m => {
    const hit = series.find(s => s.cum >= m);
    if (!hit) return '';
    const reached = m <= final;
    const color = reached ? '#e8b76d' : '#5d5b55';
    return `<line x1="${xs(hit.dateMs)}" x2="${xs(hit.dateMs)}" y1="${ys(m)}" y2="${H - P.b}" stroke="${reached ? '#a87f3e' : '#2a2c35'}" stroke-width="1" stroke-dasharray="2 4" opacity="0.55"/>` +
      `<circle cx="${xs(hit.dateMs)}" cy="${ys(m)}" r="3.5" fill="${color}"/>` +
      `<text x="${xs(hit.dateMs) + 7}" y="${ys(m) - 5}" fill="${color}" font-family="JetBrains Mono" font-size="9.5">${m}km</text>`;
  }).join('');

  const endX = xs(series[series.length - 1].dateMs);
  const endY = ys(final);

  svg.innerHTML = `
    <defs>
      <linearGradient id="jGrad" x1="0" x2="0" y1="0" y2="1">
        <stop offset="0%" stop-color="#e8b76d" stop-opacity="0.42"/>
        <stop offset="100%" stop-color="#e8b76d" stop-opacity="0.02"/>
      </linearGradient>
    </defs>
    ${yAxis}
    ${xAxis}
    <path d="${area}" fill="url(#jGrad)" />
    <path d="${line}" fill="none" stroke="#e8b76d" stroke-width="2" stroke-linejoin="round"/>
    ${milestoneMarks}
    <circle cx="${endX}" cy="${endY}" r="6" fill="#ffd897" stroke="#0a0a0c" stroke-width="2"/>
    <text x="${endX - 8}" y="${endY - 10}" text-anchor="end" fill="#ffd897" font-family="Fraunces" font-style="italic" font-size="15">${Math.round(final)} km</text>
  `;

  const msList = [
    { km: 100, label: '一次百公里门槛', note: '上海到苏州' },
    { km: 250, label: '六个全马累计', note: '上海到南京' },
    { km: 500, label: '宁波到上海', note: '沿沪甬高速' },
    { km: 838, label: '当前累计里程', note: '今天的位置' },
    { km: 1000, label: '四位数门槛', note: '即将解锁' }
  ];
  const msHtml = msList.map(m => {
    const hit = series.find(s => s.cum >= m.km);
    if (hit) {
      const days = Math.round((hit.dateMs - series[0].dateMs) / 86400000);
      return `<div class="milestone achieved">
        <div class="ms-km">${m.km}<small>km</small></div>
        <div class="ms-when"><strong>${hit.date}</strong> · ${m.label}${m.note ? ` · <span style="color:var(--text-faint)">${m.note}</span>` : ''}</div>
        <div class="ms-days">D+${days}</div>
      </div>`;
    } else {
      const remaining = m.km - final;
      return `<div class="milestone">
        <div class="ms-km">${m.km}<small>km</small></div>
        <div class="ms-when">还差 ${remaining.toFixed(1)} km · ${m.label}${m.note ? ` · <span style="color:var(--text-faint)">${m.note}</span>` : ''}</div>
        <div class="ms-days">未达成</div>
      </div>`;
    }
  }).join('');
  document.getElementById('journeyMilestones').innerHTML = msHtml;

  const climb = (window.HEALTH_DATA.summary && window.HEALTH_DATA.summary.total_elev_gain_m) || 0;
  const everests = (climb / 8848);
  const marathons = (final / 42.195);
  const sydMel = (final / 878) * 100;
  document.getElementById('journeyContextBody').innerHTML =
    `把 <strong>${Math.round(final)} km</strong> 摊开看 ──` +
    ` 相当于骑了 <strong>${marathons.toFixed(1)}</strong> 个全程马拉松，` +
    ` 或悉尼到墨尔本公路距离的 <strong>${sydMel.toFixed(0)}%</strong>。` +
    ` 一路上累计爬升 <strong>${Math.round(climb).toLocaleString()} m</strong>，` +
    ` 这些坡叠起来是 <strong>${everests.toFixed(2)}</strong> 座珠穆朗玛峰。` +
    `<br><br>19 个月、${series.length} 次启程、4 座城市，一格一格往上加。`;
}

// ============ Effort Quadrant ============
function renderEffortQuadrant() {
  const ws = (window.HEALTH_DATA && window.HEALTH_DATA.workouts) || [];
  const data = ws.filter(w => w.hr_avg != null && w.avg_speed_kmh != null && w.distance_km > 0);
  if (!data.length) return;
  const svg = document.getElementById('effortChart');
  if (!svg) return;
  const W = 900, H = 420, P = { l: 60, r: 30, t: 36, b: 50 };

  const hrs = data.map(d => d.hr_avg);
  const sps = data.map(d => d.avg_speed_kmh);
  const hrMin = Math.floor(Math.min(...hrs) - 3);
  const hrMax = Math.ceil(Math.max(...hrs) + 3);
  const spMin = Math.max(0, Math.floor(Math.min(...sps) - 1));
  const spMax = Math.ceil(Math.max(...sps) + 1);

  const median = arr => {
    const s = [...arr].sort((a, b) => a - b);
    return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
  };
  const hrMed = median(hrs);
  const spMed = median(sps);

  const xs = v => P.l + (v - hrMin) / (hrMax - hrMin) * (W - P.l - P.r);
  const ys = v => H - P.b - (v - spMin) / (spMax - spMin) * (H - P.t - P.b);

  const ticksHr = [hrMin, Math.round((hrMin + hrMed) / 2), Math.round(hrMed), Math.round((hrMed + hrMax) / 2), hrMax];
  const ticksSp = [spMin, Math.round((spMin + spMed) / 2 * 10) / 10, Math.round(spMed * 10) / 10, Math.round((spMed + spMax) / 2 * 10) / 10, spMax];

  const grid =
    ticksHr.map(t => `<line x1="${xs(t)}" x2="${xs(t)}" y1="${P.t}" y2="${H - P.b}" stroke="#1c1e25" stroke-width="1"/>` +
      `<text x="${xs(t)}" y="${H - P.b + 18}" text-anchor="middle" fill="#5d5b55" font-family="JetBrains Mono" font-size="10">${t}</text>`).join('') +
    ticksSp.map(t => `<line x1="${P.l}" x2="${W - P.r}" y1="${ys(t)}" y2="${ys(t)}" stroke="#1c1e25" stroke-width="1"/>` +
      `<text x="${P.l - 8}" y="${ys(t) + 4}" text-anchor="end" fill="#5d5b55" font-family="JetBrains Mono" font-size="10">${t}</text>`).join('');

  const cross =
    `<line x1="${xs(hrMed)}" x2="${xs(hrMed)}" y1="${P.t}" y2="${H - P.b}" stroke="#3a3d48" stroke-width="1" stroke-dasharray="4 4"/>` +
    `<line x1="${P.l}" x2="${W - P.r}" y1="${ys(spMed)}" y2="${ys(spMed)}" stroke="#3a3d48" stroke-width="1" stroke-dasharray="4 4"/>` +
    `<text x="${xs(hrMed) + 5}" y="${P.t + 12}" fill="#908d85" font-family="JetBrains Mono" font-size="9.5">中位 ${hrMed.toFixed(0)} bpm</text>` +
    `<text x="${W - P.r - 4}" y="${ys(spMed) - 5}" text-anchor="end" fill="#908d85" font-family="JetBrains Mono" font-size="9.5">中位 ${spMed.toFixed(1)} km/h</text>`;

  const labels =
    `<text x="${xs(hrMin) + 10}" y="${ys(spMax) + 18}" fill="#6cc4d9" font-family="JetBrains Mono" font-size="10" letter-spacing="0.1em">高 效 · EFFICIENT</text>` +
    `<text x="${xs(hrMax) - 10}" y="${ys(spMax) + 18}" text-anchor="end" fill="#e8b76d" font-family="JetBrains Mono" font-size="10" letter-spacing="0.1em">硬 拉 · HARD</text>` +
    `<text x="${xs(hrMin) + 10}" y="${ys(spMin) - 10}" fill="#908d85" font-family="JetBrains Mono" font-size="10" letter-spacing="0.1em">散 步 · EASY</text>` +
    `<text x="${xs(hrMax) - 10}" y="${ys(spMin) - 10}" text-anchor="end" fill="#d97a8a" font-family="JetBrains Mono" font-size="10" letter-spacing="0.1em">代 价 大 · COSTLY</text>`;

  const distMax = Math.max(...data.map(d => d.distance_km));
  const points = data.map(d => {
    const r = 4 + Math.sqrt(d.distance_km / distMax) * 14;
    const isLate = d.date >= '2026-04-01';
    const color = isLate ? '#e8b76d' : '#6cc4d9';
    return `<circle cx="${xs(d.hr_avg)}" cy="${ys(d.avg_speed_kmh)}" r="${r}" fill="${color}" fill-opacity="0.32" stroke="${color}" stroke-width="1.2"><title>${d.date} · ${d.distance_km.toFixed(1)} km · ${d.hr_avg.toFixed(0)} bpm · ${d.avg_speed_kmh.toFixed(1)} km/h</title></circle>`;
  }).join('');

  const titles =
    `<text x="${W / 2}" y="${H - 8}" text-anchor="middle" class="eq-axis-title">平均心率 (bpm)</text>` +
    `<text x="18" y="${H / 2}" text-anchor="middle" class="eq-axis-title" transform="rotate(-90 18 ${H / 2})">平均速度 (km/h)</text>`;

  svg.innerHTML = grid + cross + labels + points + titles;

  let q = { eff: 0, hard: 0, easy: 0, costly: 0 };
  data.forEach(d => {
    if (d.hr_avg <= hrMed && d.avg_speed_kmh > spMed) q.eff++;
    else if (d.hr_avg > hrMed && d.avg_speed_kmh > spMed) q.hard++;
    else if (d.hr_avg <= hrMed && d.avg_speed_kmh <= spMed) q.easy++;
    else q.costly++;
  });
  document.getElementById('effortLegend').innerHTML =
    `<div class="eq-tag eff"><strong>高效巡航</strong><span class="eq-count">${q.eff} 次</span><br>低心率、高速度 — 心肺最舒服的状态，配送早期常出现。</div>` +
    `<div class="eq-tag hard"><strong>硬拉训练</strong><span class="eq-count">${q.hard} 次</span><br>高心率、高速度 — 真正发力的几次冲刺与长距离骑行。</div>` +
    `<div class="eq-tag easy"><strong>慢速散步</strong><span class="eq-count">${q.easy} 次</span><br>低心率、低速度 — 短程或起步，几乎没出力。</div>` +
    `<div class="eq-tag costly"><strong>心率代价大</strong><span class="eq-count">${q.costly} 次</span><br>心率高但速度低 — 爬坡、疲劳或大热天的提示。</div>`;
}

// ============ Fitness & Form (CTL / ATL / TSB) ============
function renderFitnessForm() {
  const H = window.HEALTH_DATA;
  if (!H || !H.workouts || !H.workouts.length) return;

  // Aggregate active_kcal per date from workouts.
  const loadByDate = {};
  H.workouts.forEach(w => {
    if (!w.date) return;
    loadByDate[w.date] = (loadByDate[w.date] || 0) + (w.active_kcal || 0);
  });

  // Build continuous daily timeline from first ride - 14 days to last ride + 7 days
  // so the curve has visible lead-in and tail-off context.
  const dStr = s => new Date(s + 'T00:00:00Z');
  const allDates = Object.keys(loadByDate).sort();
  const first = dStr(allDates[0]);
  first.setUTCDate(first.getUTCDate() - 14);
  const last = dStr(allDates[allDates.length - 1]);
  last.setUTCDate(last.getUTCDate() + 7);

  // Cap "last" at today if today is earlier (no future projection).
  const today = new Date(); today.setUTCHours(0,0,0,0);
  const endDate = today < last ? today : last;

  const series = [];
  let ctl = 0, atl = 0;
  const tauCtl = 42, tauAtl = 7;
  // TRIMP-like daily load: kcal/10 → roughly comparable to TSS scale.
  const cur = new Date(first);
  while (cur <= endDate) {
    const ds = cur.toISOString().slice(0, 10);
    const load = (loadByDate[ds] || 0) / 10;
    ctl = ctl + (load - ctl) / tauCtl;
    atl = atl + (load - atl) / tauAtl;
    series.push({ date: ds, load, ctl, atl, tsb: ctl - atl });
    cur.setUTCDate(cur.getUTCDate() + 1);
  }

  if (series.length < 2) return;

  // ---- Chart geometry ----
  const W = 900, Hh = 320;
  const padL = 50, padR = 56, padT = 22, padB = 38;
  const chartW = W - padL - padR;
  const chartH = Hh - padT - padB;

  const maxCtl = Math.max(...series.map(p => p.ctl), 5);
  const maxAtl = Math.max(...series.map(p => p.atl), maxCtl);
  const yMax = Math.max(maxCtl, maxAtl) * 1.08;

  // TSB scale lives on right axis; symmetric around 0.
  const tsbAbs = Math.max(8, ...series.map(p => Math.abs(p.tsb)));

  const x = i => padL + (i / (series.length - 1)) * chartW;
  const y = v => padT + chartH - (v / yMax) * chartH;
  const yT = v => padT + chartH/2 - (v / tsbAbs) * (chartH/2);

  let svg = '';

  // Gradients
  svg += `<defs>
    <linearGradient id="ctlGrad" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#e8b76d" stop-opacity="0.55"/>
      <stop offset="100%" stop-color="#e8b76d" stop-opacity="0.03"/>
    </linearGradient>
    <linearGradient id="tsbGradPos" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#88b66a" stop-opacity="0.35"/>
      <stop offset="100%" stop-color="#88b66a" stop-opacity="0.0"/>
    </linearGradient>
    <linearGradient id="tsbGradNeg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#d97a8a" stop-opacity="0.0"/>
      <stop offset="100%" stop-color="#d97a8a" stop-opacity="0.35"/>
    </linearGradient>
  </defs>`;

  // y-axis grid (left, load scale)
  const ticks = 4;
  for (let i = 0; i <= ticks; i++) {
    const v = (yMax / ticks) * i;
    const yy = y(v);
    svg += `<line x1="${padL}" y1="${yy}" x2="${W-padR}" y2="${yy}" stroke="#2a2c35" stroke-width="0.5" stroke-dasharray="2 4"/>`;
    svg += `<text x="${padL-6}" y="${yy+3}" text-anchor="end" font-family="JetBrains Mono" font-size="9" fill="#5d5b55">${v.toFixed(0)}</text>`;
  }
  // axis labels
  svg += `<text x="${padL-32}" y="${padT+chartH/2}" text-anchor="middle" font-family="JetBrains Mono" font-size="9" fill="#908d85" transform="rotate(-90 ${padL-32} ${padT+chartH/2})">CTL / ATL · 负荷单位</text>`;

  // TSB right axis ticks
  [-tsbAbs, -tsbAbs/2, 0, tsbAbs/2, tsbAbs].forEach(v => {
    const yy = yT(v);
    svg += `<text x="${W-padR+6}" y="${yy+3}" text-anchor="start" font-family="JetBrains Mono" font-size="9" fill="${v >= 0 ? '#88b66a' : '#d97a8a'}">${v > 0 ? '+'+v.toFixed(0) : v.toFixed(0)}</text>`;
  });
  svg += `<text x="${W-padR+38}" y="${padT+chartH/2}" text-anchor="middle" font-family="JetBrains Mono" font-size="9" fill="#908d85" transform="rotate(90 ${W-padR+38} ${padT+chartH/2})">TSB · 状态</text>`;
  // zero line for TSB
  svg += `<line x1="${padL}" y1="${yT(0)}" x2="${W-padR}" y2="${yT(0)}" stroke="#3a3d48" stroke-width="0.6"/>`;

  // Delivery period highlight (2026-04-25 → 2026-05-19)
  const dStart = series.findIndex(p => p.date >= '2026-04-25');
  const dEnd = series.findIndex(p => p.date >= '2026-05-19');
  if (dStart >= 0 && dEnd >= 0 && dEnd > dStart) {
    const dx1 = x(dStart), dx2 = x(dEnd);
    svg += `<rect x="${dx1}" y="${padT}" width="${dx2-dx1}" height="${chartH}" fill="#e8b76d" fill-opacity="0.05" stroke="#a87f3e" stroke-opacity="0.35" stroke-width="0.5" stroke-dasharray="3 3"/>`;
    svg += `<text x="${(dx1+dx2)/2}" y="${padT+11}" text-anchor="middle" font-family="JetBrains Mono" font-size="9" fill="#a87f3e" letter-spacing="0.12em">DELIVERY · 4/25 → 5/19</text>`;
  }

  // TSB shaded area split by sign (band centered at right-axis zero)
  let posArea = '';
  let negArea = '';
  series.forEach((p, i) => {
    const xx = x(i);
    const yt = yT(p.tsb);
    const y0 = yT(0);
    if (p.tsb >= 0) {
      posArea += (i === 0 ? `M ${xx} ${y0} ` : ` L ${xx} ${y0} `) + ` L ${xx} ${yt} `;
    }
  });
  // Build proper polyline for TSB and use clipPaths? Simpler: thin TSB line, color shifts by sign via stroke segments.
  let tsbLine = '';
  series.forEach((p, i) => {
    tsbLine += (i === 0 ? 'M ' : 'L ') + `${x(i)} ${yT(p.tsb)} `;
  });

  // CTL filled area
  let ctlArea = `M ${x(0)} ${padT+chartH} `;
  series.forEach((p, i) => { ctlArea += `L ${x(i)} ${y(p.ctl)} `; });
  ctlArea += `L ${x(series.length-1)} ${padT+chartH} Z`;
  svg += `<path d="${ctlArea}" fill="url(#ctlGrad)" stroke="#e8b76d" stroke-width="1.4"/>`;

  // ATL line
  let atlLine = '';
  series.forEach((p, i) => { atlLine += (i === 0 ? 'M ' : 'L ') + `${x(i)} ${y(p.atl)} `; });
  svg += `<path d="${atlLine}" fill="none" stroke="#6cc4d9" stroke-width="1.3" stroke-opacity="0.9"/>`;

  // Daily load impulses (tiny vertical ticks at the bottom for ride days)
  series.forEach((p, i) => {
    if (p.load > 0) {
      const xx = x(i);
      const h = Math.min(28, Math.max(3, p.load * 0.6));
      svg += `<line x1="${xx}" y1="${padT+chartH}" x2="${xx}" y2="${padT+chartH-h}" stroke="#a87f3e" stroke-width="1" stroke-opacity="0.45"/>`;
    }
  });

  // TSB line — render in two passes (positive vs negative), using stroke
  svg += `<g opacity="0.95">`;
  // To color-shift TSB, draw small segments
  for (let i = 1; i < series.length; i++) {
    const a = series[i-1], b = series[i];
    const col = (a.tsb + b.tsb) / 2 >= 0 ? '#88b66a' : '#d97a8a';
    svg += `<line x1="${x(i-1)}" y1="${yT(a.tsb)}" x2="${x(i)}" y2="${yT(b.tsb)}" stroke="${col}" stroke-width="1.4" stroke-opacity="0.85"/>`;
  }
  svg += `</g>`;

  // x labels — sample monthly
  const seen = new Set();
  series.forEach((p, i) => {
    const ym = p.date.slice(0, 7);
    if (!seen.has(ym) && (i === 0 || i % 30 === 0 || i === series.length - 1)) {
      seen.add(ym);
      svg += `<text x="${x(i)}" y="${Hh - 14}" text-anchor="middle" font-family="JetBrains Mono" font-size="9" fill="#5d5b55">${ym}</text>`;
    }
  });

  // Peak CTL marker
  const peakCtl = series.reduce((a, b) => b.ctl > a.ctl ? b : a, series[0]);
  const peakIdx = series.indexOf(peakCtl);
  svg += `<circle cx="${x(peakIdx)}" cy="${y(peakCtl.ctl)}" r="4" fill="#ffd897" stroke="#0a0a0c" stroke-width="1.2"/>`;
  svg += `<text x="${x(peakIdx)}" y="${y(peakCtl.ctl) - 9}" text-anchor="middle" font-family="JetBrains Mono" font-size="9" fill="#ffd897">PEAK ${peakCtl.ctl.toFixed(1)}</text>`;

  // Current marker
  const cur2 = series[series.length - 1];
  svg += `<circle cx="${x(series.length-1)}" cy="${y(cur2.ctl)}" r="3" fill="#e8b76d"/>`;
  svg += `<circle cx="${x(series.length-1)}" cy="${y(cur2.atl)}" r="3" fill="#6cc4d9"/>`;

  document.getElementById('ffChart').innerHTML = svg;

  // ---- KPI cards ----
  const lastP = series[series.length - 1];
  const stateOf = tsb => {
    if (tsb >= 15)   return { cls: 'detrain', label: '过度休息 · 体能下降' };
    if (tsb >= 5)    return { cls: 'fresh',   label: '充分恢复 · 状态新鲜' };
    if (tsb >= -10)  return { cls: 'optimal', label: '巡航区间 · 适合发力' };
    if (tsb >= -30)  return { cls: 'heavy',   label: '负荷较重 · 仍可坚持' };
    return                  { cls: 'heavy',   label: '深度疲劳 · 注意恢复' };
  };
  const st = stateOf(lastP.tsb);
  const tsbCls = lastP.tsb >= 0 ? '' : 'neg';
  const tsbSign = lastP.tsb >= 0 ? '+' : '';

  // 7-day delta
  const past = series[Math.max(0, series.length - 8)];
  const dCtl = lastP.ctl - past.ctl;
  const dAtl = lastP.atl - past.atl;
  const arrow = v => v > 0.05 ? '↗' : v < -0.05 ? '↘' : '→';

  const kpisHtml = `
    <div class="ff-kpi">
      <div class="ff-kpi-label"><span class="ff-kpi-dot ctl"></span>体能 · CTL</div>
      <div class="ff-kpi-value">${lastP.ctl.toFixed(1)}<small>负荷单位</small></div>
      <div class="ff-kpi-foot">7 天 ${arrow(dCtl)} ${(dCtl>=0?'+':'')}${dCtl.toFixed(1)} · 峰值 <strong>${peakCtl.ctl.toFixed(1)}</strong></div>
    </div>
    <div class="ff-kpi">
      <div class="ff-kpi-label"><span class="ff-kpi-dot atl"></span>疲劳 · ATL</div>
      <div class="ff-kpi-value">${lastP.atl.toFixed(1)}<small>负荷单位</small></div>
      <div class="ff-kpi-foot">7 天 ${arrow(dAtl)} ${(dAtl>=0?'+':'')}${dAtl.toFixed(1)} · 含 ${Object.keys(loadByDate).length} 天有效骑行</div>
    </div>
    <div class="ff-kpi">
      <div class="ff-kpi-label"><span class="ff-kpi-dot tsb ${tsbCls}"></span>状态 · TSB</div>
      <div class="ff-kpi-value" style="color: ${lastP.tsb >= 0 ? '#88b66a' : 'var(--rose)'}">${tsbSign}${lastP.tsb.toFixed(1)}</div>
      <div class="ff-kpi-foot"><span class="ff-state-pill ${st.cls}">${st.label}</span></div>
    </div>
  `;
  document.getElementById('ffKpis').innerHTML = kpisHtml;

  // Footnote
  const totalLoad = series.reduce((a, p) => a + p.load, 0);
  document.getElementById('ffFoot').textContent =
    `累计 ${totalLoad.toFixed(0)} 负荷单位 · ${series.length} 天窗口 · 截止 ${lastP.date}`;
}

// ============ 心率范围 / HR Range Bars ============
function renderHrRangeChart() {
  const H = window.HEALTH_DATA;
  if (!H || !H.workouts) return;
  const rides = H.workouts
    .filter(w => w.hr_avg && w.hr_min && w.hr_max && w.hr_max > w.hr_min)
    .sort((a, b) => new Date(a.start_iso) - new Date(b.start_iso));
  if (!rides.length) {
    const c = document.getElementById('hrRangeChart');
    if (c) c.innerHTML = '<text x="50%" y="50%" text-anchor="middle" fill="#5d5b55" font-family="JetBrains Mono" font-size="12">这个时间段没有心率数据</text>';
    const f = document.getElementById('hrRangeFoot'); if (f) f.textContent = '—';
    return;
  }

  const W = 900, Ht = Math.max(220, 90 + rides.length * 12);
  const padL = 100, padR = 80, padT = 30, padB = 38;
  const chartW = W - padL - padR;
  const chartH = Ht - padT - padB;

  const allHr = rides.flatMap(r => [r.hr_min, r.hr_max]);
  const xMin = Math.max(50, Math.floor(Math.min(...allHr) / 10) * 10 - 5);
  const xMax = Math.ceil(Math.max(...allHr) / 10) * 10 + 5;
  const X = v => padL + ((v - xMin) / (xMax - xMin)) * chartW;
  const rowH = chartH / rides.length;

  let html = '';
  // viewBox dynamic
  document.getElementById('hrRangeChart').setAttribute('viewBox', `0 0 ${W} ${Ht}`);

  // grid + x labels
  for (let v = xMin; v <= xMax; v += 10) {
    const xx = X(v);
    html += `<line x1="${xx}" y1="${padT}" x2="${xx}" y2="${padT+chartH}" stroke="#2a2c35" stroke-width="0.5" stroke-dasharray="2 4"/>`;
    html += `<text x="${xx}" y="${padT-8}" text-anchor="middle" font-family="JetBrains Mono" font-size="9" fill="#5d5b55">${v}</text>`;
    html += `<text x="${xx}" y="${padT+chartH+18}" text-anchor="middle" font-family="JetBrains Mono" font-size="9" fill="#5d5b55">${v}</text>`;
  }
  html += `<text x="${padL+chartW/2}" y="14" text-anchor="middle" font-family="JetBrains Mono" font-size="10" fill="#908d85" letter-spacing="1">bpm · Heart Rate</text>`;

  // HR zone shading (background)
  const zones = [
    { from: 100, to: 120, color: 'rgba(108,196,217,0.04)' },
    { from: 120, to: 140, color: 'rgba(232,183,109,0.05)' },
    { from: 140, to: 160, color: 'rgba(217,122,138,0.06)' },
  ];
  zones.forEach(z => {
    if (z.from < xMax && z.to > xMin) {
      const x1 = X(Math.max(z.from, xMin));
      const x2 = X(Math.min(z.to, xMax));
      html += `<rect x="${x1}" y="${padT}" width="${x2-x1}" height="${chartH}" fill="${z.color}"/>`;
    }
  });

  // bars
  rides.forEach((r, i) => {
    const cy = padT + i * rowH + rowH / 2;
    const x1 = X(r.hr_min), x2 = X(r.hr_max), xa = X(r.hr_avg);
    const range = r.hr_max - r.hr_min;
    // color: warmer when avg is in middle/high zone, cooler when low
    const norm = Math.max(0, Math.min(1, (r.hr_avg - 70) / 50));
    const fill = `rgba(${Math.round(108 + norm*124)}, ${Math.round(196 - norm*13)}, ${Math.round(217 - norm*108)}, 0.45)`;

    // bar
    html += `<rect x="${x1}" y="${cy-2}" width="${Math.max(2, x2-x1)}" height="4" rx="1.5" fill="${fill}" stroke="rgba(255,255,255,0.04)" stroke-width="0.5"/>`;
    // avg dot
    html += `<circle cx="${xa}" cy="${cy}" r="3.2" fill="#ffd897" stroke="#0a0a0c" stroke-width="0.8">
      <title>${r.date} · ${r.distance_km.toFixed(1)} km · HR ${Math.round(r.hr_min)} – ${Math.round(r.hr_avg)} – ${Math.round(r.hr_max)} bpm · 范围 ${range.toFixed(0)} bpm</title>
    </circle>`;

    // date label every Nth row
    const showDate = (i % Math.max(1, Math.ceil(rides.length / 14)) === 0) || i === rides.length - 1;
    if (showDate) {
      const md = r.date.slice(5);
      html += `<text x="${padL-12}" y="${cy+3}" text-anchor="end" font-family="JetBrains Mono" font-size="9" fill="#908d85">${md}</text>`;
    }
    // distance label on right
    if (i % Math.max(1, Math.ceil(rides.length / 14)) === 0 || i === rides.length - 1) {
      html += `<text x="${W-padR+8}" y="${cy+3}" font-family="JetBrains Mono" font-size="9" fill="#5d5b55">${r.distance_km.toFixed(1)} km</text>`;
    }
  });

  // Highlight max HR ride and max range ride
  let maxHrIdx = 0, maxRangeIdx = 0;
  rides.forEach((r, i) => {
    if (r.hr_max > rides[maxHrIdx].hr_max) maxHrIdx = i;
    if ((r.hr_max - r.hr_min) > (rides[maxRangeIdx].hr_max - rides[maxRangeIdx].hr_min)) maxRangeIdx = i;
  });
  const annotate = (i, label, color) => {
    const r = rides[i];
    const cy = padT + i * rowH + rowH / 2;
    const xx = X(r.hr_max) + 14;
    html += `<line x1="${X(r.hr_max)+3}" y1="${cy}" x2="${xx}" y2="${cy}" stroke="${color}" stroke-width="0.8" stroke-dasharray="2 2"/>`;
    html += `<text x="${xx+4}" y="${cy+3}" font-family="JetBrains Mono" font-size="9" fill="${color}">${label}</text>`;
  };

  document.getElementById('hrRangeChart').innerHTML = html;

  // foot summary
  const avgHr = rides.reduce((s, r) => s + r.hr_avg, 0) / rides.length;
  const avgRange = rides.reduce((s, r) => s + (r.hr_max - r.hr_min), 0) / rides.length;
  const maxHr = Math.max(...rides.map(r => r.hr_max));
  document.getElementById('hrRangeFoot').innerHTML =
    `${rides.length} 次记录 · 平均 HR <strong style="color:var(--text)">${Math.round(avgHr)}</strong> · 平均跨度 <strong style="color:var(--text)">${Math.round(avgRange)}</strong> bpm · 峰值 <strong style="color:var(--amber)">${Math.round(maxHr)}</strong> bpm`;
}

// ============ 能量构成 / Energy Composition ============
function renderEnergyComposition() {
  const H = window.HEALTH_DATA;
  if (!H || !H.workouts) return;
  const rides = H.workouts
    .filter(w => (w.active_kj || 0) > 0)
    .sort((a, b) => new Date(a.start_iso) - new Date(b.start_iso));
  if (!rides.length) {
    const c = document.getElementById('energyChart');
    if (c) c.innerHTML = '<text x="50%" y="50%" text-anchor="middle" fill="#5d5b55" font-family="JetBrains Mono" font-size="12">这个时间段没有能量数据</text>';
    const f = document.getElementById('energyFoot'); if (f) f.textContent = '—';
    const s = document.getElementById('energyStats'); if (s) s.innerHTML = '';
    return;
  }

  const W = 900, Ht = 320;
  const padL = 56, padR = 50, padT = 24, padB = 56;
  const chartW = W - padL - padR;
  const chartH = Ht - padT - padB;

  const totals = rides.map(r => (r.active_kj || 0) + (r.basal_kj || 0));
  const yMax = Math.ceil(Math.max(...totals) / 1000) * 1000;
  const barW = chartW / rides.length * 0.7;
  const gap = chartW / rides.length * 0.3;
  const xStep = chartW / rides.length;

  // efficiency: active_kcal per km
  const effRides = rides.filter(r => r.distance_km > 0.3 && r.active_kcal > 0);
  const effs = rides.map(r => (r.distance_km > 0.3 && r.active_kcal > 0) ? r.active_kcal / r.distance_km : null);
  const validEffs = effs.filter(v => v !== null);
  const effMin = Math.floor(Math.min(...validEffs) / 5) * 5;
  const effMax = Math.ceil(Math.max(...validEffs) / 5) * 5;

  const X = i => padL + i * xStep + xStep/2;
  const Y = v => padT + chartH - (v / yMax) * chartH;
  const Yeff = v => padT + chartH - ((v - effMin) / Math.max(1, effMax - effMin)) * chartH;

  let html = '';
  // grid
  for (let v = 0; v <= yMax; v += yMax / 5) {
    const yy = Y(v);
    html += `<line x1="${padL}" y1="${yy}" x2="${W-padR}" y2="${yy}" stroke="#2a2c35" stroke-width="0.5" stroke-dasharray="2 4"/>`;
    html += `<text x="${padL-6}" y="${yy+3}" text-anchor="end" font-family="JetBrains Mono" font-size="9" fill="#5d5b55">${Math.round(v)}</text>`;
  }
  html += `<text x="14" y="${padT+chartH/2}" text-anchor="middle" font-family="JetBrains Mono" font-size="9" fill="#908d85" transform="rotate(-90 14 ${padT+chartH/2})">总能量 kJ</text>`;
  html += `<text x="${W-12}" y="${padT+chartH/2}" text-anchor="middle" font-family="JetBrains Mono" font-size="9" fill="#d97a8a" transform="rotate(-90 ${W-12} ${padT+chartH/2})">kcal / km</text>`;

  // right axis
  for (let v = effMin; v <= effMax; v += Math.max(1, Math.round((effMax-effMin)/4))) {
    const yy = Yeff(v);
    html += `<text x="${W-padR+6}" y="${yy+3}" font-family="JetBrains Mono" font-size="9" fill="#a05a6a">${v}</text>`;
  }

  // bars + month labels
  let lastMonth = '';
  rides.forEach((r, i) => {
    const x = padL + i * xStep + gap/2;
    const active = r.active_kj || 0;
    const basal = r.basal_kj || 0;
    const total = active + basal;
    // basal at bottom (full height segment near baseline)
    const basalH = (basal / yMax) * chartH;
    const activeH = (active / yMax) * chartH;
    const yBasal = padT + chartH - basalH;
    const yActive = yBasal - activeH;
    html += `<rect x="${x}" y="${yBasal}" width="${barW}" height="${basalH}" fill="rgba(108,196,217,0.45)" stroke="rgba(108,196,217,0.7)" stroke-width="0.3">
      <title>${r.date} · 基础 ${Math.round(basal)} kJ</title>
    </rect>`;
    html += `<rect x="${x}" y="${yActive}" width="${barW}" height="${activeH}" fill="rgba(232,183,109,0.78)" stroke="#ffd897" stroke-width="0.3">
      <title>${r.date} · 主动 ${Math.round(active)} kJ · ${r.distance_km.toFixed(1)} km</title>
    </rect>`;

    // month tick
    const m = r.date.slice(0, 7);
    if (m !== lastMonth) {
      lastMonth = m;
      html += `<text x="${x + barW/2}" y="${Ht-30}" text-anchor="middle" font-family="JetBrains Mono" font-size="9" fill="#5d5b55">${m.slice(2)}</text>`;
      html += `<line x1="${x + barW/2}" y1="${padT+chartH}" x2="${x + barW/2}" y2="${padT+chartH+4}" stroke="#3a3d48" stroke-width="0.5"/>`;
    }
  });

  // efficiency line
  let pathStarted = false;
  let linePath = '';
  rides.forEach((r, i) => {
    if (effs[i] === null) return;
    const cx = X(i), cy = Yeff(effs[i]);
    linePath += `${pathStarted ? 'L' : 'M'} ${cx.toFixed(2)} ${cy.toFixed(2)} `;
    pathStarted = true;
  });
  html += `<path d="${linePath}" fill="none" stroke="#d97a8a" stroke-width="1.4" stroke-opacity="0.85"/>`;
  rides.forEach((r, i) => {
    if (effs[i] === null) return;
    const cx = X(i), cy = Yeff(effs[i]);
    html += `<circle cx="${cx}" cy="${cy}" r="2.4" fill="#d97a8a" fill-opacity="0.9" stroke="#0a0a0c" stroke-width="0.6">
      <title>${r.date} · ${effs[i].toFixed(1)} kcal/km</title>
    </circle>`;
  });

  document.getElementById('energyChart').innerHTML = html;

  // foot
  const totalActive = rides.reduce((s, r) => s + (r.active_kj || 0), 0);
  const totalBasal = rides.reduce((s, r) => s + (r.basal_kj || 0), 0);
  const totalKj = totalActive + totalBasal;
  const activeShare = totalActive / totalKj * 100;
  document.getElementById('energyFoot').textContent =
    `主动消耗占比 ${activeShare.toFixed(0)}%`;

  // stats panel
  const totalKcal = rides.reduce((s, r) => s + (r.active_kcal || 0), 0);
  const longest = rides.reduce((a, r) => (r.active_kj || 0) > (a.active_kj || 0) ? r : a, rides[0]);
  const avgKcalPerKm = validEffs.reduce((a,b)=>a+b,0) / validEffs.length;
  const totalDistance = rides.reduce((s, r) => s + r.distance_km, 0);
  // 1 banana ≈ 105 kcal, 1 big mac ≈ 540 kcal
  const bigMacs = totalKcal / 540;

  document.getElementById('energyStats').innerHTML = `
    <div class="energy-stat">
      <div class="energy-stat-label">Active Energy</div>
      <div class="energy-stat-value">${(totalActive/1000).toFixed(1)}<small>MJ</small></div>
      <div class="energy-stat-sub">主动消耗能量 / 总 ${rides.length} 次</div>
    </div>
    <div class="energy-stat">
      <div class="energy-stat-label">Active vs Basal</div>
      <div class="energy-stat-value">${activeShare.toFixed(0)}<small>%</small></div>
      <div class="energy-stat-sub">主动消耗占总能量比</div>
    </div>
    <div class="energy-stat">
      <div class="energy-stat-label">Avg Cost / km</div>
      <div class="energy-stat-value">${avgKcalPerKm.toFixed(1)}<small>kcal/km</small></div>
      <div class="energy-stat-sub">主动卡路里 / 距离</div>
    </div>
    <div class="energy-stat">
      <div class="energy-stat-label">Big Mac Equivalent</div>
      <div class="energy-stat-value">${bigMacs.toFixed(1)}<small>个</small></div>
      <div class="energy-stat-sub">${Math.round(totalKcal)} kcal ≈ ${bigMacs.toFixed(1)} 个巨无霸</div>
    </div>
    <div class="energy-stat">
      <div class="energy-stat-label">Top Single Ride</div>
      <div class="energy-stat-value">${Math.round(longest.active_kj)}<small>kJ</small></div>
      <div class="energy-stat-sub">${longest.date} · ${longest.distance_km.toFixed(1)} km</div>
    </div>
  `;
}

// ============ 气候画像 / Climate Profile ============
function renderClimateProfile() {
  const H = window.HEALTH_DATA;
  if (!H || !H.workouts) return;
  const rides = H.workouts.filter(w =>
    typeof w.weather_temp_c === 'number' &&
    typeof w.weather_humidity === 'number' &&
    w.weather_humidity > 0
  );
  if (rides.length < 3) {
    const c = document.getElementById('climateChart');
    if (c) c.innerHTML = '<text x="50%" y="50%" text-anchor="middle" fill="#5d5b55" font-family="JetBrains Mono" font-size="12">这个时间段的气象样本太少 (< 3)</text>';
    const f = document.getElementById('climateFoot'); if (f) f.textContent = '—';
    return;
  }

  const W = 900, Ht = 360;
  const padL = 56, padR = 32, padT = 28, padB = 50;
  const chartW = W - padL - padR;
  const chartH = Ht - padT - padB;

  const xs = rides.map(r => r.weather_humidity * 100);
  const ys = rides.map(r => r.weather_temp_c);
  const xMin = Math.max(0, Math.floor(Math.min(...xs) / 10) * 10);
  const xMax = Math.min(100, Math.ceil(Math.max(...xs) / 10) * 10);
  const yMin = Math.floor(Math.min(...ys));
  const yMax = Math.ceil(Math.max(...ys));
  const X = v => padL + ((v - xMin) / (xMax - xMin || 1)) * chartW;
  const Y = v => padT + chartH - ((v - yMin) / (yMax - yMin || 1)) * chartH;

  const maxKm = Math.max(...rides.map(r => r.distance_km));
  const hrs = rides.map(r => r.hr_avg).filter(v => typeof v === 'number');
  const hrMin = hrs.length ? Math.min(...hrs) : 70;
  const hrMax = hrs.length ? Math.max(...hrs) : 100;

  // color mapping: cyan (low HR) -> amber -> rose (high HR)
  const colorFor = hr => {
    if (typeof hr !== 'number') return 'rgba(144,141,133,0.5)';
    const t = (hr - hrMin) / Math.max(1, hrMax - hrMin);
    if (t < 0.5) {
      const k = t * 2;
      const r = Math.round(108 + k*(255-108));
      const g = Math.round(196 + k*(216-196));
      const b = Math.round(217 + k*(151-217));
      return `rgba(${r},${g},${b},0.78)`;
    } else {
      const k = (t - 0.5) * 2;
      const r = Math.round(255 + k*(217-255));
      const g = Math.round(216 + k*(122-216));
      const b = Math.round(151 + k*(138-151));
      return `rgba(${r},${g},${b},0.78)`;
    }
  };

  let html = '';

  // grid + axes
  for (let v = xMin; v <= xMax; v += 10) {
    const xx = X(v);
    html += `<line x1="${xx}" y1="${padT}" x2="${xx}" y2="${padT+chartH}" stroke="#2a2c35" stroke-width="0.5" stroke-dasharray="2 4"/>`;
    html += `<text x="${xx}" y="${padT+chartH+18}" text-anchor="middle" font-family="JetBrains Mono" font-size="9" fill="#5d5b55">${v}%</text>`;
  }
  const yStep = Math.max(2, Math.round((yMax - yMin) / 5));
  for (let v = yMin; v <= yMax; v += yStep) {
    const yy = Y(v);
    html += `<line x1="${padL}" y1="${yy}" x2="${W-padR}" y2="${yy}" stroke="#2a2c35" stroke-width="0.5" stroke-dasharray="2 4"/>`;
    html += `<text x="${padL-6}" y="${yy+3}" text-anchor="end" font-family="JetBrains Mono" font-size="9" fill="#5d5b55">${v}°</text>`;
  }
  html += `<text x="${padL + chartW/2}" y="${Ht - 18}" text-anchor="middle" font-family="JetBrains Mono" font-size="10" fill="#908d85" letter-spacing="1">Humidity %</text>`;
  html += `<text x="14" y="${padT+chartH/2}" text-anchor="middle" font-family="JetBrains Mono" font-size="10" fill="#908d85" transform="rotate(-90 14 ${padT+chartH/2})">Temp °C</text>`;

  // comfort zone shading (typical "good cycling weather" ~ 15-22°C, 40-60% humidity)
  const cz_x1 = X(Math.max(xMin, 40));
  const cz_x2 = X(Math.min(xMax, 70));
  const cz_y1 = Y(Math.min(yMax, 22));
  const cz_y2 = Y(Math.max(yMin, 15));
  html += `<rect x="${cz_x1}" y="${cz_y1}" width="${cz_x2-cz_x1}" height="${cz_y2-cz_y1}" fill="rgba(232,183,109,0.04)" stroke="rgba(232,183,109,0.18)" stroke-width="0.5" stroke-dasharray="3 3"/>`;
  html += `<text x="${(cz_x1+cz_x2)/2}" y="${cz_y1 - 4}" text-anchor="middle" font-family="JetBrains Mono" font-size="9" fill="rgba(232,183,109,0.55)">舒适带 · comfort</text>`;

  // bubbles
  rides.forEach(r => {
    const cx = X(r.weather_humidity * 100);
    const cy = Y(r.weather_temp_c);
    const radius = 3 + (r.distance_km / maxKm) * 14;
    html += `<circle cx="${cx}" cy="${cy}" r="${radius.toFixed(2)}" fill="${colorFor(r.hr_avg)}" stroke="rgba(255,255,255,0.12)" stroke-width="0.6">
      <title>${r.date} · ${r.distance_km.toFixed(1)} km · ${r.weather_temp_c.toFixed(1)}°C · ${Math.round(r.weather_humidity*100)}% RH${r.hr_avg ? ' · '+Math.round(r.hr_avg)+' bpm' : ''}</title>
    </circle>`;
  });

  document.getElementById('climateChart').innerHTML = html;

  // foot
  const avgT = ys.reduce((a,b)=>a+b,0) / ys.length;
  const avgH = xs.reduce((a,b)=>a+b,0) / xs.length;
  const humidShare = (xs.filter(v => v > 70).length / xs.length) * 100;
  document.getElementById('climateFoot').innerHTML =
    `${rides.length} 次有气象记录 · 平均 <strong style="color:var(--text)">${avgT.toFixed(1)}°C</strong> · 平均湿度 <strong style="color:var(--text)">${avgH.toFixed(0)}%</strong> · 高湿(>70%)占 <strong style="color:var(--amber)">${humidShare.toFixed(0)}%</strong>`;
}

// ============ 日常脉搏 / Daily Steps + Flights ============
function renderDailyLife() {
  const H = window.HEALTH_DATA;
  if (!H || !H.daily) return;
  const days = H.daily.filter(d => typeof d.steps === 'number' || typeof d.flights === 'number');
  if (!days.length) return;

  const W = 900, Ht = 280;
  const padL = 56, padR = 56, padT = 24, padB = 50;
  const chartW = W - padL - padR;
  const chartH = Ht - padT - padB;

  const stepsRow = { y0: padT, y1: padT + chartH * 0.55 };
  const flightsRow = { y0: padT + chartH * 0.62, y1: padT + chartH };

  const ts = d => new Date(d.date).getTime();
  const tMin = ts(days[0]);
  const tMax = ts(days[days.length - 1]);
  const X = t => padL + ((t - tMin) / (tMax - tMin || 1)) * chartW;

  const stepsMax = Math.max(...days.map(d => d.steps || 0));
  const flightsMax = Math.max(...days.map(d => d.flights || 0));
  const Ys = v => stepsRow.y1 - (v / stepsMax) * (stepsRow.y1 - stepsRow.y0);
  const Yf = v => flightsRow.y1 - (v / flightsMax) * (flightsRow.y1 - flightsRow.y0);

  let html = '';

  // delivery period shading
  const dpStart = new Date('2026-04-25').getTime();
  const dpEnd = new Date('2026-05-19').getTime();
  if (dpEnd > tMin && dpStart < tMax) {
    const x1 = X(Math.max(dpStart, tMin));
    const x2 = X(Math.min(dpEnd, tMax));
    html += `<rect x="${x1}" y="${padT}" width="${x2-x1}" height="${chartH}" fill="rgba(232,183,109,0.06)" stroke="rgba(232,183,109,0.2)" stroke-width="0.5" stroke-dasharray="3 3"/>`;
    html += `<text x="${(x1+x2)/2}" y="${padT+11}" text-anchor="middle" font-family="JetBrains Mono" font-size="9" fill="rgba(232,183,109,0.7)">送外卖期</text>`;
  }

  // row labels
  html += `<text x="${padL-8}" y="${stepsRow.y0+4}" text-anchor="end" font-family="JetBrains Mono" font-size="9" fill="#5d5b55">${(stepsMax/1000).toFixed(0)}k</text>`;
  html += `<text x="${padL-8}" y="${stepsRow.y1+4}" text-anchor="end" font-family="JetBrains Mono" font-size="9" fill="#5d5b55">0</text>`;
  html += `<text x="14" y="${(stepsRow.y0+stepsRow.y1)/2}" text-anchor="middle" font-family="JetBrains Mono" font-size="9" fill="#e8b76d" transform="rotate(-90 14 ${(stepsRow.y0+stepsRow.y1)/2})">Steps</text>`;
  html += `<text x="${padL-8}" y="${flightsRow.y0+4}" text-anchor="end" font-family="JetBrains Mono" font-size="9" fill="#5d5b55">${Math.round(flightsMax)}</text>`;
  html += `<text x="${padL-8}" y="${flightsRow.y1+4}" text-anchor="end" font-family="JetBrains Mono" font-size="9" fill="#5d5b55">0</text>`;
  html += `<text x="14" y="${(flightsRow.y0+flightsRow.y1)/2}" text-anchor="middle" font-family="JetBrains Mono" font-size="9" fill="#6cc4d9" transform="rotate(-90 14 ${(flightsRow.y0+flightsRow.y1)/2})">Flights</text>`;

  // steps: rolling 7-day mean line (area + line) + raw light dots
  const valid = days.map(d => ({ t: ts(d), steps: d.steps || 0, flights: d.flights || 0 }));
  const win = 7;
  const rollSteps = valid.map((d, i) => {
    const s = valid.slice(Math.max(0, i - win + 1), i + 1);
    const vs = s.filter(x => x.steps > 0);
    if (!vs.length) return null;
    return vs.reduce((a, b) => a + b.steps, 0) / vs.length;
  });

  // raw step dots (faint)
  valid.forEach(d => {
    if (d.steps > 0) {
      html += `<circle cx="${X(d.t)}" cy="${Ys(d.steps)}" r="0.7" fill="rgba(232,183,109,0.28)"/>`;
    }
  });
  // smoothed area
  let areaPath = '';
  let firstX = null;
  valid.forEach((d, i) => {
    if (rollSteps[i] === null) return;
    const x = X(d.t), y = Ys(rollSteps[i]);
    if (firstX === null) { areaPath += `M ${x.toFixed(2)} ${stepsRow.y1} L ${x.toFixed(2)} ${y.toFixed(2)}`; firstX = x; }
    else { areaPath += ` L ${x.toFixed(2)} ${y.toFixed(2)}`; }
  });
  // close
  let lastX = padL + chartW;
  for (let i = valid.length - 1; i >= 0; i--) { if (rollSteps[i] !== null) { lastX = X(valid[i].t); break; } }
  areaPath += ` L ${lastX.toFixed(2)} ${stepsRow.y1} Z`;
  html += `<path d="${areaPath}" fill="rgba(232,183,109,0.14)"/>`;

  // smoothed line
  let linePath = '';
  let started = false;
  valid.forEach((d, i) => {
    if (rollSteps[i] === null) return;
    const x = X(d.t), y = Ys(rollSteps[i]);
    linePath += `${started ? 'L' : 'M'} ${x.toFixed(2)} ${y.toFixed(2)} `;
    started = true;
  });
  html += `<path d="${linePath}" fill="none" stroke="#e8b76d" stroke-width="1.4" stroke-opacity="0.95"/>`;

  // flights bars
  valid.forEach(d => {
    if (d.flights > 0) {
      const xx = X(d.t);
      const yy = Yf(d.flights);
      html += `<line x1="${xx}" y1="${flightsRow.y1}" x2="${xx}" y2="${yy}" stroke="rgba(108,196,217,0.55)" stroke-width="0.8" stroke-linecap="round"/>`;
    }
  });

  // baseline
  html += `<line x1="${padL}" y1="${stepsRow.y1}" x2="${W-padR}" y2="${stepsRow.y1}" stroke="#2a2c35" stroke-width="0.5"/>`;
  html += `<line x1="${padL}" y1="${flightsRow.y1}" x2="${W-padR}" y2="${flightsRow.y1}" stroke="#2a2c35" stroke-width="0.5"/>`;

  // month ticks
  const months = new Set();
  valid.forEach(d => {
    const ds = new Date(d.t);
    const k = ds.getFullYear() + '-' + String(ds.getMonth()+1).padStart(2,'0');
    if (!months.has(k)) {
      months.add(k);
      const xx = X(d.t);
      html += `<line x1="${xx}" y1="${padT+chartH}" x2="${xx}" y2="${padT+chartH+4}" stroke="#3a3d48" stroke-width="0.5"/>`;
      // only label every 2nd month
      if (months.size % 2 === 1) {
        html += `<text x="${xx}" y="${padT+chartH+18}" text-anchor="middle" font-family="JetBrains Mono" font-size="9" fill="#5d5b55">${k.slice(2)}</text>`;
      }
    }
  });

  document.getElementById('dailyLifeChart').innerHTML = html;

  // stats: baseline (Oct 2024 - Mar 2026) vs delivery period
  const deliveryStart = new Date('2026-04-25').getTime();
  const deliveryEnd = new Date('2026-05-19').getTime();
  const baselineEnd = deliveryStart;

  const baseline = valid.filter(d => d.t < baselineEnd && (d.steps > 0 || d.flights > 0));
  const delivery = valid.filter(d => d.t >= deliveryStart && d.t <= deliveryEnd);

  const mean = (arr, k) => {
    const v = arr.filter(x => x[k] > 0);
    return v.length ? v.reduce((a, b) => a + b[k], 0) / v.length : 0;
  };
  const baseSteps = mean(baseline, 'steps');
  const baseFlights = mean(baseline, 'flights');
  const delSteps = mean(delivery, 'steps');
  const delFlights = mean(delivery, 'flights');

  const peakSteps = valid.reduce((a, d) => d.steps > a.steps ? d : a, valid[0]);
  const peakFlights = valid.reduce((a, d) => d.flights > a.flights ? d : a, valid[0]);

  const deltaClass = (cur, base) => cur >= base ? 'up' : 'down';
  const deltaSign = (cur, base) => cur >= base ? '+' : '';
  const pct = (cur, base) => base ? ((cur - base) / base * 100).toFixed(0) : '—';

  document.getElementById('dailyLifeStats').innerHTML = `
    <div class="dl-stat">
      <div class="dl-stat-label">Avg Steps · Baseline</div>
      <div class="dl-stat-row">
        <span class="dl-stat-base">${Math.round(baseSteps).toLocaleString()}</span>
        <span class="dl-stat-arrow">→</span>
        <span class="dl-stat-now">${Math.round(delSteps).toLocaleString()}</span>
      </div>
      <span class="dl-stat-delta ${deltaClass(delSteps, baseSteps)}">${deltaSign(delSteps, baseSteps)}${pct(delSteps, baseSteps)}% · 配送期</span>
    </div>
    <div class="dl-stat">
      <div class="dl-stat-label">Avg Flights · Baseline</div>
      <div class="dl-stat-row">
        <span class="dl-stat-base">${baseFlights.toFixed(1)}</span>
        <span class="dl-stat-arrow">→</span>
        <span class="dl-stat-now">${delFlights.toFixed(1)}</span>
      </div>
      <span class="dl-stat-delta ${deltaClass(delFlights, baseFlights)}">${deltaSign(delFlights, baseFlights)}${pct(delFlights, baseFlights)}% · 配送期</span>
    </div>
    <div class="dl-stat">
      <div class="dl-stat-label">Peak Day · Steps</div>
      <div class="dl-stat-row">
        <span class="dl-stat-now">${Math.round(peakSteps.steps).toLocaleString()}</span>
      </div>
      <span class="dl-stat-delta">${new Date(peakSteps.t).toISOString().slice(0,10)}</span>
    </div>
    <div class="dl-stat">
      <div class="dl-stat-label">Peak Day · Flights</div>
      <div class="dl-stat-row">
        <span class="dl-stat-now">${Math.round(peakFlights.flights)} 层</span>
      </div>
      <span class="dl-stat-delta">${new Date(peakFlights.t).toISOString().slice(0,10)}</span>
    </div>
  `;
}

// ============ 爬升画像 / Elevation Profile Gallery ============
function renderElevGallery() {
  const H = window.HEALTH_DATA;
  if (!H || !H.workouts) return;
  const rides = H.workouts.filter(w => (w.elev_series || []).length > 10 && (w.elev_gain_m || 0) >= 50);
  if (!rides.length) {
    const g = document.getElementById('elevGallery');
    if (g) g.innerHTML = '<div class="empty-range">这个时间段没有显著爬升的骑行</div>';
    const s = document.getElementById('elevSummary'); if (s) s.textContent = '—';
    return;
  }
  const top = [...rides].sort((a, b) => (b.elev_gain_m || 0) - (a.elev_gain_m || 0)).slice(0, 8);

  const cardW = 260, cardH = 70;
  const cards = top.map(r => {
    const es = r.elev_series;
    const eMin = Math.min(...es);
    const eMax = Math.max(...es);
    const range = Math.max(1, eMax - eMin);
    const xStep = cardW / (es.length - 1);
    const Y = v => 6 + (1 - (v - eMin) / range) * (cardH - 14);
    let path = '';
    let area = `M 0 ${cardH - 2} `;
    es.forEach((v, i) => {
      const x = i * xStep;
      const y = Y(v);
      path += `${i === 0 ? 'M' : 'L'} ${x.toFixed(2)} ${y.toFixed(2)} `;
      area += `L ${x.toFixed(2)} ${y.toFixed(2)} `;
    });
    area += `L ${cardW} ${cardH - 2} Z`;

    const start = es[0], end = es[es.length - 1];
    const xS = 0, yS = Y(start);
    const xE = cardW, yE = Y(end);

    const svg = `
      <svg viewBox="0 0 ${cardW} ${cardH}" preserveAspectRatio="none">
        <defs>
          <linearGradient id="elevGrad_${r.id || r.date}" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="rgba(232,183,109,0.30)"/>
            <stop offset="100%" stop-color="rgba(232,183,109,0.02)"/>
          </linearGradient>
        </defs>
        <path d="${area}" fill="url(#elevGrad_${r.id || r.date})"/>
        <path d="${path}" fill="none" stroke="#ffd897" stroke-width="1.2" stroke-linejoin="round"/>
        <circle cx="${xS}" cy="${yS}" r="2.6" fill="#6cc4d9" stroke="#0a0a0c" stroke-width="0.6"/>
        <circle cx="${xE-1}" cy="${yE}" r="2.6" fill="#d97a8a" stroke="#0a0a0c" stroke-width="0.6"/>
        <text x="4" y="${cardH-3}" font-family="JetBrains Mono" font-size="8" fill="#5d5b55">${Math.round(eMin)}m</text>
        <text x="${cardW-4}" y="11" text-anchor="end" font-family="JetBrains Mono" font-size="8" fill="#5d5b55">${Math.round(eMax)}m</text>
      </svg>`;

    const loss = r.elev_loss_m || 0;
    const net = (r.elev_gain_m || 0) - loss;
    return `
      <div class="elev-card">
        <div class="elev-card-head">
          <span class="elev-card-date">${r.date}</span>
          <span class="elev-card-gain">${Math.round(r.elev_gain_m || 0)}<small>m ↑</small></span>
        </div>
        ${svg}
        <div class="elev-card-meta">
          <span><b>距离</b>${(r.distance_km || 0).toFixed(1)} km</span>
          <span><b>下降</b>${Math.round(loss)} m</span>
          <span><b>净</b>${net >= 0 ? '+' : ''}${Math.round(net)} m</span>
          <span><b>HR</b>${r.hr_avg ? Math.round(r.hr_avg) : '—'}</span>
        </div>
      </div>`;
  }).join('');

  document.getElementById('elevGallery').innerHTML = cards;

  // summary line
  const totalGain = rides.reduce((s, r) => s + (r.elev_gain_m || 0), 0);
  const totalLoss = rides.reduce((s, r) => s + (r.elev_loss_m || 0), 0);
  const peakGain = Math.max(...rides.map(r => r.elev_gain_m || 0));
  const everest = (totalGain / 8848 * 100);
  document.getElementById('elevSummary').innerHTML = `
    <span><b>累计爬升</b> ${Math.round(totalGain).toLocaleString()} m</span>
    <span><b>累计下降</b> ${Math.round(totalLoss).toLocaleString()} m</span>
    <span><b>单次最高</b> ${Math.round(peakGain)} m</span>
    <span><b>≈ 珠峰</b> ${everest.toFixed(1)}%</span>
    <span style="color: var(--text-faint);">起点 <span style="color:#6cc4d9;">●</span> · 终点 <span style="color:#d97a8a;">●</span></span>
  `;
}

// ============ 代谢强度 / METS Intensity ============
function renderMetsIntensity() {
  const H = window.HEALTH_DATA;
  if (!H || !H.workouts) return;
  const rides = H.workouts.filter(w => w.mets != null);
  if (!rides.length) {
    const c = document.getElementById('metsChart');
    if (c) c.innerHTML = '<text x="50%" y="50%" text-anchor="middle" fill="#5d5b55" font-family="JetBrains Mono" font-size="12">这个时间段没有 METS 数据</text>';
    const b = document.getElementById('metsBands'); if (b) b.innerHTML = '';
    const f = document.getElementById('metsFoot'); if (f) f.textContent = '—';
    return;
  }

  const bands = [
    { key: 'light',   label: '轻 Light',     min: 2, max: 3, color: '#7aa0a8' },
    { key: 'mod',     label: '中 Moderate',  min: 3, max: 6, color: '#6cc4d9' },
    { key: 'vig',     label: '剧烈 Vigorous', min: 6, max: 9, color: '#e8b76d' },
    { key: 'max',     label: '极限 Max',     min: 9, max: 20, color: '#d97a8a' },
  ];
  const bandOf = m => bands.find(b => m >= b.min && m < b.max) || bands[bands.length - 1];
  rides.forEach(r => { r._band = bandOf(r.mets); });

  // ---- SVG: distribution bars (left) + scatter (right)
  const W = 900, Ht = 300;
  const padL = 50, padR = 30, padT = 22, padB = 50;
  const split = 0.34; // bars take 34% width
  const innerW = W - padL - padR;
  const barsW = innerW * split - 18;
  const scatterW = innerW * (1 - split) - 18;
  const scatterX0 = padL + innerW * split + 18;

  const counts = bands.map(b => rides.filter(r => r._band.key === b.key).length);
  const maxCount = Math.max(...counts, 1);

  const chartH = Ht - padT - padB;
  let svg = '';

  // bars area background
  svg += `<text x="${padL}" y="${padT-6}" font-family="JetBrains Mono" font-size="10" fill="#908d85">骑行次数 / Count</text>`;

  // y-grid for bars
  for (let i = 0; i <= 4; i++) {
    const v = Math.ceil(maxCount * i / 4);
    const yy = padT + chartH - (i / 4) * chartH;
    svg += `<line x1="${padL}" y1="${yy}" x2="${padL + barsW}" y2="${yy}" stroke="#2a2c35" stroke-width="0.5" stroke-dasharray="2 4"/>`;
    svg += `<text x="${padL-6}" y="${yy+3}" text-anchor="end" font-family="JetBrains Mono" font-size="9" fill="#5d5b55">${v}</text>`;
  }

  const barWidth = barsW / bands.length * 0.62;
  const barGap = barsW / bands.length;
  bands.forEach((b, i) => {
    const c = counts[i];
    const h = (c / maxCount) * chartH;
    const x = padL + i * barGap + (barGap - barWidth) / 2;
    const y = padT + chartH - h;
    svg += `<rect x="${x}" y="${y}" width="${barWidth}" height="${h}" fill="${b.color}" fill-opacity="0.78" stroke="${b.color}" stroke-width="0.5"/>`;
    svg += `<text x="${x + barWidth/2}" y="${y - 6}" text-anchor="middle" font-family="JetBrains Mono" font-size="10" fill="#ebe8e1">${c}</text>`;
    svg += `<text x="${x + barWidth/2}" y="${padT + chartH + 14}" text-anchor="middle" font-family="JetBrains Mono" font-size="9" fill="#908d85">${b.label.split(' ')[0]}</text>`;
    svg += `<text x="${x + barWidth/2}" y="${padT + chartH + 26}" text-anchor="middle" font-family="JetBrains Mono" font-size="8" fill="#5d5b55">${b.min}–${b.max === 20 ? '+' : b.max}</text>`;
  });

  // ---- scatter: distance (x) vs METS (y), color by HR
  svg += `<text x="${scatterX0}" y="${padT-6}" font-family="JetBrains Mono" font-size="10" fill="#908d85">距离 km × METS · 圆色 = HR</text>`;

  const sRides = rides.filter(r => r.distance_km > 0);
  const distMax = Math.ceil(Math.max(...sRides.map(r => r.distance_km)) / 10) * 10;
  const metsMin = 2, metsMax = Math.ceil(Math.max(...sRides.map(r => r.mets)));
  const sX = v => scatterX0 + (v / distMax) * scatterW;
  const sY = v => padT + chartH - ((v - metsMin) / Math.max(1, metsMax - metsMin)) * chartH;

  // grid
  for (let i = 0; i <= 4; i++) {
    const yy = padT + chartH - (i / 4) * chartH;
    svg += `<line x1="${scatterX0}" y1="${yy}" x2="${scatterX0 + scatterW}" y2="${yy}" stroke="#2a2c35" stroke-width="0.5" stroke-dasharray="2 4"/>`;
    const mv = metsMin + (metsMax - metsMin) * i / 4;
    svg += `<text x="${scatterX0 - 6}" y="${yy + 3}" text-anchor="end" font-family="JetBrains Mono" font-size="9" fill="#5d5b55">${mv.toFixed(0)}</text>`;
  }
  for (let i = 0; i <= 4; i++) {
    const xx = scatterX0 + (i / 4) * scatterW;
    const dv = Math.round(distMax * i / 4);
    svg += `<text x="${xx}" y="${padT + chartH + 14}" text-anchor="middle" font-family="JetBrains Mono" font-size="9" fill="#5d5b55">${dv}</text>`;
  }
  svg += `<text x="${scatterX0 + scatterW/2}" y="${padT + chartH + 30}" text-anchor="middle" font-family="JetBrains Mono" font-size="9" fill="#908d85">distance km</text>`;

  // HR color ramp
  const hrs = sRides.map(r => r.hr_avg).filter(Boolean);
  const hrMin = Math.min(...hrs), hrMax = Math.max(...hrs);
  const hrColor = hr => {
    if (hr == null) return '#5d5b55';
    const t = (hr - hrMin) / Math.max(1, hrMax - hrMin);
    // cyan -> amber -> rose
    const a = { r: 108, g: 196, b: 217 };
    const b = { r: 255, g: 216, b: 151 };
    const c = { r: 217, g: 122, b: 138 };
    let r, g, bl;
    if (t < 0.5) {
      const k = t / 0.5;
      r = a.r + (b.r - a.r) * k; g = a.g + (b.g - a.g) * k; bl = a.b + (b.b - a.b) * k;
    } else {
      const k = (t - 0.5) / 0.5;
      r = b.r + (c.r - b.r) * k; g = b.g + (c.g - b.g) * k; bl = b.b + (c.b - b.b) * k;
    }
    return `rgb(${r|0},${g|0},${bl|0})`;
  };

  sRides.forEach(r => {
    const cx = sX(r.distance_km);
    const cy = sY(r.mets);
    const radius = Math.max(3, Math.sqrt((r.duration_min || 10)) * 0.8);
    svg += `<circle cx="${cx.toFixed(2)}" cy="${cy.toFixed(2)}" r="${radius.toFixed(1)}" fill="${hrColor(r.hr_avg)}" fill-opacity="0.78" stroke="#0a0a0c" stroke-width="0.6">
      <title>${r.date} · ${r.distance_km.toFixed(1)}km · METS ${r.mets.toFixed(1)} · HR ${r.hr_avg ? Math.round(r.hr_avg) : '—'}</title>
    </circle>`;
  });

  document.getElementById('metsChart').innerHTML = svg;

  // ---- bands grid
  const totalCount = counts.reduce((a, b) => a + b, 0);
  const bandsHTML = bands.map((b, i) => {
    const c = counts[i];
    const pct = totalCount ? (c / totalCount * 100) : 0;
    return `
      <div class="mets-band">
        <div class="mets-band-label">${b.label}</div>
        <div class="mets-band-range">METS ${b.min}–${b.max === 20 ? '+' : b.max}</div>
        <div class="mets-band-count">${c}<small>次 · ${pct.toFixed(0)}%</small></div>
        <div class="mets-band-bar"><span style="width:${pct.toFixed(1)}%;background:${b.color};"></span></div>
      </div>`;
  }).join('');
  document.getElementById('metsBands').innerHTML = bandsHTML;

  // foot: total MET-hours
  const totalMetH = rides.reduce((s, r) => s + (r.mets * (r.duration_min || 0) / 60), 0);
  const avgMets = rides.reduce((s, r) => s + r.mets, 0) / rides.length;
  const peak = rides.reduce((a, r) => r.mets > a.mets ? r : a, rides[0]);
  document.getElementById('metsFoot').textContent =
    `Σ ${totalMetH.toFixed(0)} MET·h · 均值 ${avgMets.toFixed(1)} · 峰值 ${peak.mets.toFixed(1)} (${peak.date})`;
}

// ============ 出发热力图 / Departure Heatmap ============
function renderDepartureHeatmap() {
  const H = window.HEALTH_DATA;
  if (!H || !H.workouts) return;
  const rides = H.workouts.filter(w => w.hour != null && w.weekday != null);
  if (!rides.length) {
    const tgt = document.getElementById('hourHeatmap');
    if (tgt) tgt.innerHTML = '<div class="empty-range">这个时间段没有出发记录</div>';
    const stats = document.getElementById('hmStats'); if (stats) stats.innerHTML = '';
    const foot = document.getElementById('hmFoot'); if (foot) foot.textContent = '—';
    return;
  }

  // grid[weekday 0..6][hour 0..23] = count
  const grid = Array.from({ length: 7 }, () => Array(24).fill(0));
  rides.forEach(r => {
    const wd = ((r.weekday % 7) + 7) % 7;
    const hr = Math.max(0, Math.min(23, Math.floor(r.hour)));
    grid[wd][hr]++;
  });
  const flat = grid.flat();
  const maxV = Math.max(...flat, 1);

  // weekday labels: data uses 0=Mon..6=Sun (Python convention)
  const wdLabels = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

  const colorFor = c => {
    if (!c) return '';
    const t = c / maxV;
    const alpha = 0.15 + t * 0.80;
    return `rgba(232,183,109,${alpha.toFixed(2)})`;
  };

  const cells = [];
  // header row
  cells.push(`<div class="hm-corner"></div>`);
  for (let h = 0; h < 24; h++) {
    cells.push(`<div class="hm-hour">${h % 3 === 0 ? String(h).padStart(2,'0') : ''}</div>`);
  }
  // body rows
  for (let wd = 0; wd < 7; wd++) {
    cells.push(`<div class="hm-wd">${wdLabels[wd]}</div>`);
    for (let h = 0; h < 24; h++) {
      const c = grid[wd][h];
      const cls = 'hm-cell' + (c ? ' has' : '');
      const bg = c ? `background:${colorFor(c)};` : '';
      const showNum = c >= Math.max(2, Math.ceil(maxV * 0.5));
      cells.push(`<div class="${cls}" style="${bg}" title="${wdLabels[wd]} ${String(h).padStart(2,'0')}:00 · ${c} 次">${showNum ? `<span class="hm-dot">${c}</span>` : ''}</div>`);
    }
  }
  document.getElementById('hourHeatmap').innerHTML = cells.join('');

  // stats
  // peak slot
  let peakWd = 0, peakHr = 0, peakC = 0;
  for (let wd = 0; wd < 7; wd++) for (let h = 0; h < 24; h++) {
    if (grid[wd][h] > peakC) { peakC = grid[wd][h]; peakWd = wd; peakHr = h; }
  }
  // peak hour overall
  const hrTotals = Array(24).fill(0);
  const wdTotals = Array(7).fill(0);
  for (let wd = 0; wd < 7; wd++) for (let h = 0; h < 24; h++) {
    hrTotals[h] += grid[wd][h];
    wdTotals[wd] += grid[wd][h];
  }
  const peakHrOverall = hrTotals.indexOf(Math.max(...hrTotals));
  const peakWdOverall = wdTotals.indexOf(Math.max(...wdTotals));

  // morning vs afternoon vs evening split
  const buckets = { '清晨 5–11': 0, '午后 11–17': 0, '黄昏 17–22': 0, '深夜 22–5': 0 };
  rides.forEach(r => {
    const h = Math.floor(r.hour);
    if (h >= 5 && h < 11) buckets['清晨 5–11']++;
    else if (h >= 11 && h < 17) buckets['午后 11–17']++;
    else if (h >= 17 && h < 22) buckets['黄昏 17–22']++;
    else buckets['深夜 22–5']++;
  });
  const dominant = Object.entries(buckets).sort((a, b) => b[1] - a[1])[0];

  document.getElementById('hmFoot').textContent =
    `${rides.length} 次出发 · 跨越 ${(new Set(rides.map(r => Math.floor(r.hour)))).size} 个不同小时`;

  document.getElementById('hmStats').innerHTML = `
    <div class="hm-stat">
      <div class="hm-stat-label">Peak Slot</div>
      <div class="hm-stat-value">${wdLabels[peakWd]} ${String(peakHr).padStart(2,'0')}:00</div>
      <div class="hm-stat-sub">${peakC} 次出发 · 单格最高</div>
    </div>
    <div class="hm-stat">
      <div class="hm-stat-label">Peak Hour</div>
      <div class="hm-stat-value">${String(peakHrOverall).padStart(2,'0')}:00</div>
      <div class="hm-stat-sub">${hrTotals[peakHrOverall]} 次 · 跨所有星期</div>
    </div>
    <div class="hm-stat">
      <div class="hm-stat-label">Peak Day</div>
      <div class="hm-stat-value">${wdLabels[peakWdOverall]}</div>
      <div class="hm-stat-sub">${wdTotals[peakWdOverall]} 次 · 跨所有时段</div>
    </div>
    <div class="hm-stat">
      <div class="hm-stat-label">Dominant Window</div>
      <div class="hm-stat-value" style="font-size: 18px;">${dominant[0]}</div>
      <div class="hm-stat-sub">${dominant[1]} 次 · 占 ${(dominant[1]/rides.length*100).toFixed(0)}%</div>
    </div>
  `;
}

// ============ Floating Side Navigator ============
function buildSideNav() {
  const sections = [...document.querySelectorAll('main > section')];
  const items = sections.map((s, i) => {
    let label = '';
    const titleEl = s.querySelector('.section-title');
    if (titleEl && titleEl.firstChild) {
      label = (titleEl.firstChild.textContent || '').trim();
    } else if (s.classList.contains('hero')) {
      label = '开篇';
    } else if (s.classList.contains('latest-band')) {
      label = '最近一次';
    } else if (s.classList.contains('map-section')) {
      label = '轨迹地图';
    }
    if (!label) return null;
    if (!s.id) s.id = 'sec-' + i;
    return { id: s.id, label };
  }).filter(Boolean);
  if (!items.length) return;
  const nav = document.createElement('div');
  nav.className = 'side-nav';
  nav.id = 'sideNav';
  nav.innerHTML = items.map(it => `<div class="side-nav-item" data-target="${it.id}">${it.label}</div>`).join('');
  document.body.appendChild(nav);
  nav.addEventListener('click', e => {
    const item = e.target.closest('.side-nav-item');
    if (!item) return;
    const el = document.getElementById(item.dataset.target);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  const update = () => {
    const probe = window.scrollY + 140;
    let active = items[0];
    for (const it of items) {
      const el = document.getElementById(it.id);
      if (!el) continue;
      const absTop = el.getBoundingClientRect().top + window.scrollY;
      if (absTop <= probe) active = it;
    }
    document.querySelectorAll('.side-nav-item').forEach(i => i.classList.toggle('active', i.dataset.target === active.id));
  };
  window.addEventListener('scroll', update, { passive: true });
  update();
}

// ============ 时间范围筛选 / Time-range filter ============
// withRange() temporarily swaps HEALTH_DATA.daily and HEALTH_DATA.workouts
// for filtered subsets, runs fn, then restores. Render functions need no
// changes — they keep reading from H.daily / H.workouts as before.

(function rangeFilterSetup() {
  function loadActive() {
    if (window.activeRange === undefined) {
      try {
        const raw = localStorage.getItem('cyclingActiveRange');
        if (raw) {
          const p = JSON.parse(raw);
          window.activeRange = {
            from: new Date(p.from),
            to: new Date(p.to),
            label: p.label || '自定义',
          };
        } else {
          window.activeRange = null;
        }
      } catch (_) { window.activeRange = null; }
    }
    return window.activeRange;
  }

  function inRange(dateStr, r) {
    if (!dateStr) return false;
    const t = new Date(dateStr).getTime();
    if (Number.isNaN(t)) return false;
    return t >= r.from.getTime() && t <= (r.to.getTime() + 86399999);
  }

  window.getActiveRange = loadActive;

  window.filterDailyByRange = function (arr) {
    const r = loadActive();
    if (!r) return arr;
    return arr.filter(d => inRange(d.date, r));
  };

  window.filterWorkoutsByRange = function (arr) {
    const r = loadActive();
    if (!r) return arr;
    return arr.filter(w => inRange(w.date || (w.start_iso || '').slice(0, 10), r));
  };

  window.withRange = function (fn) {
    const H = window.HEALTH_DATA;
    if (!H) { fn(); return; }
    if (!window._origHealthDaily) window._origHealthDaily = H.daily;
    if (!window._origHealthWorkouts) window._origHealthWorkouts = H.workouts;
    const od = H.daily, ow = H.workouts;
    H.daily = window.filterDailyByRange(window._origHealthDaily);
    H.workouts = window.filterWorkoutsByRange(window._origHealthWorkouts);
    try { fn(); }
    finally { H.daily = od; H.workouts = ow; }
  };

  window.setActiveRange = function (from, to, label) {
    if (!from || !to) {
      window.activeRange = null;
      try { localStorage.removeItem('cyclingActiveRange'); } catch (_) {}
    } else {
      window.activeRange = { from, to, label: label || '自定义' };
      try {
        localStorage.setItem('cyclingActiveRange', JSON.stringify({
          from: from.toISOString(), to: to.toISOString(), label: label || '自定义',
        }));
      } catch (_) {}
    }
    if (typeof window.__rerunRanged === 'function') window.__rerunRanged();
    if (typeof window.__updateRangeSummary === 'function') window.__updateRangeSummary();
  };
})();

// Which renders should re-run when the time range changes. These are the
// "dense" data sections — anything that draws a timeline, calendar, or
// per-ride scatter benefits from filtering.
function isRanged(fn) {
  if (!window._RANGED_RENDERS) {
    window._RANGED_RENDERS = new Set([
      typeof renderDailyChart === 'function' ? renderDailyChart : null,
      typeof renderCalendar === 'function' ? renderCalendar : null,
      typeof renderLoadChart === 'function' ? renderLoadChart : null,
      typeof renderJourney === 'function' ? renderJourney : null,
      typeof renderFitnessForm === 'function' ? renderFitnessForm : null,
      typeof renderDailyLife === 'function' ? renderDailyLife : null,
      typeof renderDepartureHeatmap === 'function' ? renderDepartureHeatmap : null,
      typeof renderClimateProfile === 'function' ? renderClimateProfile : null,
      typeof renderEffortQuadrant === 'function' ? renderEffortQuadrant : null,
      typeof renderEnergyComposition === 'function' ? renderEnergyComposition : null,
      typeof renderHrRangeChart === 'function' ? renderHrRangeChart : null,
      typeof renderMetsIntensity === 'function' ? renderMetsIntensity : null,
      typeof renderHrZones === 'function' ? renderHrZones : null,
      typeof renderWeatherScatter === 'function' ? renderWeatherScatter : null,
      typeof renderClimbChart === 'function' ? renderClimbChart : null,
      typeof renderSpeedDist === 'function' ? renderSpeedDist : null,
      typeof renderMonthlyChart === 'function' ? renderMonthlyChart : null,
      typeof renderEfficiencyChart === 'function' ? renderEfficiencyChart : null,
      typeof renderHero === 'function' ? renderHero : null,
      typeof renderAscentDescent === 'function' ? renderAscentDescent : null,
      typeof renderElevGallery === 'function' ? renderElevGallery : null,
      typeof renderHrvRecovery === 'function' ? renderHrvRecovery : null,
      typeof renderRestingHrTrend === 'function' ? renderRestingHrTrend : null,
      typeof renderRespRateBand === 'function' ? renderRespRateBand : null,
      typeof renderSleepStory === 'function' ? renderSleepStory : null,
      typeof renderWalkingReserve === 'function' ? renderWalkingReserve : null,
      typeof renderRecoveryComposite === 'function' ? renderRecoveryComposite : null,
    ].filter(Boolean));
  }
  return window._RANGED_RENDERS.has(fn);
}

// Range-filter UI binding. The widget is HTML markup in the page;
// this function only wires up the listeners.
function bindRangeFilter() {
  const host = document.getElementById('rangeFilter');
  if (!host) return;
  const H = window.HEALTH_DATA;
  if (!H || !H.daily || !H.daily.length) return;

  const minDate = (window._origHealthDaily || H.daily)[0].date;
  const maxDate = (window._origHealthDaily || H.daily).slice(-1)[0].date;
  const fromInp = document.getElementById('rangeFrom');
  const toInp = document.getElementById('rangeTo');
  const summary = document.getElementById('rangeFilterSummary');
  if (!fromInp || !toInp || !summary) return;

  fromInp.min = toInp.min = minDate;
  fromInp.max = toInp.max = maxDate;

  function presetRange(p) {
    const last = new Date(maxDate);
    const first = new Date(minDate);
    if (p === 'all') return null;
    if (p === 'sydney') return { from: new Date('2026-04-25'), to: last };
    const days = p === '30d' ? 30 : p === '90d' ? 90 : 365;
    const from = new Date(last); from.setDate(from.getDate() - days + 1);
    return { from: from < first ? first : from, to: last };
  }

  function applyPreset(p, label) {
    const r = presetRange(p);
    [...host.querySelectorAll('.range-preset')].forEach(b =>
      b.classList.toggle('range-preset--active', b.dataset.preset === p));
    if (r) {
      fromInp.value = r.from.toISOString().slice(0, 10);
      toInp.value = r.to.toISOString().slice(0, 10);
      window.setActiveRange(r.from, r.to, label || p);
    } else {
      window.setActiveRange(null, null, null);
      fromInp.value = minDate;
      toInp.value = maxDate;
    }
  }

  function updateSummary() {
    const r = window.getActiveRange();
    if (!r) {
      summary.innerHTML = `<strong>全部数据</strong> · ${minDate} → ${maxDate}`;
      return;
    }
    const days = Math.round((r.to - r.from) / 86400000) + 1;
    const f = r.from.toISOString().slice(0, 10);
    const t = r.to.toISOString().slice(0, 10);
    const rides = window.filterWorkoutsByRange(window._origHealthWorkouts || []).length;
    summary.innerHTML = `<strong>${r.label || '自定义'}</strong> · ${f} → ${t} · ${days} 天 · ${rides} 次骑行`;
  }
  window.__updateRangeSummary = updateSummary;

  [...host.querySelectorAll('.range-preset')].forEach(btn => {
    btn.addEventListener('click', () => applyPreset(btn.dataset.preset, btn.textContent));
  });

  function applyCustomFromInputs() {
    if (!fromInp.value || !toInp.value) return;
    const f = new Date(fromInp.value);
    const t = new Date(toInp.value);
    if (f > t) return;
    [...host.querySelectorAll('.range-preset')].forEach(b => b.classList.remove('range-preset--active'));
    window.setActiveRange(f, t, '自定义');
  }
  fromInp.addEventListener('change', applyCustomFromInputs);
  toInp.addEventListener('change', applyCustomFromInputs);

  // Restore persisted selection
  const saved = window.getActiveRange();
  if (saved && saved.from && saved.to) {
    fromInp.value = saved.from.toISOString().slice(0, 10);
    toInp.value = saved.to.toISOString().slice(0, 10);
    if (saved.label === '近 30 天' || saved.label === '30d') applyPreset('30d', '近 30 天');
    else if (saved.label === '近 90 天' || saved.label === '90d') applyPreset('90d', '近 90 天');
    else if (saved.label === '近 1 年' || saved.label === 'year') applyPreset('year', '近 1 年');
    else if (saved.label === '悉尼期' || saved.label === 'sydney') applyPreset('sydney', '悉尼期');
    else {
      [...host.querySelectorAll('.range-preset')].forEach(b => b.classList.remove('range-preset--active'));
    }
  } else {
    fromInp.value = minDate;
    toInp.value = maxDate;
    host.querySelector('.range-preset[data-preset="all"]')?.classList.add('range-preset--active');
  }
  updateSummary();
}

// ============ 初始化 ============
// Page-aware boot. Each render is wrapped in a guard so pages that omit
// a section still load cleanly — the missing-id throw is swallowed.
window.addEventListener('DOMContentLoaded', () => {
  const safe = (fn, ...args) => {
    try {
      if (typeof fn !== 'function') return;
      if (isRanged(fn)) window.withRange(() => fn(...args));
      else fn(...args);
    } catch (_) { /* section not present on this page */ }
  };

  const PAGE_RENDERS = {
    overview: [
      [initMap], [renderRoutes, 'Sydney'], [renderList, 'Sydney'],
      [updateCityInfo, 'Sydney'], [renderCityCounts],
      [renderHero], [renderLatestBand], [renderPersonalRecords],
      [renderCityAtlas], [renderJourney],
    ],
    patterns: [
      [renderHero],
      [renderHourClock], [renderWeekday], [renderDailyChart],
      [renderMonthlyChart], [bindMonthlyTabs], [renderMonthlyStats],
      [renderCalendar], [renderDepartureHeatmap],
    ],
    body: [
      [renderHero],
      [renderHrZones], [renderHrRangeChart], [renderWeatherScatter],
      [renderClimateProfile],
      [renderTradePanel], [renderVo2], [renderWeight], [renderBodyDeltas],
      [renderDailyLife],
    ],
    training: [
      [renderHero],
      [renderLoadChart], [renderFitnessForm], [renderEfficiencyChart],
      [renderEffortQuadrant], [renderClimbChart], [renderSpeedDist],
      [renderMetsIntensity], [renderOverlayChart], [bindOverlayTabs],
    ],
    rides: [
      [renderHero],
      [renderEnergyComposition], [renderElevGallery], [renderAscentDescent],
      [renderRidesTable], [bindRidesTable], [renderAnnotation],
    ],
    explorer: [
      [renderHero],
      [renderRideExplorer],
    ],
    recovery: [
      [renderHero],
      [renderHrvRecovery], [renderRestingHrTrend], [renderRespRateBand],
      [renderSleepStory], [renderWalkingReserve], [renderRecoveryComposite],
    ],
    all: null,  // run everything (single-page archive)
  };

  const pageKey = (document.body.dataset.page || 'all').toLowerCase();
  const plan = PAGE_RENDERS[pageKey];

  // Save plan so the range-filter can re-run only the ranged renders later.
  window.__rerunRanged = function () {
    const targetPlan = plan || [];
    targetPlan.forEach(([fn, ...args]) => {
      if (isRanged(fn)) safe(fn, ...args);
    });
  };

  if (plan) {
    plan.forEach(([fn, ...args]) => safe(fn, ...args));
  } else {
    // legacy: run the full original sequence
    [
      [initMap], [renderRoutes, 'Sydney'], [renderList, 'Sydney'],
      [updateCityInfo, 'Sydney'], [renderCityCounts],
      [renderHero], [renderPersonalRecords], [renderHourClock],
      [renderWeekday], [renderDailyChart], [renderMonthlyChart],
      [bindMonthlyTabs], [renderMonthlyStats], [renderHrZones],
      [renderWeatherScatter], [renderCalendar], [renderLoadChart],
      [renderTradePanel], [renderVo2], [renderWeight], [renderBodyDeltas],
      [renderSpeedDist], [renderClimbChart], [renderOverlayChart],
      [bindOverlayTabs], [renderAnnotation], [renderRidesTable],
      [bindRidesTable], [renderLatestBand], [renderEfficiencyChart],
      [renderCityAtlas], [renderJourney], [renderEffortQuadrant],
      [renderFitnessForm], [renderHrRangeChart], [renderEnergyComposition],
      [renderClimateProfile], [renderDailyLife],
      [typeof renderHrvRecovery === 'function' ? renderHrvRecovery : null],
      [typeof renderRestingHrTrend === 'function' ? renderRestingHrTrend : null],
      [typeof renderRespRateBand === 'function' ? renderRespRateBand : null],
      [typeof renderSleepStory === 'function' ? renderSleepStory : null],
      [typeof renderWalkingReserve === 'function' ? renderWalkingReserve : null],
      [typeof renderRecoveryComposite === 'function' ? renderRecoveryComposite : null],
      [renderElevGallery],
      [renderMetsIntensity], [renderDepartureHeatmap],
    ].forEach(([fn, ...args]) => safe(fn, ...args));
  }

  bindRangeFilter();
  safe(buildSideNav);
  safe(buildTopNav);
  safe(renderFooter);
});

function renderFooter() {
  const s = window.HEALTH_DATA && window.HEALTH_DATA.summary;
  if (!s) return;
  const gen = document.getElementById('footerGen');
  if (gen) {
    const g = (s.generated_at || '').slice(0, 10).replace(/-/g, '.');
    gen.textContent = `导出于 ${g} · Apple Health Export · 数据范围 ${s.first_ride} → ${s.last_ride}`;
  }
  const tracks = document.getElementById('footerTracks');
  if (tracks) {
    tracks.textContent = `${(window.ROUTES_DATA || []).length} GPX tracks`;
  }
  const days = document.getElementById('footerDays');
  if (days) {
    days.textContent = `${(window.HEALTH_DATA.daily || []).length} 天身体数据 · ${(window.HEALTH_DATA.vo2max || []).length} 次 VO₂max`;
  }
}

// Top-of-page nav linking all pages. Reads body.dataset.page to mark
// the current entry as active.
function buildTopNav() {
  const host = document.getElementById('topNav');
  if (!host) return;
  const pages = [
    { key: 'overview', href: 'index.html',    cn: '总览',   en: 'Overview' },
    { key: 'patterns', href: 'patterns.html', cn: '节律',   en: 'Patterns' },
    { key: 'body',     href: 'body.html',     cn: '身体',   en: 'Body' },
    { key: 'training', href: 'training.html', cn: '训练',   en: 'Training' },
    { key: 'rides',    href: 'rides.html',    cn: '骑行',   en: 'Rides' },
    { key: 'recovery', href: 'recovery.html', cn: '复元',   en: 'Recovery' },
    { key: 'explorer', href: 'explorer.html', cn: '逐次',   en: 'Explorer' },
    { key: 'all',      href: 'cycling-analysis.html', cn: '全景', en: 'All' },
  ];
  const cur = (document.body.dataset.page || '').toLowerCase();
  host.innerHTML = pages.map(p => {
    const active = p.key === cur ? ' top-nav-link--active' : '';
    return `<a class="top-nav-link${active}" href="${p.href}"><span class="top-nav-cn">${p.cn}</span><span class="top-nav-en">${p.en}</span></a>`;
  }).join('');
}

// ============ 逐次探索 / Ride Explorer ============
// Interactive single-ride drill-down. Picks one workout, draws its full
// elevation profile with a hover-scrubbable cursor, a route mini-map, and
// a stats grid. Selection persists in localStorage so navigating away
// and back keeps you on the same ride.
function renderRideExplorer() {
  const H = window.HEALTH_DATA;
  if (!H || !H.workouts) return;
  const root = document.getElementById('rideExplorer');
  if (!root) return;

  // Eligible rides have at least a date and either a track or elev_series
  const rides = [...H.workouts]
    .filter(w => w.date && ((w.track || []).length > 1 || (w.elev_series || []).length > 1))
    .sort((a, b) => b.date.localeCompare(a.date));

  if (!rides.length) {
    root.innerHTML = '<div class="empty-range">这个时间段没有可探索的骑行</div>';
    return;
  }

  let picked = null;
  try { picked = localStorage.getItem('cyclingExplorerRide'); } catch (_) {}
  let current = rides.find(r => r.id === picked) || rides[0];

  root.innerHTML = `
    <div class="explorer-bar">
      <div class="explorer-picker-wrap">
        <label class="explorer-picker-label">挑一次骑行 · Pick a ride</label>
        <select class="explorer-picker" id="explorerPicker">
          ${rides.map(r => `<option value="${r.id}">${r.date} · ${(r.distance_km||0).toFixed(1)} km · ${Math.round(r.elev_gain_m||0)} m↑</option>`).join('')}
        </select>
      </div>
      <div class="explorer-nav">
        <button class="explorer-nav-btn" id="explorerPrev" title="上一次 / Previous">‹</button>
        <span class="explorer-counter" id="explorerCounter">—</span>
        <button class="explorer-nav-btn" id="explorerNext" title="下一次 / Next">›</button>
      </div>
    </div>
    <div class="explorer-body">
      <div class="explorer-detail" id="explorerDetail"></div>
    </div>
  `;

  const picker = root.querySelector('#explorerPicker');
  picker.value = current.id;

  const drawCurrent = () => {
    try { localStorage.setItem('cyclingExplorerRide', current.id); } catch (_) {}
    const idx = rides.findIndex(r => r.id === current.id);
    root.querySelector('#explorerCounter').textContent = `${idx + 1} / ${rides.length}`;
    root.querySelector('#explorerPrev').disabled = idx >= rides.length - 1;
    root.querySelector('#explorerNext').disabled = idx <= 0;
    renderExplorerDetail(current, root.querySelector('#explorerDetail'));
  };

  picker.addEventListener('change', () => {
    const r = rides.find(x => x.id === picker.value);
    if (r) { current = r; drawCurrent(); }
  });
  root.querySelector('#explorerPrev').addEventListener('click', () => {
    const i = rides.findIndex(r => r.id === current.id);
    if (i < rides.length - 1) { current = rides[i + 1]; picker.value = current.id; drawCurrent(); }
  });
  root.querySelector('#explorerNext').addEventListener('click', () => {
    const i = rides.findIndex(r => r.id === current.id);
    if (i > 0) { current = rides[i - 1]; picker.value = current.id; drawCurrent(); }
  });

  drawCurrent();
}

function renderExplorerDetail(ride, host) {
  if (!host) return;
  const es = ride.elev_series || [];
  const eMin = es.length ? Math.min(...es) : 0;
  const eMax = es.length ? Math.max(...es) : 0;
  const eRange = Math.max(1, eMax - eMin);

  const fmtKm = v => (v || 0).toFixed(2);
  const fmtMin = v => {
    const m = Math.floor(v || 0), s = Math.round(((v || 0) - m) * 60);
    return `${m}:${String(s).padStart(2, '0')}`;
  };
  const hourLabel = ride.start_iso
    ? new Date(ride.start_iso).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
    : '—';
  const weatherStr = (ride.weather_temp_c != null)
    ? `${ride.weather_temp_c.toFixed(1)}°C · 湿度 ${Math.round((ride.weather_humidity || 0) * 100)}%`
    : '室内 / 无气象';

  const grossClimb = Math.round(ride.elev_gain_m || 0);
  const grossDrop = Math.round(ride.elev_loss_m || 0);
  const net = grossClimb - grossDrop;

  host.innerHTML = `
    <div class="explorer-headline">
      <div>
        <div class="explorer-date">${ride.date}</div>
        <div class="explorer-when">出发 ${hourLabel} · ${weatherStr}</div>
      </div>
      <div class="explorer-headline-num">
        <span class="explorer-big">${fmtKm(ride.distance_km)}</span><span class="explorer-big-unit">km</span>
      </div>
    </div>

    <div class="explorer-stats">
      <div class="explorer-stat"><div class="es-label">时长</div><div class="es-value">${fmtMin(ride.duration_min)}<small>min</small></div></div>
      <div class="explorer-stat"><div class="es-label">均速</div><div class="es-value">${ride.avg_speed_kmh ? ride.avg_speed_kmh.toFixed(2) : '—'}<small>km/h</small></div></div>
      <div class="explorer-stat"><div class="es-label">均心率</div><div class="es-value">${ride.hr_avg ? Math.round(ride.hr_avg) : '—'}<small>bpm</small></div></div>
      <div class="explorer-stat"><div class="es-label">最高心率</div><div class="es-value">${ride.hr_max ? Math.round(ride.hr_max) : '—'}<small>bpm</small></div></div>
      <div class="explorer-stat"><div class="es-label">消耗</div><div class="es-value">${ride.active_kcal ? Math.round(ride.active_kcal) : '—'}<small>kcal</small></div></div>
      <div class="explorer-stat"><div class="es-label">METS</div><div class="es-value">${ride.mets ? ride.mets.toFixed(1) : '—'}</div></div>
      <div class="explorer-stat"><div class="es-label">爬升</div><div class="es-value">${grossClimb}<small>m ↑</small></div></div>
      <div class="explorer-stat"><div class="es-label">下降</div><div class="es-value">${grossDrop}<small>m ↓</small></div></div>
      <div class="explorer-stat"><div class="es-label">净海拔</div><div class="es-value">${net >= 0 ? '+' : ''}${net}<small>m</small></div></div>
    </div>

    <div class="explorer-twocol">
      <div class="explorer-elev-wrap">
        <div class="explorer-sub-title">海拔剖面 · Elevation profile<span class="explorer-sub-foot" id="explorerElevReadout">悬停查看 · hover to scrub</span></div>
        <svg class="explorer-elev" id="explorerElevSvg" viewBox="0 0 800 220" preserveAspectRatio="none"></svg>
      </div>
      <div class="explorer-map-wrap">
        <div class="explorer-sub-title">路线 · Route</div>
        <div class="explorer-map" id="explorerMap"></div>
      </div>
    </div>
  `;

  const svg = host.querySelector('#explorerElevSvg');
  const readout = host.querySelector('#explorerElevReadout');
  drawExplorerElev(svg, ride, eMin, eMax, eRange, readout);

  // Mini map (Leaflet). Re-init each draw — host element changes on rebuild.
  const mapDiv = host.querySelector('#explorerMap');
  if (mapDiv && typeof L !== 'undefined') {
    const track = ride.track || [];
    if (track.length > 1) {
      // Leaflet doesn't tolerate re-init on the same node, but each render
      // replaces the div so the new one is clean.
      const map = L.map(mapDiv, {
        zoomControl: true, attributionControl: false,
        scrollWheelZoom: false, dragging: true,
      });
      L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
        maxZoom: 18, subdomains: 'abcd',
      }).addTo(map);
      const poly = L.polyline(track, { color: '#e8b76d', weight: 3, opacity: 0.9 }).addTo(map);
      L.circleMarker(track[0],            { radius: 5, color: '#6cc4d9', fillColor: '#6cc4d9', fillOpacity: 1, weight: 1 }).addTo(map);
      L.circleMarker(track[track.length-1], { radius: 5, color: '#d97a8a', fillColor: '#d97a8a', fillOpacity: 1, weight: 1 }).addTo(map);
      map.fitBounds(poly.getBounds(), { padding: [12, 12] });
    } else {
      mapDiv.innerHTML = '<div class="explorer-map-empty">这次没有 GPS 轨迹</div>';
    }
  }
}

function drawExplorerElev(svg, ride, eMin, eMax, eRange, readout) {
  const es = ride.elev_series || [];
  if (!svg) return;
  if (es.length < 2) {
    svg.innerHTML = '<text x="400" y="110" text-anchor="middle" fill="#5d5b55" font-size="13" font-family="JetBrains Mono">没有海拔细节</text>';
    return;
  }
  const W = 800, H = 220, PAD_L = 38, PAD_R = 12, PAD_T = 16, PAD_B = 28;
  const plotW = W - PAD_L - PAD_R;
  const plotH = H - PAD_T - PAD_B;
  const xStep = plotW / (es.length - 1);
  const Y = v => PAD_T + (1 - (v - eMin) / eRange) * plotH;
  const X = i => PAD_L + i * xStep;

  let line = '', area = `M ${X(0)} ${PAD_T + plotH} `;
  es.forEach((v, i) => {
    const x = X(i), y = Y(v);
    line += `${i === 0 ? 'M' : 'L'} ${x.toFixed(2)} ${y.toFixed(2)} `;
    area += `L ${x.toFixed(2)} ${y.toFixed(2)} `;
  });
  area += `L ${X(es.length - 1)} ${PAD_T + plotH} Z`;

  // y-axis tick labels (3 marks)
  const ticks = [eMin, (eMin + eMax) / 2, eMax];
  const tickMarks = ticks.map(v => {
    const y = Y(v).toFixed(1);
    return `
      <line x1="${PAD_L}" x2="${W - PAD_R}" y1="${y}" y2="${y}" stroke="rgba(232,183,109,0.06)" stroke-width="1"/>
      <text x="${PAD_L - 6}" y="${y}" text-anchor="end" dy="3" fill="#5d5b55" font-family="JetBrains Mono" font-size="9">${Math.round(v)}m</text>
    `;
  }).join('');

  svg.innerHTML = `
    <defs>
      <linearGradient id="explorerElevGrad" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="rgba(232,183,109,0.32)"/>
        <stop offset="100%" stop-color="rgba(232,183,109,0.02)"/>
      </linearGradient>
    </defs>
    ${tickMarks}
    <path d="${area}" fill="url(#explorerElevGrad)"/>
    <path d="${line}" fill="none" stroke="#ffd897" stroke-width="1.6" stroke-linejoin="round"/>
    <circle cx="${X(0).toFixed(1)}" cy="${Y(es[0]).toFixed(1)}" r="4" fill="#6cc4d9" stroke="#0a0a0c" stroke-width="1"/>
    <circle cx="${X(es.length-1).toFixed(1)}" cy="${Y(es[es.length-1]).toFixed(1)}" r="4" fill="#d97a8a" stroke="#0a0a0c" stroke-width="1"/>
    <line class="explorer-scrub-line" id="explorerScrubLine" x1="${PAD_L}" x2="${PAD_L}" y1="${PAD_T}" y2="${PAD_T+plotH}" stroke="rgba(232,183,109,0.55)" stroke-width="1" stroke-dasharray="3,3" style="display:none;"/>
    <circle class="explorer-scrub-dot" id="explorerScrubDot" r="4.5" fill="#e8b76d" stroke="#0a0a0c" stroke-width="1" style="display:none;"/>
    <text x="${PAD_L}" y="${H-8}" fill="#5d5b55" font-family="JetBrains Mono" font-size="9">起 ●</text>
    <text x="${W-PAD_R}" y="${H-8}" text-anchor="end" fill="#5d5b55" font-family="JetBrains Mono" font-size="9">● 终</text>
    <rect class="explorer-elev-hot" x="${PAD_L}" y="${PAD_T}" width="${plotW}" height="${plotH}" fill="transparent" style="cursor:crosshair;"/>
  `;

  const scrubLine = svg.querySelector('#explorerScrubLine');
  const scrubDot = svg.querySelector('#explorerScrubDot');
  const hot = svg.querySelector('.explorer-elev-hot');
  if (!hot) return;
  const onMove = (e) => {
    const rect = svg.getBoundingClientRect();
    const ratio = (e.clientX - rect.left) / rect.width;
    const xViewBox = ratio * W;
    let idx = Math.round((xViewBox - PAD_L) / xStep);
    if (idx < 0) idx = 0;
    if (idx > es.length - 1) idx = es.length - 1;
    const v = es[idx];
    const x = X(idx), y = Y(v);
    scrubLine.setAttribute('x1', x); scrubLine.setAttribute('x2', x); scrubLine.style.display = '';
    scrubDot.setAttribute('cx', x); scrubDot.setAttribute('cy', y); scrubDot.style.display = '';
    const pct = (idx / (es.length - 1)) * 100;
    const distEst = ((idx / (es.length - 1)) * (ride.distance_km || 0)).toFixed(2);
    if (readout) {
      readout.innerHTML = `位置 <b>${pct.toFixed(0)}%</b> · ≈ ${distEst} km · 海拔 <b>${Math.round(v)} m</b>`;
    }
  };
  const onLeave = () => {
    scrubLine.style.display = 'none';
    scrubDot.style.display = 'none';
    if (readout) readout.textContent = '悬停查看 · hover to scrub';
  };
  hot.addEventListener('mousemove', onMove);
  hot.addEventListener('mouseleave', onLeave);
  hot.addEventListener('touchmove', e => {
    if (!e.touches[0]) return;
    onMove(e.touches[0]);
    e.preventDefault();
  }, { passive: false });
}

// ============ 爬升 vs 下降 / Ascent vs Descent ============
// Top rides by elevation gain, plotted as paired ascent (up) and descent
// (down) bars from a shared baseline. Net climb shown as a marker. Uses
// elev_loss_m which was untapped until this section.
function renderAscentDescent() {
  const H = window.HEALTH_DATA;
  if (!H || !H.workouts) return;
  const host = document.getElementById('ascentDescentChart');
  const summary = document.getElementById('ascentDescentSummary');
  if (!host) return;
  const rides = H.workouts.filter(w => (w.elev_gain_m || 0) >= 30 || (w.elev_loss_m || 0) >= 30);
  if (!rides.length) {
    host.innerHTML = '<div class="empty-range">这个时间段没有有海拔变化的骑行</div>';
    if (summary) summary.textContent = '—';
    return;
  }
  const top = [...rides]
    .sort((a, b) => ((b.elev_gain_m || 0) + (b.elev_loss_m || 0)) - ((a.elev_gain_m || 0) + (a.elev_loss_m || 0)))
    .slice(0, 12)
    .sort((a, b) => a.date.localeCompare(b.date));

  const maxMag = Math.max(
    ...top.map(r => Math.max(r.elev_gain_m || 0, r.elev_loss_m || 0)),
    1
  );

  const W = 900, H_ = 320, PAD_L = 44, PAD_R = 12, PAD_T = 22, PAD_B = 56;
  const plotW = W - PAD_L - PAD_R, plotH = H_ - PAD_T - PAD_B;
  const mid = PAD_T + plotH / 2;
  const halfH = plotH / 2;
  const barGroupW = plotW / top.length;
  const barW = Math.min(28, barGroupW * 0.62);

  const tickVals = [maxMag, maxMag / 2, 0, -maxMag / 2, -maxMag];
  const ticks = tickVals.map(v => {
    const y = mid - (v / maxMag) * halfH;
    return `
      <line x1="${PAD_L}" x2="${W - PAD_R}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}" stroke="rgba(232,183,109,${v === 0 ? '0.20' : '0.05'})" stroke-width="${v === 0 ? 1 : 1}"/>
      <text x="${PAD_L - 6}" y="${y.toFixed(1)}" dy="3" text-anchor="end" fill="#5d5b55" font-family="JetBrains Mono" font-size="9">${Math.abs(Math.round(v))}m</text>
    `;
  }).join('');

  const bars = top.map((r, i) => {
    const cx = PAD_L + i * barGroupW + barGroupW / 2;
    const gain = r.elev_gain_m || 0;
    const loss = r.elev_loss_m || 0;
    const net = gain - loss;
    const hUp = (gain / maxMag) * halfH;
    const hDown = (loss / maxMag) * halfH;
    const upX = cx - barW / 2 - 1;
    const downX = cx + 1;
    return `
      <g class="ad-group" data-date="${r.date}">
        <rect x="${upX}" y="${mid - hUp}" width="${barW/2 - 1}" height="${hUp}" fill="#ffd897" rx="2"/>
        <rect x="${downX}" y="${mid}" width="${barW/2 - 1}" height="${hDown}" fill="#7aa0a8" rx="2"/>
        <circle cx="${cx}" cy="${mid - (net / maxMag) * halfH}" r="3" fill="${net >= 0 ? '#e8b76d' : '#6cc4d9'}" stroke="#0a0a0c" stroke-width="1"/>
        <text x="${cx}" y="${H_ - 36}" text-anchor="middle" fill="#5d5b55" font-family="JetBrains Mono" font-size="9" transform="rotate(-32 ${cx} ${H_ - 36})">${r.date.slice(5)}</text>
        <title>${r.date} · ↑${Math.round(gain)}m · ↓${Math.round(loss)}m · 净 ${net >= 0 ? '+' : ''}${Math.round(net)}m</title>
      </g>
    `;
  }).join('');

  host.innerHTML = `
    <svg viewBox="0 0 ${W} ${H_}" preserveAspectRatio="xMidYMid meet" class="ad-svg">
      ${ticks}
      ${bars}
      <text x="${PAD_L - 6}" y="${PAD_T + 8}" text-anchor="end" fill="#e8b76d" font-family="JetBrains Mono" font-size="10">↑ 爬升</text>
      <text x="${PAD_L - 6}" y="${H_ - PAD_B + 10}" text-anchor="end" fill="#7aa0a8" font-family="JetBrains Mono" font-size="10">↓ 下降</text>
    </svg>
    <div class="ad-legend">
      <span><span class="ad-swatch" style="background:#ffd897"></span>爬升 (gain)</span>
      <span><span class="ad-swatch" style="background:#7aa0a8"></span>下降 (loss)</span>
      <span><span class="ad-swatch ad-dot" style="background:#e8b76d"></span>净海拔 (net)</span>
    </div>
  `;

  if (summary) {
    const totalGain = rides.reduce((s, r) => s + (r.elev_gain_m || 0), 0);
    const totalLoss = rides.reduce((s, r) => s + (r.elev_loss_m || 0), 0);
    const netAll = totalGain - totalLoss;
    const ratio = totalLoss > 0 ? (totalGain / totalLoss) : 0;
    summary.innerHTML = `
      <span><b>累计爬升</b> ${Math.round(totalGain).toLocaleString()} m</span>
      <span><b>累计下降</b> ${Math.round(totalLoss).toLocaleString()} m</span>
      <span><b>净变化</b> ${netAll >= 0 ? '+' : ''}${Math.round(netAll).toLocaleString()} m</span>
      <span><b>爬升 / 下降</b> ${ratio.toFixed(2)}×</span>
    `;
  }
}

