/* One calm reading path per page, with conclusions limited to what the records show. */
(function () {
  'use strict';
  const $ = (s, root = document) => root.querySelector(s);
  const page = document.body.dataset.page || 'all';
  const COPY = {
    overview: ['总览', '先确认记录覆盖，再进入专题', '总览告诉你数据覆盖到哪里；节律、训练和身体页才回答具体变化。', '轨迹记录不等于完整活动记录。'],
    patterns: ['节律', '先看出发时刻，再看星期与日期', '高频时段只说明你过去常在这时出门；它不能代表需求、天气或收益。', '这是个人骑行节律，不是外卖订单高峰。'],
    body: ['身体', '先看心率区间，再对照天气与长期估算', '优先比较同一城市、相近活动和同一口径；单点变化不足以说明身体状态改变。', '设备估值用于观察个人趋势，不用于诊断。'],
    training: ['训练', '先看负荷趋势，再检查单次骑行', '长期趋势适合观察训练量如何变化；短期峰值需要回到对应骑行核对。', '负荷是模型估算，不是训练处方或疲劳诊断。'],
    rides: ['骑行', '先看典型距离，再看极值与单次轨迹', '中位数描述常见骑行；最长、最快和最大爬升只是个别记录。', 'GPS 距离、速度与海拔会受设备采样和路线影响。'],
    explorer: ['逐次', '选一趟记录，沿时间轴核对路线和剖面', '先确认日期与路线，再把海拔、速度和心率当作同一趟活动的证据。', '缺失的传感器数据不会因图表显示而补齐。'],
    recovery: ['复元', '先看长期基线，再观察连续几天的偏离', '连续记录比单日读数更有解释力；先检查样本是否足够，再读变化方向。', '个人设备读数不用于诊断，也不能单独决定是否训练。'],
    delivery: ['配送分析', '先看当前报价，再用时段与区域缩小候选', '时段与区域按 GPS 推断取餐频率选试跑候选；单均金额只作跨平台情景参考。要验证收益，需要记录真实在线时长与实际收入。', 'GPS 记录小时不是平台在线小时；GPS 活动还包含其他平台订单。'],
    dashboard: ['配送作战台', '先选试跑区，再核对当前报价与送达落点', '区域和时段只用于挑选试跑候选；接单判断要输入这单实际的去店、等餐和送达时间。', '历史估算不代表下一单派单概率，也不等于实际平台在线时薪。'],
    all: ['全景', '先按问题进入专题，不要横向比较不同口径的图', '节律看出发习惯；训练看负荷；复元看连续生理记录；配送看报价与历史 GPS 线索。', '全景页混合了不同设备、时间范围和估算口径。'],
  };
  const pageCopy = COPY[page] || COPY.all;

  // Section-level notes turn chart subtitles into a short interpretation path.
  // Match by the stable Chinese heading prefix so the combined page works too.
  const SECTION_COPY = [
    ['时间画像', '先看最高的出发时段和星期，再看每日距离；次数代表你记录到的出门习惯，不代表当时订单量或收入。'],
    ['月度全景', '比较月份前先确认日期筛选是否覆盖完整月；总量变化可能来自记录天数不同，不能直接当作强度变化。'],
    ['出发热力图', '亮格表示你在该星期和小时更常开始骑行；空格不说明当时没有订单或需求。'],
    ['活动日历', '颜色展示每天的骑行距离，连续空白可能是休息或缺记录；它本身不区分这两种情况。'],
    ['健康指标', '心率区间描述记录中的运动强度分布；天气和路线会同时影响心率，不能只凭分布判断体能变化。'],
    ['心率范围', '横条跨度是单次记录的最低到最高心率，圆点是平均值；先找持续偏移，再回到路线和天气核对。'],
    ['气候画像', '点的位置对应温湿度、颜色对应平均心率；样本集中在特定季节时，不宜外推到全年。'],
    ['身体适应', '对比基线与近期的设备估值时，先看有效天数和两段覆盖日期；估值差异不等于临床变化。'],
    ['日常脉搏', '步数和爬楼是全天活动记录，骑行日也包含骑行之外的活动；设备缺测不能解释为零活动。'],
    ['7 天滚动负荷', '柱看近 7 天距离、线看骑行天数；连续上升表示记录量增加，不代表疲劳或体能必然同步变化。'],
    ['训练负荷与状态', '短期线高于长期线表示近期模型负荷较高；它由活动能量近似，需用实际训练感受和记录核对。'],
    ['训练效率', '同速下每公里心跳较低可作为个人观察线索；只比较路线、坡度、停顿和天气相近的骑行。'],
    ['强度象限', '中位线只把本批骑行分成相对高低；落在某象限不是训练等级，也不适合跨筛选期直接比较。'],
    ['爬升 × 配速', '看相近爬升量下速度是否不同，并检查距离和路线；相关分布不能说明爬升单独造成速度变化。'],
    ['代谢强度', 'METS 是设备估算的活动强度；同时看分档和单次距离，避免把估值当作实测功率。'],
    ['骑行与日常活动', '图中画的是全天步数与爬楼及各自的滚动均值；它没有叠加骑行距离，空白也不等于零。'],
    ['能量构成', '主动能量与基础代谢是设备估算的构成项；骑行之间比较时确认记录时长和设备覆盖一致。'],
    ['爬升画像', '曲线形状展示每趟爬升的空间分布，纵向尺度需结合图轴；精选的 Top 8 不能代表所有路线。'],
    ['爬升 vs 下降', '爬升与下降分别看累计量，净海拔是起终点差；GPS 高程误差会影响短路线的差值。'],
    ['HRV 复元', '先看个人中位范围和连续偏离，再看选区统计；单日 HRV 波动常见，不足以单独评价恢复。'],
    ['静息心率', '比较 7 天均线和两段均值时留意记录天数；短期上升是值得复核的信号，不是诊断结论。'],
    ['呼吸节律', '分别读呼吸率和血氧轴，关注连续变化及低值日期；单次设备异常可先复核佩戴和记录质量。'],
    ['睡眠时长', '直方图看时长分布，骑行日对照看两组记录差异；观察到的差异不能证明骑行导致睡眠变化。'],
    ['步行与静息心率差', '差值是在同一天两项测量的相减结果；先核对成对样本数量，避免把缺测日当成生理变化。'],
    ['晨间生理', '四条线共享日期但单位不同，按各自轴和个人基线读；同步变化只是时间上的共现。'],
    ['逐次骑行', '选中一趟后联动核对路线、海拔、速度和心率；传感器缺口表示没有读数，不代表活动停止。'],
    ['最佳成绩', '纪录只显示当前数据中的极值；确认距离、时间和采样完整后再把它当作可比较成绩。'],
    ['城市分布', '轨迹数反映记录覆盖，不等于每座城市的总骑行量；跨城比较前先看日期跨度和设备缺测。'],
    ['累计旅程', '累计线只会随已记录距离增长；平段可能是没有活动，也可能是没有同步记录。'],
    ['全部骑行明细', '用日期和距离定位一趟，再打开地图核实路线；表格排序结果不代表典型活动。'],
    ['热点地图', '停车点分类来自轨迹推断；先看地图位置和人工核验结果，再用底色指标筛查候选热点。'],
    ['配送概览', '分解单量、移动时间和停留时间时，记住这些都由 GPS 反推；不要直接当作平台订单流水。'],
    ['区域排行', '只有日期和时段可比时才看取餐频率；结合送达后的续接与骑行效率，再决定试跑区域。'],
    ['这一单该不该接', '把眼前订单的实际时间和报价代入后看净增量；历史均值不能替代当前路况和等餐情况。'],
    ['什么时候去哪试跑', '按每 GPS 记录小时的推断取餐频率挑试跑点；先看样本量和区间宽度，再小规模验证。频率不是平台在线时薪或派单概率。'],
    ['接单区还是送达区', '把取餐、送达和送达后的位置分开看；单看取餐密度会漏掉空驶回流成本。'],
    ['时段规律', '取餐频率的分母包含无取餐记录时间；显示门槛会隐藏样本不足的区时组合。'],
    ['路段好坏', '额外分钟是相对模型自由流速度的估计；它用于找反复慢点，不是精确的信号灯延误。'],
    ['区域档案', '把区域环境特征与个人骑行结果分开读；相关性不说明餐厅密度造成了更高收益或更慢速度。'],
    ['这一脚是在干嘛', '分类依赖停留时长、位置和人工核验；模糊样本会影响后续所有配送频率估计。'],
    ['判得准不准', '用真实订单逐条核对推断标签，并同时看漏判与误判；样本覆盖范围限制准确率的外推。'],
  ];

  function filtered(read) {
    let result;
    const run = () => { result = read(); };
    if (typeof window.withRange === 'function') window.withRange(run);
    else run();
    return result;
  }
  const number = (n, digits = 0) => n == null || !Number.isFinite(Number(n)) ? '—' : Number(n).toLocaleString('zh-CN', {
    minimumFractionDigits: digits, maximumFractionDigits: digits,
  });
  const mean = xs => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
  const correlation = (rows, x, y) => {
    if (rows.length < 2) return null;
    const mx = mean(rows.map(r => r[x])), my = mean(rows.map(r => r[y]));
    const xx = rows.reduce((s, r) => s + (r[x] - mx) ** 2, 0);
    const yy = rows.reduce((s, r) => s + (r[y] - my) ** 2, 0);
    if (!xx || !yy) return null;
    return rows.reduce((s, r) => s + (r[x] - mx) * (r[y] - my), 0) / Math.sqrt(xx * yy);
  };
  const median = xs => {
    if (!xs.length) return null;
    const s = [...xs].sort((a, b) => a - b), i = Math.floor(s.length / 2);
    return s.length % 2 ? s[i] : (s[i - 1] + s[i]) / 2;
  };
  const valid = (rows, key) => rows.map(r => r[key]).filter(v => v !== null && v !== undefined && Number.isFinite(Number(v))).map(Number);
  let deliveryFilters = {period:'recent', day:'all', time:'all'};

  function sectionFinding(title) {
    const H = window.HEALTH_DATA || {}, daily = H.daily || [], ws = H.workouts || [];
    const routes = window.ROUTES_DATA || [];
    const D = window.DELIVERY_DATA || {}, model = window.DeliveryModel;
    const keyed = (s) => title.startsWith(s);
    const pct = (n, total) => total ? `${number(n / total * 100)}%` : '0%';
    const topBy = (items, key) => [...items].sort((a, b) => b[key] - a[key])[0];
    const week = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];

    if (keyed('时间画像') || keyed('出发热力图')) {
      if (!routes.length) return '当前筛选没有 GPS 出发记录。';
      const counts = Array.from({length: 168}, () => 0);
      const observed = routes.filter(r => Number.isInteger(r.weekday) && r.weekday >= 0 && r.weekday < 7
        && Number.isFinite(r.start_hour) && r.start_hour >= 0 && r.start_hour < 24);
      if (!observed.length) return `${routes.length} 条轨迹中没有完整有效的星期与出发小时，暂时无法判断高频时段。`;
      observed.forEach(r => { counts[r.weekday * 24 + Math.floor(r.start_hour)]++; });
      const i = counts.indexOf(Math.max(...counts));
      return `${routes.length} 条轨迹中有 ${observed.length} 条具备星期和小时；最常见出发格是${week[Math.floor(i / 24)]} ${String(i % 24).padStart(2, '0')}:00（${counts[i]} / ${observed.length} 条有效记录，占 ${pct(counts[i], observed.length)}）。`;
    }
    if (keyed('月度全景')) {
      const months = new Map();
      ws.forEach(w => { const key = String(w.date || '').slice(0, 7); if (key) months.set(key, (months.get(key) || 0) + (Number(w.distance_km) || 0)); });
      if (!months.size) return '当前筛选没有可汇总的骑行月份。';
      const [month, km] = [...months].sort((a, b) => b[1] - a[1])[0];
      return `记录量最高的月份是 ${month}（${number(km, 1)} km）；先核对该月是否为完整月份，再比较总量。`;
    }
    if (keyed('活动日历')) {
      const active = daily.filter(d => Number.isFinite(Number(d.distance_km)) && Number(d.distance_km) > 0.01);
      const maxDay = topBy(active, 'distance_km');
      if (!active.length) return '当前筛选没有带骑行距离的日记录。';
      return `${active.length} 个有骑行距离的日期合计 ${number(active.reduce((a, d) => a + Number(d.distance_km), 0), 1)} km；单日最高为 ${maxDay.date}（${number(maxDay.distance_km, 1)} km）。`;
    }
    if (keyed('健康指标')) {
      const hrs = valid(ws, 'hr_avg');
      if (!hrs.length) return '当前筛选没有有效的骑行平均心率记录。';
      return `${hrs.length} 次骑行的平均心率中位数为 ${number(median(hrs))} bpm；先用中位数描述常见记录，再查看个别高低值。`;
    }
    if (keyed('心率范围')) {
      const rows = ws.filter(w => Number.isFinite(w.hr_min) && Number.isFinite(w.hr_avg) && Number.isFinite(w.hr_max));
      if (!rows.length) return '当前筛选没有完整的最低、平均和最高心率记录。';
      return `${rows.length} 次骑行的平均心率中位数为 ${number(median(rows.map(w => w.hr_avg)))} bpm；单次平均跨度中位数为 ${number(median(rows.map(w => w.hr_max - w.hr_min)))} bpm。`;
    }
    if (keyed('气候画像')) {
      const rows = ws.filter(w => Number.isFinite(w.weather_temp_c) && Number.isFinite(w.hr_avg));
      if (rows.length < 3) return `仅有 ${rows.length} 组温度与心率配对记录，样本太少，不总结两者关系。`;
      const t = mean(rows.map(w => w.weather_temp_c)), h = mean(rows.map(w => w.hr_avg));
      const cov = mean(rows.map(w => (w.weather_temp_c - t) * (w.hr_avg - h)));
      const denom = Math.sqrt(mean(rows.map(w => (w.weather_temp_c - t) ** 2)) * mean(rows.map(w => (w.hr_avg - h) ** 2)));
      const r = denom ? cov / denom : null;
      return `有 ${rows.length} 组配对记录，平均温度 ${number(t, 1)}°C、平均心率 ${number(h)} bpm${r == null ? '；变量没有足够变化来计算相关' : `，温度与心率的线性相关 r=${number(r, 2)}`}。这是描述性关联，不说明因果。`;
    }
    if (keyed('身体适应')) {
      const deltas = H.summary?.body_deltas || {};
      const labels = [['resting_hr','静息心率','bpm'],['hrv','HRV','ms'],['sleep_h','睡眠','小时'],['resp_rate','呼吸','次/分']];
      const parts = labels.filter(([k]) => deltas[k]).map(([k,l,u]) => {
        const d = deltas[k]; return `${l} ${number(d.baseline, 1)}→${number(d.recent, 1)} ${u}（${d.baseline_n}/${d.recent_n} 天）`;
      });
      if (!parts.length) return '首尾 14 天都具备足够记录的指标不足；缩短筛选跨度时尤其容易出现这种情况。';
      return `起始 14 天到最近 14 天：${parts.slice(0, 2).join('；')}。只比较记录覆盖充分的指标。`;
    }
    if (keyed('日常脉搏')) {
      const riding = daily.filter(d => d.rides > 0 && Number.isFinite(d.steps)).map(d => d.steps);
      const other = daily.filter(d => !(d.rides > 0) && Number.isFinite(d.steps)).map(d => d.steps);
      if (!riding.length || !other.length) return '当前筛选缺少骑行日或非骑行日步数，无法形成两组对照。';
      return `骑行日步数中位数 ${number(median(riding))}，非骑行日 ${number(median(other))}（各 ${riding.length}/${other.length} 天）；这是两组记录对照，不代表骑行造成差异。`;
    }
    if (keyed('7 天滚动负荷')) {
      const points = window.ChartModel?.calendarLoad(daily) || [];
      if (!points.length) return '当前筛选没有日历记录，无法计算 7 天距离。';
      const peak = topBy(points, 'km'), last = points.at(-1);
      return `筛选记录内最高 7 天距离为 ${number(peak.km, 1)} km（截至 ${peak.date}）；末段截至 ${last.date} 为 ${number(last.km, 1)} km。`;
    }
    if (keyed('训练效率')) {
      const rows = ws.filter(w => Number.isFinite(w.hr_avg) && Number.isFinite(w.duration_min) && Number(w.distance_km) > 0 && Number(w.avg_speed_kmh) > 1)
        .sort((a,b) => a.date.localeCompare(b.date)).map(w => w.hr_avg * w.duration_min / w.distance_km);
      if (rows.length < 6) return `只有 ${rows.length} 次可计算的记录，暂不比较前后变化。`;
      const n = Math.max(3, Math.floor(rows.length * .2)), first = mean(rows.slice(0,n)), last = mean(rows.slice(-n));
      return `每公里心跳数前段均值 ${number(first)}、末段 ${number(last)}（各取约 20% 记录）；较低值只在路线与停顿相近时才可视为效率线索。`;
    }
    if (keyed('强度象限')) {
      const rows = ws.filter(w => w.hr_avg != null && w.avg_speed_kmh != null && w.distance_km > 0);
      if (!rows.length) return '当前筛选没有可用的心率与速度配对记录。';
      const hm = median(rows.map(w => w.hr_avg)), sm = median(rows.map(w => w.avg_speed_kmh));
      const q = { efficient: 0, hard: 0, easy: 0, costly: 0 };
      rows.forEach(w => {
        if (w.hr_avg <= hm && w.avg_speed_kmh > sm) q.efficient++;
        else if (w.hr_avg > hm && w.avg_speed_kmh > sm) q.hard++;
        else if (w.hr_avg <= hm) q.easy++;
        else q.costly++;
      });
      const labels = [['高效巡航',q.efficient],['硬拉训练',q.hard],['慢速散步',q.easy],['心率代价大',q.costly]];
      const [label, count] = labels.reduce((a,b)=>b[1]>a[1]?b:a);
      return `${rows.length} 次配对骑行；中位分界为 ${number(hm)} bpm / ${number(sm,1)} km/h。四象限：高效 ${q.efficient}、硬拉 ${q.hard}、慢速 ${q.easy}、心率代价大 ${q.costly} 次；最多的是“${label}”（${pct(count,rows.length)}）。这是本筛选内相对分组，不是训练等级。`;
    }
    if (keyed('爬升 × 配速')) {
      const rows = ws.filter(w => w.distance_km > 0.5 && w.avg_speed_kmh != null && w.elev_gain_m != null);
      if (!rows.length) return '当前筛选没有完整的爬升与平均速度配对记录。';
      const delivery = rows.filter(w => w.date >= '2026-04-01'), r = correlation(delivery,'elev_gain_m','avg_speed_kmh');
      return `${rows.length} 次完整记录；爬升中位数 ${number(median(rows.map(w => w.elev_gain_m)))} m、速度中位数 ${number(median(rows.map(w => w.avg_speed_kmh)),1)} km/h。图中送餐期（2026-04-01 起，${delivery.length} 次）趋势相关 r=${number(r,2)}${r == null ? '（样本或变量变化不足）' : ''}；相关不表示爬升造成速度变化。`;
    }
    if (keyed('代谢强度')) {
      const values = valid(ws, 'mets');
      if (!values.length) return '当前筛选没有 METS 估值。';
      const bands = [values.filter(v => v >= 2 && v < 3).length, values.filter(v => v >= 3 && v < 6).length,
        values.filter(v => v >= 6 && v < 9).length, values.filter(v => v >= 9).length];
      const labels = ['轻','中等','剧烈','极限'];
      const i = bands.indexOf(Math.max(...bands));
      const bucketed = bands.reduce((a,b)=>a+b,0);
      return `${values.length} 次有 METS 估值；图中四档（2–3、3–6、6–9、≥9）分别 ${bands.join(' / ')} 次，最多是“${labels[i]}”（${pct(bands[i],bucketed)}）；低于 2 的 ${values.length-bucketed} 次未进入分档。`;
    }
    if (keyed('骑行与日常活动')) {
      const measure = key => daily.filter(d => d[key] != null && Number.isFinite(Number(d[key])));
      const steps = measure('steps'), flights = measure('flights');
      if (!steps.length && !flights.length) return '当前筛选没有有效步数或爬楼记录。';
      const stat = (rows,key,label,unit) => rows.length ? `${label} ${rows.length} 天，均值 ${number(mean(rows.map(d=>Number(d[key]))),0)} ${unit}，最高 ${number(Math.max(...rows.map(d=>Number(d[key]))),0)} ${unit}` : `${label}无有效记录`;
      return `${stat(steps,'steps','步数','步')}；${stat(flights,'flights','爬楼','层')}。图中两项各自按日绘点并画滚动均值，没有按骑行日/非骑行日分组。`;
    }
    if (keyed('能量构成')) {
      const paired = ws.filter(w => Number.isFinite(w.active_kj) && Number.isFinite(w.basal_kj));
      if (!paired.length) return '当前筛选没有完整的主动与基础能量配对记录。';
      return `${paired.length} 次配对记录的主动能量中位数 ${number(median(paired.map(w=>w.active_kj)))} kJ、基础能量中位数 ${number(median(paired.map(w=>w.basal_kj)))} kJ；均为设备估算。`;
    }
    if (keyed('爬升画像')) {
      const rows = ws.filter(w => Number.isFinite(w.elev_gain_m));
      if (!rows.length) return '当前筛选没有爬升记录。';
      const top = topBy(rows, 'elev_gain_m');
      return `${rows.length} 次记录中最大单次爬升为 ${number(top.elev_gain_m)} m（${top.date}）；画廊只展示爬升靠前的路线。`;
    }
    if (keyed('爬升 vs 下降')) {
      const rows = ws.filter(w => Number.isFinite(w.elev_gain_m) && Number.isFinite(w.elev_loss_m));
      if (!rows.length) return '当前筛选没有成对的爬升与下降记录。';
      const up = mean(rows.map(w => w.elev_gain_m)), down = mean(rows.map(w => w.elev_loss_m));
      return `${rows.length} 次记录平均爬升 ${number(up)} m、下降 ${number(down)} m；短路线的 GPS 高程误差会放大两者差异。`;
    }
    if (keyed('HRV 复元') || keyed('静息心率') || keyed('呼吸节律') || keyed('睡眠时长')) {
      const key = keyed('HRV 复元') ? 'hrv' : keyed('静息心率') ? 'resting_hr' : keyed('呼吸节律') ? 'resp_rate' : 'sleep_h';
      const label = {hrv:'HRV',resting_hr:'静息心率',resp_rate:'呼吸频率',sleep_h:'睡眠'}[key];
      const values = daily.filter(d => Number.isFinite(d[key]) && d[key] > 0 && (key !== 'sleep_h' || d[key] < 14));
      if (!values.length) return `当前筛选没有有效的${label}记录。`;
      const base = `${values.length} 天有记录，中位数 ${number(median(values.map(d => d[key])), 1)}${key === 'hrv' ? ' ms' : key === 'resting_hr' ? ' bpm' : key === 'resp_rate' ? ' 次/分' : ' 小时'}`;
      if (key === 'sleep_h') {
        const rideDays = new Set(ws.map(w => w.date));
        const on = values.filter(d => rideDays.has(d.date)).map(d => d[key]), off = values.filter(d => !rideDays.has(d.date)).map(d => d[key]);
        return `${base}；骑行日/非骑行日均值 ${on.length ? number(mean(on),1) : '—'}/${off.length ? number(mean(off),1) : '—'} 小时（${on.length}/${off.length} 天）。`;
      }
      return `${base}；先比较连续数日和个人常态，不用单日波动下结论。`;
    }
    if (keyed('步行与静息心率差')) {
      const diffs = daily.filter(d => Number.isFinite(d.walking_hr) && Number.isFinite(d.resting_hr)).map(d => d.walking_hr - d.resting_hr);
      if (!diffs.length) return '当前筛选没有同日步行与静息心率配对记录。';
      return `${diffs.length} 天同日配对的心率差中位数为 ${number(median(diffs), 1)} bpm；先确认佩戴和活动情境相近。`;
    }
    if (keyed('晨间生理')) {
      const fields = ['hrv','resting_hr','resp_rate','sleep_h'];
      const counts = fields.map(k => daily.filter(d => Number.isFinite(d[k]) && d[k] > 0).length);
      return `HRV、静息心率、呼吸、睡眠有效天数分别为 ${counts.join(' / ')}；先以覆盖日期足够的指标为准，四条线单位不同。`;
    }
    if (keyed('全部骑行明细')) {
      const ds = valid(ws, 'distance_km');
      if (!ds.length) return '当前筛选没有骑行明细。';
      return `${ds.length} 次骑行，距离中位数 ${number(median(ds), 1)} km，最长 ${number(Math.max(...ds), 1)} km；中位数更接近常见单次记录。`;
    }
    if (keyed('最佳成绩')) {
      const distances = ws.filter(w => Number.isFinite(w.distance_km));
      const speeds = ws.filter(w => Number.isFinite(w.avg_speed_kmh));
      if (!distances.length && !speeds.length) return '当前筛选没有可比较的骑行成绩。';
      const longest = distances.sort((a,b)=>b.distance_km-a.distance_km)[0];
      const fastest = speeds.sort((a,b)=>b.avg_speed_kmh-a.avg_speed_kmh)[0];
      return `当前记录极值：${longest ? `最长 ${number(longest.distance_km,1)} km（${longest.date}）` : '无距离数据'}；${fastest ? `最快均速 ${number(fastest.avg_speed_kmh,1)} km/h（${fastest.date}）` : '无速度数据'}。需核对采样与路线后再横向比较。`;
    }
    if (keyed('城市分布')) {
      const cities = new Map();
      routes.forEach(r => { if (r.city) cities.set(r.city,(cities.get(r.city)||0)+1); });
      if (!cities.size) return '当前筛选没有带城市标签的 GPS 轨迹。';
      const [city,count] = [...cities].sort((a,b)=>b[1]-a[1])[0];
      return `${cities.size} 个有记录的城市、${routes.length} 条轨迹；记录最多为 ${city}（${count} 条）。跨城市比较前先看日期跨度与路线覆盖。`;
    }
    if (keyed('累计旅程')) {
      const ds = valid(ws, 'distance_km');
      if (!ds.length) return '当前筛选没有可累计的骑行距离。';
      const total = ds.reduce((a,b)=>a+b,0);
      return `筛选内 ${ds.length} 次骑行累计 ${number(total,1)} km，平均每次 ${number(total/ds.length,1)} km；累计值随筛选范围改变。`;
    }
    if (keyed('训练负荷与状态')) {
      const source = (window._origHealthWorkouts || ws).filter(w => Number.isFinite(w.active_kcal) && w.date);
      const citySource = typeof window.filterWorkoutsByCity === 'function' ? window.filterWorkoutsByCity(source) : source;
      if (!citySource.length) return '当前城市筛选没有活动能量记录，无法构建模型负荷曲线。';
      const loads = new Map(); citySource.forEach(w=>loads.set(w.date,(loads.get(w.date)||0)+w.active_kcal));
      const dates = [...loads.keys()].sort(), start = new Date(`${dates[0]}T00:00:00Z`), end = new Date(`${dates.at(-1)}T00:00:00Z`);
      start.setUTCDate(start.getUTCDate()-14); end.setUTCDate(end.getUTCDate()+7);
      const today = new Date(); today.setUTCHours(0,0,0,0); if (today < end) end.setTime(today.getTime());
      const range = window.getActiveRange?.(), from = range?.from?.toISOString().slice(0,10), to = range?.to?.toISOString().slice(0,10);
      let ctl = 0, atl = 0, last = null, cur = new Date(start);
      while (cur <= end) {
        const date = cur.toISOString().slice(0,10), load = (loads.get(date)||0)/10;
        ctl += (load-ctl)/42; atl += (load-atl)/7;
        if ((!from || date >= from) && (!to || date <= to)) last = {date,ctl,atl,tsb:ctl-atl};
        cur.setUTCDate(cur.getUTCDate()+1);
      }
      if (!last) return '当前日期筛选没有负荷曲线日期。';
      return `筛选末端 ${last.date}：长期指数约 ${number(last.ctl,1)}、短期约 ${number(last.atl,1)}、差值 ${number(last.tsb,1)}（kcal/10 近似，42/7 日平滑）。这是负荷模型读数，不是疲劳诊断。`;
    }
    if (keyed('热点地图')) {
      const stops = D.hotspots || [], kinds = ['pickup','dropoff'].map(kind => [kind, stops.filter(x => x.kind === kind).length]);
      if (!stops.length) return '当前数据没有可视化停留点。';
      return `${stops.length} 个候选停留点：${kinds[0][1]} 个取餐、${kinds[1][1]} 个送达；位置分类来自 GPS 规则推断，需抽样人工核对。`;
    }
    if (keyed('配送概览')) {
      const s = D.summary || {}, meta = D.meta || {};
      if (!meta.shifts) return '当前没有配送 GPS 班次汇总。';
      return `${meta.shifts} 个 GPS 班次、${number(s.hours,1)} 个记录小时、${number(s.orders)} 次推断送达（${meta.first} 至 ${meta.last}）；约 ${number(s.orders_per_hour,2)} 次/记录小时，不能当作平台在线时薪。`;
    }
    if (keyed('区域排行')) {
      const rows = model && D.planning ? model.aggregate(D, deliveryFilters).filter(z => z.enough) : [];
      if (!rows.length) return '当前配送筛选没有达到小时数、班次数和取餐数门槛的区域；扩大日期范围再比较。';
      const z = rows[0];
      return `当前筛选达标 ${rows.length} 个区域；取餐/记录小时最高为 ${z.label}（${number(z.rate,2)}，${z.pickups} 次 / ${number(z.hours,1)} 小时 / ${z.shifts} 班）。此频率不是派单概率或收益。`;
    }
    if (keyed('这一单该不该接')) {
      return '这是单笔报价计算器：填报价、去店/等餐/送达时间与回程成本后读净增量；留空时没有可靠的当前订单结论。';
    }
    if (keyed('什么时候去哪试跑') || keyed('什么时候去哪最赚')) {
      const slots = model && D.planning ? model.slots(D, {period:deliveryFilters.period}, {value:0,cost:0}) : [];
      const candidate = slots.find(x => !x.thin) || slots[0];
      if (!candidate) return '当前没有足够的区域×时段样本生成候选；先扩大日期范围。';
      return `模型试跑候选：${candidate.label} · ${candidate.weekend ? '周末' : '工作日'} ${candidate.daypartLabel}；约 ${number(candidate.rate,2)} 次推断取餐 / GPS 记录小时（${candidate.pickups} 次 / ${number(candidate.hours,1)} 小时 / ${candidate.shifts} 班）。这是个人历史活动频率，不是平台派单概率或收入。`;
    }
    if (keyed('接单区还是送达区')) {
      const s = D.summary || {}, c = D.chain || {};
      if (!s.orders) return '当前没有可比较的送达与接单区域记录。';
      const coverage = number(c.coverage_pct), dead = number(c.dead_share);
      return `历史推断的取餐集中区是 ${s.top_pickup_zone || '—'}，送达集中区是 ${s.top_drop_zone || '—'}；订单链路覆盖 ${coverage}${coverage === '—' ? '' : '%'}，已识别链条内续接里程占 ${dead}${dead === '—' ? '' : '%'}。需把回程成本计入区域选择。`;
    }
    if (keyed('时段规律')) {
      const rows = model && D.planning ? model.hourly(D, deliveryFilters).filter(x => x.enough) : [];
      if (!rows.length) return '当前时段筛选没有达到最低样本门槛的小时；灰格表示样本不足，不等于没有需求。';
      const h = rows.sort((a,b)=>b.rate-a.rate)[0];
      return `达标小时中最高为 ${String(h.hour).padStart(2,'0')}:00（${number(h.rate,2)} 次/记录小时，${h.pickups} 次 / ${number(h.hours,1)} 小时 / ${h.shifts} 班）；结论仅适用于当前历史筛选。`;
    }
    if (keyed('路段好坏')) {
      const eligible = (D.corridors || []).filter(c => c.passes >= 3), hard = [...eligible].sort((a,b)=>b.lost_per_pass-a.lost_per_pass)[0];
      if (!hard) return '当前没有可计算的反复慢行路段。';
      return `${eligible.length} 个至少重复通过 3 次的路段候选中，模型估计 ${hard.zone || '该区域'} 的慢行损失最高（约 ${number(hard.lost_per_pass,1)} 分钟/趟，${hard.passes} 次通过）；这是相对自由流基线的估算。`;
    }
    if (keyed('区域档案')) {
      const sort = window.__dlvProfSort || {key:'flow',dir:'desc'}, key = sort.key;
      const shown = (D.zones || []).filter(z => z.ranked).sort((a,b) => {
        if (a[key] == null || b[key] == null) return a[key] == null ? (b[key] == null ? 0 : 1) : -1;
        return (a[key] - b[key]) * (sort.dir === 'asc' ? 1 : -1);
      }).slice(0,18);
      const zones = shown.filter(z => Number.isFinite(z.prep_per_km2));
      if (!zones.length) return '当前展示区域中没有可比较的餐饮点密度。';
      const z = [...zones].sort((a,b)=>b.prep_per_km2-a.prep_per_km2)[0];
      return `当前表格显示 ${shown.length} 个达标区域，其中餐饮点密度最高为 ${z.label || z.name}（${number(z.prep_per_km2)} 家/km²）；排序方式会改变展示区域。这是地图资料特征，不代表订单量或收入。`;
    }
    if (keyed('这一脚是在干嘛')) {
      const examples = D.samples || {}, uncertain = D.meta?.uncertain || 0;
      return `样例包含 ${number((examples.quick_pickups || []).length)} 个候选取餐停留和 ${number((examples.long_lights || []).length)} 个长等灯停留；全量 ${number(uncertain)} 个样本标记不确定，分类应逐条对照地图与真实订单。`;
    }
    if (keyed('判得准不准')) {
      const v = D.validation;
      if (!v) return '目前没有可对照的真实订单日志；无法从 GPS 推断值计算准确率。';
      return `对照 ${number(v.in_window)} 笔真实订单：送达召回 ${number(v.recall_drop,1)}%、取餐召回 ${number(v.recall_pickup,1)}%、区域命中 ${number(v.zone_pct,1)}%；覆盖 ${number(v.coverage_pct,1)}%。这些准确率只适用于这批有日志的日期。`;
    }
    if (keyed('逐次骑行')) return '选中一趟记录后，先核对日期与路线，再沿同一趟的海拔、速度和心率读变化。';
    return '';
  }

  function resultForPage() {
    if (page === 'dashboard') return '按顺序使用：先选试跑区域，再核对眼前报价，最后记录送完后的落点。';
    if (page === 'delivery') {
      const data = window.DELIVERY_DATA;
      const model = window.DeliveryModel;
      if (!data || !model) return '配送数据尚未加载。';
      const slots = model.slots(data, { period: deliveryFilters.period }, { value: 0, cost: 0 });
      const candidate = slots.find(x => !x.thin) || slots[0];
      if (!candidate) return '现有记录不足以生成时段与区域候选。';
      return `试跑候选：${candidate.label} · ${candidate.weekend ? '周末' : '工作日'} ${candidate.daypartLabel}，约 ${number(candidate.rate,2)} 次推断取餐 / GPS 记录小时；样本为 ${number(candidate.shifts)} 个班次、${number(candidate.hours,1)} 小时、${number(candidate.pickups)} 次取餐。只是历史 GPS 活动频率，不是派单概率或收入。`;
    }
    return filtered(() => {
      const H = window.HEALTH_DATA || {};
      const routes = window.ROUTES_DATA || [];
      if (page === 'patterns') {
        if (!routes.length) return '当前筛选没有出发记录。';
        const hours = Array(24).fill(0), weekdays = Array(7).fill(0);
        const validHours = routes.filter(r => Number.isFinite(r.start_hour) && r.start_hour >= 0 && r.start_hour < 24);
        const validDays = routes.filter(r => Number.isInteger(r.weekday) && r.weekday >= 0 && r.weekday < 7);
        validHours.forEach(r => hours[Math.floor(r.start_hour)]++);
        validDays.forEach(r => weekdays[r.weekday]++);
        const bestHour = hours.indexOf(Math.max(...hours));
        const days = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
        const bestDay = weekdays.indexOf(Math.max(...weekdays));
        const hourText = validHours.length ? `${String(bestHour).padStart(2, '0')}:00 时段（${hours[bestHour]}/${validHours.length} 条有效时间）` : '没有有效出发时间';
        const dayText = validDays.length ? `${days[bestDay]}（${weekdays[bestDay]}/${validDays.length} 条有效星期）` : '没有有效星期';
        return `筛选内有 ${number(routes.length)} 条轨迹；出发最多的是 ${hourText}，星期最多的是 ${dayText}。这只是过去的出门记录。`;
      }
      if (page === 'body') {
        const values = (H.vo2max || []).filter(x => Number.isFinite(x.value)).sort((a, b) => a.date.localeCompare(b.date));
        if (values.length < 2) return `当前筛选有 ${values.length} 个 VO₂max 估值；至少需要两个时间点才能比较趋势。`;
        const first = values[0], last = values[values.length - 1];
        const delta = last.value - first.value;
        return `筛选内有 ${number(values.length)} 个 VO₂max 估值：${number(first.value, 1)} → ${number(last.value, 1)}（${delta > 0 ? '+' : ''}${number(delta, 1)}）。这是设备估值的首尾差，先对照心率与活动记录。`;
      }
      if (page === 'training') {
        const workouts = H.workouts || [];
        if (!workouts.length) return '当前筛选没有可比较的训练记录。';
        const km = workouts.reduce((sum, w) => sum + (Number(w.distance_km) || 0), 0);
        return `筛选内 ${number(workouts.length)} 次记录、合计 ${number(km, 1)} km。先读负荷曲线的持续变化，再点进明显峰值对应的骑行核对。`;
      }
      if (page === 'rides') {
        const workouts = H.workouts || [];
        const distances = workouts.map(w => Number(w.distance_km)).filter(Number.isFinite).sort((a, b) => a - b);
        if (!distances.length) return '当前筛选没有可比较的骑行距离。';
        const middle = Math.floor(distances.length / 2);
        const median = (distances[(distances.length - 1) >> 1] + distances[middle]) / 2;
        return `筛选内 ${number(distances.length)} 次骑行，距离中位数 ${number(median, 1)} km；用中位数看典型一趟，再把极值当作个例检查。`;
      }
      if (page === 'recovery') {
        const values = (H.daily || []).filter(d => Number.isFinite(d.hrv) && d.hrv > 0).sort((a, b) => a.date.localeCompare(b.date));
        if (!values.length) return '当前筛选没有有效 HRV 记录；可以改看静息心率、呼吸或睡眠的连续记录。';
        const sorted = values.map(x => x.hrv).sort((a, b) => a - b);
        const middle = Math.floor(sorted.length / 2);
        const median = (sorted[(sorted.length - 1) >> 1] + sorted[middle]) / 2;
        return `筛选内有 ${number(values.length)} 天有效 HRV，个人中位数 ${number(median, 1)} ms；先看连续偏离，再对照睡眠和静息心率。`;
      }
      if (page === 'overview') return `当前视图包含 ${number(routes.length)} 条 GPS 轨迹；要回答具体问题，请进入“节律、训练、复元”或“配送分析”。`;
      if (page === 'explorer') return '逐次页不做跨活动汇总；选择一趟记录后，按路线、爬升、速度和心率核对这次活动。';
      return `${number(routes.length)} 条 GPS 轨迹、${number((H.workouts || []).length)} 次健康记录。全景只用于定位专题，不适合直接比较不同口径的指标。`;
    });
  }

  function makeGuide() {
    const guide = document.createElement('aside');
    guide.className = 'analysis-guide';
    guide.setAttribute('aria-label', '本页分析结论与读图顺序');
    const top = document.createElement('div'); top.className = 'analysis-guide-top';
    const eyebrow = document.createElement('span'); eyebrow.className = 'analysis-guide-eyebrow'; eyebrow.textContent = '本页怎么读 · ' + pageCopy[0];
    const result = document.createElement('p'); result.className = 'analysis-guide-result'; result.setAttribute('aria-live', 'polite');
    top.append(eyebrow, result);
    const cols = document.createElement('div'); cols.className = 'analysis-guide-cols';
    const blocks = [
      ['阅读顺序', pageCopy[1]],
      ['能得出的结论', pageCopy[2]],
      ['结论边界', pageCopy[3]],
    ];
    blocks.forEach(([label, value]) => {
      const block = document.createElement('div'); block.className = 'analysis-guide-block';
      const title = document.createElement('b'); title.textContent = label;
      const text = document.createElement('span'); text.textContent = value;
      block.append(title, text); cols.append(block);
    });
    guide.append(top, cols);
    const main = $('main');
    if (!main) return null;
    if (page === 'dashboard') {
      const intro = $('.dash-intro');
      if (intro) intro.after(guide);
      result.textContent = '按顺序使用：先选试跑区域，再核对眼前报价，最后记录送完后的落点。';
    } else {
      const nav = $('.section-index');
      if (nav) nav.after(guide);
      else main.before(guide);
      const first = main.querySelector(':scope > section.analysis-section .section-title');
      const second = main.querySelectorAll(':scope > section.analysis-section .section-title')[1];
      if (first && second) {
        const order = blocks[0][1];
        blocks[0][1] = `${order}：${first.textContent.trim()} → ${second.textContent.trim()}。`;
        cols.querySelector('.analysis-guide-block span').textContent = blocks[0][1];
      }
    }
    const readings = [];
    main.querySelectorAll(':scope > section.analysis-section').forEach(section => {
      if (section.querySelector('.section-reading')) return;
      const heading = section.querySelector('.section-title');
      const subtitle = section.querySelector('.section-sub');
      if (!heading || !subtitle) return;
      const title = heading.textContent.replace(/\s+/g, ' ').trim();
      const note = SECTION_COPY.find(([prefix]) => title.startsWith(prefix));
      if (!note) return;
      const reading = document.createElement('p');
      reading.className = 'section-reading';
      const finding = document.createElement('span');
      finding.className = 'section-reading-finding';
      finding.setAttribute('aria-live', 'polite');
      const label = document.createElement('b');
      label.textContent = '当前筛选';
      const value = document.createElement('span');
      finding.append(label, value);
      const interpretation = document.createElement('span');
      interpretation.className = 'section-reading-note';
      interpretation.textContent = note[1];
      reading.append(finding, interpretation);
      subtitle.after(reading);
      readings.push({ title, value, note: note[1] });
    });
    return { result, readings };
  }

  function boot() {
    const guide = makeGuide();
    if (!guide) return;
    const refresh = () => {
      guide.result.textContent = resultForPage();
      const findings = filtered(() => guide.readings.map(({title, note}) => ({
        value: sectionFinding(title), note,
      })));
      guide.readings.forEach((reading, i) => {
        const {value, note} = findings[i];
        reading.value.textContent = value || note;
        reading.value.parentElement.hidden = !value;
      });
    };
    window.addEventListener('delivery-filter-change', ev => {
      deliveryFilters = {...deliveryFilters, ...(ev.detail || {})};
      refresh();
    });
    refresh();
    if (typeof window.__rerunRanged === 'function') {
      const rerun = window.__rerunRanged;
      window.__rerunRanged = function (...args) {
        const value = rerun.apply(this, args);
        refresh();
        return value;
      };
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
})();
