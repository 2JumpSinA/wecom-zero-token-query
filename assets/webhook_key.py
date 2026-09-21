# -*- coding: utf-8 -*-
"""企微群机器人 webhook key 的**唯一读取入口**（说明见 `references/09-本地化部署.md` §4.1）。

解决什么问题：一套部署里往往有多个脚本各自往同一个群发消息。如果每个脚本都把
webhook 地址写死在源码里，那「轮换 key」就变成「翻遍所有脚本改多份，还不能漏」——
而漏掉的那一个不会报错，只会在某个时刻**静默地不再发消息**（群里看起来和"今天没有异常"一样）。

用这套之后：key 只在 `webhooks.json` 里出现一次，脚本改成调用本模块 —— 轮换只改那个文件。

读取优先级：
  1) 环境变量 `WECOM_HOOK_<NAME>`（大写、连字符换下划线）—— 便于临时覆盖或换机器部署
  2) `webhooks.json`（与本文件同目录；可用环境变量 `WECOM_HOOKS_FILE` 指向别处）
  3) 抛 `HookConfigError`，消息里写明去哪儿配

为什么读不到就"大声报错"而不是返回空字符串：这类通道最常见的故障是**静默失败** ——
返回空 key 会让脚本发一个必然失败的请求，然后被当成"发送失败"（errcode=93000），
而真正的原因（配置没读到）要翻很久才看得见。宁可当场崩，也不要半夜里悄悄不发。

`webhooks.json` 的形状：

    {
      "hooks": {
        "brand-a": { "key": "<uuid>", "label": "品牌A数据播报群" },
        "brand-b": { "key": "<uuid>", "label": "品牌B数据播报群" }
      }
    }
"""
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_FILE = os.path.join(HERE, "webhooks.json")
ENV_FILE = "WECOM_HOOKS_FILE"
WEBHOOK_TMPL = "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key={key}"


class HookConfigError(RuntimeError):
    """webhook 配置读不到 / 写错了。故意不吞掉：这是必须让人看见的错误。"""


def hooks_file() -> str:
    return os.environ.get(ENV_FILE) or DEFAULT_FILE


def load_hooks(path: str | None = None) -> dict:
    """读配置文件的 hooks 段。"""
    p = path or hooks_file()
    try:
        with open(p, "r", encoding="utf-8") as f:
            data = json.load(f)
    except FileNotFoundError:
        raise HookConfigError(
            f"找不到 webhook 配置文件：{p}（可用环境变量 {ENV_FILE} 指向别处）"
        ) from None
    except json.JSONDecodeError as e:
        raise HookConfigError(f"webhook 配置文件不是合法 JSON：{p}（{e}）") from None
    hooks = data.get("hooks")
    if not isinstance(hooks, dict) or not hooks:
        raise HookConfigError(f"webhook 配置文件里没有可用的 hooks 段：{p}")
    return hooks


def webhook_key(name: str) -> str:
    """取某个 hook 的 key（不含 URL）。环境变量优先于配置文件。"""
    env = "WECOM_HOOK_" + name.upper().replace("-", "_")
    key = (os.environ.get(env) or "").strip()
    if key:
        return key
    hooks = load_hooks()
    entry = hooks.get(name)
    if not isinstance(entry, dict) or not str(entry.get("key") or "").strip():
        known = ", ".join(sorted(hooks)) or "（空）"
        raise HookConfigError(f"webhooks.json 里没有名为「{name}」的 key（已知：{known}）")
    return str(entry["key"]).strip()


def webhook_url(name: str) -> str:
    """取完整的 webhook 地址 —— 脚本里直接用它发消息。"""
    return WEBHOOK_TMPL.format(key=webhook_key(name))


def describe() -> str:
    """给人看的清单（只留 key 前 6 位，方便日志里打印而不泄漏）。"""
    hooks = load_hooks()
    lines = [f"配置文件：{hooks_file()}"]
    for name in sorted(hooks):
        entry = hooks[name] if isinstance(hooks[name], dict) else {}
        key = str(entry.get("key") or "")
        shown = key[:6] + "…" if key else "（空）"
        lines.append(f"  {name:<10} {shown:<10} {entry.get('label', '')}")
    return "\n".join(lines)


if __name__ == "__main__":
    print(describe())
