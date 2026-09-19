#!/usr/bin/env node
/**
 * wecom-fastlane —— 企业微信智能机器人「数据查询」快通道
 * ========================================================
 * 目的：把几类固定查询（余额 / 品牌A门店 / 品牌A订单 …）做成「零 token」通道。
 *
 *   群里 @数据查询机器人 发命令
 *     → 本进程命中命令表
 *     → 直接跑本地 Python 脚本（脚本用「只打印、不推送」模式）
 *     → 把脚本产出的企微 markdown 原样贴回同一条消息
 *
 *   全程不经过 DSH、不经过任何模型，因此不消耗 token。
 *
 * 与 dsh-im 的关系：完全独立。
 *   两者各自持有**不同的**智能机器人凭据（botId/secret），互不依赖。
 *   本进程挂掉不影响 @恢恢企微分身；DSH 重启也不影响本进程。
 *
 * 用法：
 *   node fastlane.mjs                    常驻，接企微长连接
 *   node fastlane.mjs --check            自检配置 / SDK / 凭据（不联网）
 *   node fastlane.mjs --selftest [命令]   本地跑命令并打印，验证「只产文本不推群」（不联网）
 *   node fastlane.mjs --list             列出命令表
 *
 * 配置：同目录 commands.json（命令表 + 白名单 + botId）
 * 凭据：环境变量（commands.json 的 secretEnv）优先，其次同目录 secret.txt
 * 日志：logs\fastlane.log
 */
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(HERE, 'commands.json');
const CONFIG_EXAMPLE = path.join(HERE, 'commands.example.json');
const LOG_DIR = path.join(HERE, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'fastlane.log');
const HEARTBEAT_FILE = path.join(LOG_DIR, 'heartbeat.txt');
const PID_FILE = path.join(LOG_DIR, 'fastlane.pid');
const LOG_MAX_BYTES = 5 * 1024 * 1024;
const MAX_REPLY_BYTES = 20000; // SDK 上限 20480 字节，留余量
const SEPARATOR_RE = /^\s*={10,}\s*$/;

// ---------------------------------------------------------------- 日志
function stamp() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function log(message) {
  const line = `[${stamp()}] ${message}`;
  console.log(line);
  try {
    if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });
    if (existsSync(LOG_FILE) && statSync(LOG_FILE).size > LOG_MAX_BYTES) {
      renameSync(LOG_FILE, `${LOG_FILE}.1`);
    }
    appendFileSync(LOG_FILE, line + '\n', 'utf8');
  } catch {
    /* 日志失败不能影响主流程 */
  }
}

// ---------------------------------------------------------------- 配置
/**
 * 展开配置里的 ${变量}：
 *   ${HERE}      → 通道所在目录（配置和脚本放一起时用它，换机器不用改路径）
 *   ${DSH_HOME}  → DSH 主目录
 *   其它名字     → 按环境变量展开（找不到就原样留着，便于发现问题）
 */
function expandVars(value) {
  if (typeof value !== 'string') return value;
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (whole, name) => {
    if (name === 'HERE') return HERE;
    const v = process.env[name];
    return v === undefined ? whole : v;
  });
}

function loadConfig() {
  let file = CONFIG_PATH;
  if (!existsSync(file)) {
    if (!existsSync(CONFIG_EXAMPLE)) {
      throw new Error(`找不到配置文件：${CONFIG_PATH}（也没有 ${path.basename(CONFIG_EXAMPLE)} 可参考）`);
    }
    file = CONFIG_EXAMPLE;
    log(`!! 没有 ${path.basename(CONFIG_PATH)}，正在用示例配置 ${path.basename(CONFIG_EXAMPLE)} 启动`);
    log('!! 示例里的 botId / 白名单 / 脚本路径都是占位值，请复制成 commands.json 后按文档填写');
  }
  // 容忍 UTF-8 BOM：用记事本「另存为 UTF-8」或 PowerShell 写出来的 JSON 会带 BOM，
  // 而 JSON.parse 遇到 BOM 会直接抛 SyntaxError —— 对非技术使用者这是最容易踩的一脚。
  const raw = readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  const cfg = JSON.parse(raw);
  cfg.commands = Array.isArray(cfg.commands) ? cfg.commands : [];
  for (const c of cfg.commands) {
    if (!c.id || !Array.isArray(c.match)) {
      throw new Error(`命令项格式不对（至少需要 id/match）：${JSON.stringify(c).slice(0, 120)}`);
    }
    if (c.builtin) continue; // 内建命令（如 status）不跑脚本，不需要 exe/args
    if (!c.exe || !Array.isArray(c.args)) {
      throw new Error(`命令项格式不对（需要 exe/args，或声明 builtin）：${JSON.stringify(c).slice(0, 120)}`);
    }
    // 路径不写死：支持 ${HERE} 之类的变量（见 references/09、10）
    c.cwd = expandVars(c.cwd);
    c.exe = expandVars(c.exe);
    c.args = c.args.map(expandVars);
  }
  return cfg;
}

function loadSecret(cfg) {
  const envName = cfg.secretEnv || 'DSH_WECOM_FASTLANE_SECRET';
  const fromEnv = process.env[envName];
  if (fromEnv && fromEnv.trim()) return { secret: fromEnv.trim(), source: `环境变量 ${envName}` };
  const file = path.join(HERE, cfg.secretFile || 'secret.txt');
  if (existsSync(file)) {
    const fromFile = readFileSync(file, 'utf8').trim();
    if (fromFile) return { secret: fromFile, source: `文件 ${file}` };
  }
  return { secret: '', source: `未配置（${envName} 或 ${file}）` };
}

// ---------------------------------------------------------------- SDK
/** 依次尝试的 SDK 绝对路径（本机没有独立 node_modules 时，借用 DSH 的模块回退目录） */
function sdkCandidates() {
  const out = [];
  if (process.env.WECOM_FASTLANE_SDK) out.push(process.env.WECOM_FASTLANE_SDK);
  const rel = path.join('node_modules', '@wecom', 'aibot-node-sdk', 'dist', 'index.esm.js');
  out.push(path.join(HERE, rel));
  out.push(path.join(HERE, '..', rel));
  const home = process.env.DSH_HOME || path.join(process.env.USERPROFILE || '', 'dsh-home');
  try {
    for (const e of readdirSync(path.join(home, 'profiles'), { withFileTypes: true })) {
      if (e.isDirectory()) out.push(path.join(home, 'profiles', e.name, '.dsh-module-fallback', rel));
    }
  } catch {
    /* 没有 DSH_HOME 就跳过这条路 */
  }
  return out;
}

async function loadSdk() {
  try {
    return await import('@wecom/aibot-node-sdk');
  } catch (e) {
    log(`bare import 失败（${e.message}），改为按绝对路径查找 SDK`);
  }
  for (const cand of sdkCandidates()) {
    if (!cand || !existsSync(cand)) continue;
    try {
      const mod = await import(pathToFileURL(cand).href);
      log(`已加载 SDK：${cand}`);
      return mod;
    } catch (e) {
      log(`加载失败：${cand} —— ${e.message}`);
    }
  }
  throw new Error(
    '找不到 @wecom/aibot-node-sdk。请在程序目录执行：npm i @wecom/aibot-node-sdk' +
      '（或用环境变量 WECOM_FASTLANE_SDK 指向它的 dist/index.esm.js）',
  );
}

// ---------------------------------------------------------------- 跑脚本
function runCommand(entry) {
  const timeoutMs = Number(entry.timeoutMs ?? 300000);
  return new Promise((resolve) => {
    const started = Date.now();
    let out = '';
    let err = '';
    let timedOut = false;
    let child;
    try {
      child = spawn(entry.exe, entry.args, {
        cwd: entry.cwd || HERE,
        windowsHide: true,
        env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
      });
    } catch (e) {
      resolve({ ok: false, code: 'spawn-failed', out, err: String(e.message), ms: 0 });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill();
      } catch {
        /* ignore */
      }
    }, timeoutMs);
    child.stdout?.on('data', (d) => (out += d.toString('utf8')));
    child.stderr?.on('data', (d) => (err += d.toString('utf8')));
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ ok: false, code: 'error', out, err: `${err}\n${e.message}`, ms: Date.now() - started });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) {
        resolve({ ok: false, code: 'timeout', out, err, ms: Date.now() - started });
        return;
      }
      resolve({ ok: code === 0, code, out, err, ms: Date.now() - started });
    });
  });
}

/**
 * 剥掉 HTML 标签，只留文字。
 *
 * 为什么必须做：`<font color="comment|info|warning">` 是**群机器人 webhook**
 * 的 markdown 才支持的颜色写法，**智能机器人**（快通道走的就是它）不支持，
 * 原样发出去就会在群里看到裸标签（2026-09-19 实测：`<font color="comment">150</font>`）。
 * 定时播报走 webhook，颜色照旧，不受这里影响。
 *
 * 先按已知标签精确剥离，最后再兜底扫一遍"像标签的东西"，保证群里不出现裸标签。
 */
function sanitizeForBot(text) {
  let out = text
    .replace(/<font\s+color\s*=\s*(?:"[^"]*"|'[^']*'|[^>\s]+)\s*>/gi, '')
    .replace(/<\/font\s*>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?(?:b|i|strong|em|span|div|p|a)\s*[^>]*>/gi, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&amp;/gi, '&');
  // 兜底：任何 <字母...> 或 </字母...> 形态一律去掉（正文是我们自己生成的 markdown，
  // 正常内容不会用到这种尖括号）
  out = out.replace(/<\/?[a-zA-Z][^>\n]{0,60}>/g, '');
  return out.replace(/[ \t]+\n/g, '\n').trim();
}

/** 从脚本 stdout 里剥出「真正要发出去的那段 markdown」 */
function extractPayload(entry, stdout) {
  let text = String(stdout).replace(/\r\n/g, '\n');
  const lines = text.split('\n');

  if ((entry.extract ?? 'separator') === 'separator') {
    const marks = [];
    lines.forEach((l, i) => {
      if (SEPARATOR_RE.test(l)) marks.push(i);
    });
    if (marks.length >= 2) {
      text = lines.slice(marks[marks.length - 2] + 1, marks[marks.length - 1]).join('\n');
    }
  }

  const drops = (entry.dropLines ?? []).map((p) => new RegExp(p));
  if (drops.length) {
    text = text
      .split('\n')
      .filter((l) => !drops.some((r) => r.test(l)))
      .join('\n');
  }
  const cleaned = text.replace(/\n{3,}/g, '\n\n').trim();
  // 智能机器人的 markdown 不认 <font>，这里剥成纯文本；想保留就设 "html": "keep"
  return entry.html === 'keep' ? cleaned : sanitizeForBot(cleaned);
}

/**
 * 按群作用域裁剪正文。
 *
 * 泛化说明（见 references/10）：早期只有"品牌"这一个维度，字段叫 brandScope/brands；
 * 现在维度是任意的（品牌、渠道、区域、账号），字段叫 scopeByGroup/scope，
 * 老字段作为别名继续可用 —— 两种写法等价，互不影响。
 *
 * 规则：正文按空行切成区块；
 *   - 区块里出现了哪个「已知 scope 值」（所有群 scope 的并集），就归属该值；
 *   - 只要沾到本群 scope 就保留，只沾别的就整块丢掉；
 *   - 一个值都没出现的区块（标题、说明行）一律保留；
 *   - 本群 scope 为空 → 不裁剪（"只想自己看"的群就该看到全部）；
 *   - 裁完为空 → 退回原文，绝不发空消息；单聊没有群身份 → 不裁剪。
 */
function groupScope(g) {
  return [...(g?.scope ?? []), ...(g?.brands ?? [])].map(String).filter(Boolean);
}

function applyBrandScope(text, entry, cfg, chatId, chattype) {
  const enabled = entry.scopeByGroup === true || entry.brandScope === 'group';
  if (!enabled || chattype !== 'group') return text;
  const allowed = groupScope(cfg.groups?.[chatId]);
  if (!allowed.length) return text;
  const known = [...new Set(Object.values(cfg.groups ?? {}).flatMap(groupScope))].filter(Boolean);
  if (!known.length) return text;

  const blocks = text.split(/\n{2,}/);
  let dropped = 0;
  const kept = blocks.filter((block) => {
    const hit = known.filter((b) => block.includes(b));
    if (!hit.length) return true; // 与作用域无关（标题等）
    if (hit.some((b) => allowed.includes(b))) return true;
    dropped += 1;
    return false;
  });
  const out = kept.join('\n\n').trim();
  if (!out) return text; // 裁没了就退回原文，绝不发空消息
  if (dropped) log(`按群作用域裁剪：本群=${allowed.join('/')}，丢弃 ${dropped} 个他域区块`);
  return out;
}

// ---------------------------------------------------------------- 文本
function textOf(body) {
  if (body?.msgtype === 'text') return String(body.text?.content ?? '').trim();
  if (body?.msgtype === 'voice') return String(body.voice?.content ?? '').trim(); // 语音转写
  if (body?.msgtype === 'mixed' && Array.isArray(body.mixed?.msg_item)) {
    return body.mixed.msg_item
      .filter((i) => i?.msgtype === 'text' && typeof i.text?.content === 'string')
      .map((i) => i.text.content)
      .join('\n')
      .trim();
  }
  return '';
}

function stripMention(text, chattype) {
  return chattype === 'group' ? text.replace(/^\s*@\S+(?:\s+|$)/u, '').trim() : text.trim();
}

/** 单聊不受群限制；群里只有 chats 列出的群能用这条命令（chats 为空＝各群通用） */
function chatAllowed(cmd, chatId, chattype) {
  if (chattype !== 'group') return true;
  const chats = (cmd.chats ?? []).map((s) => String(s).toLowerCase());
  return chats.length === 0 || chats.includes(String(chatId).toLowerCase());
}

function usableIn(cfg, chatId, chattype) {
  return cfg.commands.filter((c) => c.enabled !== false && chatAllowed(c, chatId, chattype));
}

/** 通用别名在本群/本会话里唯一时才可用（否则要求写明品牌） */
function uniqueGenerics(cmd, usable) {
  return (cmd.generic ?? []).filter(
    (g) => usable.filter((x) => (x.generic ?? []).includes(g)).length === 1,
  );
}

/**
 * 解析命令。
 *   先按 match 精确匹配（"品牌A门店" 在任何地方都认）；
 *   再按 generic 通用别名匹配（"门店"/"订单"/"营业"）——只有在当前会话里
 *   唯一指向一条命令时才生效，从而做到「品牌A群说门店＝品牌A，品牌B群说门店＝品牌B」，
 *   而在单聊里（两边都可用）会返回 ambiguous，让用户写明品牌。
 * @returns {{cmd:object}|{ambiguous:object[]}|null}
 */
function resolveCommand(text, cfg, chatId, chattype) {
  const t = text.trim().toLowerCase();
  if (!t) return null;
  const usable = usableIn(cfg, chatId, chattype);
  for (const c of usable) {
    if (c.match.some((m) => String(m).toLowerCase() === t)) return { cmd: c };
  }
  const generic = usable.filter((c) => (c.generic ?? []).some((m) => String(m).toLowerCase() === t));
  if (generic.length === 1) return { cmd: generic[0] };
  if (generic.length > 1) return { ambiguous: generic };
  return null;
}

function groupInfo(cfg, chatId, chattype) {
  if (chattype !== 'group') return null;
  return cfg.groups?.[chatId] ?? null;
}

function helpText(cfg, chatId, chattype) {
  const info = groupInfo(cfg, chatId, chattype);
  const usable = usableIn(cfg, chatId, chattype);
  const list = usable
    .map((c) => {
      const gen = uniqueGenerics(c, usable);
      return `> **${c.match.join(' / ')}** —— ${c.label}${gen.length ? `（本群也可直接说：${gen.join(' / ')}）` : ''}${c.long ? '｜较慢，几十秒' : ''}`;
    })
    .join('\n');
  const head = info?.name ? `### 数据查询机器人 · ${info.name}` : '### 数据查询机器人';
  const brand = info?.brands?.length ? `\n> 本群默认品牌：${info.brands.join(' / ')}` : '';
  return `${head}${brand}\n> 直接 @我 并发送下面的命令：\n${list}\n> 其它问题请 @恢恢企微分身（那条通道会带上下文，但会消耗额度）`;
}

/** 心跳文件：只有「连接正常」时才写，并带上自己的 PID。
 *  看门狗据此区分三件事：进程在不在、连接活不活、心跳是不是**这个**进程写的。
 *  （2026-09-19 的教训：只看"有个进程 + 心跳文件还新鲜"，会把一次
 *   --selftest 运行 + 上一个进程留下的心跳误判成健康，于是该重启时没重启。） */
function beat(note) {
  try {
    if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });
    writeFileSync(HEARTBEAT_FILE, `${new Date().toISOString()} pid=${process.pid} ${note ?? ''}\n`, 'utf8');
  } catch {
    /* 心跳失败不能影响主流程 */
  }
}

function readPidFile() {
  try {
    const n = Number(readFileSync(PID_FILE, 'utf8').trim());
    return Number.isInteger(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

function heartbeatPid() {
  try {
    const m = readFileSync(HEARTBEAT_FILE, 'utf8').match(/pid=(\d+)/);
    return m ? Number(m[1]) : 0;
  } catch {
    return 0;
  }
}

function heartbeatAgeSeconds() {
  try {
    return (Date.now() - statSync(HEARTBEAT_FILE).mtimeMs) / 1000;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e?.code === 'EPERM'; // 存在但没权限 → 也算活着
  }
}

// ---------------------------------------------------------------- 失败跟踪与告警
/**
 * 连续失败告警。
 * 为什么需要：凭据过期、平台改版这类故障，用户不问就永远不知道 ——
 * 群里看起来只是"今天没人查"，实际是坏的。所以连续失败要主动出声。
 *
 * 策略（配置在 commands.json 的 alerts 字段）：
 *   { "enabled": true, "consecutiveFailures": 3, "cooldownMinutes": 60, "dryRun": false }
 *   - 同一命令连续失败 N 次 → 往"出事的那条会话"推一条提醒
 *   - 冷却期内不重复告警（默认 60 分钟），成功一次就清零
 */
const failureState = new Map(); // cmdId -> { fails, lastAlertAt }
const lastRuns = new Map(); // cmdId -> { ts, ok, code, ms }
const STARTED_AT = Date.now();

function noteSuccess(cmdId) {
  const st = failureState.get(cmdId);
  if (st?.fails) log(`连续失败计数清零：${cmdId}（此前连续 ${st.fails} 次）`);
  if (st) st.fails = 0;
}

/** 记录一次失败，返回 { alert, reason } —— 纯状态机，便于用 --alert-selftest 验证 */
function noteFailure(cmdId, alerts) {
  const a = alerts ?? {};
  const st = failureState.get(cmdId) ?? { fails: 0, lastAlertAt: 0 };
  st.fails += 1;
  failureState.set(cmdId, st);

  if (a.enabled === false) return { alert: false, reason: 'alerts.enabled=false' };
  const threshold = Number(a.consecutiveFailures ?? 3);
  if (!Number.isFinite(threshold) || threshold <= 0) return { alert: false, reason: '阈值未启用' };
  if (st.fails < threshold) return { alert: false, reason: `第 ${st.fails}/${threshold} 次` };

  const cooldownMs = Number(a.cooldownMinutes ?? 60) * 60 * 1000;
  const since = Date.now() - st.lastAlertAt;
  if (st.lastAlertAt && since < cooldownMs) {
    return { alert: false, reason: `冷却中（还需 ${Math.ceil((cooldownMs - since) / 60000)} 分钟）` };
  }
  st.lastAlertAt = Date.now();
  return { alert: true, reason: `连续 ${st.fails} 次失败` };
}

/** 状态文本：群里发「状态」时回的内容，与 CLI 的 --status 共用 */
function buildStatusText(cfg, rt) {
  const { connected, running, startedAt, pid, hbAge } = rt;
  const upMs = Date.now() - (startedAt ?? STARTED_AT);
  const upMin = Math.max(0, Math.floor(upMs / 60000));
  const upText = upMin >= 60 ? `${Math.floor(upMin / 60)} 小时 ${upMin % 60} 分` : `${upMin} 分钟`;
  const conn = typeof connected === 'string' ? connected : connected ? '已认证' : '未连接';
  const lines = [
    '### 数据查询机器人 · 状态',
    `> 进程：pid ${pid ?? '-'}，本次已运行 ${upText}`,
    `> 长连接：${conn}`,
    `> 心跳：${Number.isFinite(hbAge) ? `${Math.round(hbAge)} 秒前` : '（读不到）'}`,
    `> 当前任务：${running ?? '空闲'}`,
    `> 命令数：${cfg.commands.filter((c) => c.enabled !== false).length} 条｜访问策略：${cfg.allowAllUsers === true ? '对所有人开放' : '白名单'}`,
  ];
  const recent = [...lastRuns.entries()].slice(-5);
  if (recent.length) {
    lines.push('> 最近执行：');
    for (const [id, r] of recent) {
      const t = new Date(r.ts).toTimeString().slice(0, 5);
      const fails = failureState.get(id)?.fails ?? 0;
      lines.push(`> · ${id}：${t} ${r.ok ? '成功' : '失败'} ${(r.ms / 1000).toFixed(1)}s${fails ? `（已连续失败 ${fails} 次）` : ''}`);
    }
  } else {
    lines.push('> 最近执行：（本次启动后还没有查询）');
  }
  const hb = heartbeatAgeSeconds();
  if (Number.isFinite(hb) && hb > 240) lines.push('> ⚠️ 心跳超过 4 分钟未刷新，看门狗应当已经着手重启');
  return lines.join('\n');
}

/**
 * 失败原因里的人话提示。
 * 为什么需要：脚本失败时最常甩出一段 traceback，同事看不懂；而这类失败里
 * 绝大多数是「登录态过期」——一句"运行 login.bat 续期"能省掉一整轮沟通。
 * 配置：commands.json 的 authHints 数组 [{ "match": "<正则>", "hint": "<人话>" }]，
 * 不配置时用下面的内置默认。
 */
const DEFAULT_AUTH_HINTS = [
  {
    match: '重新登陆|重新登录|验证错误|未登录|登录态失效|登录态已失效|token[^\\n]{0,12}(过期|失效)|凭据[^\\n]{0,12}(过期|失效)',
    hint: '看起来是登录态/凭据失效 → 在本机运行 login.bat 重新登录（或注入新的 token）',
  },
  { match: '\\b401\\b|Unauthorized', hint: '接口返回 401（未授权）→ 登录态多半已过期，续期后重试' },
  { match: 'cookie[^\\n]{0,12}(失效|过期)', hint: 'Cookie 已失效 → 运行 login.bat 重新捕获登录态' },
];

function authHintFor(text, cfg) {
  // 先看配置里的规则，再退回内置规则 —— 这样"只加一条自己的规则"不会把通用覆盖丢掉
  const configured = Array.isArray(cfg.authHints) ? cfg.authHints : [];
  const hay = String(text ?? '');
  for (const r of [...configured, ...DEFAULT_AUTH_HINTS]) {
    if (!r || !r.match) continue;
    try {
      if (new RegExp(r.match, 'i').test(hay)) return r.hint ?? '';
    } catch {
      /* 配置里的正则写错就跳过，不能让提示功能把主流程带崩 */
    }
  }
  return '';
}

/** 主动推一条提醒（告警用）。dryRun 时只写日志，不打扰群。 */async function sendAlert(client, cfg, chatId, text) {
  if (cfg.alerts?.dryRun === true) {
    log(`[dryRun] 本该推送告警：${text.replace(/\n/g, ' ｜ ')}`);
    return;
  }
  try {
    await client.sendMessage(chatId, { msgtype: 'markdown', markdown: { content: text } });
    log(`已推送连续失败告警到 ${chatId}`);
  } catch (e) {
    log(`告警推送失败：${e?.message ?? e}`);
  }
}

// ---------------------------------------------------------------- 主流程
async function serve(cfg, sdk) {
  const { WSClient, generateReqId } = sdk;
  const { secret, source } = loadSecret(cfg);
  if (!cfg.botId || !secret) {
    throw new Error(`缺少机器人凭据：botId=${cfg.botId ? '已配置' : '空'}，secret=${source}`);
  }

  const allowedUsers = new Set((cfg.allowedUsers ?? []).map((s) => s.toLowerCase()));
  const allowedChats = new Set((cfg.allowedChats ?? []).map((s) => s.toLowerCase()));

  // 访问策略。历史遗留陷阱：旧写法是 `if (allowedUsers.size && !has(uid))`，
  // 结果「空数组」＝放行所有人，而配置文件说明、--check 输出、操作手册三处
  // 都写着「空＝谁都不响应」—— 想锁死的人反而门户大开。这里改成显式二选一：
  //   allowAllUsers === true  → 对所有人开放（忽略白名单）
  //   否则                    → 严格按白名单；空数组＝谁都不响应（真的安全默认）
  const allowAllUsers = cfg.allowAllUsers === true;
  const userAllowed = (uid) => allowAllUsers || allowedUsers.has(String(uid).toLowerCase());

  // 单实例保护：同一个机器人挂两条长连接会让消息被两边各回一次。
  // 只有当「pid 文件里的进程还活着，且心跳是它写的、且新鲜」时才让路；
  // 心跳不新鲜说明那已经是个死实例，本进程接管。
  const otherPid = readPidFile();
  if (
    otherPid &&
    otherPid !== process.pid &&
    processAlive(otherPid) &&
    heartbeatPid() === otherPid &&
    heartbeatAgeSeconds() < 120
  ) {
    log(`已有实例在运行（pid ${otherPid}，心跳 ${Math.round(heartbeatAgeSeconds())}s 前），本进程退出`);
    return;
  }

  let running = null; // 单飞：同一时刻只跑一个查询
  let connected = false;

  const client = new WSClient({ botId: cfg.botId, secret, maxReconnectAttempts: -1 });

  // 把自己的 PID 写下来：看门狗据此精确找到本进程，不必去猜命令行
  try {
    if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });
    writeFileSync(PID_FILE, String(process.pid), 'utf8');
  } catch {
    /* PID 文件写不了不影响运行，看门狗有兜底扫描 */
  }

  client.on('authenticated', () => {
    connected = true;
    log('已连接企微智能机器人（WebSocket 长连接认证成功）');
    beat('authenticated');
  });
  client.on('disconnected', (reason) => {
    connected = false;
    log(`连接断开：${reason ?? '未知'}`);
  });
  client.on('reconnecting', (attempt) => log(`正在重连（第 ${attempt} 次）`));
  client.on('error', (e) => {
    log(`SDK 错误：${e?.message ?? e}`);
  });

  // 心跳只代表「连接健康」：断开期间不写，看门狗据此重启进程
  const heartbeatTimer = setInterval(() => {
    if (connected) beat('alive');
  }, 60000);
  heartbeatTimer.unref?.();

  client.on('event.enter_chat', async (frame) => {
    try {
      const body = frame?.body ?? {};
      const uid = (body.from?.userid ?? '').toLowerCase();
      const chattype = body.chattype === 'group' ? 'group' : 'direct';
      const chatId = chattype === 'group' ? String(body.chatid ?? '') : uid;
      if (!userAllowed(uid)) return;
      await client.replyWelcome(frame, {
        msgtype: 'markdown',
        markdown: { content: helpText(cfg, chatId, chattype) },
      });
    } catch (e) {
      log(`欢迎语发送失败：${e?.message ?? e}`);
    }
  });

  async function handle(frame) {
    const body = frame?.body ?? {};
    const chattype = body.chattype === 'group' ? 'group' : 'direct';
    const userId = String(body.from?.userid ?? '');
    const chatId = chattype === 'group' ? String(body.chatid ?? '') : userId;
    const raw = textOf(body);
    const text = stripMention(raw, chattype);
    const groupName = groupInfo(cfg, chatId, chattype)?.name ?? '';

    log(`收到消息 chattype=${chattype} chat=${chatId}${groupName ? `(${groupName})` : ''} user=${userId} text=${JSON.stringify(text)}`);
    beat('message');

    if (!userAllowed(userId)) {
      log(allowedUsers.size
        ? '发送者不在白名单，静默忽略'
        : '白名单为空且未开 allowAllUsers，静默忽略（安全默认）');
      return;
    }
    if (allowedChats.size && chattype === 'group' && !allowedChats.has(chatId.toLowerCase())) {
      log('群不在白名单，静默忽略');
      return;
    }
    if (!text) return;

    const streamId = generateReqId('stream');
    const hit = resolveCommand(text, cfg, chatId, chattype);

    if (!hit) {
      log('未命中命令，回复帮助');
      await client.replyStream(frame, streamId, helpText(cfg, chatId, chattype), true);
      return;
    }
    if (hit.ambiguous) {
      const names = hit.ambiguous.map((c) => c.match[0]).join(' / ');
      log(`通用别名在本会话不唯一，已要求写明品牌：${names}`);
      await client.replyStream(frame, streamId, `> 这里能查多个品牌，请写明要哪个：${names}`, true);
      return;
    }
    const cmd = hit.cmd;

    // 内建命令：状态。不跑脚本，直接回运行状况；放在单飞检查之前，
    // 这样"有查询正在跑"的时候也能问一句状态。
    if (cmd.builtin === 'status') {
      log('内建命令：状态');
      await client.replyStream(
        frame,
        streamId,
        buildStatusText(cfg, {
          connected,
          running,
          startedAt: STARTED_AT,
          pid: process.pid,
          hbAge: heartbeatAgeSeconds(),
        }),
        true,
      );
      return;
    }

    if (running) {
      await client.replyStream(frame, streamId, `> 上一条查询（${running}）还在执行，请等它出结果后再试。`, true);
      return;
    }

    running = cmd.label;
    log(`开始执行：${cmd.id}（${cmd.label}）`);
    try {
      await client.replyStream(frame, streamId, `> 已收到「${cmd.label}」查询，正在取数…`, false);
    } catch (e) {
      log(`占位回复失败：${e?.message ?? e}`);
    }

    try {
      const res = await runCommand(cmd);
      const payload = applyBrandScope(
        extractPayload(cmd, res.out),
        cmd,
        cfg,
        chatId,
        chattype,
      );
      log(`执行结束：${cmd.id} exit=${res.code} ${(res.ms / 1000).toFixed(1)}s stdout=${Buffer.byteLength(res.out, 'utf8')}B 正文=${Buffer.byteLength(payload, 'utf8')}B`);

      if (!res.ok || !payload) {
        const tail = (res.err || res.out || '').trim().split('\n').slice(-6).join('\n');
        const detail = tail ? `\n> ${tail.replace(/\n/g, '\n> ')}` : '';
        const hint = authHintFor(`${res.err}\n${res.out}`, cfg);
        if (hint) log(`命中失败提示规则：${hint}`);
        const hintLine = hint ? `\n> 💡 ${hint}` : '';
        await client.replyStream(frame, streamId, `### ❌ ${cmd.label}查询失败\n> 退出码：${res.code}，耗时 ${(res.ms / 1000).toFixed(1)} 秒${hintLine}${detail}`, true);
        lastRuns.set(cmd.id, { ts: Date.now(), ok: false, code: res.code, ms: res.ms });
        const dec = noteFailure(cmd.id, cfg.alerts);
        log(`失败计数：${cmd.id} —— ${dec.alert ? '★ 触发告警' : '不告警'}（${dec.reason}）`);
        if (dec.alert) {
          const fails = failureState.get(cmd.id)?.fails ?? '?';
          await sendAlert(
            client,
            cfg,
            chatId,
            `### ⚠️ ${cmd.label}连续失败\n` +
              `> 已连续失败 ${fails} 次（${dec.reason}）\n` +
              `> 最近一次：退出码 ${res.code}，耗时 ${(res.ms / 1000).toFixed(1)} 秒\n` +
              '> 常见原因：登录态过期 / 平台改版 / 脚本路径变动\n' +
              '> 排查：本机 `logs\\fastlane.log`，或见 references/05-排查手册.md',
          );
        }
        return;
      }
      noteSuccess(cmd.id);
      lastRuns.set(cmd.id, { ts: Date.now(), ok: true, code: res.code, ms: res.ms });
      const clipped =
        Buffer.byteLength(payload, 'utf8') > MAX_REPLY_BYTES
          ? payload.slice(0, MAX_REPLY_BYTES) + '\n> （内容过长已截断，完整明细见本地日志）'
          : payload;
      await client.replyStream(frame, streamId, clipped, true);
    } catch (e) {
      log(`执行异常：${cmd.id} ${e?.stack ?? e}`);
      lastRuns.set(cmd.id, { ts: Date.now(), ok: false, code: 'exception', ms: 0 });
      const dec = noteFailure(cmd.id, cfg.alerts);
      if (dec.alert) {
        await sendAlert(client, cfg, chatId, `### ⚠️ ${cmd.label}连续失败\n> ${String(e?.message ?? e)}`);
      }
      try {
        await client.replyStream(frame, streamId, `### ❌ ${cmd.label}查询异常\n> ${String(e?.message ?? e)}`, true);
      } catch {
        /* ignore */
      }
    } finally {
      running = null;
    }
  }

  client.on('message.text', (frame) => void handle(frame).catch((e) => log(`处理失败：${e?.stack ?? e}`)));
  client.on('message.voice', (frame) => void handle(frame).catch((e) => log(`处理失败：${e?.stack ?? e}`)));

  client.connect();
  log('正在连接企微智能机器人…');

  const stop = () => {
    log('收到退出信号，断开连接');
    try {
      client.disconnect();
    } catch {
      /* ignore */
    }
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

// ---------------------------------------------------------------- 探针
/**
 * --probe：把「任意一个脚本」变成一条命令配置，并（可选）校验它是否满足契约。
 *   静态模式：猜解释器、生成可粘贴的 JSON 条目、列出要人工确认的点（不执行脚本）
 *   --run   ：真跑一次（默认带预演开关），检查：退出码 / 正文可提取 / 无裸标签 / 实测耗时
 * 见 references/08-脚本接入契约与探针.md
 */
async function probeScript(args) {
  const target = args.find((a) => !a.startsWith('--'));
  const has = (n) => args.includes(n);
  const opt = (n, d) => {
    const i = args.indexOf(n);
    return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d;
  };
  // 取"下一个 token 原样"的版本：--preview-flag 的值本身可能就是 --demo 这种开关，
  // 用上面的 opt() 会被"下一项也是开关"的启发式丢掉。
  const optRaw = (n, d) => {
    const i = args.indexOf(n);
    return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : d;
  };
  if (!target) {
    console.log('用法: run-fastlane.cmd --probe <脚本路径> [--run] [--preview-flag --preview] [--exe <解释器>] [--cwd <工作目录>] [--timeout <毫秒>]');
    return 2;
  }
  if (!existsSync(target)) {
    console.log(`找不到脚本：${target}`);
    return 2;
  }

  const previewFlag = optRaw('--preview-flag', '--preview');
  const cwd = opt('--cwd', path.dirname(path.resolve(target)));
  const ext = path.extname(target).toLowerCase();
  let exe = opt('--exe', '');
  let cmdArgs;
  if (exe) {
    cmdArgs = [target, previewFlag];
  } else if (ext === '.py') {
    exe = process.env.PYTHON_EXE || 'python';
    cmdArgs = ['-X', 'utf8', target, previewFlag];
  } else if (ext === '.ps1') {
    exe = 'powershell.exe';
    cmdArgs = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', target, previewFlag];
  } else if (ext === '.js' || ext === '.mjs') {
    exe = process.execPath;
    cmdArgs = [target, previewFlag];
  } else {
    exe = target;
    cmdArgs = [previewFlag];
  }

  const base = path.basename(target).replace(/\.[^.]+$/, '');
  const entry = {
    id: base.replace(/[^A-Za-z0-9_-]/g, '-').toLowerCase(),
    label: base,
    match: ['<在这里填群里要发的触发词>'],
    chats: [],
    cwd,
    exe,
    args: cmdArgs,
    extract: 'separator',
    timeoutMs: Number(opt('--timeout', '180000')),
    long: true,
  };

  console.log('=== 静态分析 ===');
  console.log(`脚本   : ${path.resolve(target)}  (${(statSync(target).size / 1024).toFixed(1)} KB)`);
  console.log(`解释器 : ${exe}`);
  console.log(`参数   : ${cmdArgs.join(' ')}`);
  console.log(`工作目录: ${cwd}`);
  console.log('\n=== 可直接粘贴的配置条目 ===');
  console.log(JSON.stringify(entry, null, 2));

  if (!has('--run')) {
    console.log('\n=== 下一步 ===');
    console.log('  1) 确认预演开关真的是这个（默认假设 --preview；有的脚本是 --dry 或不加 --send）');
    console.log('  2) 把触发词填进 match，按需填 chats / generic / scopeByGroup');
    console.log(`  3) 真跑一次做契约校验：run-fastlane.cmd --probe "${target}" --run [--preview-flag --dry]`);
    console.log('     注意：--run 会真的执行脚本（应当在预演模式下，不会发群）');
    return 0;
  }

  console.log('\n=== 契约校验（真跑一次，带预演开关）===');
  const res = await runCommand(entry);
  const payload = extractPayload(entry, res.out);
  const leftover = payload.match(/<\/?[a-zA-Z][^>\n]*>/g);
  const checks = [
    ['契约3 退出码为 0', res.ok, `exit=${res.code}`],
    ['契约2 取到正文', Boolean(payload && payload.length > 0), `${Buffer.byteLength(payload || '', 'utf8')} 字节`],
    ['正文无裸标签', !leftover, leftover ? [...new Set(leftover)].join(' ') : 'OK'],
  ];
  for (const [name, ok, extra] of checks) console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}  (${extra})`);
  const suggested = Math.max(30000, Math.ceil((res.ms * 3) / 10000) * 10000);
  console.log(`\n实测耗时 ${(res.ms / 1000).toFixed(1)}s → 建议 timeoutMs = ${suggested}（留 3 倍余量）`);
  console.log('\n--- 正文预览（前 500 字）---');
  console.log((payload || '(空)').slice(0, 500));
  if (res.err.trim()) console.log(`\n--- stderr 尾部 ---\n${res.err.trim().split('\n').slice(-3).join('\n')}`);
  console.log('\n机器验不了的（需人工确认）：契约1 预演时确实没发消息/没写状态；契约4 运行时不等待输入。');
  return checks.every(([, ok]) => ok) ? 0 : 1;
}

// ---------------------------------------------------------------- 入口
async function main() {
  const argv = process.argv.slice(2);
  const mode = argv[0] ?? '';

  // --probe 不需要读配置（它正是用来生成配置的）
  if (mode === '--probe') return probeScript(argv.slice(1));

  const cfg = loadConfig();

  // 状态：与群里发「状态」同一份文本，方便在命令行核对
  if (mode === '--status') {
    console.log(
      buildStatusText(cfg, {
        connected: '未知（CLI 模式）',
        running: null,
        startedAt: null,
        pid: readPidFile() || '-',
        hbAge: heartbeatAgeSeconds(),
      }),
    );
    return 0;
  }

  // 告警状态机自检：喂 N 次失败，打印每次的判定（不联网、不打扰群）
  if (mode === '--hint-selftest') {
    const samples = [
      'RuntimeError: 登录态失效: {code: 401, msg: "请重新登陆"}',
      'requests.exceptions.HTTPError: 401 Unauthorized',
      'cookie 已失效，请重新捕获',
      'ValueError: 找不到配置文件 config.json',
    ];
    for (const s of samples) {
      const hit = authHintFor(s, cfg);
      console.log(`  ${hit ? '★ 命中' : '  未命中'}  ${s}`);
      if (hit) console.log(`         → ${hit}`);
    }
    return 0;
  }

  if (mode === '--alert-selftest') {
    const id = argv[1] && !argv[1].startsWith('--') ? argv[1] : 'demo';
    const a = cfg.alerts ?? {};
    console.log(
      `策略：enabled=${a.enabled !== false} 阈值=${a.consecutiveFailures ?? 3} 冷却=${a.cooldownMinutes ?? 60}分钟 dryRun=${a.dryRun === true}`,
    );
    for (let i = 1; i <= 5; i += 1) {
      const d = noteFailure(id, a);
      console.log(`  第 ${i} 次失败 → ${d.alert ? '★ 触发告警' : '不告警'}（${d.reason}）`);
    }
    noteSuccess(id);
    const after = noteFailure(id, a);
    console.log(`  成功清零后再失败 1 次 → ${after.alert ? '★ 触发告警' : '不告警'}（${after.reason}）`);
    return 0;
  }

  if (mode === '--list') {
    for (const c of cfg.commands) {
      console.log(`${c.enabled === false ? '[停用] ' : ''}${c.id.padEnd(16)} ${c.match.join(' / ').padEnd(28)} ${c.label}`);
    }
    return 0;
  }

  if (mode === '--check') {
    const sdk = await loadSdk();
    const { secret, source } = loadSecret(cfg);
    console.log(`SDK        : ${typeof sdk.WSClient === 'function' ? 'OK（WSClient 可用）' : '异常：没有 WSClient'}`);
    console.log(`botId      : ${cfg.botId || '（空，等你在企微后台建好机器人后填）'}`);
    console.log(`secret     : ${secret ? `已就绪（来源：${source}）` : `缺失（${source}）`}`);
    console.log(`访问策略   : ${cfg.allowAllUsers === true ? '★ 对所有人开放（allowAllUsers=true）' : '仅白名单'}`);
    console.log(`白名单用户 : ${(cfg.allowedUsers ?? []).join(', ') || '（空＝谁都不响应）'}`);
    console.log(`白名单群   : ${(cfg.allowedChats ?? []).join(', ') || '（空＝所有群）'}`);
    for (const [id, g] of Object.entries(cfg.groups ?? {})) {
      console.log(`群绑定     : ${g.name} = ${id}　作用域 ${groupScope(g).join('/') || '未设（不裁剪，看到全部）'}`);
    }
    console.log(`命令数     : ${cfg.commands.filter((c) => c.enabled !== false).length} 条可用`);

    // 护栏：对所有人开放时，安全边界就从「谁能用」移到了「命令表里有什么」。
    // 这里只提示（不是错误）。注意启发式的天然局限：有的脚本用「不带 --send」表示预演，
    // 那是"缺少某个参数"，机器看不出来 —— 这类命令请在配置里显式写 "readonly": true 消歧。
    const risky = cfg.commands.filter(
      (c) =>
        c.enabled !== false &&
        !c.builtin &&
        c.readonly !== true &&
        !(c.args ?? []).some((a) => /^--(preview|dry|no-?send)$/i.test(String(a))),
    );
    if (risky.length) {
      console.log(
        `⚠ 未检出预演开关 : ${risky.map((c) => c.id).join(', ')}` +
          ' —— 请人工确认它不会自己推群、不会写「今天已推」状态；确认无误就在该命令上加 "readonly": true',
      );
    }
    if (cfg.allowAllUsers === true) {
      console.log('⚠ 访问策略      : 对所有人开放 → commands[] 就是安全边界，只放只读脚本，新增前先想一遍');
    }
    return sdk.WSClient && cfg.botId && secret ? 0 : 1;
  }

  // 不联网的路由自检：把每个群里每条别名的解析结果打出来
  if (mode === '--routes') {
    const probes = [...new Set(cfg.commands.flatMap((c) => [...c.match, ...(c.generic ?? [])]))];
    const show = (p, chatId, chattype) => {
      const hit = resolveCommand(p, cfg, chatId, chattype);
      if (hit?.cmd) return `${hit.cmd.id}（${hit.cmd.label}）`;
      if (hit?.ambiguous) return `需写明品牌：${hit.ambiguous.map((c) => c.match[0]).join(' / ')}`;
      return '（无此命令 → 回帮助）';
    };
    for (const [chatId, info] of Object.entries(cfg.groups ?? {})) {
      console.log(`\n=== ${info.name}　${chatId} ===`);
      for (const p of probes) console.log(`  ${p.padEnd(10)} -> ${show(p, chatId, 'group')}`);
    }
    console.log('\n=== 单聊（无群上下文） ===');
    for (const p of probes) console.log(`  ${p.padEnd(10)} -> ${show(p, (cfg.allowedUsers ?? ['dm'])[0], 'direct')}`);
    return 0;
  }

  if (mode === '--selftest') {
    // 可选：--as-group <群ID> —— 以「某个群的视角」试跑（会应用该群的品牌裁剪），
    // 但依然只打印、不发群。用来验证「品牌A群里不会出现品牌B的数字」。
    const rest = argv.slice(1);
    const gi = rest.indexOf('--as-group');
    const asGroup = gi >= 0 ? String(rest[gi + 1] ?? '').trim() : '';
    const filter = rest.find((a, i) => !a.startsWith('--') && !(gi >= 0 && i === gi + 1)) ?? '';
    if (asGroup) {
      const info = cfg.groups?.[asGroup];
      console.log(
        info
          ? `以群视角试跑：${info.name}（本群品牌 ${(info.brands ?? []).join('/') || '未设'}）`
          : `以群视角试跑：${asGroup}（⚠ 不在 cfg.groups 里，不会裁剪）`,
      );
    }
    const targets = cfg.commands.filter(
      (c) => !c.builtin && (!filter || c.id === filter || c.label === filter || c.match.includes(filter)),
    );
    if (!targets.length) {
      console.log(`没有匹配「${filter}」的命令`);
      return 1;
    }
    let bad = 0;
    for (const c of targets) {
      const r = await runCommand(c);
      const payload = applyBrandScope(
        extractPayload(c, r.out),
        c,
        cfg,
        asGroup,
        asGroup ? 'group' : 'direct',
      );
      // 群里出现裸标签 = 体验事故，直接判失败（智能机器人的 markdown 不认 <font>）
      const leftover = payload.match(/<\/?[a-zA-Z][^>\n]*>/g);
      console.log('─'.repeat(64));
      console.log(`# ${c.label}（${c.id}） exit=${r.code} 耗时=${(r.ms / 1000).toFixed(1)}s 正文=${Buffer.byteLength(payload, 'utf8')}B`);
      if (leftover) console.log(`!! 正文里仍有疑似标签：${[...new Set(leftover)].join(' ')}`);
      console.log(payload ? payload.slice(0, 1500) : `(正文为空；stderr 尾部：${(r.err || '').trim().split('\n').slice(-4).join(' | ')})`);
      if (!r.ok || !payload || leftover) bad += 1;
    }
    console.log('─'.repeat(64));
    console.log(bad ? `自检结束：${bad} 条异常` : '自检结束：全部正常（命令都能只产文本、不推群）');
    return bad ? 1 : 0;
  }

  const sdk = await loadSdk();
  await serve(cfg, sdk);
  return 0;
}

main().then(
  (code) => {
    if (code !== 0) process.exitCode = code;
  },
  (e) => {
    log(`启动失败：${e?.stack ?? e}`);
    process.exitCode = 1;
  },
);
