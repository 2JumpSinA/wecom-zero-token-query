# WeCom "Zero-Token" Query Lane · a skill package

[![tests](https://github.com/2JumpSinA/wecom-zero-token-query/actions/workflows/tests.yml/badge.svg)](https://github.com/2JumpSinA/wecom-zero-token-query/actions/workflows/tests.yml) · **English** · [中文](README.zh-CN.md) · v2.3.6 · [MIT](LICENSE)

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

## Development and testing

```bash
python -m pip install -r requirements-dev.txt      # development / testing only
python -m unittest discover -s tests -v            # 46 assertion-level regressions
```

- **`--demo` works with zero third-party dependencies**: the offline path of all three sample
  adapters never imports `requests`, so a plain Python install is enough to prove the whole path.
  One CI job deliberately installs **nothing** to keep that promise honest.
- The channel layer (`assets/fastlane.mjs`) is Node, so the collection/cache tests need Node;
  without it they skip themselves.
- CI: GitHub Actions on `windows-latest` with Python 3.11 / 3.13 (see `.github/workflows/tests.yml`).

## License

MIT © 2026 2JumpSinA
