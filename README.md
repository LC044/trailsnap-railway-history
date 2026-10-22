# 国铁车次历史数据采集

从 12306 采集全国车次时刻表，按**版本化历史**存储——随着铁路运行图调整而更新，保留每次变更记录，可查询某个车次的**历史运行情况**。

## 特性

- **前缀递归枚举**：8 类车次（G/D/C/K/Z/T/S/Y）无遗漏，单次返回满 200 条自动拆分子前缀
- **版本化历史**：每个车次码的每次时刻表变更都记录为一个版本（内容指纹去重，未变化仅延长日期）
- **车站变迁**：追踪车站新增、改名（同电报码不同名）、停用；可查询历史车站名
- **自建里程表**：基于车站 GPS 坐标离线估算站间里程，不依赖第三方网站
- **增量提交**：每次运行只追加变化数据到 git，快照上传 Release

## 数据布局

```
data/
  stations/station_history.json   车站档案：电报码 -> 名称变迁 epochs + 状态
  mileage/segments.json            站间里程缓存："teleA|teleB" -> km
  trains/history_G.jsonl          每行一个车次码的全部运行版本
  trains/history_D.jsonl
  ...
  changes/diff_YYYY-MM-DD.json    变更报告
  last_run.json                    上次运行元信息
  summary.json                      本次运行统计
assets/
  station_gps.json                 12306 车站 GPS 坐标种子数据
```

## 数据结构详解

### station_history.json

键 = 电报码，值结构：

```jsonc
{
  "telecode": "VAP",
  "names": [
    { "name": "北京北", "first": "2026-10-23", "last": "2026-10-23" }
  ],
  "pinyin": "beijingbei",
  "city": "北京",
  "status": "active",
  "first_seen": "2026-10-23",
  "last_seen": "2026-10-23"
}
```

车站改名时旧 name 的 epoch 封存（last 停在改名日），开新 epoch。

### history_<CLASS>.jsonl

每行一个车次码，结构：

```jsonc
{
  "code": "G1",
  "versions": [
    {
      "no": "24000000G10L",
      "f": "北京南",
      "t": "上海虹桥",
      "fd": "2026-10-23",
      "ld": "2026-10-23",
      "h": "a1b2c3d4e5f60718",
      "s": [
        { "n": "北京南", "c": "VNP", "a": null, "d": "06:30", "dd": 0 },
        { "n": "沧州西", "c": "CBP", "a": "07:18", "d": "07:20", "dd": 0 }
      ]
    }
  ]
}
```

调图后时刻表变化 → 开新版本，旧版本封存。

### segments.json

键 `"teleA|teleB"`，值 `{ km, first, last, source }`。地理属性，不随调图变。

## 运行方式

GitHub Actions 自动运行（每周一北京时间 03:00），也支持手动触发。

本地运行：

```bash
npm install
npx tsx src/index.ts
```

可选环境变量：
- `QUERY_DATE_OFFSET`：查询日期偏移天数（0=今天）
- `TEST_PREFIX`：仅枚举指定前缀（测试用）
- `TEST_LIMIT`：仅抓前 N 个车次详情（测试用，0=不限）

## 来源

- 车次/时刻表：12306 公开搜索接口
- 车站表/GPS：12306 官方页面内嵌的 station_name js 及 App 车站列表接口
- 里程：GPS 直线距离 × 1.2 铁路曲折系数

## 免责声明

仅供学习交流。数据来自公开接口，使用者须遵守 12306 使用条款及相关法律法规。