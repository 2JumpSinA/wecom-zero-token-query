# 企微「零 Token 数据查询」直调通道 · 技能包

把「固定几类数据查询」做成企业微信里的**零 token 直调入口**：
群里 @机器人 发命令 → 本机脚本直接取数 → 结果回到那条消息。
**全程不经过 AI agent、不消耗 token**，并且可以安全开放给同事。

> ⚠️ **先说清楚它不是什么**：它**不是** MCP server，**不是** AI agent 的工具箱，
> **不是**通用聊天机器人框架。它只解决一个问题 —— **把几条固定的只读查询做成群里的一个按钮**，
> 并且让它在没人看着的时候也能自己发现故障。要接 AI 的话，本项目刻意不做那件事（见下节）。

## 为什么值得这么做

| | 让 AI 助手（agent）跑脚本 | 本方案（直调通道） |
|---|---|---|
| token | 每条消息都要重放上下文 → 烧钱 | **0**，一次模型调用都没有 |
| 对话边界 | 查数据/改文件/跑命令混在一个入口 | 固定命令表，越界直接拒绝 |
| 权限 | 开放群权限 = 交出机器操作权 | 只读脚本 + 白名单，**可开放给同事** |
| 响应 | 秒级但每次都在花钱 | **毫秒级**（读后台采集结果；没配缓存的命令 2~20 秒，占位消息先到，体感不差） |
| 能力 | 自由提问、多步任务 | 只做那几类固定查询 |

**不是替换，是分流**：固定查询走本通道，自由提问走 agent。

> **v2.2.0 起**：查询默认读**后台定期采集的结果**，所以毫秒返回，而且**平台挂了 / 登录态过期时，
> 仍然答得出上一次成功的数据**（正文会带「数据时间」与陈旧提示）。每条命令加一个 `"snapshot"` 字段即接入，
> 不写新脚本；详见 `references/11-采集与缓存.md`。

## 与相近项目的区别

先说在前面：**企微机器人这件事本身很成熟**。下面这些项目在技术底座上与本项目高度重合
（长连接或 HTTP 回调、命令表、白名单、群聊）。差别不在"能不能收发消息"，而在**解决什么问题**。

| 项目 | 它解决什么 | 与本项目的关系 |
|---|---|---|
| [easy-wx/xbot](https://github.com/easy-wx/xbot) | 个人助手工具箱：`[scene] [cmd] [args]` 格式、按「场景 + 命令 + 日期」授权、富媒体回复，走 **HTTP 回调** | 命令表与权限模型可互相借鉴；它面向"人让机器人办事"，本项目面向"固定几条只读查询、零模型参与" |
| [ruilisi/lsbot](https://github.com/ruilisi/lsbot) | *Lean & Secure Bot*：立场是"不必要的地方不建立信任依赖"，不让消息流经第三方云 | **出发点相近**（数据不出本机）；它是通用 bot 框架，本项目是一套可复制的查询通道 |
| [OpenClaw 企微插件](https://github.com/sunnoy/openclaw-plugin-wecom) 等 | **把 AI 接进企微**：长连接、群聊、指令白名单、流式输出 | 技术底座最像（本项目同样走企微长连接）；但**目标相反** —— 本项目把确定性查询从模型路径上**分流出去** |
| [AMOS144/ZeroToken](https://github.com/AMOS144/ZeroToken) | 名字相近，实为"给 agent 做浏览器自动化的 MCP" | 无关，仅提醒别混淆 |

**本项目真正想解决的三件事**（也是上面这些项目里没找到对应物的）：

1. **立场，而不是副作用。** 不是"顺便不用模型"，而是**刻意分流**：确定性查询不需要上下文、
   不需要花钱、也不该被模型的随机性影响 —— 所以它不走模型。自由提问仍然留给 agent 通道。
   这条判断直接决定了架构（固定命令表 + 只读脚本 + 越界拒绝）。
2. **把运维当一等公民。** 数据时间、陈旧告警、历史留档、并发与端口冲突、凭据「在位 ≠ 有效」、
   Windows 上非提权会话的种种限制……这些只有真跑过生产才长得出来。
   本项目把它们写成**可验证的机制**（`--stale-check` / `--history` / 体检脚本 / 断言级测试），
   而不是散落在注释里的注意事项。
3. **可交付性。** 脚本契约 + `--probe` 探针 + 断言级测试 + 换机器迁移清单 ——
   目标是**别人也能装起来并用住**，而不是"作者自己那台机器上能跑"。

**它不是**：不是 MCP server、不是 AI agent 工具箱、不是通用 chatbot 框架。
它是"把几个固定查询做成群里一个按钮"的完整工程件。

### English

**WeCom bots are a solved problem.** These projects share most of this project's plumbing
(long connection or HTTP callback, command table, allow-list, group chat) — the difference is
*which problem* gets solved:

- [easy-wx/xbot](https://github.com/easy-wx/xbot) — personal-assistant toolbox: `[scene] [cmd] [args]`,
  per-scene/command/date permissions, rich replies, **HTTP callback**.
- [ruilisi/lsbot](https://github.com/ruilisi/lsbot) — *Lean & Secure Bot*: the same **belief**
  (don't route your data through someone else's cloud), but a general bot framework.
- [OpenClaw WeCom plugins](https://github.com/sunnoy/openclaw-plugin-wecom) — the closest plumbing
  (WeCom long connection, allow-list, streaming), yet the **opposite goal**: putting an AI *into*
  WeCom. This project deliberately keeps deterministic queries *out* of the model path.
- [AMOS144/ZeroToken](https://github.com/AMOS144/ZeroToken) — same name, unrelated
  (an MCP for agent-driven browser automation).

What this project actually contributes:

1. **A stance, not a side effect.** Deterministic queries need no context, no spend, and no model
   non-determinism — so they don't get one. Free-form questions stay on the agent channel.
   That single judgement shapes the architecture (fixed command table, read-only scripts, hard refusal otherwise).
2. **Ops as a first-class citizen.** Data timestamps, staleness alerts, historical archives,
   port contention, "credentials present ≠ credentials valid", the realities of running unelevated
   on Windows — all of it learned from production, and all of it encoded as *checkable mechanisms*
   (`--stale-check`, `--history`, the health-check script, assertion-level tests) rather than comments.
3. **Deliverability.** A script contract, a `--probe` tool, assertion-level tests, and a
   machine-migration checklist — so someone else can install it *and keep it running*.

**It is not** an MCP server, not an AI agent toolbox, not a general chatbot framework.
It is "turn a handful of fixed queries into a button in the group chat", end to end.

## 怎么用（给 agent）

把 `SKILL.md` 交给 agent 读即可 —— 它是完整规程：前置条件、五步落地、每步验收、8 条硬规则、排查表。
或者直接说：

> 读 `wecom-zero-token-query/SKILL.md`，帮我把「查余额 / 查门店营业 / 查订单异常」做成企微群里的零 token 查询入口。

一键安装脚本：

```powershell
.\scripts\install.ps1 -Target D:\wecom-fastlane -BotId aibXXXX -Secret <secret>
```

## 目录

```
SKILL.md                  给 agent 的完整规程（从这里开始读）
assets/                   可直接复制的运行时代码（Node 守护进程 + 看门狗 + 启动器）
references/               细节：企微侧准备 / 命令表与分群 / 脚本接口约定 / 常驻与防闪窗 / 排查 / 安全 / 采集与缓存
tests/                    断言级回归：样板适配器 10 条 + 采集与缓存 15 条（沙箱里跑真程序，不联网）
scripts/install.ps1       一键安装：拷文件 + 填配置 + 注册任务 + 自检
docs/标准操作手册.md/.docx  给「没有 Python 基础的人」的逐步手册（可直接转发给同事）
```

## 依赖

- Node.js ≥ 18
- `@wecom/aibot-node-sdk`（`npm i @wecom/aibot-node-sdk`；若本机是 DSH 环境，程序也会自动去 DSH 的模块回退目录找）
- 每个查询一个「只打印不推送」的脚本（`references/03-脚本接口约定.md` 有约定和参考实现）

## 关键前提

1. 企微**管理员**权限（建智能机器人、加入群）
2. 机器人的接收方式必须是 **长连接（WebSocket）** —— 这样不需要公网 IP、不需要回调 URL
3. 一台**长期开机且已登录**的 Windows（进程不在，机器人就没反应）
