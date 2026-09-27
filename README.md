<a id="zh"></a>
# 企微「零 Token 数据查询」直调通道 · 技能包

**中文** · [English](#en) · v2.3.3 · [MIT](LICENSE)

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

## 它是怎么工作的：三层 + 一个契约

```
取数层（Data Acquisition）        ← 每个平台都不一样，天然不通用
  任意语言的只读脚本：正式 API / 私有接口 / 导出文件 / 浏览器自动化
        │  只通过「脚本契约」耦合（四条，见下）
通道层（Channel）                 ← 本方案的主体，与数据源零耦合
  常驻进程 + 命令表 JSON + 看门狗 + 采集定时器
        │  部署成「本机服务」
部署层（Deployment）              ← 让它在别人机器上活下来
  安装脚本 + 计划任务 + 心跳 + 迁移清单
```

三层各自变化的原因不同：数据平台会改版（第一层变），企微接口会改（第二层变），
机器会换（第三层变）。拆开之后，改一层不会牵动另外两层。

**一次查询的完整生命周期**：

```
群里 @数据查询 订单
   └─ 企微把消息推到本机长连接（出站连接，不需要公网 IP、不需要回调 URL）
        └─ 通道层：谁发的 → 在哪个群 → 命中哪条命令 → 白名单 / 群 / 命令级校验
             ├─ 命中 snapshot → 读 snapshots\<源>.json → 毫秒返回
             │    （最近一次采集失败也照答；没有或太旧，才落回现场抓取）
             └─ 未命中 → 先回占位消息「正在取数…」→ 跑脚本 → 同一条消息补全结果
```

### 契约：任何脚本接进来的唯一条件

任何语言、任何来源的脚本，满足这四条即可接入（详细版见 `references/08-脚本接入契约与探针.md`）：

| # | 契约 | 为什么 |
|---|---|---|
| 1 | **只读或可预演**：提供 `--preview`（或 `--dry`／不带 `--send`）开关，带上它绝不下发、绝不写状态 | 否则同一份数据会推两次；手动查询还会顶掉定时播报 |
| 2 | **正文可提取**：结果夹在两条 `====`（≥10 个等号）之间，或整段 stdout | 让进度日志和正文分开 |
| 3 | **退出码有语义**：0 = 成功；非 0 = 失败且把原因写出来 | 通道据此决定回「结果」还是回「失败详情」 |
| 4 | **无交互、有超时**：不等待输入，单次运行有上限 | 群里没人能按回车 |

有了契约，「支持什么数据平台」这个问题就消失了：平台由你的脚本决定，通道只认契约。
**新增一个平台 = 新增一个满足契约的脚本 + 一段配置。**

### 通用性（诚实版）

| 部分 | 通用吗 | 说明 |
|---|---|---|
| 通道层代码 | ✅ 完全通用 | 与数据源零耦合，换脚本只改 JSON |
| 命令表 / 作用域模型 | ✅ 通用 | 「品牌」只是"维度"的一个实例，见 `references/10-泛化模型与作用域.md` |
| 部署与自愈 | ✅ 通用 | 计划任务 + 看门狗 + 心跳，任何 Windows 机器一样 |
| 脚本契约 | ✅ 通用 | 四条约束与平台无关 |
| **具体取数脚本** | ❌ **不可能通用** | 每个平台的登录态、接口、字段都不同 —— 这是本方案的成本所在 |
| 取数选路 | 🟡 半通用 | 决策树通用（`references/07-取数路径.md`），落地要针对具体平台 |

所以正确的预期是：这套东西把「**接入一个新查询**」的成本从**几天降到几十分钟**
（写脚本 + 填配置 + 跑一次自检），而不是「零成本支持任何平台」。
任何声称后者通用的方案，都是在隐藏第一层的成本。

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

## 快速开始

### 给 agent：把 `SKILL.md` 交给它

`SKILL.md` 是完整规程：前置条件、五步落地、每步验收、8 条硬规则、排查表。
或者直接说：

> 读 `wecom-zero-token-query/SKILL.md`，帮我把「查余额 / 查门店营业 / 查订单异常」做成企微群里的零 token 查询入口。

### 五步落地（每步都有验收，不要跳）

1. 企微后台建一个**智能机器人**（接收方式选长连接）；
2. 落地程序目录；
3. 准备「只打印不推送」的脚本（三条接口约定，见 `references/03-脚本接口约定.md`）；
4. 填命令表与白名单（`commands.json`）；
5. 常驻 —— 必须走 `wscript`，否则每分钟闪窗。

### 一键安装

```powershell
.\scripts\install.ps1 -Target D:\wecom-fastlane -BotId aibXXXX -Secret <secret>
```

### 装完先自检

```cmd
run-fastlane.cmd --routes                      :: 命令表挂对了吗
run-fastlane.cmd --selftest <触发词>            :: 这条命令真的跑得通吗
run-fastlane.cmd --probe examples\adapter-api.py --run --exe <python.exe>
```

## 目录结构

```
SKILL.md                      给 agent 的完整规程（从这里开始读）
VERSION / CHANGELOG.md        版本与变更记录
assets/                       可直接复制的运行时代码（Node 守护进程 fastlane.mjs + 看门狗 + 启动器）
examples/                     三个样板适配器：正式 API / 私有接口 / 导出文件（都能离线 --demo）
references/                   00 架构总览 … 11 采集与缓存（细节与踩坑）
tests/                        45 条断言级回归（沙箱里跑真程序，不联网）
scripts/install.ps1           一键安装：拷文件 + 填配置 + 注册任务 + 自检
scripts/probe-env.ps1         环境体检
scripts/build_manual_docx.py  把 docs/标准操作手册.md 转成 .docx（纯 python-docx，不依赖 pandoc）
docs/标准操作手册.md/.docx      给「没有 Python 基础的人」的逐步手册（可直接转发给同事）
LICENSE                       MIT
```

## 取数层：三个样板适配器

对应 `references/07-取数路径.md` 的三条主线，**都能离线跑（`--demo`）**，
可以先打通整条链路，再去填凭据和接口细节。

| 文件 | 平台类型 | 核心难点 | 内置的实战模式 |
|---|---|---|---|
| `examples/adapter-api.py` | A 有正式 API | 签名/换 token、限流、分页 | HMAC 签名、access_token 缓存、429 退避、业务码→人话 |
| `examples/adapter-private-api.py` | B 私有接口（中台/后台 XHR） | 登录态复用、参数加密、失效识别 | token 注入优先于账号登录、AES-CBC 参数加解密、`重新登陆/401` 失效判定、重试退避 |
| `examples/adapter-export-file.py` | C 只有导出文件 | 数据脏、列名会变、编码 | 列名映射（不用列号）、GBK/UTF-8 自适应、已知非异常台账剔除、缺列显式报错 |

> 适配器**只负责取数 + 打印**，通道负责"收消息 / 匹配命令 / 回群"。
> 适配器里**不要**出现任何企微推送代码 —— 那会让同一份数据在群里出现两次。

## 依赖

- Node.js ≥ 18
- `@wecom/aibot-node-sdk`（`npm i @wecom/aibot-node-sdk`；若本机是 DSH 环境，程序也会自动去 DSH 的模块回退目录找）
- 每个查询一个「只打印不推送」的脚本（`references/03-脚本接口约定.md` 有约定和参考实现）

## 关键前提

1. 企微**管理员**权限（建智能机器人、加入群）
2. 机器人的接收方式必须是 **长连接（WebSocket）** —— 这样不需要公网 IP、不需要回调 URL
3. 一台**长期开机且已登录**的 Windows（进程不在，机器人就没反应）

## 运维与验证：这套东西为什么能长期跑

- **采集与缓存**：常驻进程按 `collect.everyMinutes` 定时把带 `snapshot` 的命令跑一遍，
  结果原子写入 `snapshots\<源>.json`，同时 append 到 `history\<源>\<日期>.jsonl` 供事后回看；
  轮末判定陈旧，该出声就推一条告警到运维群。平台挂了也能答出上一次成功的数据。
- **凭据「在位 ≠ 有效」**：这类系统最大的运维痛点。提供 `--check-auth`（还能用吗）、
  `--set-token`（从浏览器复制的 token 10 秒注入，不改代码）；**失效必须显式报错，
  绝不能静默返回 0 条** —— 群里看到"0 家门店"比看到报错危险得多。
- **探针与自检**：`--probe` 验证脚本满足契约并直接生成配置条目；`--selftest` / `--routes` 验证命令真跑得通。
- **断言级回归**：45 条测试（沙箱里跑真程序，不联网），包含样板适配器与采集缓存层，
  以及 `.ps1`/`.vbs` 必须带 UTF-8 BOM、`.cmd`/`.bat` 必须纯 ASCII 的编码回归 ——
  这个坑在真实项目里踩过两次（中文注释被按 GBK 解码，报错位置还会漂到几十行之后）。

## 文档索引

| 文档 | 什么时候读 |
|---|---|
| `references/00-架构总览.md` | 想理解整体：三层怎么切、契约是什么 |
| `references/01-企微侧准备.md` | 建机器人、加群 |
| `references/02-命令表与分群.md` | 命令表怎么写、按群分发 |
| `references/03-脚本接口约定.md` | 写取数脚本前的三条约定 |
| `references/04-常驻与防闪窗.md` | 常驻、计划任务、别闪窗 |
| `references/05-排查手册.md` | 出问题，前 6 条覆盖绝大多数情况 |
| `references/06-安全与边界.md` | 权限、边界、哪些事不该做 |
| `references/07-取数路径.md` | 接新平台：选路决策树 + 五类平台配方 |
| `references/08-脚本接入契约与探针.md` | 契约成文 + `--probe` 探针 |
| `references/09-本地化部署.md` | 换机器、凭据健康检查、迁移清单 |
| `references/10-泛化模型与作用域.md` | 品牌/渠道/区域/账号都只是"维度值" |
| `references/11-采集与缓存.md` | 让查询变快、平台挂了仍答得出 |
| `docs/标准操作手册.md/.docx` | 给没有 Python 基础的同事，可整份转发 |

## 许可

MIT © 2026 2JumpSinA

---
<a id="en"></a>
# WeCom "Zero-Token" Query Lane · a skill package

**English** · [中文](#zh) · v2.3.3 · [MIT](LICENSE)

Turn a handful of fixed data lookups into a **zero-token query lane** inside WeCom:
`@bot <command>` in a group → a local script fetches the data → the result lands in that same message.
**No AI agent in the loop, no tokens burned**, and safe to hand to colleagues.

> ⚠️ **First, what this is _not_**: it is **not** an MCP server, **not** an AI agent toolbox,
> **not** a general-purpose chatbot framework. It solves exactly one problem — **turning a few fixed
> read-only lookups into a button in the group chat**, and making it notice its own failures while
> nobody is watching. Wiring an AI into WeCom is deliberately out of scope.

## Why bother

| | Letting an AI agent run the script | This project (direct lane) |
|---|---|---|
| Tokens | Every message replays context → real money | **0** — not a single model call |
| Blast radius | Data lookups, file edits and shell commands behind one door | A fixed command table; anything off-table is refused |
| Permissions | Opening the group = handing over the machine | Read-only scripts + allow-list, **safe to share with colleagues** |
| Latency | Seconds, and you pay every time | **Milliseconds** (reads the background collector; commands without a snapshot take 2–20 s with a placeholder first) |
| Scope | Free-form questions, multi-step tasks | Only those few fixed lookups |

**Not a replacement — a split.** Deterministic lookups take this lane; free-form questions stay on the agent lane.

> **Since v2.2.0**: queries read the results of a **background collector** by default, so they return in
> milliseconds — and they **still answer with the last good data when the upstream platform is down or the
> session has expired** (the reply carries a data timestamp and a staleness note). Adding one `"snapshot"`
> field per command is all it takes; no new script. See `references/11-采集与缓存.md`.

## How it works: three layers, one contract

```
Data acquisition              ← differs per platform, inherently not portable
  read-only scripts in any language: official API / private API / export file / browser automation
        │  coupled only through the script contract (four rules, below)
Channel                       ← the body of this project, zero coupling to the data source
  long-running process + command table (JSON) + watchdog + collection timer
        │  deployed as a local service
Deployment                    ← making it survive on someone else's machine
  installer + scheduled task + heartbeat + migration checklist
```

The three layers change for different reasons: the upstream platform gets redesigned (layer 1),
the WeCom API changes (layer 2), the machine gets replaced (layer 3). Split this way, changing one
does not drag the other two along.

**Lifecycle of one query**:

```
@data-bot orders            (in a WeCom group)
   └─ WeCom pushes the message to a long-lived local connection
      (outbound only: no public IP, no callback URL)
        └─ Channel: who sent it → which group → which command matched → allow-list / group / command checks
             ├─ snapshot configured → read snapshots\<source>.json → return in milliseconds
             │    (a failed latest collection still answers; only missing or too-old data falls through)
             └─ no snapshot → post a placeholder "fetching…" → run the script → complete the same message
```

### The contract: the only requirement for plugging in a script

Any script, in any language, from any source, becomes part of the lane once it satisfies these four rules
(full version in `references/08-脚本接入契约与探针.md`):

| # | Rule | Why |
|---|---|---|
| 1 | **Read-only or rehearsable**: expose `--preview` (or `--dry` / omit `--send`); with it, never send and never mutate state | Otherwise the same data goes out twice, and a manual lookup cancels the day's scheduled broadcast |
| 2 | **Extractable body**: the result sits between two `====` lines (≥10 `=`), or is the whole stdout | Keeps progress logs out of the payload |
| 3 | **Meaningful exit codes**: 0 = success; non-zero = failure with the reason written out | The channel decides between "result" and "failure detail" |
| 4 | **Non-interactive, with a timeout**: never waits for input; a single run is bounded | Nobody can press Enter inside a group chat |

With the contract in place, the question "which platforms are supported?" disappears: the platform is
decided by your script, and the channel only honours the contract.
**Adding a platform = one contract-compliant script + one config entry.**

### How portable is it, honestly

| Part | Portable? | Notes |
|---|---|---|
| Channel code | ✅ Fully | Zero coupling to the data source; swapping scripts touches JSON only |
| Command table / scope model | ✅ Yes | A "brand" is just one instance of a dimension — see `references/10-泛化模型与作用域.md` |
| Deployment & self-healing | ✅ Yes | Scheduled task + watchdog + heartbeat, identical on any Windows box |
| Script contract | ✅ Yes | The four rules are platform-agnostic |
| **The actual fetch scripts** | ❌ **Impossible** | Session handling, endpoints and field names differ per platform — this is the real cost of the design |
| Fetch-path selection | 🟡 Partly | The decision tree travels (`references/07-取数路径.md`); the landing does not |

So the honest expectation: this lowers the cost of **adding one new query** from *days* to *tens of minutes*
(write the script, fill in config, run one self-check) — not "any platform, for free". Any project claiming
the latter is hiding the cost of layer one.

## How it differs from similar projects

**WeCom bots are a solved problem.** The projects below share most of this project's plumbing
(long connection or HTTP callback, command table, allow-list, group chat) — the difference is
*which problem* gets solved:

- [easy-wx/xbot](https://github.com/easy-wx/xbot) — personal-assistant toolbox: `[scene] [cmd] [args]`,
  per-scene/command/date permissions, rich replies, **HTTP callback**. Its command table and permission
  model are worth borrowing; it serves "a human asks a bot to do things", this project serves
  "a few fixed read-only lookups with no model involved".
- [ruilisi/lsbot](https://github.com/ruilisi/lsbot) — *Lean & Secure Bot*: the same **belief**
  (don't route your data through someone else's cloud), but a general bot framework; this project is
  one reproducible query lane.
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

## Quick start

### Hand `SKILL.md` to your agent

`SKILL.md` is the full runbook: prerequisites, a five-step rollout, an acceptance check per step,
eight hard-won rules, and a troubleshooting table. Or just say:

> Read `wecom-zero-token-query/SKILL.md` and turn "check balance / check store hours / check order
> exceptions" into a zero-token query lane in our WeCom group.

### The five-step rollout (each step has its own acceptance check — don't skip)

1. Create a **smart robot** in the WeCom admin console (receiving mode: long connection);
2. Lay down the program directory;
3. Prepare "print, never push" scripts (three interface rules — `references/03-脚本接口约定.md`);
4. Fill in the command table and allow-list (`commands.json`);
5. Make it resident — must go through `wscript`, or you get a console window flashing every minute.

### One-command install

```powershell
.\scripts\install.ps1 -Target D:\wecom-fastlane -BotId aibXXXX -Secret <secret>
```

### Verify right after installing

```cmd
run-fastlane.cmd --routes                      :: are the commands wired up?
run-fastlane.cmd --selftest <trigger>          :: does this command actually work?
run-fastlane.cmd --probe examples\adapter-api.py --run --exe <python.exe>
```

## Repository layout

```
SKILL.md                      the complete runbook for an agent (start here)
VERSION / CHANGELOG.md        version and change log
assets/                       copy-ready runtime (Node daemon fastlane.mjs + watchdog + launchers)
examples/                     three reference adapters: official API / private API / export file (all run offline via --demo)
references/                   00 architecture overview … 11 collection & caching (details and war stories)
tests/                        45 assertion-level regressions (real programs in a sandbox, no network)
scripts/install.ps1           one-command install: copy files, fill config, register task, self-check
scripts/probe-env.ps1         environment health check
scripts/build_manual_docx.py  renders docs/标准操作手册.md to .docx (pure python-docx, no pandoc)
docs/标准操作手册.md/.docx      a step-by-step manual for people with no Python background — forward it as-is
LICENSE                       MIT
```

## Data-acquisition layer: three reference adapters

They map to the three main branches of `references/07-取数路径.md`, and **all run offline (`--demo`)**,
so you can prove the whole path end to end before touching credentials or endpoints.

| File | Platform type | Hard part | Production patterns baked in |
|---|---|---|---|
| `examples/adapter-api.py` | A — a real API | signing / token exchange, rate limits, pagination | HMAC signing, access_token cache, 429 backoff, business codes → human text |
| `examples/adapter-private-api.py` | B — private API (internal console / XHR) | session reuse, parameter encryption, detecting expiry | token injection before password login, AES-CBC param encryption, `重新登陆/401` expiry detection, retry backoff |
| `examples/adapter-export-file.py` | C — export file only | dirty data, shifting column names, encodings | column-name mapping (never column indexes), GBK/UTF-8 auto-detect, dropping known non-exception ledgers, explicit error on missing columns |

> Adapters **only fetch and print**; the channel handles "receive message / match command / reply in group".
> Never put WeCom push code in an adapter — that makes the same data appear twice in the group.

## Requirements

- Node.js ≥ 18
- `@wecom/aibot-node-sdk` (`npm i @wecom/aibot-node-sdk`; on a DSH machine the daemon also looks in DSH's module fallback directory)
- One "print, never push" script per query (conventions and reference implementations in `references/03-脚本接口约定.md`)

## Prerequisites

1. WeCom **administrator** rights (to create a smart robot and add it to a group)
2. The robot's receiving mode must be a **long connection (WebSocket)** — then you need no public IP and no callback URL
3. A Windows machine that stays **powered on and logged in** (no process, no bot)

## Operating it: why this keeps running

- **Collection & caching**: the resident process re-runs every `snapshot` command on a
  `collect.everyMinutes` timer, atomically writes `snapshots\<source>.json`, appends to
  `history\<source>\<date>.jsonl` for later review, and raises a staleness alert at the end of a
  round when it should. When the upstream platform is down, the last good data still answers.
- **"Credentials present ≠ credentials valid"** — the biggest operational pain in this class of system.
  `--check-auth` asks whether they still work; `--set-token` injects a token copied from the browser in
  10 seconds without touching code. **Expiry must fail loudly, never silently return zero rows** —
  seeing "0 stores today" in the group is far more dangerous than seeing an error.
- **Probe and self-check**: `--probe` validates that a script satisfies the contract and emits the config
  entry for it; `--selftest` / `--routes` prove the commands actually run.
- **Assertion-level regressions**: 45 tests (real programs in a sandbox, no network) covering the
  reference adapters, the collection/cache layer, and encoding rules — `.ps1`/`.vbs` files must carry a
  UTF-8 BOM and `.cmd`/`.bat` must stay pure ASCII. That trap has bitten this project twice: a Chinese
  comment decoded as GBK breaks the syntax *and* moves the reported error line dozens of lines away.

## Documentation index

| Document | Read it when |
|---|---|
| `references/00-架构总览.md` | You want the whole picture: how the three layers split, what the contract is |
| `references/01-企微侧准备.md` | Creating the robot, adding it to a group |
| `references/02-命令表与分群.md` | Writing the command table, routing per group |
| `references/03-脚本接口约定.md` | Before writing a fetch script |
| `references/04-常驻与防闪窗.md` | Staying resident, scheduled tasks, no flashing windows |
| `references/05-排查手册.md` | Something broke — the first six entries cover most cases |
| `references/06-安全与边界.md` | Permissions, boundaries, what not to do |
| `references/07-取数路径.md` | New platform: selection decision tree + five platform recipes |
| `references/08-脚本接入契约与探针.md` | The contract in full, plus the `--probe` tool |
| `references/09-本地化部署.md` | Moving to another machine, credential health, migration checklist |
| `references/10-泛化模型与作用域.md` | Brand / channel / region / account are all just dimension values |
| `references/11-采集与缓存.md` | Making queries fast and answerable while the platform is down |
| `docs/标准操作手册.md/.docx` | For colleagues with no Python background — forward it as a whole |

## License

MIT © 2026 2JumpSinA
