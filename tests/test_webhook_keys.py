# -*- coding: utf-8 -*-
"""webhook key 收拢的**断言级**回归测试（只用标准库，无需 pytest；不联网、不发消息）。

跑法（在技能根目录）：
    python -m unittest discover -s tests -v
    python tests/test_webhook_keys.py

测什么：
  1. `assets/webhook_key.py` 的读取契约 —— 文件读取、环境变量优先、拼 URL、
     以及**读不到时必须报错**（这一条最关键：返回空 key 会让故障静默化）
  2. `assets/check_webhook_keys.py` 真的能发现问题 —— 干净沙箱判过、埋一个写死的 key 判不过，
     而且 `webhooks.json` 自己不算命中

测试里一律用**假的** UUID，真实 key 绝不进技能仓库。
"""
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / "assets"

FAKE_UUID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
FAKE_UUID_2 = "11111111-2222-3333-4444-555555555555"
TEMPLATE = "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key={}"


def load_webhook_key_module(hooks_dir: Path):
    """从指定目录加载 webhook_key.py（这样 WECOM_HOOKS_FILE 的默认值就是沙箱里的那份）"""
    spec = importlib.util.spec_from_file_location("wk_sandbox", hooks_dir / "webhook_key.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class SandboxBase(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="webhook-keys-test-"))
        self.hooks_dir = self.tmp / "hooks"
        self.hooks_dir.mkdir()
        shutil.copy2(ASSETS / "webhook_key.py", self.hooks_dir / "webhook_key.py")
        self.write_hooks({"quanyi": {"key": FAKE_UUID, "label": "测试群A"}})
        self.wk = load_webhook_key_module(self.hooks_dir)

    def tearDown(self):
        for env in list(os.environ):
            if env.startswith("WECOM_HOOK"):
                os.environ.pop(env, None)
        shutil.rmtree(self.tmp, ignore_errors=True)

    def write_hooks(self, hooks):
        (self.hooks_dir / "webhooks.json").write_text(
            json.dumps({"hooks": hooks}, ensure_ascii=False, indent=2), encoding="utf-8"
        )

    def run_check(self, *roots, hooks_file=None):
        cmd = [sys.executable, "-X", "utf8", str(ASSETS / "check_webhook_keys.py")]
        cmd += [str(r) for r in (roots or [self.tmp])]
        cmd += ["--hooks-file", str(hooks_file or (self.hooks_dir / "webhooks.json"))]
        p = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8",
                           errors="replace", timeout=120)
        return p.returncode, p.stdout


class TestWebhookKeyModule(SandboxBase):
    def test_reads_key_and_builds_url(self):
        self.assertEqual(self.wk.webhook_key("quanyi"), FAKE_UUID)
        self.assertEqual(self.wk.webhook_url("quanyi"), TEMPLATE.format(FAKE_UUID))

    def test_env_var_overrides_file(self):
        os.environ["WECOM_HOOK_QUANYI"] = FAKE_UUID_2
        self.assertEqual(self.wk.webhook_key("quanyi"), FAKE_UUID_2)

    def test_unknown_name_fails_loudly(self):
        """返回空 key 会把故障变成"发送失败"，真正的原因（名字写错）就看不见了"""
        with self.assertRaises(self.wk.HookConfigError) as ctx:
            self.wk.webhook_key("nosuch")
        self.assertIn("nosuch", str(ctx.exception))

    def test_missing_file_fails_loudly(self):
        (self.hooks_dir / "webhooks.json").unlink()
        with self.assertRaises(self.wk.HookConfigError):
            self.wk.webhook_key("quanyi")

    def test_broken_json_fails_loudly(self):
        (self.hooks_dir / "webhooks.json").write_text("{not json", encoding="utf-8")
        with self.assertRaises(self.wk.HookConfigError):
            self.wk.webhook_key("quanyi")

    def test_missing_hooks_section_fails_loudly(self):
        (self.hooks_dir / "webhooks.json").write_text(json.dumps({"hooks": {}}), encoding="utf-8")
        with self.assertRaises(self.wk.HookConfigError):
            self.wk.webhook_key("quanyi")

    def test_env_file_override(self):
        """WECOM_HOOKS_FILE 能把读取位置指到别处（换机器部署时常用）"""
        other = self.tmp / "elsewhere.json"
        other.write_text(json.dumps({"hooks": {"quanyi": {"key": FAKE_UUID_2}}}), encoding="utf-8")
        os.environ["WECOM_HOOKS_FILE"] = str(other)
        self.assertEqual(self.wk.webhook_key("quanyi"), FAKE_UUID_2)


class TestCheckScript(SandboxBase):
    def test_clean_tree_passes(self):
        (self.tmp / "app.py").write_text(
            "import sys\nsys.path.insert(0, 'hooks')\n"
            "from webhook_key import webhook_url\nWEBHOOK = webhook_url('quanyi')\n",
            encoding="utf-8",
        )
        rc, out = self.run_check()
        self.assertEqual(rc, 0, msg=out)
        self.assertIn("PASS", out)
        self.assertIn("0 处", out)

    def test_hardcoded_key_is_caught(self):
        bad = self.tmp / "old_script.py"
        bad.write_text(f"WEBHOOK = '{TEMPLATE.format(FAKE_UUID)}'\n", encoding="utf-8")
        rc, out = self.run_check()
        self.assertEqual(rc, 1, msg=out)
        self.assertIn("old_script.py", out)
        self.assertIn("FAIL", out)

    def test_hooks_file_itself_is_not_a_hit(self):
        """webhooks.json 本来就该含明文 key；它自己不能算命中，否则自检永远过不了"""
        rc, out = self.run_check()
        self.assertEqual(rc, 0, msg=out)

    def test_placeholder_is_not_a_hit(self):
        (self.tmp / "doc.md.txt").write_text("", encoding="utf-8")
        (self.tmp / "example.py").write_text(
            "TMPL = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key={key}'\n"
            "DOC = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=<你的key>'\n",
            encoding="utf-8",
        )
        rc, out = self.run_check()
        self.assertEqual(rc, 0, msg=out)

    def test_archive_and_logs_are_skipped(self):
        arch = self.tmp / "_archive"
        arch.mkdir()
        (arch / "old.py").write_text(f"WEBHOOK = '{TEMPLATE.format(FAKE_UUID)}'\n", encoding="utf-8")
        logs = self.tmp / "logs"
        logs.mkdir()
        (logs / "accidental.py").write_text(f"WEBHOOK = '{TEMPLATE.format(FAKE_UUID)}'\n", encoding="utf-8")
        rc, out = self.run_check()
        self.assertEqual(rc, 0, msg=out)

    def test_env_override_is_exercised(self):
        rc, out = self.run_check()
        self.assertIn("环境变量 WECOM_HOOK_QUANYI 覆盖生效", out)


if __name__ == "__main__":
    unittest.main(verbosity=2)
