# -*- coding: utf-8 -*-
"""--preview 开关的隔离验证：不发群、不动任何「已推/已提醒」状态。

用 monkeypatch 把 requests.post 换成会抛异常的哨兵：
- PREVIEW=True  时不应该有任何 HTTP 请求；
- PREVIEW=False 时仍必须走真实推送路径（哨兵抛错即证明）。
"""
import sys

sys.path.insert(0, r"<你的脚本目录>")

import requests  # noqa: E402

calls = []
requests.post = lambda *a, **k: (calls.append(a), (_ for _ in ()).throw(AssertionError("真实 HTTP 推送被触发"))) [0]

import wecom_cancel_ratio_bot as bot  # noqa: E402

fails = []


def check(name, ok, extra=""):
    print(("PASS " if ok else "FAIL ") + name + (f"  {extra}" if extra else ""))
    if not ok:
        fails.append(name)


def state_of(p):
    return p.read_text(encoding="utf-8") if p.exists() else None


# 1) PREVIEW 下 send_to_wecom 不联网，且把正文夹在分隔线之间打印
bot.PREVIEW = True
calls.clear()
r = bot.send_to_wecom("DUMMY_KEY", "### 测试正文\n> 一行")
check("preview 下 send_to_wecom 不发 HTTP", len(calls) == 0, f"calls={len(calls)}")
check("preview 下返回 errcode=0", r.get("errcode") == 0, str(r))

# 2) 非 PREVIEW 时必须是真实推送路径（哨兵抛错 = 路径没被改坏）
bot.PREVIEW = False
calls.clear()
try:
    bot.send_to_wecom("DUMMY_KEY", "### x")
    real_path_ok = False
except AssertionError:
    real_path_ok = True
check("非 preview 仍走真实推送", real_path_ok and len(calls) == 1, f"calls={len(calls)}")

# 3) push_shops 在 preview 下不写「今天已推」（否则会顶掉 09:00 的定时播报）
bot.PREVIEW = True
bot.build_shop_md = lambda cfg: "### 门店营业情况播报\n> 项目：测试\n门店营业情况（美团）：营业中 1 家"
before = state_of(bot.SHOP_STATE_FILE)
md = bot.push_shops({"wecom_webhook_key": "DUMMY_KEY"})
after = state_of(bot.SHOP_STATE_FILE)
check("preview 下 push_shops 不动 .shop_report_date", before == after, f"{before!r} -> {after!r}")
check("preview 下 push_shops 仍返回文案", bool(md and "门店营业情况" in md))

# 4) 失败提醒在 preview 下不发群、也不占用 6 小时去重额度
bot.PREVIEW = True
fp = bot.FAIL_STATE_FILE.with_name(".failure_notice_orders")
before = state_of(fp)
calls.clear()
bot._notify_failure({"wecom_webhook_key": "DUMMY_KEY"}, "订单", RuntimeError("boom"), scope="orders")
after = state_of(fp)
check("preview 下失败提醒不发 HTTP", len(calls) == 0, f"calls={len(calls)}")
check("preview 下失败提醒不写去重状态", before == after, f"{before!r} -> {after!r}")

print()
print("结论：" + ("全部通过" if not fails else f"失败项 {fails}"))
sys.exit(1 if fails else 0)
