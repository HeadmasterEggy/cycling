# Cycling Atlas

一个把 Apple Health 骑行数据做成可视化站点的静态项目 —— 22 个月、66 条 GPS 轨迹、4 座城市。
纯静态,无框架、无打包器:HTML + 一份 CSS + 几个 JS 数据/渲染文件。

## 页面

| 文件 | `data-page` | 内容 |
|---|---|---|
| `index.html` | `overview` | 轨迹地图、个人最佳、城市分布、累计旅程 |
| `patterns.html` | `patterns` | 时段时钟、月度全景、出发热力图、活动日历 |
| `body.html` | `body` | 心率区间、气候画像、VO₂max、体重、日常脉搏 |
| `training.html` | `training` | 滚动负荷、Fitness/Form、训练效率、强度象限 |
| `rides.html` | `rides` | 能量构成、海拔画廊、爬升/下降、骑行明细表 |
| `delivery.html` | `delivery` | 配送效率:停留分类(取餐/送达/等灯)、区域排行、可交互热点地图、路段好坏、时段规律、区域档案 |
| `explorer.html` | `explorer` | 单次骑行逐条放大 |
| `recovery.html` | `recovery` | HRV、静息心率、呼吸、血氧、睡眠 |
| `cycling-analysis.html` | `all` | 所有章节合并的单页全景视图 |

## 目录结构

```
assets/
  styles.css        共享样式
  app.js            渲染逻辑(图表、地图、导航、页脚)
  recovery.js       恢复类图表
  delivery.js       配送页图表(停留判定、区域、地图、路段、时段、档案)
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

### 配送分析

`analyze_delivery.py` 回答一个别的页面回答不了的问题:**哪儿的活值得干**。
它读 GPX,再配上 `fetch_osm.py` 缓存下来的地图底料。

```bash
python3 fetch_osm.py          # 抓一次红绿灯 / 餐饮店 / 路网,写进 osm_context.json
python3 analyze_delivery.py
python3 analyze_delivery.py --dry-run
```

导出里没有订单,只有 1 Hz 的位置、速度、航向和海拔,所以一切都是推断出来的:

- **停留(dwell)** —— 速度低于 0.7 m/s 的连续段,再把中间那段「短、近、慢」的移动合并进来。
  送一单是停车 → 走到门口 → 等 → 走回来,朴素的停车检测会把这一单切成三段;按时长记数
  就变成了三单。合并之后,停留的**活动范围**本身成了有用的信号 —— 等红灯是没有范围的。
- **停留分类** —— 每次停留判成 `取餐 / 送达 / 等灯`,靠的是几条人也会用的证据加权:
  停了多久、离最近的红绿灯多远、活动范围多大、进出方向夹角(等灯是直着穿过去,送完餐常是
  原路折返)、门口 20 米内有没有餐饮店、这个点跨班次来过几次。权重不是拟合出来的 ——
  没有标注可拟合 —— 而是照着数据的形状定的:离红绿灯 12 米内的停留中位 45 秒、范围 2 米,
  80 米外的中位 87 秒、范围 7 米,两拨分得足够开,权重再动几个点也翻不了案。
  每条证据都随结果输出,页面上直接把它们摆出来。
- **旧规则错在哪** —— 「停够 90 秒算一单」两头都会错。一个六车道路口 98 秒的红灯不是单;
  一家去过 14 次的店门口 81 秒的停留是。这两类样本页面上各列了 8 个。
- **单** —— 一单 = 一次**送达**。取餐单独计数;把两者相加会把每一单算两遍,旧版本正是如此。
  取餐和送达是用两条互不相关的证据判的,谁也不知道对方存在,结果落在 215 : 197(比值 1.09)——
  每单本该一取一送,这个比值是个说得过去的旁证(规则换一换会在 0.8–1.4 间晃),不是证明。
- **区** —— 点落在哪个 ABS 2016 suburb 多边形里。用的是点在多边形,不是就近取中心点 ——
  内西区的 suburb 互相咬合得厉害,取中心点会把停留判到隔壁区去。
  CBD 那个 suburb 官方就叫 `Sydney`,在图表里看着像整座城市,所以显示名改成 `Sydney CBD`;
  查找、多边形和 OSM 关联仍然用官方名。
- **好跑指数** —— 0–100,由通行速度(34%)、红灯耗时(28%)、爬升(20%)、走走停停(18%)
  加权而成。两处和旧版不同:每项的归一化用的是数据自身按里程加权的 10/90 分位数,不再是手挑的
  边界(旧的 8–22 km/h、0–26 m/km 是拍的,超出还会悄悄截断),分位数会写进输出让页面印出来;
  每项还会按里程向全城水平**收缩**,`PRIOR_KM` 公里的曝光量等于自身和全城各占一半。
  跑了 400 米的区照样有中位速度,但那是一个晚上一条街的中位速度。
- **值得去** —— 单位是「活/小时」,不再是对最好那个区取比值的 0–100 分。
  = 收缩后的活/小时 × (本区好跑 / 全城好跑中位)。样本不够的区不给分,也不参与排名
  (门槛:`RANK_MIN_KM` 公里 + `RANK_MIN_SHIFTS` 个班次)。
- **路段** —— 常骑的 60 米格子连成链。单个格子不成路,一串才是。「最难走」按每趟多花的
  时间排序,不是累计 —— 否则排出来的只是最长最常走的那几条。

每次出勤自己起点/终点 150 米内的停留会被剔除 —— 那是家不是客户,而站点是公开的。
早先的做法是把所有班次的起终点聚类、把最密的那团当作家,但起点是散的(GPS 常在半个街区外
才锁上,也不是每次都从同一个门出发),阈值永远够不着,等于什么都没排除。改成每个停留只和
它自己那趟的起终点比,不需要阈值,也不会把一个真的很忙的区误判成谁家客厅。

`suburbs_sydney.json` 是从 [michalsn/australian-suburbs](https://github.com/michalsn/australian-suburbs)(MIT,
数据源为 ABS 2016 Census)裁出悉尼一带、再用 30 米容差简化后的边界。
`osm_context.json` 由 `fetch_osm.py` 生成:OpenStreetMap(ODbL)的红绿灯、餐饮店、
主干道中心线,以及每个区的餐厅数、红绿灯数、路网长度和面积;人口密度取自 Wikipedia/Wikidata
的 ABS 普查数字 —— 它用的是同一套 suburb 边界(Haymarket 两边都是 0.52 km²),
所以密度和这里的几何是对得上的,不是把两种「区」的定义混在一起。

> 单量是从轨迹反推的,不是平台真实单数。它能比较区与区的相对高低,不能当账单看。

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

需联网加载 Leaflet(unpkg)、Google Fonts 与 CARTO 底图瓦片;
离线时页面仍可渲染,只是地图与字体降级。

## 部署

静态站点,无构建步骤 —— 页面是已生成好的 HTML,数据内联在 `assets/*.js` 里,
运行时不发任何请求取数据。

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
