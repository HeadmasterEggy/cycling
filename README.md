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
| `explorer.html` | `explorer` | 单次骑行逐条放大 |
| `recovery.html` | `recovery` | HRV、静息心率、呼吸、血氧、睡眠 |
| `cycling-analysis.html` | `all` | 所有章节合并的单页全景视图 |

## 目录结构

```
assets/
  styles.css       共享样式
  app.js           渲染逻辑(图表、地图、导航、页脚)
  recovery.js      恢复类图表
  routes.js        window.ROUTES_DATA —— 逐条 GPS 轨迹(含简化后的折线)
  health-data.js   window.HEALTH_DATA —— Apple Health 派生数据
  favicon.svg
build_pages.py     由 cycling-analysis.html 生成全部页面
parse_health.py    由 Apple Health 导出生成 health-data.js / health_data.json / routes.js
health_data.json   与 health-data.js 同内容的可移植 JSON 导出
```

## 数据流

```
apple_health_export/export.xml + workout-routes/*.gpx
        │  parse_health.py
        ▼
health_data.json  +  assets/health-data.js   (window.HEALTH_DATA)
                  +  assets/routes.js        (window.ROUTES_DATA)
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

### 重新生成页面

`cycling-analysis.html` 是各 `<section>` 区块的源头。改完区块或资源后:

```bash
python3 build_pages.py
```

脚本按标题标记切片,重新拼装全部 8 个页面。该操作幂等 —— 连跑两次输出字节一致。

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
