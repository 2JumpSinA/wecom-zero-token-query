# -*- coding: utf-8 -*-
"""操作手册 `.docx` 生成脚本的回归测试（需要 python-docx；没装就整体 skip）。

为什么值得测：docx 是**分发物**的一部分（给不懂技术的同事直接转发），而它是**生成物** ——
生成脚本一旦坏掉、或者手册 md 用了新语法，不会有任何人立刻发现（Word 照样能打开，
只是内容悄悄缺了）。所以断言的是"标题/表格都还在、且样式是对的"，而不是"文件存在"。

跑法（在技能根目录）：
    python -m unittest discover -s tests -v
    python tests/test_manual_docx.py
"""
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "build_manual_docx.py"
MANUAL = ROOT / "docs" / "标准操作手册.md"

try:
    import docx  # noqa: F401
    HAS_DOCX = True
except ImportError:  # pragma: no cover
    HAS_DOCX = False


def markdown_table_data_rows(text: str) -> int:
    """md 里的表格明细行数 = 以 | 开头的行，减掉每个表的分隔行（|---|）"""
    rows = 0
    for line in text.split("\n"):
        s = line.strip()
        if not s.startswith("|"):
            continue
        cells = [c.strip() for c in s.strip("|").split("|")]
        if cells and all(re.match(r"^:?-{2,}:?$", c) for c in cells if c):
            continue          # 分隔行
        rows += 1
    return rows


@unittest.skipUnless(HAS_DOCX, "没装 python-docx，跳过 docx 生成测试")
class TestManualDocx(unittest.TestCase):
    """生成一次，三个断言共用（生成一次要一两秒，别每个 test 都跑）"""

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory(prefix="manual-docx-test-")
        cls.out = Path(cls.tmp.name) / "manual.docx"
        proc = subprocess.run(
            [sys.executable, "-X", "utf8", str(SCRIPT), str(MANUAL), "-o", str(cls.out)],
            capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=300,
        )
        cls.proc = proc
        from docx import Document

        cls.doc = Document(str(cls.out)) if cls.out.exists() else None

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def test_script_exits_zero_and_writes_file(self):
        self.assertEqual(self.proc.returncode, 0, msg=self.proc.stdout + self.proc.stderr)
        self.assertIsNotNone(self.doc, "应当生成 docx")

    def test_headings_use_real_heading_styles(self):
        """旧版手册的标题是手动排版的普通段落，Word 导航窗格里看不到结构 —— 别退回去"""
        styles = {p.style.name for p in self.doc.paragraphs}
        self.assertIn("Heading 1", styles)
        self.assertIn("Heading 2", styles)
        self.assertIn("Heading 3", styles)
        h2 = [p for p in self.doc.paragraphs if p.style.name == "Heading 2"]
        h3 = [p for p in self.doc.paragraphs if p.style.name == "Heading 3"]
        # 下界断言：手册章节只会增不会减，改标题名也不至于让测试误报
        self.assertGreaterEqual(len(h2), 15)
        self.assertGreaterEqual(len(h3), 20)

    def test_tables_keep_every_row(self):
        """表格掉行是最隐蔽的失败：Word 里看着是张表，只是少了几行"""
        expected = markdown_table_data_rows(MANUAL.read_text(encoding="utf-8"))
        actual = sum(len(t.rows) for t in self.doc.tables)
        self.assertEqual(actual, expected, f"表格行数应为 {expected}")

    def test_ends_with_generated_notice(self):
        """文末的『这是生成物』说明不能丢：否则有人会直接编辑 docx，下次重生成就白改了"""
        self.assertIn("自动生成", self.doc.paragraphs[-1].text)


if __name__ == "__main__":
    unittest.main(verbosity=2)
