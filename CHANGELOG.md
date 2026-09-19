# 变更记录

本技能按"取数层 / 通道层 / 部署层"三层组织（见 `references/00-架构总览.md`）。
版本号在 `VERSION` 文件里；打包用 `scripts/pack.ps1`（会自动排除 logs/、__pycache__、.git 等）。

## v2.1.0 — 凭据生命周期（过期不再是"等失败才发现"）

- **失败回执里的人话提示**（`authHints`）：命中登录态/401/Cookie 失效等特征时，回复里多一行「怎么办」，
  而不是把 traceback 甩给同事。配置规则优先、内置规则兜底；`--hint-selftest` 可离线验证命中情况
- `references/07` 增加**登录态探测脚本的最小配方**（只读接口 + token 打码 + 总是退出 0 的三条注意）
- `references/02` 补 `authHints` 字段说明
- 配套的部署侧实践：把探测做成群命令（如「登录态」），谁都能随时问一句

## v2.0.0 — 通用化重构

**结构**
- 新增 `references/00-架构总览.md`：三层职责边界、数据流、通用性从哪来（含"取数层不可能通用"的结论）
- 新增 `references/07-取数路径.md`：五类数据平台的选路决策树与配方
- 新增 `references/08-脚本接入契约与探针.md`：四条契约成文 + `--probe` 用法
- 新增 `references/09-本地化部署.md`：环境探测、变量路径、凭据生命周期、离线安装、升级回滚、迁移清单
- 新增 `references/10-泛化模型与作用域.md`：把"品牌"泛化成任意维度 + 多租户闸门

**新增能力（通道层）**
- 配置**变量展开**：`${HERE}` `${DSH_HOME}` 任意环境变量 → 换机器不用改路径
- **通用作用域** `scope` / `scopeByGroup`（旧 `brands` / `brandScope` 仍兼容）
- **`--probe` 探针**：把任意脚本变成命令配置，并校验契约（退出码 / 正文 / 裸标签 / 耗时→timeoutMs）
- **`--status` + 群内「状态」内建命令**：随时查进程、连接、心跳、当前任务、最近执行
- **连续失败告警**：同一命令连续失败 N 次主动推群，冷却期内不重复，成功即清零（`alerts` 配置）
- **`--alert-selftest`**：不发一条消息就能验证告警状态机
- 配置 **BOM 容忍**（记事本/PowerShell 写出的 JSON 常带 BOM，原先会直接启动失败）
- `--check` 增加**安全护栏提示**：未检出预演开关的命令、以及对所有人开放时的边界提醒

**新增能力（取数层）**
- `examples/adapter-api.py`（正式 API）、`adapter-private-api.py`（私有接口）、`adapter-export-file.py`（导出文件）
  三个可跑样板，均支持 `--demo` 离线跑通链路
- 样板 B 内置真实项目提炼的模式：token 注入优先、失效标志识别、重试退避、参数加解密
- 样板 B 增加**登录态续期三件套**：`--check-auth` / `--set-token` / `refresh_session()` 钩子
- 样板 C 的已知非异常清单支持环境变量覆盖（便于测试与共享）

**新增能力（部署层）**
- `scripts/probe-env.ps1`：Node / Python / 网络（企微长连接、npm、PyPI、GitHub API）/ 计划任务权限 / 磁盘
- `scripts/pack.ps1`：干净打包（排除日志与缓存）
- `tests/test_adapters.py`：10 条断言级回归（契约 5 条 + 逻辑 4 条 + 失败路径 1 条）

**修复**
- 含中文的 `.ps1` 在无 BOM 时被 PowerShell 5.1 按 GBK 误读 → 中文乱码（三个脚本已加 BOM）
- 探针的参数解析丢弃"值本身以 `--` 开头"的参数（如 `--preview-flag --demo`）
- 安全护栏把内建命令误判为"可能推群的脚本"
- 适配器 docstring 里的 Windows 路径触发 `\x` 转义错误

## v1.0.0 — 首版

- 企微智能机器人长连接 → 本地脚本 → 回群的零 token 通道
- 命令表 / 三级白名单 / 群作用域裁剪 / 流式占位回复 / 剥 HTML 标签
- 计划任务 + 看门狗（进程 + 心跳 + pid 三条件）+ 静默启动（wscript，不闪窗）
- 标准操作手册（Markdown + Word）
