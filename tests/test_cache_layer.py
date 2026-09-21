# -*- coding: utf-8 -*-
"""
采集与缓存层的**断言级**回归测试（只用标准库，无需 pytest；不需要 SDK、不联网、不发群）。

跑法（在技能根目录）：
    python -m unittest discover -s tests -v
    python tests/test_cache_layer.py

为什么值得写：这一层最危险的不是"崩"，而是**悄悄坏** ——
  · 采集失败却把「数据时间」刷新了 → 陈旧告警永远不触发（看起来一切正常）
  · 查询要求「最近一次采集成功」才肯用缓存 → 平台一挂，手里那份好数据也不给用
  · 保留期清理的日期比较写反 → 把全部留档删掉，而且悄无声息
这三条在真实项目里都各写过一次，所以每条都留一个断言钉住。

沙箱：每个测试在临时目录里搭一套最小环境 —— 拷 `assets/fastlane.mjs`、生成一份最小
`commands.json`，取数脚本直接复用 `examples/adapter-api.py --demo`（它本来就满足契约，
且完全离线）。没有 Node 就整体 skip：这一层的能力在 Node 侧。
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / "assets"
EXAMPLES = ROOT / "examples"


def find_node():
    """按优先级找 node：本技能专用环境变量 → PATH → 常见安装位置"""
    for cand in (os.environ.get("WECOM_FASTLANE_NODE"), shutil.which("node"), r"D:\nodejs\node.exe"):
        if cand and Path(cand).exists():
            return str(cand)
    return None


NODE = find_node()


def iso_minutes_ago(minutes: int) -> str:
    """ISO 时间戳，形如 2026-09-21T02:00:00.000Z（与程序写入的格式一致）"""
    t = datetime.now(timezone.utc) - timedelta(minutes=minutes)
    return t.isoformat(timespec="milliseconds").replace("+00:00", "Z")


class CacheLayerBase(unittest.TestCase):
    """搭一个最小沙箱：<tmp>\\fastlane.mjs + commands.json（snapshots/ history/ 由程序自己建）"""

    def setUp(self):
        if not NODE:
            self.skipTest("找不到 node，跳过通道层（Node 侧）测试")
        self.source = "sample"
        self.tmp = Path(tempfile.mkdtemp(prefix="fastlane-cache-test-"))
        shutil.copy2(ASSETS / "fastlane.mjs", self.tmp / "fastlane.mjs")
        self.write_config()

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def write_config(self, exe=None, chats=None):
        """写一份最小命令表；exe 传一个不存在的路径就能模拟『采集必失败』"""
        cfg = {
            "botId": "aibTESTTESTTESTTESTTESTTEST",
            "secretEnv": "WECOM_FASTLANE_SECRET_TEST",
            "secretFile": "secret-does-not-exist.txt",
            "allowedUsers": ["tester"],
            "allowedChats": [],
            "groups": {},
            "collect": {"enabled": True, "everyMinutes": 10, "startDelaySeconds": 30},
            "freshness": {"staleMinutes": 30, "maxAgeMinutes": 180},
            "history": {"enabled": True, "keepDays": 14, "graceFactor": 2.5},
            "alerts": {
                "enabled": True,
                "consecutiveFailures": 3,
                "cooldownMinutes": 60,
                "dryRun": False,
                "stale": {
                    "enabled": True,
                    "afterMinutes": 30,
                    "cooldownMinutes": 180,
                    # chats 故意留空：告警只写日志，测试永远不会往任何群发消息
                    "chats": chats or [],
                    "dryRun": False,
                },
            },
            "commands": [
                {
                    "id": "sample",
                    "label": "样例数据",
                    "snapshot": self.source,
                    # 触发词故意用 ASCII：--query 是按**触发词**（match）解析的，不认 id；
                    # 这里要测的是缓存逻辑，不该把中文参数的编码问题混进来
                    "match": ["sample"],
                    "chats": [],
                    "cwd": str(EXAMPLES),
                    "exe": exe or sys.executable,
                    "args": ["-X", "utf8", str(EXAMPLES / "adapter-api.py"), "--demo"],
                    "extract": "separator",
                    "timeoutMs": 60000,
                }
            ],
        }
        (self.tmp / "commands.json").write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")

    # ---- 小工具 -------------------------------------------------------
    def fastlane(self, *args, timeout=120):
        p = subprocess.run(
            [NODE, str(self.tmp / "fastlane.mjs"), *args],
            capture_output=True, text=True, encoding="utf-8", errors="replace",
            timeout=timeout, cwd=str(self.tmp),
        )
        return p.returncode, p.stdout, p.stderr

    def snapshot_path(self, source=None):
        return self.tmp / "snapshots" / f"{source or self.source}.json"

    def read_snapshot(self, source=None):
        return json.loads(self.snapshot_path(source).read_text(encoding="utf-8"))

    def write_snapshot(self, snap):
        self.snapshot_path().write_text(json.dumps(snap, ensure_ascii=False, indent=2), encoding="utf-8")

    def history_lines(self, day=None):
        day = day or date.today().isoformat()
        p = self.tmp / "history" / self.source / f"{day}.jsonl"
        if not p.exists():
            return []
        return [l for l in p.read_text(encoding="utf-8").splitlines() if l.strip()]

    def collect_log(self):
        p = self.tmp / "logs" / "collect.log"
        return p.read_text(encoding="utf-8") if p.exists() else ""


class TestCollect(CacheLayerBase):
    def test_collect_writes_snapshot_and_history(self):
        rc, out, err = self.fastlane("--collect")
        self.assertEqual(rc, 0, msg=out + err)

        snap = self.read_snapshot()
        self.assertTrue(snap["ok"], "采集应当成功")
        self.assertIn("###", snap["markdown"], "正文应当是渲染好的 markdown")
        self.assertIn("captured_at", snap)
        self.assertIn("last_attempt_at", snap)

        lines = self.history_lines()
        self.assertEqual(len(lines), 1, "历史应当有一行")
        rec = json.loads(lines[0])
        self.assertTrue(rec["ok"])
        self.assertIn("markdown", rec)

    def test_history_appends_instead_of_overwriting(self):
        self.fastlane("--collect")
        self.fastlane("--collect")
        self.assertEqual(len(self.history_lines()), 2, "留档是 append-only，不是覆盖写")

    def test_collect_single_source_filter(self):
        rc, out, err = self.fastlane("--collect", "sample")
        self.assertEqual(rc, 0, msg=out + err)
        self.assertTrue(self.snapshot_path().exists())
        rc, out, _ = self.fastlane("--collect", "不存在的源")
        self.assertNotEqual(rc, 0, "筛不到源应当如实报失败，而不是假装成功")


class TestQueryPath(CacheLayerBase):
    def test_query_reads_cache(self):
        self.fastlane("--collect")
        rc, out, _ = self.fastlane("--query", "sample")
        self.assertEqual(rc, 0)
        self.assertIn("读缓存", out)
        self.assertIn("数据时间", out)
        self.assertNotIn("现场抓取", out)

    def test_query_falls_back_without_snapshot(self):
        """没有缓存时的行为必须与改造前一致：现场抓取，而不是答不出来"""
        rc, out, _ = self.fastlane("--query", "sample")
        self.assertEqual(rc, 0)
        self.assertIn("现场抓取", out)
        self.assertIn("实时取数", out)

    def test_failed_collect_keeps_data_time_and_still_serves(self):
        """坑 1 + 坑 2 的合并回归（见 references/11 §5）"""
        self.fastlane("--collect")
        before = self.read_snapshot()

        # 让采集必失败：解释器指向不存在的路径
        self.write_config(exe=str(self.tmp / "no-such-python.exe"))
        rc, out, err = self.fastlane("--collect")
        self.assertNotEqual(rc, 0, "采集失败应当如实反映在退出码上")

        after = self.read_snapshot()
        self.assertFalse(after["ok"])
        self.assertEqual(after["fails"], 1)
        self.assertEqual(after["captured_at"], before["captured_at"], "失败绝不能推进『数据时间』")
        self.assertNotEqual(after["last_attempt_at"], before["last_attempt_at"], "『上次尝试』应当推进")
        self.assertEqual(after["markdown"], before["markdown"], "失败要保留上一份好数据")

        # 而且查询仍然答得出 —— 不许因为『最近一次失败』就拒绝用缓存
        rc, out, _ = self.fastlane("--query", "sample")
        self.assertEqual(rc, 0)
        self.assertIn("读缓存", out)
        self.assertIn("数据时间", out)


class TestFreshness(CacheLayerBase):
    def test_stale_warning_appears_after_threshold(self):
        self.fastlane("--collect")
        snap = self.read_snapshot()
        snap["captured_at"] = iso_minutes_ago(45)  # 超过 freshness.staleMinutes = 30
        self.write_snapshot(snap)
        rc, out, _ = self.fastlane("--query", "sample")
        self.assertIn("读缓存", out)
        self.assertIn("未更新", out, "超过陈旧线应当在正文里加一行警告")

    def test_too_old_snapshot_falls_back_to_live(self):
        self.fastlane("--collect")
        snap = self.read_snapshot()
        snap["captured_at"] = iso_minutes_ago(400)  # 超过 freshness.maxAgeMinutes = 180
        self.write_snapshot(snap)
        rc, out, _ = self.fastlane("--query", "sample")
        self.assertIn("现场抓取", out, "太旧就该回退现场抓取，而不是一直拿旧数据答")


class TestStaleAlert(CacheLayerBase):
    def test_stale_check_flags_only_old_snapshots(self):
        self.fastlane("--collect")
        rc, out, _ = self.fastlane("--stale-check")
        self.assertEqual(rc, 0)
        self.assertNotIn("★ 会告警", out, "刚采完不该告警")

        snap = self.read_snapshot()
        snap["captured_at"] = iso_minutes_ago(120)
        snap["ok"] = False
        snap["fails"] = 3
        snap["error"] = "模拟：平台 502"
        self.write_snapshot(snap)

        rc, out, _ = self.fastlane("--stale-check")
        self.assertIn("★ 会告警", out)
        self.assertIn("采集器数据陈旧", out)
        self.assertIn("数据时间", out)
        self.assertIn("平台 502", out, "告警正文要带上失败原因，否则收到告警也不知道从哪查")

    def test_stale_selftest_covers_boundaries(self):
        rc, out, _ = self.fastlane("--stale-selftest")
        self.assertEqual(rc, 0)
        self.assertIn("冷却中", out)
        self.assertIn("从来没有采集成功过", out)
        self.assertIn("不告警", out)

    def test_stale_alert_never_touches_a_chat_when_chats_empty(self):
        """chats 留空时，告警只能落到日志里 —— 这条是防止"测试误推真群"的护栏"""
        self.fastlane("--collect")
        snap = self.read_snapshot()
        snap["captured_at"] = iso_minutes_ago(120)
        self.write_snapshot(snap)
        # 走一遍会触发告警的判定（--stale-check 只打印、不推）
        rc, out, _ = self.fastlane("--stale-check")
        self.assertIn("会推送的正文", out)
        cfg = json.loads((self.tmp / "commands.json").read_text(encoding="utf-8"))
        self.assertEqual(cfg["alerts"]["stale"]["chats"], [], "测试沙箱不得配置任何推送目标")


class TestHistory(CacheLayerBase):
    def test_history_reports_gap(self):
        self.fastlane("--collect")
        # 在今天的留档前面插一条 2 小时前的记录 → 中间就是空档
        old = json.dumps({"at": iso_minutes_ago(120), "ok": True, "ms": 1, "markdown": "旧记录"})
        p = self.tmp / "history" / self.source / f"{date.today().isoformat()}.jsonl"
        p.write_text(old + "\n" + p.read_text(encoding="utf-8"), encoding="utf-8")

        rc, out, _ = self.fastlane("--history")
        self.assertEqual(rc, 0)
        self.assertIn("最长空档", out)
        self.assertIn("空档：", out)

    def test_prune_removes_expired_only(self):
        """会删文件的逻辑必须实测：日期比较写反了会删掉全部留档，而且悄无声息"""
        self.fastlane("--collect")
        today = self.tmp / "history" / self.source / f"{date.today().isoformat()}.jsonl"
        expired = today.parent / "2020-01-01.jsonl"
        future = today.parent / f"{(date.today() + timedelta(days=30)).isoformat()}.jsonl"
        expired.write_text('{"at":"2020-01-01T00:00:00.000Z","ok":true,"ms":1,"markdown":"x"}\n', encoding="utf-8")
        future.write_text('{"at":"2099-01-01T00:00:00.000Z","ok":true,"ms":1,"markdown":"x"}\n', encoding="utf-8")

        self.fastlane("--collect")

        self.assertFalse(expired.exists(), "超过 keepDays 的留档应当被清理")
        self.assertTrue(today.exists(), "今天的留档绝不能被删")
        self.assertTrue(future.exists(), "未来日期的文件不该被删（日期比较写反的信号）")


class TestExampleConfig(unittest.TestCase):
    """示例配置的静态检查：新用户是照着它抄的，字段一个都不能少"""

    def test_example_config_documents_new_blocks(self):
        cfg = json.loads((ASSETS / "commands.example.json").read_text(encoding="utf-8"))
        for key in ("collect", "freshness", "history", "alerts"):
            self.assertIn(key, cfg)
        self.assertIn("stale", cfg["alerts"])
        self.assertTrue(any("snapshot" in c for c in cfg["commands"]), "至少一条示例命令要带 snapshot")
        self.assertTrue(any("snapshot" not in c for c in cfg["commands"]), "也要留一条不带，说明可以一条一条地上")

    def test_snapshot_docs_mention_boundaries(self):
        """平台不给历史查询这件事必须写进文档 —— 否则下一个人会以为"补采"能回平台补数"""
        text = (ROOT / "references" / "11-采集与缓存.md").read_text(encoding="utf-8")
        self.assertIn("本地留档", text)
        self.assertIn("不给历史查询", text)


if __name__ == "__main__":
    unittest.main(verbosity=2)
