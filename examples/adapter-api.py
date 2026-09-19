#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
样板适配器 A：正式 API（有开放平台/文档/AppKey 的那类）。

适用：平台提供 REST 接口 + 签名鉴权（最常见的两种：HMAC 签名、或先换 access_token）。
这类是**最省事、最稳定**的一类，能用它就别去抓包。

要改的只有 4 处，标了 TODO。

契约：本脚本只打印、不发送任何消息（--preview 是给通道传的兼容参数）。
用法：
  python adapter-api.py                     # 真实取数（需要凭据）
  python adapter-api.py --preview           # 同上（本脚本不发消息）
  python adapter-api.py --demo              # 内置样例数据，不联网（先打通链路）
"""
import argparse
import hashlib
import hmac
import json
import os
import random
import string
import sys
import time
from datetime import datetime, timedelta

try:
    import requests
except ImportError:
    print("需要 requests：pip install requests", file=sys.stderr)
    sys.exit(2)

# ============================ TODO 1/4：站点与鉴权方式 ======================
API_BASE = os.environ.get("MY_API_BASE", "https://api.example.com")
APP_KEY = os.environ.get("MY_APP_KEY", "")          # 别写进代码，用环境变量
APP_SECRET = os.environ.get("MY_APP_SECRET", "")
AUTH_MODE = "hmac"        # "hmac"（每请求签名）或 "token"（先换 access_token 再带 Bearer）
TIMEOUT = 30
MAX_RETRY = 3
TOKEN_CACHE = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".access_token.json")

# 平台返回的业务错误码 → 人话（按你平台文档填）
ERROR_HINTS = {
    401: "凭据无效或已过期",
    429: "请求过于频繁（被限流）",
    500: "平台内部错误",
}


# ---------------------------------------------------------------- 契约工具
def emit(markdown: str) -> None:
    """契约 2：正文夹在两条 ==== 之间"""
    print()
    print("=" * 40)
    print(markdown)
    print("=" * 40)


def fail(msg: str, code: int = 1) -> int:
    """契约 3：失败给人话 + 非 0 退出码"""
    print(f"[失败] {msg}", file=sys.stderr)
    return code


# ---------------------------------------------------------------- 鉴权
def sign_hmac(params: dict) -> dict:
    """TODO 2/4：按平台文档实现签名（这里是通用形状：排序拼接 + HMAC-SHA256）"""
    ts = str(int(time.time()))
    nonce = "".join(random.choices(string.ascii_lowercase + string.digits, k=16))
    payload = "&".join(f"{k}={params[k]}" for k in sorted(params))
    raw = f"{payload}&timestamp={ts}&nonce={nonce}&key={APP_SECRET}"
    sign = hmac.new(APP_SECRET.encode(), raw.encode(), hashlib.sha256).hexdigest().upper()
    return {"timestamp": ts, "nonce": nonce, "sign": sign, "appKey": APP_KEY}


def get_access_token(session) -> str:
    """token 模式：换 access_token 并缓存（多数平台有效期 2 小时，别每次都换）"""
    try:
        with open(TOKEN_CACHE, "r", encoding="utf-8") as f:
            cached = json.load(f)
        if cached.get("token") and cached.get("expire_at", 0) > time.time() + 60:
            return cached["token"]
    except Exception:
        pass
    resp = session.post(f"{API_BASE}/oauth/token",
                        json={"appKey": APP_KEY, "appSecret": APP_SECRET}, timeout=TIMEOUT)
    body = safe_json(resp)
    token = body.get("access_token") or (body.get("data") or {}).get("access_token")
    if not token:
        raise RuntimeError(f"换 token 失败：{body}")
    expires_in = int(body.get("expires_in") or 7200)
    with open(TOKEN_CACHE, "w", encoding="utf-8") as f:
        json.dump({"token": token, "expire_at": time.time() + expires_in}, f)
    os.chmod(TOKEN_CACHE, 0o600)
    return token


def safe_json(resp) -> dict:
    try:
        return resp.json()
    except Exception:
        raise RuntimeError(f"响应不是 JSON（HTTP {resp.status_code}）：{resp.text[:200]}")


# ---------------------------------------------------------------- 请求
def api_get(session, token, path: str, params: dict) -> dict:
    """带重试退避的 GET：网络类错误退避重试；鉴权类错误立刻抛（重试没意义）"""
    last = None
    for attempt in range(MAX_RETRY):
        try:
            query = dict(params)
            headers = {"Accept": "application/json"}
            if AUTH_MODE == "hmac":
                query.update(sign_hmac(query))
            else:
                headers["Authorization"] = f"Bearer {token}"
            resp = session.get(f"{API_BASE}{path}", params=query, headers=headers, timeout=TIMEOUT)
            if resp.status_code in (401, 403):
                raise RuntimeError(ERROR_HINTS.get(401, "鉴权失败"))
            if resp.status_code == 429:
                raise requests.exceptions.RequestException("被限流")
            if resp.status_code >= 500:
                raise requests.exceptions.RequestException(f"平台 {resp.status_code}")
            body = safe_json(resp)
            code = body.get("code", body.get("errcode", 0))
            if code not in (0, 200, "0", "200", None):
                hint = ERROR_HINTS.get(code, "")
                raise RuntimeError(f"接口返回错误 code={code} {hint} msg={body.get('msg') or body.get('message')}")
            return body
        except RuntimeError:
            raise
        except requests.exceptions.RequestException as e:
            last = e
        if attempt < MAX_RETRY - 1:
            time.sleep(2 * (attempt + 1))
    raise RuntimeError(f"接口连续 {MAX_RETRY} 次失败：{last}")


# ============================ TODO 3/4：接口与渲染 ==========================
def fetch_stats(session, token, day: str) -> dict:
    """拉一天的数据。分页要拿全；口径（时区、是否含取消单）以输出里的说明为准。"""
    rows, page = [], 1
    while page <= 50:
        body = api_get(session, token, "/report/daily",
                       {"date": day, "page": page, "pageSize": 200})
        data = body.get("data") or {}
        batch = data.get("list") or data.get("records") or []
        rows.extend(batch)
        total = data.get("total")
        if not batch or (isinstance(total, int) and len(rows) >= total):
            break
        page += 1
    return {"rows": rows, "date": day}


def normalize(row: dict) -> dict:
    """字段归一化：平台字段 → 你自己的字段（换平台只改这里）"""
    return {
        "shop": str(row.get("shopName") or row.get("shop_name") or "未知门店"),
        "amount": float(row.get("amount") or 0),
        "orders": int(row.get("orderCount") or row.get("order_count") or 0),
    }


def render(stats: dict) -> str:
    rows = [normalize(r) for r in stats["rows"]]
    total_orders = sum(r["orders"] for r in rows)
    total_amount = sum(r["amount"] for r in rows)
    lines = [
        "### 日报（样板 A · 正式 API）",
        "> 项目：示例项目",
        f"> 统计时段：{stats['date']} 全天",
        f"> 门店数：{len(rows)}",
        f"> 订单合计：{total_orders}",
        f"> **金额合计：{total_amount:,.2f}**",
    ]
    top = sorted(rows, key=lambda r: r["amount"], reverse=True)[:3]
    if top:
        lines.append("> 金额前三：" + "、".join(f"{r['shop']} {r['amount']:,.0f}" for r in top))
    return "\n".join(lines)


# ============================ TODO 4/4：演示数据 ============================
def demo_stats(day: str) -> dict:
    return {"date": day, "rows": [
        {"shopName": "示例门店 A", "amount": 1234.5, "orderCount": 32},
        {"shopName": "示例门店 B", "amount": 987.0, "orderCount": 21},
        {"shopName": "示例门店 C", "amount": 456.7, "orderCount": 12},
    ]}


def main() -> int:
    ap = argparse.ArgumentParser(description="样板适配器 A · 正式 API")
    ap.add_argument("--preview", action="store_true", help="契约兼容参数（本脚本不发消息）")
    ap.add_argument("--demo", action="store_true", help="用内置样例数据，不联网")
    ap.add_argument("--day", default=datetime.now().strftime("%Y-%m-%d"))
    args = ap.parse_args()

    try:
        if args.demo:
            print("[demo] 使用内置样例数据")
            stats = demo_stats(args.day)
        else:
            if not APP_KEY or not APP_SECRET:
                return fail("缺少凭据：请设置环境变量 MY_APP_KEY / MY_APP_SECRET")
            session = requests.Session()
            token = None if AUTH_MODE == "hmac" else get_access_token(session)
            print(f"[取数] {args.day} …")
            stats = fetch_stats(session, token, args.day)
        emit(render(stats))
        return 0
    except Exception as e:
        return fail(f"{type(e).__name__}: {e}")


if __name__ == "__main__":
    sys.exit(main())
