import fs from "fs";
import path from "path";
import crypto from "crypto";

/**
 * 历史数据存储层
 *
 * 数据布局（全部增量提交到 git）：
 * data/
 *   stations/station_history.json   # telecode -> 车站档案（含名称变迁 epochs、启用/停用状态）
 *   mileage/segments.json           # "teleA|teleB" -> 相邻站间里程（物理属性，不随调图变化）
 *   trains/history_<CLASS>.jsonl    # 每行一个车次码的全部运行版本（去重后增量追加）
 *   changes/diff_<DATE>.json        # 每次运行与上次的差异报告
 *   last_run.json                   # 上次运行元信息（用于 diff）
 *   summary.json                    # 本次运行统计
 * snapshot/（不进 git）             # 原始全量快照，上传 Release 供下载
 */

export const DATA_DIR = path.join(process.cwd(), "data");
export const SNAPSHOT_DIR = path.join(process.cwd(), "snapshot");

export const ensureDirs = () => {
  for (const dir of [
    DATA_DIR,
    path.join(DATA_DIR, "stations"),
    path.join(DATA_DIR, "mileage"),
    path.join(DATA_DIR, "trains"),
    path.join(DATA_DIR, "changes"),
    SNAPSHOT_DIR,
  ]) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }
};

const readJson = <T>(filePath: string, fallback: T): T => {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
  } catch {
    return fallback;
  }
};

const writeJson = (filePath: string, data: unknown) => {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
};

// ------------------------------ 车站历史 ------------------------------

export interface StationNameEpoch {
  /** 车站名称 */
  name: string;
  /** 该名称首次出现（运行日期 YYYY-MM-DD） */
  first: string;
  /** 该名称最后出现（运行日期 YYYY-MM-DD） */
  last: string;
}

export interface StationRecord {
  telecode: string;
  names: StationNameEpoch[];
  pinyin: string;
  pinyin_short: string;
  city: string;
  /** active=本次运行仍存在；inactive=已从 12306 车站表消失 */
  status: "active" | "inactive";
  /** 首次发现日期 */
  first_seen: string;
  /** 最后出现日期 */
  last_seen: string;
}

export type StationHistory = Record<string, StationRecord>;

export const loadStationHistory = (): StationHistory =>
  readJson<StationHistory>(path.join(DATA_DIR, "stations", "station_history.json"), {});

export const saveStationHistory = (history: StationHistory) =>
  writeJson(path.join(DATA_DIR, "stations", "station_history.json"), history);

export interface StationSnapshotItem {
  name: string;
  tele_code: string;
  pinyin: string;
  pinyin_short: string;
  city: string;
}

/**
 * 用本次抓取的车站表更新车站历史，返回变更事件。
 * 改名判定：同 telecode 出现新名称 → 旧名称 epoch 封存，新名称开 epoch。
 */
export const updateStationHistory = (
  history: StationHistory,
  stations: StationSnapshotItem[],
  runDate: string,
): { added: string[]; renamed: { telecode: string; from: string; to: string }[]; removed: string[] } => {
  const currentTelecodes = new Set<string>();
  const added: string[] = [];
  const renamed: { telecode: string; from: string; to: string }[] = [];

  for (const s of stations) {
    if (!s.name || !s.tele_code) continue;
    currentTelecodes.add(s.tele_code);
    const rec = history[s.tele_code];
    if (!rec) {
      history[s.tele_code] = {
        telecode: s.tele_code,
        names: [{ name: s.name, first: runDate, last: runDate }],
        pinyin: s.pinyin,
        pinyin_short: s.pinyin_short,
        city: s.city,
        status: "active",
        first_seen: runDate,
        last_seen: runDate,
      };
      added.push(s.name);
      continue;
    }
    rec.status = "active";
    rec.last_seen = runDate;
    rec.pinyin = s.pinyin || rec.pinyin;
    rec.pinyin_short = s.pinyin_short || rec.pinyin_short;
    rec.city = s.city || rec.city;
    const lastEpoch = rec.names[rec.names.length - 1];
    if (lastEpoch.name === s.name) {
      lastEpoch.last = runDate;
    } else {
      renamed.push({ telecode: s.tele_code, from: lastEpoch.name, to: s.name });
      rec.names.push({ name: s.name, first: runDate, last: runDate });
    }
  }

  const removed: string[] = [];
  for (const rec of Object.values(history)) {
    if (!currentTelecodes.has(rec.telecode) && rec.status === "active") {
      rec.status = "inactive";
      removed.push(rec.names[rec.names.length - 1].name);
    }
  }

  return { added, renamed, removed };
};

/** 名称 -> 电报码 映射（含全部历史名称，用于解析历史数据/里程源） */
export const buildNameToTelecode = (history: StationHistory): Map<string, string> => {
  const map = new Map<string, string>();
  for (const rec of Object.values(history)) {
    for (const epoch of rec.names) {
      if (!map.has(epoch.name)) map.set(epoch.name, rec.telecode);
    }
  }
  return map;
};

// ------------------------------ 里程表 ------------------------------

export interface SegmentRecord {
  km: number;
  first: string;
  last: string;
  source: string;
}

export type MileageSegments = Record<string, SegmentRecord>;

export const loadSegments = (): MileageSegments =>
  readJson<MileageSegments>(path.join(DATA_DIR, "mileage", "segments.json"), {});

export const saveSegments = (segments: MileageSegments) =>
  writeJson(path.join(DATA_DIR, "mileage", "segments.json"), segments);

export const segmentKey = (teleA: string, teleB: string): string => `${teleA}|${teleB}`;

// ------------------------------ 车次历史 ------------------------------

export interface StopRecord {
  /** 站名（当时名称，历史保真） */
  n: string;
  /** 电报码 */
  c: string;
  /** 到站时间（始发站为 null） */
  a: string | null;
  /** 发车时间（终到站为 null） */
  d: string | null;
  /** 到达天数差 */
  dd: number;
}

export interface TrainVersion {
  /** 12306 内部车号 */
  no: string;
  /** 始发站名 */
  f: string;
  /** 终到站名 */
  t: string;
  /** 版本首次出现日期 */
  fd: string;
  /** 版本最后确认日期 */
  ld: string;
  /** 停靠序列 */
  s: StopRecord[];
  /** 版本内容指纹 */
  h: string;
}

export interface TrainHistoryEntry {
  code: string;
  versions: TrainVersion[];
}

export const versionHash = (no: string, f: string, t: string, stops: StopRecord[]): string =>
  crypto
    .createHash("sha1")
    .update(`${no}|${f}|${t}|${stops.map((s) => `${s.c},${s.a},${s.d},${s.dd}`).join(";")}`)
    .digest("hex")
    .slice(0, 16);

export const classFile = (cls: string): string =>
  path.join(DATA_DIR, "trains", `history_${cls}.jsonl`);

export const loadClassHistory = (cls: string): Map<string, TrainHistoryEntry> => {
  const map = new Map<string, TrainHistoryEntry>();
  const file = classFile(cls);
  if (!fs.existsSync(file)) return map;
  for (const line of fs.readFileSync(file, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const entry = JSON.parse(trimmed) as TrainHistoryEntry;
      map.set(entry.code, entry);
    } catch {
      // 忽略损坏行
    }
  }
  return map;
};

export const saveClassHistory = (cls: string, entries: Map<string, TrainHistoryEntry>) => {
  const sorted = [...entries.values()].sort((a, b) =>
    a.code.localeCompare(b.code, void 0, { numeric: true }),
  );
  const content = sorted.map((e) => JSON.stringify(e)).join("\n") + "\n";
  fs.writeFileSync(classFile(cls), content, "utf-8");
};

// ------------------------------ 运行元信息 ------------------------------

export interface LastRunInfo {
  date: string;
  codes: string[];
  train_count: number;
}

export const loadLastRun = (): LastRunInfo | null =>
  readJson<LastRunInfo | null>(path.join(DATA_DIR, "last_run.json"), null);

export const saveLastRun = (info: LastRunInfo) => writeJson(path.join(DATA_DIR, "last_run.json"), info);

export const saveSummary = (summary: unknown) => writeJson(path.join(DATA_DIR, "summary.json"), summary);

export const saveDiffReport = (runDate: string, diff: unknown) =>
  writeJson(path.join(DATA_DIR, "changes", `diff_${runDate}.json`), diff);

export const saveSnapshot = (filename: string, data: unknown) => {
  if (!fs.existsSync(SNAPSHOT_DIR)) fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
  const filePath = path.join(SNAPSHOT_DIR, filename);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
  return filePath;
};
