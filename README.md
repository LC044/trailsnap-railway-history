# 12306 铁路历史数据

按运行日期采集车站、车次及停靠时刻，保留从首次采集开始的全部观测历史，供 TrailSnap 离线查询。当前完整性以 data/feed/manifest.json 的 coverage 和 metadata 为准；样本或部分成功不代表全国完整时刻表。

## 运行

```powershell
npm ci
npm test
npm run dev
```

正式 GitHub Action 每天北京时间 03:00 采集。新字段原始值随版本保留；历史 JSON 损坏会中止运行，不会当空库覆盖。车次以查询日期记录 dates（实际观测运行日），不是以采集日推断有效期。旧名称和不再出现在新车站表中的记录均保留。

枚举包括 G/D/C/K/Z/T/S/Y/L/A 和纯数字入口，满 200 条会递归分拆；同一内部号的详情只查一次。请求失败在调用方重试并接收返回值。详情失败不推断停运，保留列表起终站；无时刻表的实体 s=[]。单日 checkpoint 在 snapshot/ 下，重新运行同一天可继续。

## 数据文件与客户端协议

- data/stations/station_history.json：电报码为键，names 名称观测、versions 原字段/GPS 快照、status_history 状态观测。
- data/trains/history_*.jsonl：车次与所有内容版本；每个版本 dates 为已观测日期，fd/ld 只是日期边界，不代表边界内每天都验证过。
- data/feed/manifest.json：协议版本、单调序号、覆盖说明、全历史 snapshot 及全部 delta 描述。
- data/feed/packs/<sha256>.json.gz：不可变压缩包，首次可下载全历史 snapshot，以后只下载游标后的 delta。
- assets/station_gps.json：现有 12306 坐标种子；当前没有验证可自动刷新的官方 GPS 接口。原始坐标和版本嵌入车站历史，缺失时不猜测。
- snapshot/：诊断快照和隔离试跑，不进 Git。Actions Artifact 有过期时间，不能作为历史唯一存储。

每个包包含 schema_version、sequence、full、upserts（key=station:电报码 或 train:车次，value=历史实体）。manifest 描述包含 SHA-256 和压缩字节数。包只能增加和更新，不删除实体；变更实体携带其保留的全部历史。v1 增量按实体发送，并非最小观测事件；数据规模增大后可另设计 v2 分片，保留老包兼容已有客户端。

Actions 先把包和清单一起推送，成功后创建独立 Release，附件提供全历史 snapshot。测试模式不推送或发布；失败时仅上传诊断 artifact。不要在正式 data/ 上试跑或与其他采集进程同时写入。

## 参数

- QUERY_DATE_OFFSET：查询日期偏移，默认 0。
- DATA_DIR / SNAPSHOT_DIR：历史及快照目录，可用绝对路径。
- TEST_PREFIX：完整前缀，如 G101、1461；TEST_LIMIT：详情上限。
- 测试模式必须显式指定隔离 DATA_DIR。
- REPLAY_SNAPSHOT_DIR：重放已有 stations_日期.json、train_list_日期.json、train_detail_日期.json。
- REPLAY_DATE：输入文件日期；REPLAY_QUERY_DATE：显式运行日期，详情无法关联列表时必须提供，禁止误将旧数据标成今天。

TrailSnap 中 railway/history_cache.py 实现 SHA-256 校验、SQLite 事务与游标增量导入；railway/history_cli.py 可用于本地导入。默认每天从本仓库 main 分支 data/feed/ 同步，首次同步前仍使用静态种子。历史查询精确命中观测日，否则使用最近完整时刻表；未知或仅列表车次只使用起终站，其余信息可为空。

里程为相邻停靠站 GPS Haversine 距离 × 1.2 的累加，是估算值，缺坐标时为空。坐标系尚未经官方确认，不代表实际线路或计费里程。原 src/history/mileage.ts 的站段缓存保留供兼容；新查询按站点坐标版本即时计算，不依赖可能过期的缓存。

## 首版结果

详见 FIRST-EDITION.md；首版包在本地 snapshot/initial-v1/，尚未远端发布。完整时刻表覆盖仍有限，不能依据列表条数声称采集完整。
