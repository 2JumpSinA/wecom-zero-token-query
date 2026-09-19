#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
样板适配器 B：私有接口（后台/中台的 XHR）—— 最常用、也最容易踩坑的一类。

适用：平台没有开放 API，但后台页面的数据是前端用 XHR 拉的（F12 → Network 能看到 JSON）。
来源：取自一个真实投产项目的模式（已全面脱敏：域名、密钥、字段名、品牌名全部替换为占位）。

要改的只有 5 处，都在下面标了 TODO。
真实投产时请把「登录态获取」尽量做成 token 注入（见 acquire_session），
因为账号密码登录会把网页端挤下线，而且频率高了会触发风控。

契约：本脚本只打印、不发送任何消息（--preview 是给通道传的兼容参数）。
用法：
  python adapter-private-api.py                 # 真实取数（需要凭据）
  python adapter-private-api.py --preview       # 同上（本脚本不发消息，参数仅为契约兼容）
  python adapter-private-api.py --demo          # 内置样例数据，不联网、不需凭据（用于打通链路）
"""
import argparse
import base64
import json
import os
import sys
import time
from datetime import datetime, timedelta

try:
    import requests
except ImportError:
    print("需要 requests：pip install requests", file=sys.stderr)
    sys.exit(2)

# ============================ TODO 1/5：站点常量 ============================
API_BASE = os.environ.get("MY_API_BASE", "https://api.example.com/pos")   # 抓包得到的接口前缀
TIMEOUT = 30          # 单次请求超时（秒）
MAX_RETRY = 3         # 网络类失败的原地重试次数
# 有些中台的请求参数是前端加密的（对应前端某个 _K()/_E() 函数）。
# 从打包后的 JS 里找到算法与密钥后填这里；明文接口则整段删掉。
_raw_key = os.environ.get("MY_PARAM_AES_KEY", "0123456789abcdef")
PARAM_AES_KEY = _raw_key.encode("utf-8") if isinstance(_raw_key, str) else _raw_key   # 16/24/32 字节
PARAMS_ENCRYPTED = False      # 明文接口保持 False

# 登录态失效的判定标志（不同平台措辞不同，抓一次过期的响应就能确认）
AUTH_ERROR_MARKERS = ("重新登陆", "重新登录", "验证错误", "401", "未登录")

# ============================ TODO 2/5：凭据 ================================
TOKEN_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".session.json")
ENV_USER = "MY_API_USER"
ENV_PASS = "MY_API_PASS"


# ---------------------------------------------------------------- 契约工具
def emit(markdown: str) -> None:
    """契约 2：正文夹在两条 ==== 之间，进度日志留在外面"""
    print()
    print("=" * 40)
    print(markdown)
    print("=" * 40)


def is_auth_error(err) -> bool:
    """登录态失效的判定：所有走不通的路最后都归一到这里"""
    text = str(err)
    return any(m in text for m in AUTH_ERROR_MARKERS)


# ---------------------------------------------------------------- 加密（可选）
def enc_params(obj) -> str:
    """AES-CBC 加密请求参数 → base64(iv + 密文)。对应前端加密函数。"""
    from Crypto.Cipher import AES
    from Crypto.Random import get_random_bytes
    from Crypto.Util.Padding import pad

    iv = get_random_bytes(16)
    plain = json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    return base64.b64encode(iv + AES.new(PARAM_AES_KEY, AES.MODE_CBC, iv).encrypt(pad(plain, 16))).decode()


def dec_data(value: str):
    """解密响应体（base64(iv + 密文)）"""
    from Crypto.Cipher import AES
    from Crypto.Util.Padding import unpad

    raw = base64.b64decode(value)
    plain = AES.new(PARAM_AES_KEY, AES.MODE_CBC, raw[:16]).decrypt(raw[16:])
    try:
        plain = unpad(plain, 16)
    except ValueError:
        pass
    return json.loads(plain.decode("utf-8"))


# ---------------------------------------------------------------- 登录态
def load_session():
    """读本地缓存的登录态（token），过期就当作没有"""
    try:
        with open(TOKEN_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        if data.get("saved_at") and time.time() - data["saved_at"] > data.get("ttl", 43200):
            return None
        return data
    except Exception:
        return None


def save_session(token: str, extra: dict = None) -> None:
    payload = {"token": token, "saved_at": time.time(), "ttl": 12 * 3600}
    if extra:
        payload.update(extra)
    try:
        with open(TOKEN_FILE, "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False)
        os.chmod(TOKEN_FILE, 0o600)
    except Exception as e:
        print(f"[warn] 登录态缓存写入失败（不影响本次运行）：{e}", file=sys.stderr)


def refresh_session(session, saved):
    """
    登录态续期（可选）。
    平台若支持 refresh_token，就在这里实现；不支持就返回 None，
    上层会退化为"读缓存 token → 都没有就报错并告诉你怎么办"。

    真实经验：多数国内中台**不发** refresh_token，token 就是会过期。
    所以更实用的是下面两条：
      --check-auth   随时查一下还有效吗（比等到查询失败才发现好）
      --set-token    从浏览器复制一个新 token 塞进来（10 秒的事，不用改代码）
    """
    refresh = (saved or {}).get("refresh_token")
    if not refresh:
        return None
    # TODO（按平台文档实现）：
    # resp = session.post(f"{API_BASE}/oauth/refresh", json={"refresh_token": refresh}, timeout=TIMEOUT)
    # body = unwrap(resp)
    # token = (body.get("data") or {}).get("token")
    # save_session(token, {"refresh_token": (body.get("data") or {}).get("refresh_token", refresh)})
    # return token
    return None


def acquire_session(session: requests.Session) -> str:
    """
    获取登录态。**优先复用缓存 token**，只在没有缓存时才登录一次。

    为什么：账号密码登录会把网页端挤下线（用户正在用后台时会被踢），
    而带 token 请求不会。真实项目里这一步的取舍直接决定"用户会不会抱怨"。
    """
    cached = load_session()
    if cached and cached.get("token"):
        refreshed = refresh_session(session, cached)
        if refreshed:
            print("[登录态] 已用 refresh_token 续期")
            return refreshed
        print("[登录态] 复用本地缓存 token")
        return cached["token"]

    user, pwd = os.environ.get(ENV_USER), os.environ.get(ENV_PASS)
    if not (user and pwd):
        raise RuntimeError(
            f"没有可用登录态：请设置环境变量 {ENV_USER} / {ENV_PASS} 登录一次，"
            f"或手动把 token 写进 {TOKEN_FILE}"
        )

    print("[登录态] 缓存为空，执行一次账号登录（会挤掉网页端登录）")
    resp = session.post(
        f"{API_BASE}/login/login",
        json={"username": user, "password": pwd},
        timeout=TIMEOUT,
    )
    body = unwrap(resp)
    token = (body.get("data") or {}).get("token")
    if not token:
        raise RuntimeError(f"登录失败：{body}")
    save_session(token)
    return token


# ---------------------------------------------------------------- 请求
def unwrap(resp) -> dict:
    """统一的响应解包：处理 {code, msg, data} 包装 + 登录态失效"""
    try:
        body = resp.json()
    except Exception:
        raise RuntimeError(f"响应不是 JSON（HTTP {resp.status_code}）：{resp.text[:200]}")
    code = body.get("code")
    msg = str(body.get("msg") or body.get("message") or "")
    if code == 401 or is_auth_error(msg):
        raise RuntimeError(f"登录态失效：{msg or body}")
    if code not in (0, 200, "0", "200", None):
        raise RuntimeError(f"接口返回错误：code={code} msg={msg}")
    if PARAMS_ENCRYPTED and isinstance(body.get("data"), str):
        try:
            body["data"] = dec_data(body["data"])
        except Exception:
            pass
    return body


def request_json(session, token: str, path: str, params: dict) -> dict:
    """带重试退避的 GET。登录态失效不回退（要立刻让上层提示用户续期）。"""
    params = {k: v for k, v in params.items() if v is not None}
    if PARAMS_ENCRYPTED:
        params = {"p": enc_params(params)}
    last = None
    for attempt in range(MAX_RETRY):
        try:
            resp = session.get(
                f"{API_BASE}{path}",
                params=params,
                headers={"Authorization": token, "Accept": "application/json"},
                timeout=TIMEOUT,
            )
            return unwrap(resp)
        except RuntimeError as e:
            if is_auth_error(e):        # 登录态问题重试没有意义
                raise
            last = e
        except requests.exceptions.RequestException as e:
            last = e
        if attempt < MAX_RETRY - 1:
            time.sleep(2 * (attempt + 1))   # 退避，别把对方打崩
    raise RuntimeError(f"接口连续 {MAX_RETRY} 次失败：{last}")


# ============================ TODO 3/5：接口与字段 ==========================
def fetch_orders(session, token: str, day: str) -> list:
    """拉取一天的数据（真实接口）。注意：分页要拿全，别只取第一页。"""
    rows, page = [], 1
    while page <= 50:
        body = request_json(session, token, "/order/lists",
                            {"sdate": day, "edate": day, "page": page, "limit": 100})
        data = body.get("data") or {}
        batch = data.get("list") or data.get("rows") or []
        rows.extend(batch)
        total = data.get("total")
        if not batch or (isinstance(total, int) and len(rows) >= total):
            break
        page += 1
    return rows


def normalize(row: dict) -> dict:
    """字段归一化：把平台的字段收敛成你自己的一套名字（换平台时只改这里）"""
    return {
        "order_no": str(row.get("order_no") or ""),
        "shop": str((row.get("shop_info") or {}).get("shop_name") or row.get("shop_id") or "未知门店"),
        "cancelled": str(row.get("cancel_state")) in ("1", "True", "true"),
        "reason": str(row.get("reject_state_name") or row.get("delivery_state_name") or "未知"),
    }


def render(rows: list, day: str) -> str:
    """渲染企微 markdown。注意：智能机器人不支持 <font color>，用 **加粗**。

    契约要求：口径必须写进输出（"统计时段"这行不能省）。
    """
    total = len(rows)
    cancelled = [r for r in rows if r["cancelled"]]
    ratio = (len(cancelled) / total * 100) if total else 0.0
    lines = [
        "### 订单异常播报（样板 B · 私有接口）",
        "> 项目：示例项目",
        f"> 统计时段：{day} 全天",
        f"> 订单总数：{total}",
        f"> 取消单数：{len(cancelled)}",
        f"> **取消占比：{ratio:.1f}%**",
    ]
    if cancelled:
        from collections import Counter
        top = Counter(r["reason"] for r in cancelled).most_common(3)
        lines.append("> 主要原因：" + "、".join(f"{k} {v}" for k, v in top))
    return "\n".join(lines)


# ============================ TODO 4/5：演示数据 ============================
def demo_rows() -> list:
    """--demo 用：内置样例，不联网、不需凭据，用来先打通通道链路"""
    return [
        {"order_no": "D0001", "shop_info": {"shop_name": "示例门店 A"}, "cancel_state": 0,
         "reject_state_name": "", "delivery_state_name": "配送完成"},
        {"order_no": "D0002", "shop_info": {"shop_name": "示例门店 A"}, "cancel_state": 1,
         "reject_state_name": "用户取消", "delivery_state_name": ""},
        {"order_no": "D0003", "shop_info": {"shop_name": "示例门店 B"}, "cancel_state": 1,
         "reject_state_name": "无人接单", "delivery_state_name": ""},
    ]


# ============================ TODO 5/5：入口 ================================
def main() -> int:
    ap = argparse.ArgumentParser(description="样板适配器 B · 私有接口")
    ap.add_argument("--preview", action="store_true", help="契约兼容参数（本脚本不发消息）")
    ap.add_argument("--demo", action="store_true", help="用内置样例数据，不联网")
    ap.add_argument("--day", default=datetime.now().strftime("%Y-%m-%d"), help="统计日期")
    ap.add_argument("--set-token", default="", help="把浏览器里复制的 token 写进本地缓存（最省事的续期方式）")
    ap.add_argument("--check-auth", action="store_true", help="只检查登录态是否还有效（不查询业务数据）")
    args = ap.parse_args()

    # —— 登录态续期：先注入 token，再查一次是否有效（两者都不联网灌数据）——
    if args.set_token:
        save_session(args.set_token.strip())
        print(f"[登录态] 已写入 {TOKEN_FILE}（有效期按 12 小时估算，过期再注入一次即可）")
        return 0
    if args.check_auth:
        session = requests.Session()
        token = acquire_session(session)
        try:
            request_json(session, token, "/order/lists", {"page": 1, "limit": 1})
            print("[登录态] 有效 ✓")
            return 0
        except Exception as e:
            if is_auth_error(e):
                print("[登录态] 已失效 ✗ —— 请用 --set-token <新token> 注入，或设置账号密码环境变量重新登录")
            else:
                print(f"[登录态] 检查失败（可能不是登录态问题）：{type(e).__name__}: {e}")
            return 1

    try:
        if args.demo:
            print("[demo] 使用内置样例数据")
            rows = demo_rows()
        else:
            session = requests.Session()
            token = acquire_session(session)
            print(f"[取数] {args.day} …")
            rows = fetch_orders(session, token, args.day)
            if not rows:
                print("[warn] 接口返回 0 条 —— 先确认是「真的没有」还是「登录态失效但被吞掉了」",
                      file=sys.stderr)
        md = render([normalize(r) for r in rows], args.day)
        emit(md)
        return 0
    except Exception as e:
        # 契约 3：失败要非 0 退出，并且给"人话"原因（群里能看懂）
        if is_auth_error(e):
            print("[失败] 登录态已失效，请重新登录一次以刷新本地缓存 token")
        else:
            print(f"[失败] {type(e).__name__}: {e}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
