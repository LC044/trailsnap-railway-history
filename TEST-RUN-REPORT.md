# cr-12306-train-info Fork 试跑报告

日期：2026-10-23 | 位置：`tmp/cr-12306-train-info/`

## 结论：跑通了，可用

### 为跑通所做的改造（原仓库代码有 3 处问题）

| 文件 | 问题 | 修复 |
|---|---|---|
| `src/utils/request.ts` | 代理池为空时直接失败（`allowDirectConnection` 字段定义了但没用） | pool 为空时走直连；实测 12306 两个接口直连均可用，无需代理 |
| `src/services/station_names/fetch.ts` | `matchAll` 缺 `g` 标志；且 `request()` 封装强制按 JSON 解析，HTML 变空串 | 用原生 fetch 重写 |
| 环境依赖 | esbuild 的 win32-x64 optional 依赖未装上 | `npm install @esbuild/win32-x64` |

### 试跑结果（C 字头样本）

| 指标 | 结果 | 对比现方案 |
|---|---|---|
| 车次枚举 | **2932 个 C 类车次，91 次请求，15 秒** | 现方案 99 关键词/类 + 每次随机睡 1~10s，且有 200 条截断漏车 |
| 车次详情 | 18/20 成功（2 个偶发 fetch failed） | 正式跑有 5 轮重试 + 前一日 Release 补偿机制兜底 |
| 车站表 | 3399 条，含电报码/拼音/简拼/城市 | 现方案 station.csv 静态文件 |

### 全量运行预估

- 枚举：8 类全跑约 **330 次请求**（自动递归拆分前缀）
- 详情：约 1.1 万车次 × 1 请求；内置 2~5s 随机延迟 + 并发自适应（2~6），预计 **1~1.5 小时**
- 查询日期固定为「今天 +13 天」（预售期边缘，保证查得到）

### 数据覆盖度（对照 railway/schemas.py）

**TrainCreate：全字段 ✅**

**TrainScheduleCreate：12/13 字段 ✅**
- 全部时间字段（到发时间、停留、运行时分、跨天）直接映射
- `station_telecode` 通过 3399 条车站表按站名关联，实测命中率 96/97（未命中：眉山，个别新站需兜底）
- ❌ **`accumulated_mileage` 缺失**——12306 接口本身无里程字段（这正是原代码爬 gaotie.cn 的原因）

**TrainOperationPlanCreate：4/8 字段 ✅**
- ❌ `start_date`/`end_date` 运行计划生效期：数据源只有一个采样日期
- ❌ `run_rule` 开行规律（每日/工作日/周末）：需对同一车次在多日期采样后推导
- ❌ `total_mileage`：依赖里程，同上缺失

**StationCreate：核心字段 ✅**（电报码/名称/拼音 ✅；省份、区县需用 city + 行政区划库另行补全）

### 缺失清单与对策

| 缺失 | 严重度 | 对策 |
|---|---|---|
| 累计里程 | 高（schema 必填） | 方案A：保留 gaotie.cn 但只查「新站间区间」并缓存；方案B：自建站间里程表（里程是线路物理属性，不随调图变） |
| 运行计划生效期 / run_rule | 中 | 对同一车次连续采样多日（如预售期内 15 天）推导开行规律；调图日常在 1/4/7/10 月，可按季度刷新 |
| 车站省份/区县 | 低 | city 字段 + 高德/民政部行政区划数据映射 |
| 个别新站无电报码 | 低 | 名称精确匹配 + 人工补录 |

### 附带发现

- 同一 `train_no` 挂多个车次码的情况有 542/2932（跨线交路，如 C921/C924），fork 的列表输出已自动聚合，现方案的 `train_code_set` 逻辑可简化
- 原仓库 GitHub Actions 已于 2026-06-04 停止，Release 数据不可再白嫖，必须自己跑

### 试跑产物

- `dist-test/train_list_C_20261105.json` — 2932 条车次列表
- `dist-test/train_detail_C_20261105.json` — 18 条详情样本
- `dist-test/station_names.json` — 3399 条车站表
- `src/test-run.ts` — 可复用的试跑脚本（`npx tsx src/test-run.ts <前缀> <详情数>`）
