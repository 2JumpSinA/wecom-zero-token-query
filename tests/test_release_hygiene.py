# -*- coding: utf-8 -*-
"""发版卫生的断言级回归（只读、不联网、不打包）。

钉住三类「踩过一次就不能再犯」的事（2026-10-20 发版前审计）：
  1. 仓库里所有 .py 必须能 ast.parse —— v2.3.7 曾把带语法错误的
     assets/_preview_check.py 打进 zip，而 CI 只跑 tests/，抓不到；
  2. webhooks.json 带 UTF-8 BOM 时仍可读 —— 记事本 / PowerShell 5.1
     写出来的就是带 BOM 的，用 utf-8 读会 JSONDecodeError；
  3. pack.ps1 与 .gitignore 的敏感项清单必须覆盖凭据与采集结果 ——
     漏一项就等于在跑过实例的目录里把 key / 业务数据打进公开 zip。

跑法（技能根目录）：
    python -m unittest discover -s tests -v
    python tests/test_release_hygiene.py
"""
import ast
import importlib.util
import json
import shutil
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

# 这些名字必须同时出现在 pack.ps1 的排除清单与 .gitignore 里
REQUIRED_IN_LISTS = [
    "snapshots",
    "history",
    "webhooks.json",
    "secret.txt",
    "commands.json",
    ".access_token.json",
    ".env",
]

FAKE_UUID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"


class TestPythonAssetsParse(unittest.TestCase):
    def test_every_python_file_parses(self):
        bad = []
        for p in sorted(ROOT.rglob("*.py")):
            if {".git", "__pycache__"} & set(p.parts):
                continue
            try:
                ast.parse(p.read_text(encoding="utf-8-sig"), filename=str(p))
            except SyntaxError as e:
                bad.append(f"{p.relative_to(ROOT)}:{e.lineno} {e.msg}")
        self.assertEqual(bad, [], "以下 .py 不能编译：" + "; ".join(bad))


class TestWebhookHooksBom(unittest.TestCase):
    def test_bom_prefixed_hooks_json_is_readable(self):
        tmp = Path(tempfile.mkdtemp(prefix="bom-hooks-"))
        try:
            hooks_dir = tmp / "hooks"
            hooks_dir.mkdir()
            shutil.copy2(ROOT / "assets" / "webhook_key.py", hooks_dir / "webhook_key.py")
            payload = json.dumps({"hooks": {"quanyi": {"key": FAKE_UUID}}}, ensure_ascii=False, indent=2)
            # 记事本「另存为 UTF-8」/ PowerShell 5.1 Set-Content -Encoding utf8 都会带 BOM
            (hooks_dir / "webhooks.json").write_bytes(b"\xef\xbb\xbf" + payload.encode("utf-8"))

            spec = importlib.util.spec_from_file_location("wk_bom", hooks_dir / "webhook_key.py")
            mod = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(mod)
            self.assertEqual(mod.webhook_key("quanyi"), FAKE_UUID)
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


class TestReleaseHygieneLists(unittest.TestCase):
    def test_pack_excludes_credentials_and_data(self):
        text = (ROOT / "scripts" / "pack.ps1").read_text(encoding="utf-8-sig")
        missing = [n for n in REQUIRED_IN_LISTS if n not in text]
        self.assertEqual(missing, [], f"pack.ps1 的排除/断言清单缺少：{missing}")

    def test_gitignore_covers_credentials_and_data(self):
        text = (ROOT / ".gitignore").read_text(encoding="utf-8-sig")
        missing = [n for n in REQUIRED_IN_LISTS if n not in text]
        self.assertEqual(missing, [], f".gitignore 缺少：{missing}")


if __name__ == "__main__":
    unittest.main()
