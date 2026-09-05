# Cycling Atlas

一个把 Apple Health 骑行数据做成可视化站点的静态项目，包含骑行、恢复与悉尼配送分析。
纯静态，无框架、无打包器：HTML、CSS 和 JS 数据/渲染文件。

## 页面

| 文件 | `data-page` | 内容 |
|---|---|---|
| `index.html` | `overview` | 轨迹地图、个人最佳、城市分布、累计旅程 |
| `patterns.html` | `patterns` | 时段时钟、月度全景、出发热力图、活动日历 |
| `body.html` | `body` | 心率区间、气候画像、VO₂max、体重、日常脉搏 |
| `training.html` | `training` | 滚动负荷、Fitness/Form、训练效率、强度象限 |
| `rides.html` | `rides` | 能量构成、海拔画廊、爬升/下降、骑行明细表 |
| `delivery.html` | `delivery` | 配送分析：区域与时段筛选、整轮接单估算、Quest 情景、三周收入核对、历史地图与数据口径 |
| `dashboard.html` | `dashboard` | 配送作战台：手机/桌面自适应，区域候选、地图、落点续接、接单估算与收入账本联动 |
| `explorer.html` | `explorer` | 单次骑行逐条放大 |
| `recovery.html` | `recovery` | HRV、静息心率、呼吸、血氧、睡眠 |
| `cycling-analysis.html` | `all` | 所有章节合并的单页全景视图 |

## 目录结构

```
assets/
  styles.css        共享样式
  site-ui.css/js    整站导航、手机布局、章节索引与图表放大
  chart-model.js    日历窗口、过滤汇总、缺测断线与图表读数
  app.js            渲染逻辑(图表、地图、导航、页脚)
  recovery.js       恢复类图表
  delivery.js       配送页图表(停留判定、区域、地图、路段、时段、档案)
  delivery-charts.css 配送图表、地图控件与可操作热力图
  delivery-model.js 配送筛选、整轮贡献、Quest 与周期核对计算
  delivery-planner.css/js 区域对照、报价暂存与延误情景
  routes.js         window.ROUTES_DATA —— 逐条 GPS 轨迹(含简化后的折线)
  health-data.js    window.HEALTH_DATA —— Apple Health 派生数据
  delivery-data.js  window.DELIVERY_DATA —— 配送分析派生数据
  favicon.svg
build_pages.py      由 cycling-analysis.html 生成全部页面
parse_health.py     由 Apple Health 导出生成 health-data.js / health_data.json / routes.js
analyze_delivery.py 由 GPX 轨迹 + osm_context.json 生成 delivery-data.js / delivery_data.json
fetch_osm.py        抓 OpenStreetMap 与人口数据,缓存成 osm_context.json
suburbs_sydney.json 悉尼 suburb 边界(点在多边形判定用),ABS 2016 SSC
health_data.json    与 health-data.js 同内容的可移植 JSON 导出
delivery_data.json  与 delivery-data.js 同内容的可移植 JSON 导出
```

## 数据流

```
apple_health_export/export.xml + workout-routes/*.gpx
        │  parse_health.py
        ▼
health_data.json  +  assets/health-data.js   (window.HEALTH_DATA
                  |                           含 stays / summary.cities)
                  +  assets/routes.js        (window.ROUTES_DATA)

Overpass API + Wikipedia/Wikidata
        │  fetch_osm.py
        ▼
osm_context.json  (红绿灯 / 餐饮店 / 主干道 / 每区结构指标)
        │
apple_health_export/workout-routes/*.gpx + suburbs_sydney.json + osm_context.json
        │  analyze_delivery.py
        ▼
delivery_data.json + assets/delivery-data.js (window.DELIVERY_DATA)
        │
        ▼
   页面在浏览器端渲染
```

### 更新健康数据

从 iPhone「健康」App 导出(个人资料 → 导出所有健康数据),解压后:

```bash
python3 parse_health.py --export-dir ~/Downloads/apple_health_export
```

默认读取 `./data/apple_health_export`(该目录已 gitignore,原始导出有几百 MB),
同时写出 `health_data.json` 和 `assets/health-data.js`。

同一条命令也会由 `workout-routes/*.gpx` 重建 `assets/routes.js`(地图轨迹)。
只有 GPX 变化时可以跳过 `export.xml`:

```bash
python3 parse_health.py --routes-only
```

轨迹折线用 Douglas-Peucker 简化,默认容差 12 米(`--rdp-epsilon` 可调),
保证每个原始点到简化折线的偏离不超过该值。城市由坐标落在 `CITY_BOXES`
的哪个框内判定;落在所有框之外的轨迹标为 `Unknown` 并在运行结束时列出,
不会被硬塞进最近的城市。

> 注:`assets/routes.js` 原先由一个已不在仓库中的脚本产出。现在的生成器是
> 按那份输出的字段反推重写的,所以覆盖之前请先跑一次比对 —— 它只读不写,
> 会逐字段报告能否复现:
>
> ```bash
> python3 parse_health.py --check-routes
> ```
>
> 折线本身(`track` / `num_simplified`)预期会变,因为原简化算法已无从考证。

### 城市筛选与停留区间

记录横跨四个城市、两年多,中间大段空白 —— 2024-2025 在国内,2026 年 2 月起在悉尼,
中间还回过两次国。把这些摊在同一条时间轴上,任何一张图都在展示一段跟当下无关的历史。

每个页面顶部因此有一排城市筹码(配送页除外 —— 那一页本来就只有悉尼)。选中一个城市:

- **轨迹与骑行**自带城市标签,直接按标签筛。
- **身体数据**(HRV、静息心率、睡眠、体重、步数)没有地点标签,按 `stays` 筛 ——
  `parse_health.py` 把所有 GPS 轨迹的时间线切成「停留区间」,每段从首条轨迹到末条轨迹,
  再向两侧各外扩最多 `STAY_FILL_DAYS`(30)天。相邻两段之间的空档从中点切开,谁也不
  越界;空档超过两倍上限时中间那块就没人认领 —— 那是诚实的答案,不是猜。
- **时间轴自动收窄**到该城市的范围。选悉尼,横轴就只剩 2026-01 → 2026-08,前面两年
  不入镜。时间范围筛选器仍然可用,两者取交集。
- 选择存在 localStorage,跨页跨刷新保留;总览页地图那排 tab 与筹码是同一个选择。

当前数据切出 9 段停留,覆盖 94% 的有记录天数。页面上会写明身体数据的归属是推断的。

> 城市判定用的是 `CITY_BOXES` 里的经纬度方框。去了新地方就往里加一个,
> 否则轨迹会落进 `Unknown`,只出现在「全部」里。

### 配送分析与作战台

`analyze_delivery.py` 读取 Apple Health GPX、缓存的 OpenStreetMap 地图资料和可选的
Uber 活动日志，生成 `delivery_data.json` 与 `assets/delivery-data.js`。

```bash
python3 fetch_osm.py          # 需要更新地图资料时运行
python3 analyze_delivery.py
python3 build_pages.py
```

区域数据来自 GPS 推断，包含跨平台活动；Uber 收入属于单个平台，二者不能直接相除
得到真实在线时薪。当前记录截至 2026-08-30，作战台明确显示记录范围。

- **停车识别**：低于 0.7 m/s 的连续段合并短距离慢速移动，再用停车时长、红绿灯距离、
  餐饮店距离、活动范围、进出方向及重复到访等证据判断取餐、送达或等灯。
  这些是推断事件，拼单也不一定一取一送。起终点 150 米内的停留被剔除。
- **区域边界**：按 ABS 2016 suburb 多边形归属；`Sydney` 显示为 `Sydney CBD`。
- **取餐频率**：推断取餐次数 ÷ 区内 GPS 记录小时。分母保留没有取餐的时段，
  不加送达次数、不乘骑行分数。至少 1 小时、4 个班次、6 次取餐才显示排名。
  这是个人历史参考，不是实时需求、平台派单概率或利润。
- **日期与时段**：`planning.cells` 按班次、区域、悉尼日期和小时汇总时间与事件。
  跨小时的采样区间拆开，筛选后重新计算分母和样本门槛。最近 28 天以最新记录日为终点，
  午餐 11–14、晚餐 17–20、晚间 20–23 可分别比较，工作日与周末可切换。
  时段热力图使用统一色阶；样本不足留空，不能把留空解释为没有订单。
- **好跑指数**：自由通行耗时 ÷ 实际通行耗时，参考速度 25 km/h。
  里程、时间和按班次 bootstrap 使用同一批通行采样，排除取餐与交付停留。
  600 次重采样给出 90% 区间；宽度超过 12 分不排名。区间只反映通行观测的不确定性，
  不涵盖 GPS 分类偏差，也不代表取餐频率的置信区间。
- **落点续接**：送达停留结束到下一次取餐停留开始，最多配对 45 分钟的相邻片段。
  包含等单和已接单去店，无法确定付费状态。约 41% 是匹配链条内部的续接里程占比，
  链条只覆盖全部记录里程的 36.3%，不能写成全部里程的无偿空驶占比。
  向取餐重心移动是几何方向，不说明骑手被迫返回或周边没有需求。
- **地图联动**：区域列表、地图取餐频率、区域散点横轴和时段图共用日期/星期/餐段筛选。
  通行指数与续接统计仍为全期；地图点位也是全期记录，小时滑块只筛点位与取送事件。
  每个指标旁注明口径，避免把筛选期频率和全期观测混读。
- **区域对照**：搜索、按频率/时长/停留排序，最多选择 3 区比较。同一组筛选下展示
  取餐次数、记录小时、班次和停留样本；逐小时对照使用统一色阶，重新检查每格样本门槛。

### 接单估算与 Quest

`assets/delivery-model.js` 提供可单独测试的计算；`assets/delivery-planner.js` 在配送页、
全景页和作战台共用同一组控件。手机优先显示接单计算器，桌面并列显示区域、地图与报价。

```
整轮分钟 = 去店 + 等餐 + 送餐 + 进楼交付 + 送完无单等待/转场
税前贡献/小时 = (报价 + 奖励增量 - 增量成本) × 60 / 整轮分钟
所需报价 = max(0, 目标时薪 × 整轮分钟 / 60 + 成本 - 奖励增量)
```

拼单使用整趟报价和不重叠的时间；转场不含下一单接单后的去店时间，避免双算。
额外延误同时增加总时间并检查是否错过奖励截止。历史落点时间仅供参考，不自动填入
无单转场。默认数字是演示输入，刷新后恢复，防止旧派单或过期 Quest 默默影响下一次判断。
可查看时间构成，点选额外延误 5/10/15 分钟比较贡献变化；最多暂存 3 份报价，
保留当时的时间与奖励假设供载入比较。暂存只在当前页面有效，刷新即清空。

奖励默认不计，另外支持两种明确输入的情景：

- 确认每次额外奖励：只填写报价之外的奖励，乘本趟实际符合条件次数。
- 冲单门槛：未获得的本档奖励 ×（接这单后达标概率 − 跳过后达标概率）。
  概率由骑手估计，本趟按时完成即可达标时取 100%；赶不上截止取 0%，已完成的门槛增量为 0。
  接一趟慢单也可能降低达标机会，所以增量允许为负。多档奖励分别分析。

历史 Quest 不平摊成未来每单奖励。账单中 Fare、Quest、Other、Tip 分开：

| 结算周 | 运费 | Quest | 其他调整 | 小费 | 账单合计 |
|---|---:|---:|---:|---:|---:|
| 2026-08-17 | 364.95 | 507.00 | 12.47 | 0.70 | 885.12 |
| 2026-08-24 | 517.66 | 715.00 | 27.00 | 8.65 | 1268.31 |

以上为 2026-09-05 在 Uber 网页账单核对的 A$ 金额。核对周以账单为准，同时保留日志值：
两周日志运费分别为 368.12、520.72；Quest 均一致，其他调整也可能不同。
差异原因未确认，不自动归因于跨周或最低收入补差。
日志按同周、同金额、十分钟窗口一对一排除疑似重复 Quest/MISC；负调整保留，
大额调整另列，金额大小本身不证明付款性质。未核对周的小费和到账合计显示未知。

### 三周最低收入核对

按 Uber 官方规则，自 2026-08-17 起至 2026-12-31，自行车/电助力为 A$31.30/h，
摩托车 A$31.50/h，汽车（载重不超过 1 吨）A$32.00/h，按每 21 天周期的有效接单时间核对。
首个周期为悉尼时间 8 月 17 日 04:00 至 9 月 7 日 04:00。
运费与促销参与比较，小费、报销和临时调整不参与。

独立计算器让用户填平台确认的同周期有效小时、运费和促销：
`max(0, 有效小时 × 标准 - 运费 - 促销)`。重叠订单时间只计一次。
GPS 和当前活动导出没有接单时刻，因此不再用上一单送达时间猜有效工时，
不把单笔订单套成保底收入，也不把保底加在 Quest 之上。

规则与有效期在页面可查：
[Uber 收入保障](https://help.uber.com/en-AU/driving-and-delivering/article/how-the-earnings-guarantee-works?nodeId=e04e6771-1b43-4ecc-8635-75334369f67a)、
[有效接单时间](https://help.uber.com/en-AU/driving-and-delivering/article/understanding-engaged-time?nodeId=df2a6923-00a1-4fbc-acea-4ee0606d2fb5)。

### 图表交互与计算口径

各页提供手机页面选择器、章节索引和图表放大窗口。图表支持点选读数，方向键浏览，
放大后保留原图交互；宽表格和热力图可横向滚动。

城市与日期筛选后从选中的骑行重新汇总月度和总量，包括不完整月份；没有交集时清除旧图。
7 天均值按日历计算而非取最近 7 条记录；缺测日断线，真实的零值保留。
恢复对照使用不重叠的首尾 14 天，并显示样本量；不足 28 天时不显示前后差值。
HRV 阴影表示个人筛选期中间 50% 的分布，不能当成通用健康区间。
训练长短期负荷基于活动热量代理值，并保留筛选前历史；不直接解释为疲劳或体能。

### 校验与数据边界

Uber 活动记录按时间戳 + 时长与推断送达对齐，只计算录制窗口内的召回率。
未匹配的 GPS 事件可能来自其他平台，也可能是误判；没有全平台真值，无法计算准确率。
小的匹配时间偏差只描述匹配样本，不证明整个分类器准确。

`data/uber/uber_activity.psv` 的格式是
`时间戳|类型|金额|时长秒|距离km|取餐点|送达地址`，属于本地输入，`data/` 已被 Git 忽略。
不会将原始账单、账户信息或客户地址写进公开代码；新增的 `planning.cells` 仅有区域级汇总，
不含精确坐标或地址。既有公开地图仍包含简化骑行轨迹与推断停留点。

```bash
node --test tests/*.test.js
python3 -m unittest discover -s tests -p 'test_*.py'
python3 build_pages.py
```

测试覆盖整轮成本、延误跨过奖励截止、拼单计数、门槛已完成、负奖励机会成本、
周期促销抵扣、输入错误、筛选分母、零事件时间、跨小时/跨日期切分、账单拆分及负调整；
也检查日历窗口、缺测断线、部分月份汇总、空态、资源完整性与页面生成的一致性。

`suburbs_sydney.json` 来自 [Australian Suburbs](https://github.com/michalsn/australian-suburbs)，
`osm_context.json` 由 OpenStreetMap 数据生成；详见缓存文件中的来源信息。

### 底图

`index.html` / `delivery.html` / `cycling-analysis.html` / `dashboard.html` 四张地图用的都是
Esri Dark Gray Canvas。原来用的 CARTO dark basemap **现在对所有匿名调用打水印** ——
瓦片仍然返回 HTTP 200、大小也正常,所以看起来像限流,直到你真的把那张 PNG 打开看一眼,
中间横着 "API KEY REQUIRED"。

Esri 免 key,但 z16 以上没有数据,会返回一张浅灰色的 "Map data not yet available" 占位图。
所以设了 `maxNativeZoom: 16` —— 请求停在 z16,更高的缩放由 Leaflet 放大 z16 的瓦片,
比原生细节软一些,但好过钻进一个 suburb 时看到一张空卡片。

Esri 的底图比站点暗色调亮两档,会和琥珀/青色的叠加层抢注意力,所以用 CSS 滤镜
(`.dlv-tiles-base`)把它压回去,标签层反向提亮。

### 重新生成页面

`cycling-analysis.html` 是各 `<section>` 区块的源头。改完区块或资源后:

```bash
python3 build_pages.py
```

脚本按标题标记切片,重新拼装全部 9 个页面。该操作幂等 —— 连跑两次输出字节一致。
每个页面只引它用得到的资源:`delivery-data.js` / `delivery.js` 只出现在配送页和全景页,
Leaflet 只出现在有地图的页面。

## 本地预览

```bash
npx http-server -p 8099 -c-1
# 打开 http://127.0.0.1:8099/index.html
```

需联网加载 Leaflet(unpkg)、Google Fonts 与 Esri 底图瓦片;
离线时页面仍可渲染,只是地图与字体降级。

## 部署

静态站点,无构建步骤 —— 页面是已生成好的 HTML,数据内联在 `assets/*.js` 里,
运行时通过静态脚本加载数据，无后台接口。生成页面时按文件内容为资源 URL 加版本号，
避免浏览器混用旧脚本和新版页面。

`vercel.json` 把这一点写死:`framework`、`buildCommand`、`installCommand` 全为
null,`outputDirectory` 为 `.`。这几项优先级高于面板设置,所以在面板导入仓库后
**不需要**手动配 Build & Output —— 反过来说,如果面板里的设置指向了仓库里不存在
的目录,部署会在一秒内直接 Error,这份配置正是用来盖掉它的。

同一份文件还配了 `cleanUrls`(`/rides` 与 `/rides.html` 等价)、`assets/*` 的
重新校验缓存(资源名没带指纹,不能用 immutable),以及 nosniff 与 referrer-policy
两个响应头。`.vercelignore` 排除 ETL 脚本与重复的 JSON 导出。

推到 GitHub 后 Vercel 自动部署;手动部署用:

```bash
vercel --prod
```
