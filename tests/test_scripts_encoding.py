# -*- coding: utf-8 -*-
"""脚本编码自检：**含中文的脚本必须带对编码**（纯标准库，不联网）。

规则（每条都是真实踩出来的）：

  · `.ps1` / `.vbs` 含非 ASCII ⇒ **必须带 UTF-8 BOM**
    Windows PowerShell 5.1 / WScript 读无 BOM 的脚本时按系统 ANSI（这里是 GBK）解码，
    中文注释的多字节字符会破坏解析 —— 而且报错位置会漂移到几十行之后，极难排查。
    真实项目里踩了两次：一次 `health.ps1`（改了文件忘了补 BOM），一次 `pack.ps1`（本来就是无 BOM 的）。

  · `.cmd` / `.bat` **不能含非 ASCII**
    cmd.exe 按 OEM 码页读批处理，中文会吞掉 CR 把下一条命令并进 rem 行；
    给它加 BOM 更糟（cmd 会把 BOM 当成命令的一部分）。

跑法（在技能根目录）：
    python -m unittest discover -s tests -v
    python tests/test_scripts_encoding.py
"""
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BOM = b"\xef\xbb\xbf"
SKIP_DIRS = {".git", "__pycache__", "node_modules", "_versions", "logs"}
NEEDS_BOM = {".ps1", ".vbs"}      # 含中文 ⇒ 必须有 BOM
MUST_BE_ASCII = {".cmd", ".bat"}  # 一律不许有中文


def scripts():
    for path in ROOT.rglob("*"):
        if not path.is_file() or path.suffix.lower() not in (NEEDS_BOM | MUST_BE_ASCII):
            continue
        if any(part in SKIP_DIRS for part in path.parts):
            continue
        yield path


def has_non_ascii(raw: bytes) -> bool:
    return any(b > 0x7F for b in raw)


class TestScriptEncoding(unittest.TestCase):
    def test_scripts_found(self):
        """自检脚本自己也要有人看着：一个都扫不到说明规则写错了"""
        found = list(scripts())
        self.assertGreaterEqual(len(found), 5, f"只扫到 {len(found)} 个脚本")

    def test_chinese_ps1_and_vbs_have_bom(self):
        bad = []
        for path in scripts():
            if path.suffix.lower() not in NEEDS_BOM:
                continue
            raw = path.read_bytes()
            if has_non_ascii(raw) and not raw.startswith(BOM):
                bad.append(path.relative_to(ROOT).as_posix())
        self.assertEqual(
            bad, [],
            "这些脚本含中文却没有 UTF-8 BOM（PS 5.1 会按 GBK 读、解析出错）：\n  " + "\n  ".join(bad),
        )

    def test_no_duplicate_bom(self):
        """BOM 只能有一个：写两遍会让 PowerShell 在第一个字符处就报错（2026-09-21 真踩过 ——
        补 BOM 时先按 utf-8 读、又按 utf-8-sig 写，于是变成 `EF BB BF EF BB BF`）"""
        bad = []
        for path in scripts():
            if path.read_bytes().startswith(BOM * 2):
                bad.append(path.relative_to(ROOT).as_posix())
        self.assertEqual(bad, [], "这些脚本有重复 BOM：\n  " + "\n  ".join(bad))

    def test_cmd_and_bat_are_ascii_only(self):
        bad = []
        for path in scripts():
            if path.suffix.lower() not in MUST_BE_ASCII:
                continue
            if has_non_ascii(path.read_bytes()):
                bad.append(path.relative_to(ROOT).as_posix())
        self.assertEqual(
            bad, [],
            "这些批处理文件含非 ASCII（cmd.exe 按 OEM 码页读，中文会破坏解析）：\n  " + "\n  ".join(bad),
        )


if __name__ == "__main__":
    unittest.main(verbosity=2)
