/**
 * 小规模试跑脚本：
 * 1. 递归枚举指定前缀（默认 C 类）车次列表
 * 2. 抓取前 N 个车次（默认 20）的详情时刻表
 * 3. 抓取车站名+电报码表
 * 4. 全部落盘到 dist-test/ 供后续分析
 *
 * 用法: npx tsx src/test-run.ts [前缀] [详情数量]
 */
import fs from "fs";
import path from "path";

import {
  queryTrainListByKeywordAndDate,
  queryTrainDetailByTrainNoAndDate,
} from "./services/train";
import { getStationNames } from "./services/station_names";
import { ensureProxyPool, TaskScheduler } from "./utils";
import { PAGE_SIZE } from "./constants";
import type { ITrain } from "./services/train/model";

const PREFIX = process.argv[2] || "C";
const DETAIL_LIMIT = Number(process.argv[3] || 20);

const targetDate = (() => {
  const d = new Date();
  d.setDate(d.getDate() + 13);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}${m}${day}`;
})();

const normalizeStation = (s: string): string => s.replace(/\s+/g, "");
const formatDateForDetail = (date: string): string =>
  `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`;

const trainList: Set<ITrain> = new Set();
let listRequestCount = 0;

const processPrefix = async (prefix: string): Promise<void> => {
  listRequestCount++;
  const rsp = await queryTrainListByKeywordAndDate(prefix, targetDate);
  if (!rsp.success) {
    console.log(`[列表] ${prefix} 请求失败: ${rsp.message}`);
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

  const subTasks: Promise<void>[] = [];
  for (let j = 0; j <= 9; j++) {
    subTasks.push(processPrefix(`${prefix}${j}`));
  }
  await Promise.all(subTasks);
};

const main = async () => {
  const outDir = path.join(process.cwd(), "dist-test");
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  console.log(`=== 试跑开始，前缀=${PREFIX}，详情上限=${DETAIL_LIMIT}，目标日期=${targetDate} ===`);
  await ensureProxyPool();

  // 1. 枚举车次列表
  const t0 = Date.now();
  await processPrefix(PREFIX);
  console.log(
    `[列表] 枚举完成: ${trainList.size} 个车次, ${listRequestCount} 次请求, 耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`,
  );
  fs.writeFileSync(
    path.join(outDir, `train_list_${PREFIX}_${targetDate}.json`),
    JSON.stringify(Array.from(trainList), null, 2),
    "utf-8",
  );

  // 2. 抓前 N 个车次详情（用调度器控制并发）
  const scheduler = new TaskScheduler(4, 2);
  const targets = Array.from(trainList).slice(0, DETAIL_LIMIT);
  const t1 = Date.now();
  const details = await Promise.all(
    targets.map(async (train) => {
      const dateStr = formatDateForDetail(train.date);
      const rsp = await scheduler.add(() =>
        queryTrainDetailByTrainNoAndDate(train.train_no, dateStr),
      );
      if (!rsp.success || !Array.isArray(rsp.data?.data)) {
        console.log(`[详情] ${train.station_train_code}(${train.train_no}) 失败: ${rsp.message}`);
        return null;
      }
      console.log(`[详情] ${train.station_train_code}(${train.train_no}) 成功, ${rsp.data!.data.length} 站`);
      return {
        train_no: train.train_no,
        station_train_code: train.station_train_code,
        from_station: train.from_station,
        to_station: train.to_station,
        data: rsp.data!.data,
      };
    }),
  );
  const okDetails = details.filter(Boolean);
  console.log(
    `[详情] 完成: ${okDetails.length}/${targets.length} 条, 耗时 ${((Date.now() - t1) / 1000).toFixed(1)}s`,
  );
  fs.writeFileSync(
    path.join(outDir, `train_detail_${PREFIX}_${targetDate}.json`),
    JSON.stringify(okDetails, null, 2),
    "utf-8",
  );

  // 3. 车站名+电报码
  try {
    const t2 = Date.now();
    const stations = await getStationNames();
    console.log(
      `[车站] 获取成功: ${stations.length} 个车站, 耗时 ${((Date.now() - t2) / 1000).toFixed(1)}s`,
    );
    fs.writeFileSync(
      path.join(outDir, `station_names.json`),
      JSON.stringify(stations, null, 2),
      "utf-8",
    );
  } catch (e) {
    console.log(`[车站] 获取失败:`, e instanceof Error ? e.message : String(e));
  }

  console.log(`=== 试跑结束，输出目录: ${outDir} ===`);
};

main();
