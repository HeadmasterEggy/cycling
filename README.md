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
| `delivery.html` | `delivery` | 配送效率:区域单量排行、停车热点、路段好坏、时段规律 |
| `explorer.html` | `explorer` | 单次骑行逐条放大 |
| `recovery.html` | `recovery` | HRV、静息心率、呼吸、血氧、睡眠 |
| `cycling-analysis.html` | `all` | 所有章节合并的单页全景视图 |

## 目录结构

```
assets/
  styles.css        共享样式
  app.js            渲染逻辑(图表、地图、导航、页脚)
  recovery.js       恢复类图表
  delivery.js       配送页图表(区域、地图、路段、时段)
  routes.js         window.ROUTES_DATA —— 逐条 GPS 轨迹(含简化后的折线)
  health-data.js    window.HEALTH_DATA —— Apple Health 派生数据
  delivery-data.js  window.DELIVERY_DATA —— 配送分析派生数据
  favicon.svg
build_pages.py      由 cycling-analysis.html 生成全部页面
parse_health.py     由 Apple Health 导出生成 health-data.js / health_data.json / routes.js
analyze_delivery.py 由 GPX 轨迹生成 delivery-data.js / delivery_data.json
suburbs_sydney.json 悉尼 suburb 边界(点在多边形判定用),ABS 2016 SSC
health_data.json    与 health-data.js 同内容的可移植 JSON 导出
delivery_data.json  与 delivery-data.js 同内容的可移植 JSON 导出
```

## 数据流

```
apple_health_export/export.xml + workout-routes/*.gpx
        │  parse_health.py
        ▼
health_data.json  +  assets/health-data.js   (window.HEALTH_DATA)
                  +  assets/routes.js        (window.ROUTES_DATA)

apple_health_export/workout-routes/*.gpx + suburbs_sydney.json
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

### 配送分析

`analyze_delivery.py` 只看 GPX,回答一个别的页面回答不了的问题:**哪儿的活值得干**。

```bash
python3 analyze_delivery.py
python3 analyze_delivery.py --stop-seconds 120   # 换个门槛看看
```

导出里没有订单,只有 1 Hz 的位置、速度和海拔,所以一切都是推断出来的:

- **单** —— 速度低于 0.7 m/s 连续 ≥ 90 秒。取餐和送达从外面看是一样的:车停两分钟。
  红灯通常更短,落进单独的「等待」桶,不会把单量撑起来。门槛用 `--stop-seconds` 调。
- **区** —— 点落在哪个 ABS 2016 suburb 多边形里。用的是点在多边形,不是就近取中心点 ——
  内西区的 suburb 互相咬合得厉害,取中心点会把停留判到隔壁区去。
- **好跑指数** —— 0–100,由中位速度(40%)、红灯密度(25%)、爬升(20%)、龟速占比(15%)
  加权而成。权重写在 `FLOW_WEIGHTS` 里,也印在页面上 —— 一个合成指标只有能看见成分才算诚实。
- **路段** —— 常骑的 60 米格子连成链。单个格子不成路,一串才是。「最难走」按每趟多花的
  时间排序,不是累计 —— 否则排出来的只是最长最常走的那几条。

每次出勤自己起点/终点 150 米内的停留会被剔除 —— 那是家不是客户,而站点是公开的。
早先的做法是把所有班次的起终点聚类、把最密的那团当作家,但起点是散的(GPS 常在半个街区外
才锁上,也不是每次都从同一个门出发),阈值永远够不着,等于什么都没排除。改成每个停留只和
它自己那趟的起终点比,不需要阈值,也不会把一个真的很忙的区误判成谁家客厅。

`suburbs_sydney.json` 是从 [michalsn/australian-suburbs](https://github.com/michalsn/australian-suburbs)(MIT,
数据源为 ABS 2016 Census)裁出悉尼一带、再用 30 米容差简化后的边界。

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
