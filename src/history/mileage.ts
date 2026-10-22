import fs from "fs";
import path from "path";

/**
 * 自建站间里程表
 *
 * 里程来源：assets/station_gps.json（12306 App 车站列表接口的 GPS 坐标），
 * 站间里程 = haversine 直线距离 × RAILWAY_COEFFICIENT（铁路曲折系数）。
 * 里程是线路的物理属性，不随调图变化；车站改名不影响（按电报码索引）。
 *
 * segments.json 作为缓存增量写入："teleA|teleB" -> { km, src }
 * GPS 数据文件更新（version_no 变化）时可全量重算。
 */

import { DATA_DIR, loadSegments, saveSegments, segmentKey, type MileageSegments, type StopRecord } from "./store";

/** 铁路曲折系数：实测京沪高铁直线 1080km/实际 1318km ≈ 1.22，京广 ≈ 1.22，取 1.2 */
const RAILWAY_COEFFICIENT = 1.2;

interface GpsStation {
  id: string;
  value: string;
  latitude: string;
  longitute: string;
  city_name: string;
}

export interface GpsIndex {
  /** telecode -> 坐标 */
  coords: Map<string, { lat: number; lng: number }>;
  /** 电报码 -> 城市（补充信息） */
  cities: Map<string, string>;
  /** 数据版本号 */
  version: string;
}

const normalizeName = (s: string): string => s.replace(/\s+/g, "");

export const loadGpsIndex = (): GpsIndex => {
  const file = path.join(process.cwd(), "assets", "station_gps.json");
  const raw = JSON.parse(fs.readFileSync(file, "utf-8")) as {
    stationList: GpsStation[];
    version_no: string;
  };
  const coords = new Map<string, { lat: number; lng: number }>();
  const cities = new Map<string, string>();
  for (const s of raw.stationList ?? []) {
    if (s.id && s.latitude && s.longitute) {
      coords.set(s.id, { lat: parseFloat(s.latitude), lng: parseFloat(s.longitute) });
    }
    if (s.id && s.city_name) {
      cities.set(s.id, normalizeName(s.city_name));
    }
  }
  return { coords, cities, version: raw.version_no ?? "" };
};

/** haversine 两点直线距离（km） */
export const haversineKm = (
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number => {
  const R = 6371.0088;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
};

/** 估算相邻站间里程；任一站无坐标返回 null */
export const estimateSegmentKm = (
  gps: GpsIndex,
  teleA: string,
  teleB: string,
): number | null => {
  const a = gps.coords.get(teleA);
  const b = gps.coords.get(teleB);
  if (!a || !b) return null;
  const direct = haversineKm(a.lat, a.lng, b.lat, b.lng);
  if (direct <= 0) return null;
  return Math.round(direct * RAILWAY_COEFFICIENT * 10) / 10;
};

/**
 * 为停靠序列补算新的相邻站段并写入 segments 缓存。
 * 返回更新后的 segments（同时已保存）。
 */
export const fillSegments = (
  gps: GpsIndex,
  stops: StopRecord[][],
  runDate: string,
): { segments: MileageSegments; added: number; missing: string[] } => {
  const segments = loadSegments();
  const before = Object.keys(segments).length;
  const missing = new Set<string>();

  for (const stopList of stops) {
    for (let i = 0; i < stopList.length - 1; i++) {
      const a = stopList[i].c;
      const b = stopList[i + 1].c;
      if (!a || !b) continue;
      const key = segmentKey(a, b);
      if (segments[key]) continue;
      const km = estimateSegmentKm(gps, a, b);
      if (km == null) {
        missing.add(key);
        continue;
      }
      segments[key] = { km, first: runDate, last: runDate, source: "gps-estimate" };
    }
  }

  const added = Object.keys(segments).length - before;
  if (added > 0) saveSegments(segments);
  return { segments, added, missing: [...missing] };
};

/** 计算停靠序列的累计里程（km，四舍五入到 1 位）；某段缺失时该站及其后各站为 null */
export const accumulatedMileage = (
  segments: MileageSegments,
  stops: StopRecord[],
): (number | null)[] => {
  const result: (number | null)[] = [0];
  let acc: number | null = 0;
  for (let i = 1; i < stops.length; i++) {
    const seg = segments[segmentKey(stops[i - 1].c, stops[i].c)];
    if (seg == null || acc == null) {
      acc = null;
    } else {
      acc += seg.km;
    }
    result.push(acc == null ? null : Math.round(acc * 10) / 10);
  }
  return result;
};
