#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""对照 TrailSnap railway schema，分析 cr-12306-train-info 试跑数据的字段覆盖度"""
import json, glob, io, sys
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

base = "E:/Project/TrailSnap/tmp/cr-12306-train-info/dist-test"

# 1. 车次列表
with open(f"{base}/train_list_C_20261105.json", encoding="utf-8") as f:
    train_list = json.load(f)
print(f"=== 车次列表: {len(train_list)} 条 ===")
print("字段:", list(train_list[0].keys()))

# 2. 详情
with open(f"{base}/train_detail_C_20261105.json", encoding="utf-8") as f:
    details = json.load(f)
print(f"\n=== 车次详情: {len(details)} 条 ===")
all_keys = set()
for d in details:
    for stop in d["data"]:
        all_keys.update(stop.keys())
print("站点字段全集:", sorted(all_keys))

# 3. 车站表
with open(f"{base}/station_names.json", encoding="utf-8") as f:
    stations = json.load(f)
print(f"\n=== 车站表: {len(stations)} 条 ===")
telecodes = {s["name"]: s["tele_code"] for s in stations if s.get("name") and s.get("tele_code")}

# 4. 覆盖度分析：对照 TrainScheduleCreate
print("\n" + "=" * 60)
print("TrainScheduleCreate 字段覆盖度分析")
print("=" * 60)
sample = details[0]["data"][0]
mapping = {
    "train_no":            ("列表+详情", "train_no 直接映射"),
    "train_code":          ("详情", "station_train_code 直接映射"),
    "station_telecode":    ("车站表", "station_name -> station_names.json 查 tele_code"),
    "station_name":        ("详情", "station_name 直接映射"),
    "sequence":            ("可推导", "数组下标+1"),
    "arrive_day_diff":     ("详情", "arrive_day_diff 直接映射"),
    "arrival_time":        ("详情", "arrive_time（始发站为----需置NULL）"),
    "departure_time":      ("详情", "start_time（终到站为----需置NULL）"),
    "stop_duration":       ("可推导", "departure_time - arrival_time（跨天处理）"),
    "accumulated_mileage": ("❌缺失", "12306接口无此字段！原代码爬gaotie.cn获取"),
    "running_time":        ("详情", "running_time（HH:MM转分钟）"),
    "is_departure":        ("可推导", "下标==0"),
    "is_arrival":          ("可推导", "下标==len-1"),
}
for field, (src, note) in mapping.items():
    mark = "❌" if src.startswith("❌") else "✅"
    print(f"  {mark} {field:22s} <- {src:6s} {note}")

# 5. 电报码命中率验证
missing = set()
for d in details:
    for stop in d["data"]:
        if stop["station_name"] not in telecodes:
            missing.add(stop["station_name"])
print(f"\n=== 电报码命中率: 详情中 {sum(len(d['data']) for d in details)} 个停靠站, 未命中 {len(missing)} 个 ===")
if missing:
    print("  未命中站名:", list(missing)[:10])

# 6. 运行计划字段
print("\n" + "=" * 60)
print("TrainOperationPlanCreate 字段覆盖度分析")
print("=" * 60)
plan_mapping = {
    "train_no":           ("✅", "直接映射"),
    "start_date":         ("⚠️", "仅有所查日期，无运行计划生效起止日期"),
    "end_date":           ("❌", "无生效结束日期"),
    "run_rule":           ("❌", "无开行规律（每日/工作日/周末）——需多次采样日期推导"),
    "custom_run_days":    ("❌", "同上"),
    "station_num":        ("✅", "详情数组长度"),
    "total_mileage":      ("❌", "依赖 accumulated_mileage，同缺失"),
    "total_running_time": ("✅", "末站 running_time 转分钟"),
}
for field, (mark, note) in plan_mapping.items():
    print(f"  {mark} {field:22s} {note}")

# 7. TrainCreate
print("\n" + "=" * 60)
print("TrainCreate 字段覆盖度分析")
print("=" * 60)
for field, note in {
    "train_no": "✅ 直接映射",
    "train_code": "✅ station_train_code（列表已按车号聚合多车次码，如 G1001/G1002）",
    "train_type": "✅ 车次码首字母",
    "from_station": "✅ 列表 from_station 查电报码",
    "to_station": "✅ 列表 to_station 查电报码",
}.items():
    print(f"  {field:16s} {note}")

# 8. 数据质量抽查：同 train_no 多车次码
from collections import defaultdict
by_no = defaultdict(set)
for t in train_list:
    by_no[t["train_no"]].add(t["station_train_code"])
multi = {k: v for k, v in by_no.items() if len(v) > 1}
print(f"\n=== 数据质量抽查 ===")
print(f"  同一 train_no 挂多个车次码: {len(multi)} 个（跨线车次，如往返/延长交路）")
if multi:
    k = next(iter(multi))
    print(f"  示例: {k} -> {sorted(multi[k])}")
# 详情列表字段一致性
print(f"  详情样本数: {len(details)}, 平均站数: {sum(len(d['data']) for d in details)/len(details):.1f}")
