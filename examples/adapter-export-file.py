#!/usr/bin/env python
# -*- coding: utf-8 -*-
r"""
样板适配器 C：导出文件（后台只能导出 Excel/CSV，或每天收到报表邮件的那类）。

适用：平台没有 API、也不想抓包，但能"导出"。
这类稳定性不错，**最大的坑不是读取，而是数据本身脏**：导出表里常混着
已闭店/待上线/测试店，不剔除就会天天报同一批假异常 —— 报警疲劳比不报警更糟。

要改的只有 4 处，标了 TODO。

契约：本脚本只打印、不发送任何消息（--preview 是给通道传的兼容参数）。
用法：
  python adapter-export-file.py                        # 读最新导出文件
  python adapter-export-file.py --file D:\x\报表.xlsx   # 指定文件
  python adapter-export-file.py --demo                 # 内置样例，不读文件（先打通链路）
"""
import argparse
import csv
import glob
import json
import os
import sys
from datetime import datetime

# ============================ TODO 1/4：文件来源与列名 ======================
# 1) 导出目录（后台导出默认落点，或邮件附件保存目录）
EXPORT_DIR = os.environ.get("MY_EXPORT_DIR", r"D:\exports")
# 2) 文件名匹配（按修改时间取最新那个）
FILE_PATTERN = "*.xlsx"
# 3) 列名映射：平台的表头 → 你的字段。**用列名而不是列号**，列顺序变了也不会错位。
COLUMNS = {
    "门店名称": "shop",
    "门店ID": "shop_id",
    "营业状态": "status",
    "订单数": "orders",
    "取消数": "cancelled",
}
# 4) 已知非异常清单（人工维护）：命中就整条剔除，不算异常
#    路径可用环境变量覆盖 —— 便于测试，也便于把清单放在共享目录
KNOWN_OFFLINE_FILE = os.environ.get(
    "MY_KNOWN_OFFLINE",
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "known_offline.json"),
)

NON_OPEN_STATES = ("闭店", "停业", "休息中", "下线", "待上线", "测试")


def emit(markdown: str) -> None:
    """契约 2：正文夹在两条 ==== 之间"""
    print()
    print("=" * 40)
    print(markdown)
    print("=" * 40)


def fail(msg: str) -> int:
    print(f"[失败] {msg}", file=sys.stderr)
    return 1


def latest_export() -> str:
    files = glob.glob(os.path.join(EXPORT_DIR, FILE_PATTERN))
    if not files:
        raise RuntimeError(f"在 {EXPORT_DIR} 里找不到 {FILE_PATTERN}（导出一次，或用 --file 指定）")
    return max(files, key=os.path.getmtime)


def load_rows(path: str) -> list:
    """读 xlsx 或 csv。csv 注意编码：国内后台导出常用 GBK。"""
    ext = os.path.splitext(path)[1].lower()
    if ext in (".xlsx", ".xlsm"):
        try:
            from openpyxl import load_workbook
        except ImportError:
            raise RuntimeError("读 xlsx 需要 openpyxl：pip install openpyxl")
        wb = load_workbook(path, read_only=True, data_only=True)
        ws = wb.active
        rows = list(ws.iter_rows(values_only=True))
        wb.close()
        if not rows:
            return []
        header = [str(c).strip() if c is not None else "" for c in rows[0]]
        return [dict(zip(header, r)) for r in rows[1:] if any(v is not None for v in r)]
    if ext in (".csv", ".txt"):
        for enc in ("utf-8-sig", "gbk", "utf-8"):
            try:
                with open(path, "r", encoding=enc, newline="") as f:
                    return list(csv.DictReader(f))
            except UnicodeDecodeError:
                continue
        raise RuntimeError("CSV 编码无法识别（试过 utf-8-sig / gbk / utf-8）")
    raise RuntimeError(f"不支持的文件类型：{ext}")


def map_row(raw: dict) -> dict:
    """按列名映射；缺列要显式报错，别静默当 0 —— 静默的 0 会被当成"业务正常"""
    out = {}
    missing = []
    for src, dst in COLUMNS.items():
        if src in raw:
            out[dst] = raw[src]
        else:
            missing.append(src)
    if missing:
        raise RuntimeError(f"导出文件缺少列：{'、'.join(missing)}（表头变了？实际表头：{'、'.join(list(raw)[:8])}）")
    return {
        "shop": str(out.get("shop") or "").strip(),
        "shop_id": str(out.get("shop_id") or "").strip(),
        "status": str(out.get("status") or "").strip(),
        "orders": to_int(out.get("orders")),
        "cancelled": to_int(out.get("cancelled")),
    }


def to_int(v) -> int:
    try:
        return int(float(str(v).strip() or 0))
    except (TypeError, ValueError):
        return 0


def load_known_offline() -> set:
    try:
        with open(KNOWN_OFFLINE_FILE, "r", encoding="utf-8") as f:
            return {str(x).strip() for x in json.load(f)}
    except Exception:
        return set()


def render(rows: list, src: str) -> str:
    known = load_known_offline()
    anomalies, excluded, unplanned = [], 0, 0
    for r in rows:
        if not r["shop"]:
            continue
        closed = any(s in r["status"] for s in NON_OPEN_STATES)
        if r["shop"] in known or r["shop_id"] in known:
            excluded += 1
            continue
        if closed:
            anomalies.append(r)
        elif r["orders"] == 0:
            unplanned += 1
    lines = [
        "### 门店营业情况播报（样板 C · 导出文件）",
        "> 项目：示例项目",
        f"> 统计时间：{datetime.now().strftime('%Y-%m-%d %H:%M')}",
        f"> 数据来源：{os.path.basename(src)}",
        f"> 门店总数：{len(rows)}（已剔除已知 {excluded} 家）",
        f"> 异常未营业：{len(anomalies)} 家" + (f" —— {'、'.join(r['shop'] for r in anomalies[:3])}" if anomalies else ""),
        f"> 未规划（今日 0 单）：{unplanned} 家",
    ]
    return "\n".join(lines)


def demo_rows() -> list:
    return [
        {"门店名称": "示例门店 A", "门店ID": "S001", "营业状态": "营业中", "订单数": 12, "取消数": 1},
        {"门店名称": "示例门店 B", "门店ID": "S002", "营业状态": "闭店", "订单数": 0, "取消数": 0},
        {"门店名称": "示例门店 C", "门店ID": "S003", "营业状态": "营业中", "订单数": 0, "取消数": 0},
    ]


def main() -> int:
    ap = argparse.ArgumentParser(description="样板适配器 C · 导出文件")
    ap.add_argument("--preview", action="store_true", help="契约兼容参数（本脚本不发消息）")
    ap.add_argument("--demo", action="store_true", help="用内置样例数据，不读文件")
    ap.add_argument("--file", default="", help="指定导出文件；不填则取导出目录里最新的")
    args = ap.parse_args()

    try:
        if args.demo:
            print("[demo] 使用内置样例数据")
            rows = [map_row(r) for r in demo_rows()]
            src = "(demo)"
        else:
            path = args.file or latest_export()
            print(f"[读取] {path}")
            rows = [map_row(r) for r in load_rows(path)]
            src = path
        emit(render(rows, src))
        return 0
    except Exception as e:
        return fail(f"{type(e).__name__}: {e}")


if __name__ == "__main__":
    sys.exit(main())
