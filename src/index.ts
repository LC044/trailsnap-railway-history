import fs from "fs";
import path from "path";

import {
  queryTrainListByKeywordAndDate,
  queryTrainDetailByTrainNoAndDate,
} from "./services/train";
import { getStationNames } from "./services/station_names";
import {
  ensureProxyPool,
  TaskScheduler,
  getFailedQueueLength,
  retryFailedRequests,
  getSuccessCount,
  getPermanentlyFailedUrls,
} from "./utils";
import { PAGE_SIZE, TRAIN_CLASS_LIST } from "./constants";
import type { ITrain } from "./services/train/model";
import type { ITrainStationResponseViaTrainNoAndDate } from "./services/train/model";

import {
  ensureDirs,
  loadStationHistory,
  saveStationHistory,
  updateStationHistory,
  buildNameToTelecode,
  loadClassHistory,
  saveClassHistory,
  loadLastRun,
  saveLastRun,
  saveSummary,
  saveDiffReport,
  saveSnapshot,
  versionHash,
  type StopRecord,
  type TrainHistoryEntry,
  type TrainVersion,
  type StationSnapshotItem,
} from "./history/store";
import { loadGpsIndex, fillSegments } from "./history/mileage";

/**
 * 铁路时刻表历史采集管线
 *
 * 每次运行（每周/手动）：
 *   1. 车站表快照 -> 更新车站历史（新增/改名/停用检测）
 *   2. 前缀递归枚举全量车次（<200 条视为该前缀完整）
 *   3. 并发抓取全部车次详情（自适应并发 + 5 轮重试）
 *   4. 按车次码写入版本化历史（内容指纹去重，未变化仅延长 last 日期）
 *   5. 离线补算新站段的 GPS 估算里程
 *   6. 生成 diff 报告（新增/停运/变更车次，车站变更）
 *   7. 快照写入 snapshot/（CI 中上传 Release），历史数据提交 git
 *
 * 环境变量：
 *   QUERY_DATE_OFFSET  查询日期偏移（默认 0 = 今天；12306 预售期边缘可用 13）
 *   TEST_PREFIX        仅枚举指定前缀（测试用，如 C）
 *   TEST_LIMIT         仅抓取前 N 个车次详情（测试用，0 = 不限制）
 */

// ------------------------------ 运行参数 ------------------------------

const QUERY_DATE_OFFSET = Number(process.env.QUERY_DATE_OFFSET ?? 0);
const TEST_PREFIX = process.env.TEST_PREFIX ?? "";
const TEST_LIMIT = Number(process.env.TEST_LIMIT ?? 0);

/** 北京时区当前日期 YYYY-MM-DD */
const beijingDate = (offsetDays = 0): string => {
  const d = new Date(Date.now() + offsetDays * 86400_000);
  return d.toLocaleDateString("sv-SE", { timeZone: "Asia/Shanghai" });
};

const RUN_DATE = beijingDate();
const QUERY_DATE = beijingDate(QUERY_DATE_OFFSET).replace(/-/g, "");

const normalizeStation = (s: string): string => s.replace(/\s+/g, "");
const formatDateForDetail = (date: string): string =>
  `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`;

const timeOrNull = (t: string | undefined): string | null =>
  !t || t === "----" || t === "--" ? null : t;

// ------------------------------ 车次枚举 ------------------------------

const trainList = new Set<ITrain>();
let listRequestCount = 0;

const processPrefix = async (prefix: string): Promise<void> => {
  listRequestCount++;
  const rsp = await queryTrainListByKeywordAndDate(prefix, QUERY_DATE);
  if (!rsp.success) {
    console.log(`[列表] ${prefix} 请求失败: ${rsp.message}（进入重试队列）`);
    return;
  }
  const list = (rsp.data ?? []).map((t) => ({
    ...t,
    from_station: normalizeStation(t.from_station),
    to_station: normalizeStation(t.to_station),
  }));
  console.log(`[列表] ${prefix} -> ${list.length} 条`);

  if (list.length === 0) return;

  if (list.length < PAGE_SIZE) {
    list.forEach((t) => trainList.add(t));
    return;
  }

  const exact = list.find((t) => t.station_train_code === prefix);
  if (exact) trainList.add(exact);

  // 递归拆分子前缀，串行执行避免瞬时高并发被 403
  for (let j = 0; j <= 9; j++) {
    await processPrefix(`${prefix}${j}`);
  }
};

/** 串行枚举一类车次的所有前缀，类与类之间也串行，避免瞬时高并发触发 403 */
const fetchTrainList = async () => {
  const t0 = Date.now();
  const classes = TEST_PREFIX ? [TEST_PREFIX.charAt(0)] : TRAIN_CLASS_LIST;
  for (const cls of classes) {
    for (let i = 1; i <= 9; i++) {
      await processPrefix(`${cls}${i}`);
    }
  }
  // 列表失败重试（用失败队列重跑，已有 safeRequest 内部重试 + 这里兜底）
  for (let round = 0; round < 5 && getFailedQueueLength() > 0; round++) {
    console.log(`[列表重试] 第 ${round + 1} 轮, ${getFailedQueueLength()} 个失败请求`);
    await new Promise((r) => setTimeout(r, 15000 + round * 30000)); // 类间更长退避
    await retryFailedRequests();
  }
  console.log(
    `[列表] 枚举完成: ${trainList.size} 个车次, ${listRequestCount} 次请求, 耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`,
  );
};

// ------------------------------ 详情抓取 ------------------------------

interface DetailResult {
  train_no: string;
  station_train_code: string;
  from_station: string;
  to_station: string;
  stops: ITrainStationResponseViaTrainNoAndDate[];
}

const fetchTrainDetails = async (): Promise<{ details: DetailResult[]; failedTrainNos: string[] }> => {
  const scheduler = new TaskScheduler(5, 2);
  const targets = [...trainList];
  const limited = TEST_LIMIT > 0 ? targets.slice(0, TEST_LIMIT) : targets;
  const t0 = Date.now();
  console.log(`[详情] 开始抓取 ${limited.length} 个车次...`);

  const fetchOne = async (train: ITrain): Promise<DetailResult | { train_no: string; failed: true }> => {
    const dateStr = formatDateForDetail(train.date);
    const rsp = await scheduler.add(() =>
      queryTrainDetailByTrainNoAndDate(train.train_no, dateStr),
    );
    if (!rsp.success || !Array.isArray(rsp.data?.data) || rsp.data.data.length === 0) {
      return { train_no: train.train_no, failed: true };
    }
    return {
      train_no: train.train_no,
      station_train_code: train.station_train_code,
      from_station: train.from_station,
      to_station: train.to_station,
      stops: rsp.data.data,
    };
  };

  // 滚动批次处理：避免一次性 Promise.all 创建上万 Promise
  const BATCH = 200;
  let details: DetailResult[] = [];
  let failed: { train_no: string; failed: true }[] = [];
  for (let i = 0; i < limited.length; i += BATCH) {
    const batch = limited.slice(i, i + BATCH);
    const results = await Promise.all(batch.map(fetchOne));
    details = details.concat(results.filter((r): r is DetailResult => !("failed" in r)));
    failed = failed.concat(results.filter((r): r is { train_no: string; failed: true } => "failed" in r));
    const done = Math.min(i + BATCH, limited.length);
    console.log(`[详情] 进度 ${done}/${limited.length}，成功 ${details.length}，失败 ${failed.length}`);
  }

  // 重试轮（最多 5 轮）
  for (let round = 0; round < 5 && failed.length > 0; round++) {
    console.log(`[详情重试] 第 ${round + 1}/5 轮, ${failed.length} 个车次`);
    await new Promise((r) => setTimeout(r, 5000 + round * 10000));
    const retryResults = await Promise.all(
      failed.map((f) => {
        const train = limited.find((t) => t.train_no === f.train_no)!;
        return fetchOne(train);
      }),
    );
    details = details.concat(retryResults.filter((r): r is DetailResult => !("failed" in r)));
    failed = retryResults.filter((r): r is { train_no: string; failed: true } => "failed" in r);
  }

  console.log(
    `[详情] 完成: ${details.length}/${limited.length} 成功, ${failed.length} 失败, 耗时 ${((Date.now() - t0) / 60000).toFixed(1)} 分钟`,
  );
  return { details, failedTrainNos: failed.map((f) => f.train_no) };
};

// ------------------------------ 主流程 ------------------------------

const main = async () => {
  const t0 = Date.now();
  ensureDirs();
  console.log(`=== 运行日期: ${RUN_DATE}, 查询日期: ${QUERY_DATE}, 测试前缀: ${TEST_PREFIX || "无"}, 详情上限: ${TEST_LIMIT || "无"} ===`);

  await ensureProxyPool();

  // 1. 车站表 + 历史
  const stationsRaw = await getStationNames();
  const stations: StationSnapshotItem[] = stationsRaw
    .filter((s) => s.name && s.tele_code)
    .map((s) => ({
      name: normalizeStation(s.name),
      tele_code: s.tele_code,
      pinyin: s.pinyin ?? "",
      pinyin_short: s.pinyin_short ?? "",
      city: normalizeStation(s.city ?? ""),
    }));
  console.log(`[车站] 本次获取 ${stations.length} 个车站`);

  const stationHistory = loadStationHistory();
  const stationChanges = updateStationHistory(stationHistory, stations, RUN_DATE);
  saveStationHistory(stationHistory);
  saveSnapshot(`stations_${RUN_DATE}.json`, stations);
  console.log(
    `[车站] 新增 ${stationChanges.added.length}, 改名 ${stationChanges.renamed.length}, 停用 ${stationChanges.removed.length}`,
  );
  if (stationChanges.renamed.length > 0) {
    console.log(`[车站] 改名明细:`, JSON.stringify(stationChanges.renamed.slice(0, 20)));
  }

  const nameToTelecode = buildNameToTelecode(stationHistory);

  // 2. 枚举车次
  await fetchTrainList();
  saveSnapshot(`train_list_${RUN_DATE}.json`, [...trainList]);

  // 按 train_no 聚合所有车次码（跨线车次一 no 多码）
  const byTrainNo = new Map<string, ITrain[]>();
  for (const t of trainList) {
    const arr = byTrainNo.get(t.train_no) ?? [];
    arr.push(t);
    byTrainNo.set(t.train_no, arr);
  }
  const trainNoToCodes = new Map<string, string[]>();
  for (const [no, trains] of byTrainNo) {
    trainNoToCodes.set(
      no,
      [...new Set(trains.map((t) => t.station_train_code))].sort((a, b) =>
        a.localeCompare(b, void 0, { numeric: true }),
      ),
    );
  }

  // 3. 详情
  const { details, failedTrainNos } = await fetchTrainDetails();
  saveSnapshot(`train_detail_${RUN_DATE}.json`, details);

  // 4. 写入版本化历史
  const classHistories = new Map<string, Map<string, TrainHistoryEntry>>();
  const changedCodes: string[] = [];
  const newCodes: string[] = [];
  const lastRun = loadLastRun();
  const lastRunCodes = new Set(lastRun?.codes ?? []);

  const toStopRecords = (
    stops: ITrainStationResponseViaTrainNoAndDate[],
  ): StopRecord[] =>
    stops.map((s) => ({
      n: normalizeStation(s.station_name),
      c: nameToTelecode.get(normalizeStation(s.station_name)) ?? "",
      a: timeOrNull(s.arrive_time),
      d: timeOrNull(s.start_time),
      dd: Number(s.arrive_day_diff ?? 0),
    }));

  for (const detail of details) {
    const codes = trainNoToCodes.get(detail.train_no) ?? [detail.station_train_code];
    const stops = toStopRecords(detail.stops);
    const from = normalizeStation(detail.stops[0]?.start_station_name ?? detail.from_station);
    const to = normalizeStation(detail.stops[0]?.end_station_name ?? detail.to_station);
    const hash = versionHash(detail.train_no, from, to, stops);

    for (const code of codes) {
      const cls = code.charAt(0).toUpperCase();
      if (!classHistories.has(cls)) classHistories.set(cls, loadClassHistory(cls));
      const history = classHistories.get(cls)!;
      const entry = history.get(code);
      const version: TrainVersion = {
        no: detail.train_no,
        f: from,
        t: to,
        fd: RUN_DATE,
        ld: RUN_DATE,
        s: stops,
        h: hash,
      };

      if (!entry) {
        history.set(code, { code, versions: [version] });
        newCodes.push(code);
        changedCodes.push(code);
      } else {
        const latest = entry.versions[entry.versions.length - 1];
        if (latest.h === hash) {
          latest.ld = RUN_DATE;
        } else {
          entry.versions.push(version);
          changedCodes.push(code);
        }
      }
    }
  }

  for (const [cls, history] of classHistories) {
    saveClassHistory(cls, history);
  }

  // 5. 里程表（离线 GPS 估算，新站段增量补算）
  const gps = loadGpsIndex();
  const allStops = details.map((d) => toStopRecords(d.stops));
  const mileageResult = fillSegments(gps, allStops, RUN_DATE);
  console.log(
    `[里程] 新增站段 ${mileageResult.added} 个, 无法估算（缺坐标）${mileageResult.missing.length} 个`,
  );

  // 6. diff 报告
  const currentCodes = [...new Set(details.flatMap((d) => trainNoToCodes.get(d.train_no) ?? [d.station_train_code]))];
  const removedCodes = lastRun ? lastRun.codes.filter((c) => !currentCodes.includes(c)) : [];
  const addedCodes = lastRun ? currentCodes.filter((c) => !lastRunCodes.has(c)) : newCodes;

  saveDiffReport(RUN_DATE, {
    run_date: RUN_DATE,
    query_date: QUERY_DATE,
    trains: {
      total: currentCodes.length,
      added: addedCodes,
      removed: removedCodes,
      changed: changedCodes.filter((c) => !addedCodes.includes(c)),
    },
    stations: stationChanges,
    mileage: {
      segments_added: mileageResult.added,
      segments_missing_coords: mileageResult.missing.length,
    },
    failed_train_nos: failedTrainNos,
  });

  saveLastRun({ date: RUN_DATE, codes: currentCodes, train_count: currentCodes.length });

  const summary = {
    run_date: RUN_DATE,
    query_date: QUERY_DATE,
    duration_seconds: Math.round((Date.now() - t0) / 1000),
    test_mode: Boolean(TEST_PREFIX || TEST_LIMIT),
    http_success: getSuccessCount(),
    http_permanent_failed: getPermanentlyFailedUrls().length,
    trains: {
      enumerated: trainList.size,
      details_ok: details.length,
      details_failed: failedTrainNos.length,
      codes_total: currentCodes.length,
      codes_new: newCodes.length,
      codes_changed: changedCodes.length,
    },
    stations: {
      total: stations.length,
      added: stationChanges.added.length,
      renamed: stationChanges.renamed.length,
      removed: stationChanges.removed.length,
    },
    mileage: {
      segments_total: Object.keys(mileageResult.segments).length,
      segments_added: mileageResult.added,
      segments_missing_coords: mileageResult.missing.length,
      gps_version: gps.version,
    },
  };
  saveSummary(summary);
  console.log(`[完成] 总耗时 ${((Date.now() - t0) / 60000).toFixed(1)} 分钟`);
  console.log(JSON.stringify(summary, null, 2));

  if (failedTrainNos.length > 0) {
    console.log(`[警告] ${failedTrainNos.length} 个车次详情最终失败`);
  }
  process.exit(0);
};

main().catch((e) => {
  console.error("管线异常:", e);
  process.exit(1);
});
