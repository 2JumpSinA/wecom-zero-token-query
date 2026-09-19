# -*- coding: utf-8 -*-
"""
样板适配器的**断言级**回归测试（只用标准库，无需 pytest）。

跑法（在技能根目录）：
    python -m unittest discover -s tests -v
    python tests/test_adapters.py

测什么：
  1. 契约 —— 退出码为 0、正文夹在两条 ==== 之间、无 HTML 标签、有 ### 标题、口径行存在
  2. 逻辑 —— 各样板自己的计算/过滤是否真的对（不只是"能跑"）

为什么值得写：`--demo` 只能证明"不崩"，证明不了"算对了"。
今天这套东西里最容易悄悄坏掉的恰恰是**计算与过滤**（占比、台账剔除、字段映射），
它们坏了不会报错，只会让群里出现一个看起来正常的错数字。
"""
import json
import os
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
EXAMPLES = ROOT / "examples"
SEPARATOR = re.compile(r"^\s*={10,}\s*$", re.M)
HTML_TAG = re.compile(r"</?[a-zA-Z][^>\n]{0,60}>")


def run_adapter(name, *args, env=None):
    """跑一个适配器，返回 (returncode, stdout)"""
    full_env = dict(os.environ)
    full_env.setdefault("PYTHONIOENCODING", "utf-8")
    if env:
        full_env.update(env)
    p = subprocess.run(
        [sys.executable, "-X", "utf8", str(EXAMPLES / name), *args],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
        timeout=60, env=full_env,
    )
    return p.returncode, p.stdout, p.stderr


def payload_of(stdout: str) -> str:
    """按通道的规则取正文：最后两条分隔线之间"""
    lines = stdout.replace("\r\n", "\n").split("\n")
    marks = [i for i, l in enumerate(lines) if SEPARATOR.match(l)]
    if len(marks) < 2:
        return ""
    return "\n".join(lines[marks[-2] + 1:marks[-1]]).strip()


ADAPTERS = ["adapter-api.py", "adapter-private-api.py", "adapter-export-file.py"]


class TestContract(unittest.TestCase):
    """三条机器可验的契约（"预演不推送"由 assets/_preview_check.py 覆盖）"""

    def test_exit_code_zero(self):
        for name in ADAPTERS:
            with self.subTest(adapter=name):
                code, _, err = run_adapter(name, "--demo")
                self.assertEqual(code, 0, f"{name} 退出码非 0：{err[:200]}")

    def test_payload_extractable(self):
        for name in ADAPTERS:
            with self.subTest(adapter=name):
                _, out, _ = run_adapter(name, "--demo")
                payload = payload_of(out)
                self.assertTrue(payload, f"{name} 没能在两条 ==== 之间给出正文")

    def test_no_html_tags(self):
        for name in ADAPTERS:
            with self.subTest(adapter=name):
                _, out, _ = run_adapter(name, "--demo")
                hits = HTML_TAG.findall(payload_of(out))
                self.assertEqual(hits, [], f"{name} 正文含标签（智能机器人不认）：{hits}")

    def test_markdown_heading(self):
        for name in ADAPTERS:
            with self.subTest(adapter=name):
                _, out, _ = run_adapter(name, "--demo")
                self.assertTrue(payload_of(out).startswith("### "), f"{name} 正文没有 ### 标题")

    def test_caliber_line(self):
        """口径必须写进输出：群里看到数字却不知道统计范围，等于没有数据"""
        for name in ADAPTERS:
            with self.subTest(adapter=name):
                _, out, _ = run_adapter(name, "--demo")
                payload = payload_of(out)
                self.assertRegex(payload, r">\s*(统计时段|统计时间)", f"{name} 缺少口径行")


class TestAdapterLogic(unittest.TestCase):
    """各样板自己的计算/过滤 —— 这部分才是真正会悄悄算错的地方"""

    def test_api_sums_amounts(self):
        _, out, _ = run_adapter("adapter-api.py", "--demo")
        payload = payload_of(out)
        # demo 数据：1234.5 + 987.0 + 456.7 = 2678.2
        self.assertIn("2,678.20", payload, "金额合计算错了")
        self.assertIn("65", payload, "订单合计算错了（32+21+12=65）")

    def test_private_api_ratio(self):
        _, out, _ = run_adapter("adapter-private-api.py", "--demo")
        payload = payload_of(out)
        # demo：3 单中 2 单取消 → 66.7%
        self.assertIn("66.7%", payload, "取消占比算错了")
        self.assertIn("用户取消 1", payload, "原因归纳丢了")

    def test_export_excludes_known_offline(self):
        """台账剔除是这个样板最关键的逻辑：混进来就会天天报假异常"""
        with tempfile.TemporaryDirectory() as td:
            known = Path(td) / "known.json"
            known.write_text(json.dumps(["示例门店 B"], ensure_ascii=False), encoding="utf-8")
            code, out, err = run_adapter(
                "adapter-export-file.py", "--demo", env={"MY_KNOWN_OFFLINE": str(known)}
            )
            self.assertEqual(code, 0, err[:200])
            payload = payload_of(out)
            self.assertIn("已剔除已知 1 家", payload, "已知非异常没有被剔除")
            self.assertNotIn("示例门店 B", payload, "被剔除的门店仍然出现在异常列表里")

    def test_export_without_known_lists_anomaly(self):
        """不给台账时，闭店门店应当被列为异常（对照组，防止"永远剔除"的假通过）"""
        with tempfile.TemporaryDirectory() as td:
            code, out, _ = run_adapter(
                "adapter-export-file.py", "--demo",
                env={"MY_KNOWN_OFFLINE": str(Path(td) / "not-exist.json")},
            )
            self.assertEqual(code, 0)
            payload = payload_of(out)
            self.assertIn("异常未营业：1 家", payload)
            self.assertIn("示例门店 B", payload, "闭店门店没被识别为异常")


class TestFailurePath(unittest.TestCase):
    """失败路径也要验：坏输入必须给出非 0 退出码 + 人话原因，而不是静默返回 0 条"""

    def test_missing_credentials_fails_loudly(self):
        env = {k: "" for k in ("MY_API_USER", "MY_API_PASS", "MY_APP_KEY", "MY_APP_SECRET")}
        code, out, err = run_adapter("adapter-private-api.py", "--preview", env=env)
        self.assertNotEqual(code, 0, "缺少登录态时竟然返回了成功")
        combined = out + err
        self.assertTrue(
            "登录态" in combined or "凭据" in combined,
            f"失败信息不够「人话」：{combined[:200]}",
        )


if __name__ == "__main__":
    unittest.main(verbosity=2)
