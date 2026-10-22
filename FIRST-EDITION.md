# 首版数据与验证（2026-10-23，REQ-196）

本地首版已构建并实际导入 SQLite；本轮没有提交、推送或远端发布。不能将本报告理解为全国完整时刻表已采集完成。

| 指标 | 结果 |
| --- | ---: |
| 车站档案 | 3,398 |
| 可用 GPS 坐标 | 2,859 |
| 车次编号 | 15,731 |
| 内容版本 | 15,733 |
| 含完整时刻表的车次 | 17 |
| 增量游标 | 4 |

大多数车次仅有列表起终站。基线列表来自原八类前缀的本地 15,756 条快照，去重后补入了本次在线纯数字 1461 样本；没有将其声称为所有数字车次或全国完整覆盖。旧全量采集进程仍在运行，尚未落盘的详情没有计入。

- C20 石家庄→北京西：按 2026-10-23 精确匹配，158 分钟，GPS 估算 316.9 km。
- G1010：334 分钟，12 个停靠站，估算 1,203.8 km。
- 1461 北京→上海：1,126 分钟，部分站点缺 GPS，里程 null。
- C20 查询 2025-01-01：返回最近可观测日期 2026-10-23，match=nearest，不伪造早期历史。
- 不存在的 G99999 石家庄→北京西：只返回票面端点，时长 null、无停靠表，GPS 端点估算 315.5 km。

原始站点字段、GPS 版本与来源已随历史保存；当前 GPS 是现有种子，没有验证可自动更新的官方 GPS 接口，坐标系尚未官方确认。缺坐标一律留空。

验证：采集器 5 项通过，后端历史同步/HTTP API/站点投影/铁路初始化/票据 56 项通过，前端 197 项通过，采集器 TypeScript 检查与网站生产构建通过。未执行线上 Actions 或浏览器截图验收。

文件位于 snapshot/initial-v1/：

- data/feed/manifest.json 与 packs/：包含全历史 snapshot 和 4 批增量，可复现首次或增量导入。
- railway-history.sqlite：已导入的可查询本地缓存。
- verification.json：覆盖统计及示例完整响应。
- railway-history-first-edition.zip：供交付的上述文件及实现说明。

本地导入（在 TrailSnap/package/server 运行；路径使用当前实际部署路径替换）：

```powershell
.venv/Scripts/python.exe -m railway.history_cli --db ../../tmp/cr-12306-train-info/snapshot/initial-v1/railway-history.sqlite --feed-dir ../../tmp/cr-12306-train-info/snapshot/initial-v1/data/feed --train C20 --date 2026-10-23
```

独立仓库采集/发布实现已修改；TrailSnap 侧历史缓存、周期同步、车站查询投影、票据识别和批量统计、编辑器按日期查询均已修改。完整方案与限制见 TrailSnap/doc/railway_history.md。GitHub 首次正式发布仍需要把本地代码交付到仓库并运行正式全量采集。
