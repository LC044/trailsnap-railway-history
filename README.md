# 12306 铁路历史数据

按运行日期采集车站、车次及停靠时刻，保留从首次采集开始的全部观测历史，供 TrailSnap 离线查询。当前完整性以 data/feed/manifest.json 的 coverage 和 metadata 为准；样本或部分成功不代表全国完整时刻表。

## 运行

```powershell
npm ci
npm test
npx tsx src/restore-state.ts
npm run dev
```

正式 GitHub Action 每天北京时间 03:00 采集。新字段原始值随版本保留；历史 JSON 损坏会中止运行，不会当空库覆盖。车次以查询日期记录 dates（实际观测运行日），不是以采集日推断有效期。旧名称和不再出现在新车站表中的记录均保留。

正式采集前通过已认证的 GitHub CLI 恢复 Release 采集状态。恢复命令会替换本地车站、车次和指纹文件，应在开始一次新采集前执行；不要在尚未发布的采集中途执行。下载失败、序号不一致、校验失败或文件缺失都会中止，不会改用空库继续采集。测试模式使用隔离目录，不恢复正式状态。

枚举包括 G/D/C/K/Z/T/S/Y/L/A/N/V 和纯数字入口，满 200 条会递归分拆；同一内部号的详情只查一次。N/V 仅按公开车次前缀接入，不根据字母猜测车型。纯数字车次保存到 `history_NUMERIC.jsonl`；首次正式采集将旧 `history_N.jsonl` 中的纯数字记录原样迁移，真正 N 字头车次保留在 N 类。迁移先写目标、再移除源记录，冲突中止且不丢弃历史。请求失败在调用方重试并接收返回值。详情失败不推断停运，保留列表起终站；无时刻表的实体 s=[]。单日 checkpoint 在 snapshot/ 下，重新运行同一天可继续。

## 数据文件与客户端协议

- data/stations/station_history.json：恢复后的本地采集状态，不再随日常提交进入 Git。电报码为键，names 名称观测、versions 原字段/GPS 快照、status_history 状态观测。
- data/trains/history_*.jsonl：恢复后的本地采集状态，不再随日常提交进入 Git。包含车次与所有内容版本；每个版本 dates 为已观测日期，fd/ld 只是日期边界，不代表边界内每天都验证过。
- data/feed/fingerprints.json：恢复后的本地发布指纹，不再随日常提交进入 Git。
- data/collector-state.json：Git 中的小型采集状态指针，绑定 feed 序号、全量快照哈希和 Release 状态包的 SHA-256/大小。仅供采集器使用，客户端不读取。
- data/feed/manifest.json：协议版本、单调序号、覆盖说明、全历史 snapshot 及全部 delta 描述。
- data/feed/packs/<sha256>.json.gz：Git 中只新增不可变 delta。首次/跨协议/缺包时从 manifest.snapshot.url 下载 Release 全历史快照；不需要克隆仓库。已有历史包保留，不重写 Git 历史。
- snapshot/feed/packs/<sha256>.json.gz：新全量快照的本地暂存位置，已被 Git 忽略，仅上传 Release 附件。
- assets/station_gps.json：现有 12306 坐标种子；当前没有验证可自动刷新的官方 GPS 接口。原始坐标和版本嵌入车站历史，缺失时不猜测。
- snapshot/：诊断快照和隔离试跑，不进 Git。Actions Artifact 有过期时间，不能作为历史唯一存储。

当前只发布 v2（schema_version=2），仍使用 data/feed/ 地址，停止 v1 兼容更新。包包含 sequence、full、stations、train_versions、observations。stations 是站点实体；train_versions 为 {code,value}，value 保留 h/no/f/t/s/raw 等内容，不含 dates/fd/ld/observed_at；observations 为 {code,hash,dates,observed_at?}，只发送新观测日期。无时刻表变化时不重发内容，A→B→A 只追加 A 的观测日期。snapshot 包含全部内容与日期，delta 只含新增内容、日期及变化站点。manifest 描述包含 SHA-256 和压缩字节数。版本内容不可变，版本或观测被删除时拒绝发布。

车站精简增量使用 `station_dates_version=1` 和独立的 `compact_deltas` 描述符列表。精简包新增 `station_dates`，每条只含 `telecode`、`last_seen`、按既有名称顺序排列的 `name_last`、按既有字段版本顺序排列的 `version_last`；名称、坐标、状态、原始字段或版本结构变化仍在 `stations` 发送完整档案。完整快照始终保留全部车站及日期。新客户端只在识别该扩展版本时使用 `compact_deltas`；旧客户端的 `deltas` 列表不会包含精简包，链条缺口使原有 v2 同步逻辑自动回退 Release 全量快照，避免静默忽略日期后推进游标。

可先发布采集端，再升级行影集；未升级但已支持 v2 的客户端仍可正确同步，代价是每次有新序号时下载完整快照（目前约 7.4 MB），升级后自动恢复精简增量，无需清库。行影集后端/桌面端升级才会使用精简日期；V 字头 OCR 与 N/V 混合车次识别还需部署新版 AI 服务。网页的车票生成输入也已放开 N/V。v1-only 客户端不在本次兼容范围，继续需要升级。停止发布后回滚采集器时，应恢复原有完整车站增量，不可把精简包放入旧 `deltas` 列表。

Actions 使用浅克隆（fetch-depth=1）。先以完整 SHA-256 命名的不可变 tag `snapshot-v2-<sha256>` 上传 Release 附件 `<sha256>.json.gz` 和 manifest.json，再下载附件核对大小、SHA-256、协议和序号，成功后才提交增量和清单并推送。失败不会推送悬空清单；已有 Release 可复用，缺附件可补传，损坏附件拒绝覆盖和发布。首次 v2 发布不生成冗余的全量 delta 1；重复发布不提升数据序号。测试模式不推送或发布；失败时仅上传诊断 artifact。不要在正式 data/ 上试跑或与其他采集进程同时写入。

同一 Release 还包含 `collector-state-<sha256>.json.gz`，逐字保留车站档案、原始车次历史与发布指纹。发布器上传并重新下载验证状态包、核对全部指纹后，才更新 `data/collector-state.json` 并从 Git 索引移除上述原始状态文件。首次迁移利用当前 Git 保留的完整状态，不需要下载旧 Git 历史；该次数据提交会出现一次性删除大量原始状态文件，它们已存入 Release，历史提交也全部保留。随后日常数据提交仅更新 manifest、状态指针、小摘要以及新增的不可变增量包，不再每天重写成千上万行完整历史。重复发布不产生空提交。

## 参数

- QUERY_DATE_OFFSET：查询日期偏移，默认 0。
- QUERY_DATE：固定查询日期（YYYY-MM-DD），Actions 自动计算，避免跨午夜时检查点日期与采集日期不一致。
- DATA_DIR / SNAPSHOT_DIR：历史及快照目录，可用绝对路径。
- TEST_PREFIX：完整前缀，如 G101、1461；TEST_LIMIT：详情上限。
- 测试模式必须显式指定隔离 DATA_DIR。
- REPLAY_SNAPSHOT_DIR：重放已有 stations_日期.json、train_list_日期.json、train_detail_日期.json。
- REPLAY_DATE：输入文件日期；REPLAY_QUERY_DATE：显式运行日期，详情无法关联列表时必须提供，禁止误将旧数据标成今天。

旧版 TrailSnap 收到 v2 会同步失败但保留本地缓存；安装支持 v2 的新版后自动通过内置或远端全量快照迁移，成功后切换独立协议游标，不需要手动清库。发布器首次读取 v1 清单时从当前保留历史生成 v2 序号 1，不沿用旧增量链；旧不可变包作为归档保留。

TrailSnap 中 railway/history_cache.py 实现 SHA-256 校验、SQLite 事务与游标增量导入；railway/history_cli.py 可用于本地导入。默认每天从本仓库 main 分支 data/feed/ 同步，首次同步前仍使用静态种子。历史查询精确命中观测日，否则使用最近完整时刻表；未知或仅列表车次只使用起终站，其余信息可为空。

里程为相邻停靠站 GPS Haversine 距离 × 1.2 的累加，是估算值，缺坐标时为空。坐标系尚未经官方确认，不代表实际线路或计费里程。原 src/history/mileage.ts 的站段缓存保留供兼容；新查询按站点坐标版本即时计算，不依赖可能过期的缓存。

## 首版结果

详见 FIRST-EDITION.md；首版包在本地 snapshot/initial-v1/，尚未远端发布。完整时刻表覆盖仍有限，不能依据列表条数声称采集完整。

## 发布已有完整基线

如果仓库已有历史但尚未建立 data/feed，可手动运行 Actions 并勾选 publish_existing；只转换现有观测并发布清单/历史包，不重新抓全国车次，也不会把发布时间伪装成运行日期。已有车站缺少字段版本时补入保留记录和 GPS 种子，状态、名称历史及车次日期保持不变。重复发布未变化历史不会提升 sequence。

```powershell
gh workflow run collect.yml --repo LC044/trailsnap-railway-history -f publish_existing=true
```

## 网络失败与断点恢复

列表枚举按前缀保存成功响应到 `snapshot/enumeration_日期.json`，包括有效空列表；失败响应不会当成空列表。单个前缀请求先重试四次，仍失败则继续其他前缀，最后最多进行三轮补查（轮间等待 15/30 秒）。成功前缀不再请求；根前缀、查询日期不同不会复用旧结果。日志记录前缀、日期、HTTP 状态、响应形态和失败原因。全部前缀完整枚举后才进入时刻表与发布阶段，失败时保留正式 feed。

Actions 在采集前恢复列表/详情检查点，失败后也尝试缓存；缓存按查询日期与测试前缀、详情上限隔离，同日重新触发或重跑任务可继续。GitHub 缓存可能过期或被清理，缓存不可用时从头采集。快照 artifact 同样保留检查点供排查。测试样本只写隔离目录，不发布正式数据。

验证命令：`npm test`、`npm run typecheck`。

Node fetch 在某些运行器与官方服务器连接失败时，GET 请求自动回退到系统 curl（需安装 curl，GitHub Ubuntu 运行器已提供）；保留 HTTPS 证书验证，连接超时 5 秒、总超时 15 秒。HTTP 错误仍走正常重试，不当成成功；日志保留底层错误码用于区分 DNS、连接或 TLS 错误。

## Release 快照与客户端

快照描述保留 file=packs/<sha256>.json.gz 作为离线种子的本地路径，并新增 url=https://github.com/LC044/trailsnap-railway-history/releases/download/snapshot-v2-<sha256>/<sha256>.json.gz。客户端仅接受该仓库中哈希匹配的 HTTPS 附件地址，沿用镜像重试和包校验；离线种子使用 file，不访问 Release。增量描述不含 url，继续从 Git raw 下载。新快照及采集状态均保存在 Release，Git 仅持续新增小增量和更新清单/摘要；已有 Git 历史不清理。单独调整采集状态存储无需客户端升级；新增车站精简日期扩展需要新版客户端才能节省下载量，旧 v2 客户端回退完整快照。

`npm run verify:compact` 在忽略的 `snapshot/compact-replay-*` 下离线重放 `origin/main~1` 与 `origin/main` 的保留历史（可用 `COMPACT_REPLAY_REF` 指定末次修订），生成包、清单和 `report.json`。不写正式 data/，不联网发布；需要这两个旧修订仍包含原始状态。首次接入无内容指纹时保守发送完整车站；通过一次无变化的 `publish_existing` 可预先建立内容指纹而不增加观测序号。

发布命令 `npx tsx src/release-feed.ts` 会创建 Release 并提交推送，仅供已授权的正式发布流程运行。`npm run verify:feed-replay` 在隔离目录重放历史，不联网发布。
