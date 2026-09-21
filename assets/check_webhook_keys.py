# -*- coding: utf-8 -*-
"""webhook key 收拢自检：证明「key 只在一处」。不联网、不发消息。

用法（在部署目录里跑）：

    python check_webhook_keys.py                    # 扫描当前目录
    python check_webhook_keys.py D:\\my-project       # 扫描指定目录（可多个）
    python check_webhook_keys.py --hooks-file D:\\tools\\wecom-hooks\\webhooks.json .

检查三件事：

  1) `webhooks.json` 形状正确，每个 hook 都能拼出完整 URL（顺带验证读取模块可用）
  2) 扫描范围内，**除了 `webhooks.json` 自己**，没有任何文件写着明文 webhook key
     —— 这是「收拢完成」的通用判据：漏一处，轮换 key 时就会有一个脚本静默失效
  3) 环境变量覆盖能生效（`WECOM_HOOK_<NAME>`）

退出码：0 = 全过；1 = 有失败（可以直接挂进 CI / 体检脚本）。

为什么值得单独写一个自检：key 收拢这类重构最容易的失败不是"改错了"，
而是"改漏了一处"—— 而那处要等到下一次轮换 key 时才暴露（那时候谁都记不起还有它）。
本文件与 `webhook_key.py` 配套，见 `references/09-本地化部署.md` §4.1。
"""
import argparse
import importlib.util
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_HOOKS = os.path.join(HERE, "webhooks.json")

SKIP_DIRS = {".git", "logs", "__pycache__", "node_modules", "runtime", ".venv",
             "venv", "_archive", "_versions", "site-packages", ".idea", ".vscode"}
SCAN_EXTS = {".py", ".json", ".ps1", ".bat", ".cmd", ".vbs", ".mjs", ".js",
             ".yaml", ".yml", ".ini", ".cfg", ".toml", ".sh"}

# 写死的 webhook key 长这样；`key={key}` 这类模板不算（占位符本来就不是 16 进制）
LITERAL_KEY = re.compile(r"webhook/send\?key=(?!\{)[0-9a-fA-F-]{20,}")
UUID_LIKE = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")

ok = 0
bad = 0


def report(good: bool, name: str, detail: str = "") -> None:
    global ok, bad
    if good:
        ok += 1
    else:
        bad += 1
    print(f"  [{'PASS' if good else 'FAIL'}] {name:<38} {detail}")


def load_module(hooks_file: str):
    """按文件路径加载同目录的 webhook_key.py（不依赖 cwd / sys.path）"""
    path = os.path.join(os.path.dirname(os.path.abspath(hooks_file)), "webhook_key.py")
    if not os.path.exists(path):
        path = os.path.join(HERE, "webhook_key.py")
    spec = importlib.util.spec_from_file_location("webhook_key", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def walk(roots):
    for root in roots:
        for dirpath, dirnames, filenames in os.walk(root):
            dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
            for fn in filenames:
                if os.path.splitext(fn)[1].lower() in SCAN_EXTS:
                    yield os.path.join(dirpath, fn)


def main() -> int:
    ap = argparse.ArgumentParser(description="webhook key 收拢自检（不联网、不发消息）")
    ap.add_argument("roots", nargs="*", default=["."], help="要扫描的目录（默认当前目录）")
    ap.add_argument("--hooks-file", default=DEFAULT_HOOKS, help="webhooks.json 路径")
    args = ap.parse_args()

    roots = [os.path.abspath(r) for r in (args.roots or ["."])]
    hooks_file = os.path.abspath(args.hooks_file)

    print("=== webhook key 收拢自检 ===")
    print(f"配置文件：{hooks_file}")
    print(f"扫描范围：{', '.join(roots)}")
    print(f"（跳过：{', '.join(sorted(SKIP_DIRS))}）\n")

    print("[1] 配置文件与读取模块")
    try:
        wk = load_module(hooks_file)
        hooks = wk.load_hooks(hooks_file)
        report(True, "webhooks.json 可读", f"{len(hooks)} 个 hook：{', '.join(sorted(hooks))}")
    except Exception as e:  # noqa: BLE001
        report(False, "webhooks.json 可读", f"{type(e).__name__}: {e}")
        print("\n结论：配置都读不到，后面的检查没有意义。")
        return 1

    for name in sorted(hooks):
        entry = hooks[name] if isinstance(hooks[name], dict) else {}
        key = str(entry.get("key") or "")
        report(bool(UUID_LIKE.match(key)), f"hook「{name}」的 key 形状", (key[:6] + "…") if key else "（空）")
        try:
            url = wk.webhook_url(name)
            report(url.endswith(key) and key != "", f"hook「{name}」能拼出地址", url.replace(key, key[:6] + "…"))
        except Exception as e:  # noqa: BLE001
            report(False, f"hook「{name}」能拼出地址", f"{type(e).__name__}: {e}")

    # 环境变量覆盖
    first = sorted(hooks)[0] if hooks else ""
    if first:
        env_name = "WECOM_HOOK_" + first.upper().replace("-", "_")
        os.environ[env_name] = "11111111-2222-3333-4444-555555555555"
        try:
            got = wk.webhook_key(first)
            report(got == "11111111-2222-3333-4444-555555555555", f"环境变量 {env_name} 覆盖生效")
        except Exception as e:  # noqa: BLE001
            report(False, f"环境变量 {env_name} 覆盖", f"{type(e).__name__}: {e}")
        finally:
            os.environ.pop(env_name, None)

    print("\n[2] 扫描：除 webhooks.json 自己外，还有谁写着明文 key")
    hits = []
    for path in walk(roots):
        if os.path.abspath(path) == hooks_file:
            continue
        try:
            text = open(path, "r", encoding="utf-8", errors="replace").read()
        except OSError:
            continue
        if LITERAL_KEY.search(text):
            hits.append(path)
    report(not hits, "无残留的写死 key", "；".join(hits) if hits else "0 处")

    print(f"\n=== 结论：PASS {ok} / FAIL {bad} ===")
    if bad:
        print("还有 FAIL —— 收拢没完成，或者有人又贴了一个回去。上面每一行都指出了位置。")
        print("（若命中是归档/第三方代码，把它加进 SKIP_DIRS，或删掉那些文件。）")
    else:
        print("key 只在 webhooks.json 里出现一次，其余引用方都走统一入口。")
    return 1 if bad else 0


if __name__ == "__main__":
    raise SystemExit(main())
