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
 *   node fastlane.mjs --collect [命令]    采集：跑带 snapshot 的命令，把正文落进 snapshots\（联网取数、不发群）
 *   node fastlane.mjs --query <命令>      离线预演：走与群内查询完全相同的「读缓存 + 裁剪 + 数据时间」路径，只打印
 *   node fastlane.mjs --stale-selftest   陈旧告警判定自检（喂样本、不联网、不打扰群）
 *   node fastlane.mjs --stale-check      拿真实快照跑一遍陈旧告警判定，打印"会推什么"（不推群）
 *   node fastlane.mjs --history [源] [--date YYYY-MM-DD]   回看某天的采集留档与空档（只读本地文件）
 *
 * 配置：同目录 commands.json（命令表 + 白名单 + botId）
 * 凭据：环境变量（commands.json 的 secretEnv）优先，其次同目录 secret.txt
 * 日志：logs\fastlane.log
 */
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
const SNAPSHOT_DIR = path.join(HERE, 'snapshots');
const HISTORY_DIR = path.join(HERE, 'history');
const COLLECT_LOG_FILE = path.join(LOG_DIR, 'collect.log');

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

// ---------------------------------------------------------------- 快照缓存
/**
 * 「查询＝读采集结果」的落地（设计见 `架构改进备忘.md` §3）。
 *
 * 为什么这么改：现状是「查询＝现场抓取」——余额要 20 秒，且平台挂了/凭据过期
 * 就答不出来。改成读采集结果后：毫秒响应、平台出事也能答、对平台的请求量从
 * 「谁想起来问就抓一次」变成「每 10 分钟固定一次」。
 *
 * 为什么先缓存 markdown 原文而不是结构化数据：改动最小、复用全部现有脚本
 * （脚本本来就有「只打印不推送」模式），立刻拿到收益。代价是「改文案要重采
 * 一次」——手动跑一次 --collect 即可抹平。等真需要「同源不同口径」再升级结构。
 *
 * 为什么存**未裁剪**的正文：品牌裁剪是按群做的（applyBrandScope），采集的
 * 那一刻并不知道将来会被哪个群查，所以存全量、查询时再裁。
 */
function ensureSnapshotDir() {
  if (!existsSync(SNAPSHOT_DIR)) mkdirSync(SNAPSHOT_DIR, { recursive: true });
}

/** 采集器专用日志：守护进程的 fastlane.log 是「谁问了什么」，采集是后台噪声，分开写 */
function logCollect(message) {
  const line = `[${stamp()}] ${message}`;
  console.log(line);
  try {
    if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });
    // 与 fastlane.log 同样轮转：每 10 分钟一轮、每轮几行，一天约 50KB —— 不轮转也不会立刻出事，
    // 但「日志悄悄长到几个 G」是这类常驻脚本最经典的坑，一眼能防就别留。
    if (existsSync(COLLECT_LOG_FILE) && statSync(COLLECT_LOG_FILE).size > LOG_MAX_BYTES) {
      renameSync(COLLECT_LOG_FILE, `${COLLECT_LOG_FILE}.1`);
    }
    appendFileSync(COLLECT_LOG_FILE, line + '\n', 'utf8');
  } catch {
    /* 日志失败不能影响采集 */
  }
}

function snapshotPath(source) {
  const safe = String(source).replace(/[^A-Za-z0-9._-]/g, '_');
  return path.join(SNAPSHOT_DIR, `${safe}.json`);
}

/** 读一份快照；文件不存在/内容坏了都返回 null —— 调用方据此回退现场抓取，绝不因缓存而答不出 */
function readSnapshot(source) {
  try {
    const snap = JSON.parse(readFileSync(snapshotPath(source), 'utf8'));
    if (!snap || typeof snap !== 'object' || typeof snap.markdown !== 'string') return null;
    return snap;
  } catch {
    return null;
  }
}

/**
 * 原子写：先写 .tmp 再 rename 覆盖。
 * 为什么必须这样：查询侧随时可能读这份文件，直接覆写会让它读到半个 JSON；
 * rename 是原子的，读到的要么是旧的完整版、要么是新的完整版。
 */
function writeSnapshot(source, data) {
  ensureSnapshotDir();
  const target = snapshotPath(source);
  const tmp = `${target}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  renameSync(tmp, target);
  return target;
}

function snapshotAgeMinutes(snap) {
  const t = Date.parse(snap?.captured_at ?? '');
  if (!Number.isFinite(t)) return Number.POSITIVE_INFINITY;
  return (Date.now() - t) / 60000;
}

/**
 * 新鲜度阈值（每条命令可覆盖全局 freshness 配置）：
 *   staleMinutes —— 超过就在正文里加一行「⚠️ 数据已 N 分钟未更新」
 *   maxAgeMinutes —— 超过就不再用缓存、回退现场抓取（防止采集器死掉后一直答旧数）
 */
function snapshotLimits(cmd, cfg) {
  const f = cfg?.freshness ?? {};
  const pick = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
  return {
    stale: pick(cmd?.staleMinutes ?? f.staleMinutes, 30),
    maxAge: pick(cmd?.maxAgeMinutes ?? f.maxAgeMinutes, 180),
  };
}

function hhmm(ms) {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function humanAge(minutes) {
  if (!Number.isFinite(minutes)) return '时间未知';
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${Math.round(minutes)} 分钟前`;
  const h = Math.floor(minutes / 60);
  return `${h} 小时 ${Math.round(minutes % 60)} 分前`;
}

/**
 * 「这个源现在什么数据时间」的一句话。
 * 为什么单独抽出来：captured_at 为空＝这个源一次都没成功过，直接 `hhmm(Date.parse(''))`
 * 会印出 `NaN:NaN`；而这句话要在四处显示（群内「状态」/ `--check` / 陈旧告警 / 体检）。
 */
function dataTimeText(snap) {
  const t = Date.parse(snap?.captured_at ?? '');
  if (!Number.isFinite(t)) return '从未采集成功';
  return `${hhmm(t)}（${humanAge((Date.now() - t) / 60000)}）`;
}

/**
 * 正文第一行的「数据时间」。
 * 为什么由这里统一加、不让每个脚本各写一遍：格式只维护一处；而且「陈旧与否」
 * 取决于被查询的那一刻，脚本自己产出的那一刻并不知道。
 */
function freshnessLine(snap, cmd, cfg) {
  const t = Date.parse(snap?.captured_at ?? '');
  if (!Number.isFinite(t)) return '';
  const age = (Date.now() - t) / 60000;
  const lines = [`> 数据时间：${hhmm(t)}（${humanAge(age)}）`];
  const { stale } = snapshotLimits(cmd, cfg);
  if (age > stale) lines.push(`> ⚠️ 数据已 ${Math.round(age)} 分钟未更新，仅供参考`);
  return lines.join('\n');
}

/** 现场抓取路径用的数据时间（诚实地标明这是实时取数，不是缓存） */
function liveFreshnessLine() {
  return `> 数据时间：${hhmm(Date.now())}（实时取数）`;
}

/**
 * 命中缓存就返回正文（未裁剪）+ 快照，否则 null → 调用方走现场抓取。
 * 只有配了 "snapshot" 的命令才走这条路 —— 其余命令的行为与改动前完全一致。
 */
function snapshotPayload(cmd, cfg) {
  if (!cmd?.snapshot) return null;
  const snap = readSnapshot(cmd.snapshot);
  if (!snap || !String(snap.markdown ?? '').trim()) return null;
  const ageMin = snapshotAgeMinutes(snap);
  const { maxAge } = snapshotLimits(cmd, cfg);
  if (ageMin > maxAge) {
    const ageText = Number.isFinite(ageMin) ? `${Math.round(ageMin)} 分钟` : '从未成功';
    log(`快照不能用：${cmd.snapshot} 的数据时间 ${ageText}（上限 ${maxAge} 分钟）→ 回退现场抓取`);
    return null;
  }
  // 最近一次采集失败也照样答：这正是「查询改读缓存」的主要收益 —— 平台挂了、凭据过期，
  // 群里问一句仍然毫秒返回上次成功的数据，正文里带着数据时间和陈旧提示。
  // 原先这里要求 snap.ok === true，那会让「平台一挂，旧数据也不给用」，正好丢掉收益。
  if (snap.ok !== true) log(`读缓存（注意 ${cmd.snapshot} 最近一次采集失败，用的是上次成功的数据）`);
  return { markdown: snap.markdown, snap, ageMin };
}

// ---------------------------------------------------------------- 历史留档（P2「可补采」）
/**
 * 为什么需要（架构改进备忘 §2 的 P2）：快照只留最新一份，机器一停两小时，
 * 那两小时里采到的数据就被下一轮覆盖掉了 —— 事后谁也说不清"那时候是多少"。
 *
 * **一个必须说清的边界**：平台不给历史查询（余额是当前值、门店是当前营业状态、
 * 订单是"截至现在"的累计），所以这里的「补采」只能是**本地留档 + 空档可见**，
 * 不是"回平台把中间那两小时的数据补出来"。想让这句话变成假话，只能等 P1 的开放平台 API。
 *
 * 存储：`history\<源>\<YYYY-MM-DD>.jsonl`，一行一条、append-only
 * （追加写的好处：进程被强杀最多丢最后一行，前面的记录都还在，而"每轮覆盖一个 JSON 文件"
 * 一旦写坏就是全丢）。同一天按小时留档，`--history` 可以按天回看。
 */
function localDay(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function historyDir(source) {
  return path.join(HISTORY_DIR, String(source).replace(/[^A-Za-z0-9._-]/g, '_'));
}

function historyPath(source, day) {
  return path.join(historyDir(source), `${day}.jsonl`);
}

/** 追加一条历史；失败只记日志，绝不影响采集本身 */
function appendHistory(cfg, source, record) {
  if (cfg?.history?.enabled === false) return;
  try {
    const dir = historyDir(source);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const day = localDay(Date.parse(record.at) || Date.now());
    appendFileSync(historyPath(source, day), JSON.stringify(record) + '\n', 'utf8');
  } catch (e) {
    logCollect(`写历史失败（不影响采集）：${source} ${e?.message ?? e}`);
  }
}

/** 读某天的记录；坏行跳过（append-only 日志最常见的坏法是最后一行只写了一半） */
function readHistory(source, day) {
  try {
    return readFileSync(historyPath(source, day), 'utf8')
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * 空档统计：相邻两次**成功**之间隔了多久，超过 `graceFactor × 采集周期` 的算一个空档。
 * 为什么只看成功：失败轮次虽然也留了档，但它们本身不产生数据。
 */
function historyStats(records, everyMinutes, graceFactor) {
  const okTimes = records
    .filter((r) => r.ok)
    .map((r) => Date.parse(r.at))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  const limitMin = Number(everyMinutes || 10) * Number(graceFactor ?? 2.5);
  const gaps = [];
  for (let i = 1; i < okTimes.length; i += 1) {
    const minutes = (okTimes[i] - okTimes[i - 1]) / 60000;
    if (minutes > limitMin) gaps.push({ from: okTimes[i - 1], to: okTimes[i], minutes: Math.round(minutes) });
  }
  return {
    rounds: records.length,
    okRounds: okTimes.length,
    failRounds: records.length - okTimes.length,
    gaps,
    longestGapMin: gaps.reduce((m, g) => Math.max(m, g.minutes), 0),
  };
}

/** 清理超过 keepDays 的历史文件；每轮采集后跑一次，成本可忽略 */
function pruneHistory(cfg) {
  const keepDays = Number(cfg?.history?.keepDays ?? 14);
  if (!Number.isFinite(keepDays) || keepDays <= 0) return 0;
  const cutoff = localDay(Date.now() - keepDays * 86400000); // YYYY-MM-DD 字典序 = 时间序
  let removed = 0;
  try {
    for (const d of readdirSync(HISTORY_DIR, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const dir = path.join(HISTORY_DIR, d.name);
      for (const f of readdirSync(dir)) {
        if (!/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)) continue;
        if (f.slice(0, 10) < cutoff) {
          rmSync(path.join(dir, f), { force: true });
          removed += 1;
        }
      }
    }
  } catch {
    /* 目录不存在等一律忽略：清理失败不是故障 */
  }
  if (removed) logCollect(`清理了 ${removed} 个超过 ${keepDays} 天的历史文件`);
  return removed;
}

/**
 * 采集：跑带 snapshot 的命令的「只打印」模式，把正文落盘。
 *   node fastlane.mjs --collect [命令]
 * 注意：采集成功才覆盖 markdown；失败时保留上一份好数据并累加 fails ——
 * 这样「平台挂了」期间群里问余额，仍然答得出（这是本次改造的主要收益）。
 */
async function collect(cfg, only) {
  const targets = cfg.commands.filter(
    (c) =>
      c.enabled !== false &&
      c.snapshot &&
      !c.builtin &&
      (!only || c.id === only || c.label === only || (c.match ?? []).includes(only)),
  );
  if (!targets.length) {
    logCollect(only ? `没有匹配「${only}」的可采集命令（命令需要配 "snapshot" 字段）` : '没有配置任何 snapshot 命令，跳过');
    return 1;
  }
  logCollect(`开始采集 ${targets.length} 条：${targets.map((c) => c.id).join(', ')}`);
  let bad = 0;
  for (const c of targets) {
    const prev = readSnapshot(c.snapshot);
    const res = await runCommand(c);
    let payload = '';
    try {
      payload = res.ok ? extractPayload(c, res.out) : '';
    } catch (e) {
      logCollect(`提取正文异常：${c.id} ${e?.message ?? e}`);
    }
    const ok = Boolean(res.ok && payload.trim());
    const now = new Date().toISOString();
    // captured_at 的语义是「**这份正文**是什么时候取到的」，所以只有采集成功才推进它。
    // 踩过的坑（2026-09-21，铺第 2~5 条源时发现）：一开始失败也把 captured_at 写成 now，
    // 于是「刚失败过的源」看起来永远刚刚更新过 —— 陈旧告警永远不触发，正是我们要消灭的
    // 那类静默失败。失败时保留上次成功的时间（从未成功过就留空 → 年龄 = 无穷大）。
    const prevAt = String(prev?.captured_at ?? '');
    const data = {
      source: c.snapshot,
      command_id: c.id,
      captured_at: ok ? now : prevAt,
      last_attempt_at: now,
      ok,
      error: ok ? '' : String((res.err || res.out || '').trim().split('\n').slice(-6).join('\n') || `exit=${res.code}`),
      ms: res.ms,
      markdown: ok ? payload : String(prev?.markdown ?? ''),
      last_success_at: ok ? now : String(prev?.last_success_at ?? ''),
      fails: ok ? 0 : Number(prev?.fails ?? 0) + 1,
    };
    try {
      const file = writeSnapshot(c.snapshot, data);
      // 历史留档与快照分开写：快照给查询用（只要最新那份），历史给"事后回看"用
      appendHistory(cfg, c.snapshot, {
        at: now,
        ok,
        ms: res.ms,
        command_id: c.id,
        error: ok ? '' : data.error,
        markdown: ok ? payload : '',
      });
      logCollect(
        `${ok ? '成功' : '失败'} ${c.id} → ${path.basename(file)}　exit=${res.code} 耗时=${(res.ms / 1000).toFixed(1)}s ` +
          `正文=${Buffer.byteLength(payload, 'utf8')}B${ok ? '' : `　连续失败=${data.fails}　原因=${data.error.replace(/\n/g, ' | ')}`}`,
      );
    } catch (e) {
      bad += 1;
      logCollect(`写快照失败：${c.id} ${e?.message ?? e}`);
      continue;
    }
    if (!ok) bad += 1;
  }
  pruneHistory(cfg);
  logCollect(bad ? `采集结束：${bad}/${targets.length} 条失败` : `采集结束：${targets.length} 条全部成功`);
  return bad ? 1 : 0;
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
  // 数据源时间（查询改读采集结果之后，最该被一眼看见的就是"这份数据多旧"）
  const snapCmds = cfg.commands.filter((c) => c.enabled !== false && c.snapshot);
  if (snapCmds.length) {
    lines.push('> 数据源（采集结果）：');
    for (const c of snapCmds) {
      const snap = readSnapshot(c.snapshot);
      if (!snap) {
        lines.push(`> · ${c.snapshot}：没有数据`);
        continue;
      }
      const age = snapshotAgeMinutes(snap);
      const { stale } = snapshotLimits(c, cfg);
      const flag = !snap.ok ? ' ⚠ 最近一次采集失败' : age > stale ? ' ⚠ 超过陈旧线' : '';
      lines.push(`> · ${c.snapshot}：${dataTimeText(snap)}${flag}`);
    }
  }
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
    // 措辞故意中性：这个函数既服务「连续失败告警」也服务「采集陈旧告警」
    log(`已推送告警到 ${chatId}`);
  } catch (e) {
    log(`告警推送失败：${e?.message ?? e}`);
  }
}

// ---------------------------------------------------------------- 陈旧告警
/**
 * 「坏了自己出声」（架构改进备忘 §2 P0 第 3 项 / §3.3）。
 *
 * 为什么需要：查询改读缓存之后，采集器一旦悄悄停摆，群里的回复会**看起来正常**
 * 但数据越来越旧 —— 这正是备忘开头列的那类静默失败。所以判定不挂在查询路径上
 * （等有人来问才知道，就已经晚了），而是跟着采集轮次走。
 *
 * 判定写成纯函数，好让 --stale-selftest 离线验证；冷却状态与「连续失败告警」
 * 同一个风格，只是按「源」而不是按「命令」记。
 */
const staleAlerted = new Map(); // source -> lastAlertAt

function staleDecision(name, ageMin, st, lastAlertAt, now) {
  const t = now ?? Date.now();
  if (st?.enabled === false) return { alert: false, reason: 'stale.enabled=false' };
  const after = Number(st?.afterMinutes ?? 30);
  if (!(ageMin > after)) {
    const cur = Number.isFinite(ageMin) ? `${Math.round(ageMin)} 分钟` : '从未成功';
    return { alert: false, reason: `未超过陈旧线 ${after} 分钟（当前 ${cur}）` };
  }
  const cooldownMs = Number(st?.cooldownMinutes ?? 180) * 60000;
  const since = t - Number(lastAlertAt ?? 0);
  if (lastAlertAt && since < cooldownMs) {
    return { alert: false, reason: `冷却中（还需 ${Math.ceil((cooldownMs - since) / 60000)} 分钟）` };
  }
  const why = Number.isFinite(ageMin) ? `已 ${Math.round(ageMin)} 分钟没有新数据` : '从来没有采集成功过';
  return { alert: true, reason: `${name} ${why}（陈旧线 ${after} 分钟）` };
}

/** 一条陈旧告警的正文（抽出来是为了让 --stale-check 打印的和线上推的**逐字一致**） */
function staleAlertText(cmd, snap, ageMin) {
  const detail = snap
    ? `> 源：${cmd.snapshot}（${cmd.label}）｜数据时间 ${dataTimeText(snap)}` +
      (snap.ok ? '' : `｜最近一次采集失败（连续 ${snap.fails} 次）`)
    : `> 源：${cmd.snapshot}（${cmd.label}）｜从来没有采集成功过（snapshots 里没有这个文件）`;
  const err = snap && !snap.ok && snap.error ? `\n> 失败原因：${String(snap.error).replace(/\n/g, ' ｜ ').slice(0, 200)}` : '';
  return (
    `### ⚠️ 采集器数据陈旧\n${detail}${err}\n` +
    '> 影响：群内查询会退回现场抓取（慢；平台/凭据真出事时会一起失败）\n' +
    '> 排查：本机 `logs\\collect.log`；群里发「登录态」看凭据；`体检.cmd` 也会报这一项'
  );
}

/**
 * 此刻各源的陈旧判定（**不含推送**）。
 * 守护进程的推送达成都和 `--stale-check` 用同一份结果 —— 这样"演练时看到什么"就是"线上会推什么"，
 * 否则演练只能证明"演练的代码对"，证明不了线上的那一份。
 */
function staleReport(cfg) {
  const st = cfg.alerts?.stale ?? {};
  return cfg.commands
    .filter((c) => c.enabled !== false && c.snapshot)
    .map((c) => {
      const snap = readSnapshot(c.snapshot);
      const ageMin = snap ? snapshotAgeMinutes(snap) : Number.POSITIVE_INFINITY;
      const dec = staleDecision(c.snapshot, ageMin, st, staleAlerted.get(c.snapshot));
      return { cmd: c, snap, ageMin, dec, text: staleAlertText(c, snap, ageMin) };
    });
}

/** 采集轮结束后跑一遍：哪个源该出声就出声。返回本次真正推送的源数（便于自检/日志） */
async function staleCheck(client, cfg) {
  const st = cfg.alerts?.stale ?? {};
  const chats = (st.chats ?? []).map(String).filter(Boolean);
  let sent = 0;

  for (const r of staleReport(cfg)) {
    if (!r.dec.alert) continue;

    // 先记冷却再决定推不推：dryRun 也记，否则演练时每轮都刷一遍日志
    staleAlerted.set(r.cmd.snapshot, Date.now());
    if (!chats.length) {
      logCollect(`陈旧告警（未配 chats，只记日志）：${r.dec.reason}`);
      continue;
    }
    if (st.dryRun === true) {
      logCollect(`[dryRun] 陈旧告警本该推送：${r.dec.reason} → ${chats.join(', ')}`);
      sent += 1;
      continue;
    }
    // sendAlert 内部还会看 alerts.dryRun（总开关），两层都拦得住
    for (const chatId of chats) await sendAlert(client, cfg, chatId, r.text);
    logCollect(`陈旧告警已推送：${r.dec.reason} → ${chats.join(', ')}`);
    sent += 1;
  }
  return sent;
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

  // ------------------------------------------------------------ 内置采集器
  // 架构改进备忘 §6 第 2 步原本是注册计划任务 WecomCollect（每 10 分钟跑一次
  // --collect）。2026-09-21 实施时发现：注册计划任务需要管理员权限，而本会话
  // 是非提权会话（schtasks 与 Register-ScheduledTask 都被拒绝），于是把采集挂进
  // 守护进程自身 —— 它本来就常驻，这样不闪窗、不多占一个进程，且生命周期正好
  // 落在「看门狗每分钟体检 + 心跳带 pid」这套已验证的机制里。
  // 代价：守护进程挂掉时采集跟着停（看门狗 1 分钟内会把它拉起来）。
  // 想改回系统计划任务：把配置里 collect.enabled 设为 false，再运行
  // 注册采集任务.cmd（需要右键以管理员身份运行）。
  const collectCfg = cfg.collect ?? {};
  const collectEveryMin = Number(collectCfg.everyMinutes ?? 10) || 10;
  const hasSnapshotCmd = cfg.commands.some((c) => c.enabled !== false && c.snapshot);
  let collecting = false;

  async function collectTick(reason) {
    if (collecting) return;
    if (running) {
      // 采集和群内查询都会去平台取数，撞在一起没必要（查询优先，它有人在等）
      logCollect(`跳过本轮采集：有查询正在执行（${running}）`);
      return;
    }
    collecting = true;
    try {
      const code = await collect(cfg);
      logCollect(`定时采集（${reason}）结束：exit=${code}`);
      // 采集完立刻判定陈旧：数据是刚写的，这一轮没成功、又过了线的源就该出声
      await staleCheck(client, cfg);
    } catch (e) {
      logCollect(`定时采集异常：${e?.stack ?? e}`);
    } finally {
      collecting = false;
    }
  }

  if (hasSnapshotCmd && collectCfg.enabled !== false) {
    const firstDelayMs = Math.max(0, Number(collectCfg.startDelaySeconds ?? 30)) * 1000;
    const kickoff = setTimeout(() => void collectTick('启动后首采'), firstDelayMs);
    kickoff.unref?.();
    const collectTimer = setInterval(() => void collectTick('定时'), collectEveryMin * 60000);
    collectTimer.unref?.();
    log(`内置采集器已启用：每 ${collectEveryMin} 分钟采集一次，${Math.round(firstDelayMs / 1000)} 秒后首采`);
  } else {
    log(`内置采集器未启用（${hasSnapshotCmd ? 'collect.enabled=false' : '没有任何命令配 snapshot'}）`);
  }

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

    // —— 读缓存路径（P0：查询＝读采集结果）——
    // 放在单飞检查之前：命中缓存是毫秒级的，既不必排队等前面那条查询，也不用发
    // 「正在取数…」占位。只有配了 "snapshot" 的命令会走到这里，其余命令一字不变。
    const cached = snapshotPayload(cmd, cfg);
    if (cached) {
      const t0 = Date.now();
      const body = applyBrandScope(cached.markdown, cmd, cfg, chatId, chattype);
      const payload = [freshnessLine(cached.snap, cmd, cfg), body].filter(Boolean).join('\n\n');
      const clipped =
        Buffer.byteLength(payload, 'utf8') > MAX_REPLY_BYTES
          ? payload.slice(0, MAX_REPLY_BYTES) + '\n> （内容过长已截断，完整明细见本地日志）'
          : payload;
      const renderMs = Date.now() - t0;
      log(`读缓存命中：${cmd.id} 源=${cmd.snapshot} 数据时间=${cached.snap.captured_at}（${humanAge(cached.ageMin)}）渲染=${renderMs}ms 正文=${Buffer.byteLength(clipped, 'utf8')}B`);
      noteSuccess(cmd.id);
      lastRuns.set(cmd.id, { ts: Date.now(), ok: true, code: 0, ms: renderMs });
      await client.replyStream(frame, streamId, clipped, true);
      return;
    }
    if (cmd.snapshot) log(`缓存未命中：${cmd.id}（源 ${cmd.snapshot}）→ 回退现场抓取`);

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
      const body = applyBrandScope(
        extractPayload(cmd, res.out),
        cmd,
        cfg,
        chatId,
        chattype,
      );
      // 现场抓取也要标数据时间（同为「让新鲜度可见」的一部分，见 §3.2）；
      // 没配 snapshot 的命令保持原样，渲染路径不做任何改动。
      const payload = cmd.snapshot && body ? [liveFreshnessLine(), body].join('\n\n') : body;
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

  // 陈旧告警判定自检：喂几组「数据多旧 + 上次告警什么时候」的样本，打印判定（不联网、不打扰群）
  if (mode === '--stale-selftest') {
    const st = cfg.alerts?.stale ?? {};
    console.log(
      `策略：enabled=${st.enabled !== false}　陈旧线=${st.afterMinutes ?? 30} 分钟　冷却=${st.cooldownMinutes ?? 180} 分钟　dryRun=${st.dryRun === true}`,
    );
    console.log(`推送目标：${(st.chats ?? []).join(', ') || '（空 = 只写日志，不推群）'}`);
    const now = Date.now();
    const hoursAgo = (h) => now - h * 3600 * 1000;
    const cases = [
      ['刚采到（1 分钟前）', 1, 0],
      ['踩在线上（29 分钟前）', 29, 0],
      ['刚过线（31 分钟前），没推过', 31, 0],
      ['过线，2 小时前推过（冷却中）', 31, hoursAgo(2)],
      ['过线，4 小时前推过（冷却已过）', 31, hoursAgo(4)],
      ['从来没有采集成功过', Number.POSITIVE_INFINITY, 0],
    ];
    for (const [name, age, lastAt] of cases) {
      const d = staleDecision('demo', age, st, lastAt, now);
      console.log(`  ${d.alert ? '★ 会告警' : '　不告警'}  ${name.padEnd(30)} ${d.reason}`);
    }
    return 0;
  }

  // 陈旧告警**真身**预演：拿当前真实的快照文件跑判定与文案，打印"会推什么"（不推群）
  // 与守护进程共用 staleReport()，所以这里看到的就是线上会推的那一份。
  if (mode === '--stale-check') {
    const st = cfg.alerts?.stale ?? {};
    const chats = (st.chats ?? []).map(String).filter(Boolean);
    console.log(
      `策略：enabled=${st.enabled !== false}　陈旧线=${st.afterMinutes ?? 30} 分钟　冷却=${st.cooldownMinutes ?? 180} 分钟　dryRun=${st.dryRun === true}`,
    );
    console.log(`推送目标：${chats.join(', ') || '（空 = 只写日志，不推群）'}`);
    const rows = staleReport(cfg);
    if (!rows.length) {
      console.log('（没有任何命令配 snapshot，无从判定）');
      return 0;
    }
    let need = 0;
    for (const r of rows) {
      const age = Number.isFinite(r.ageMin) ? `${Math.round(r.ageMin)} 分钟` : '从未成功';
      console.log(
        `  ${r.dec.alert ? '★ 会告警' : '　不告警'}  ${String(r.cmd.snapshot).padEnd(16)} 数据时间 ${dataTimeText(r.snap)}（${age}）— ${r.dec.reason}`,
      );
      if (r.dec.alert) {
        need += 1;
        console.log('      ── 会推送的正文（本命令只打印，不推）──');
        for (const line of r.text.split('\n')) console.log(`      ${line}`);
      }
    }
    console.log(need ? `结论：${need} 个源此刻会触发告警` : '结论：没有源需要告警');
    return 0;
  }

  if (mode === '--list') {
    for (const c of cfg.commands) {
      console.log(`${c.enabled === false ? '[停用] ' : ''}${c.id.padEnd(16)} ${c.match.join(' / ').padEnd(28)} ${c.label}`);
    }
    return 0;
  }

  if (mode === '--collect') {
    const only = argv.slice(1).find((a) => !a.startsWith('--')) ?? '';
    return collect(cfg, only);
  }

  // 历史留档回看（P2「可补采」）：某天每轮采到了什么、有没有空档
  if (mode === '--history') {
    const rest = argv.slice(1);
    const di = rest.indexOf('--date');
    const day = di >= 0 ? String(rest[di + 1] ?? '').trim() : localDay(Date.now());
    const only = rest.find((a, i) => !a.startsWith('--') && !(di >= 0 && i === di + 1)) ?? '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
      console.log('用法：--history [源/命令] [--date YYYY-MM-DD]（不写日期＝今天）');
      return 1;
    }
    const sources = [
      ...new Set(
        cfg.commands
          .filter(
            (c) =>
              c.enabled !== false &&
              c.snapshot &&
              (!only || c.snapshot === only || c.id === only || (c.match ?? []).includes(only)),
          )
          .map((c) => c.snapshot),
      ),
    ];
    if (!sources.length) {
      console.log(only ? `没有匹配「${only}」的快照源` : '没有配 snapshot 的命令');
      return 1;
    }
    const every = Number(cfg.collect?.everyMinutes ?? 10);
    const keep = cfg.history?.keepDays ?? 14;
    const limitMin = every * Number(cfg.history?.graceFactor ?? 2.5);
    console.log(`历史留档 ${day}　采集周期 ${every} 分钟｜保留 ${keep} 天｜空档判定＝相邻两次成功间隔 > ${limitMin} 分钟`);
    for (const s of sources) {
      const recs = readHistory(s, day);
      const st = historyStats(recs, every, cfg.history?.graceFactor);
      console.log(
        `\n=== ${s}　${st.okRounds}/${st.rounds} 轮成功${st.failRounds ? `、${st.failRounds} 轮失败` : ''}` +
          `${st.longestGapMin ? `　最长空档 ${st.longestGapMin} 分钟` : ''} ===`,
      );
      if (!recs.length) {
        console.log('  （这天没有记录）');
        continue;
      }
      const show = recs.slice(-30);
      for (const r of show) {
        const preview = String(r.markdown ?? '')
          .split('\n')
          .map((x) => x.trim())
          .filter(Boolean)
          .slice(0, 2)
          .join(' ｜ ')
          .slice(0, 110);
        const tail = preview || String(r.error ?? '').replace(/\n/g, ' ').slice(0, 90) || '(无正文)';
        console.log(`  ${hhmm(Date.parse(r.at))}　${r.ok ? '成功' : '失败'}　${tail}`);
      }
      if (recs.length > show.length) console.log(`  …（这天共 ${recs.length} 条，只列最近 ${show.length} 条）`);
      if (st.gaps.length) {
        console.log(`  空档：${st.gaps.map((g) => `${hhmm(g.from)}→${hhmm(g.to)}（${g.minutes} 分钟）`).join('，')}`);
      }
    }
    return 0;
  }

  // 离线预演群内查询：走与 serve 完全相同的「读缓存 → 按群裁剪 → 加数据时间」路径，只打印。
  // 存在的意义：验收「查询改读缓存」时不必真的去群里问一句（也就不会打扰同事）。
  if (mode === '--query') {
    const rest = argv.slice(1);
    const gi = rest.indexOf('--as-group');
    const asGroup = gi >= 0 ? String(rest[gi + 1] ?? '').trim() : '';
    const filter = rest.find((a, i) => !a.startsWith('--') && !(gi >= 0 && i === gi + 1)) ?? '';
    if (!filter) {
      console.log('用法：--query <命令> [--as-group <群ID>]');
      return 1;
    }
    const chatId = asGroup || (cfg.allowedUsers ?? ['dm'])[0];
    const chattype = asGroup ? 'group' : 'direct';
    const hit = resolveCommand(filter, cfg, chatId, chattype);
    if (!hit?.cmd) {
      console.log(hit?.ambiguous ? `通用别名在本会话不唯一：${hit.ambiguous.map((c) => c.match[0]).join(' / ')}` : `没有匹配「${filter}」的命令`);
      return 1;
    }
    const cmd = hit.cmd;
    if (asGroup) {
      const info = cfg.groups?.[asGroup];
      console.log(info ? `群视角：${info.name}（本群作用域 ${groupScope(info).join('/') || '未设'}）` : `群视角：${asGroup}（⚠ 不在 cfg.groups 里，不会裁剪）`);
    }
    const t0 = Date.now();
    const cached = snapshotPayload(cmd, cfg);
    let body;
    let origin;
    if (cached) {
      body = applyBrandScope(cached.markdown, cmd, cfg, chatId, chattype);
      origin = `读缓存 ${cmd.snapshot}（${humanAge(cached.ageMin)}）`;
    } else {
      const r = await runCommand(cmd);
      body = applyBrandScope(extractPayload(cmd, r.out), cmd, cfg, chatId, chattype);
      origin = `现场抓取 exit=${r.code} 耗时=${(r.ms / 1000).toFixed(1)}s`;
    }
    const head = cached ? freshnessLine(cached.snap, cmd, cfg) : cmd.snapshot ? liveFreshnessLine() : '';
    const payload = [head, body].filter(Boolean).join('\n\n');
    console.log('─'.repeat(64));
    console.log(`# ${cmd.label}（${cmd.id}）　${origin}　端到端=${Date.now() - t0}ms`);
    console.log(payload || '(正文为空)');
    return payload ? 0 : 1;
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

    // 缓存状态：验收「查询＝读采集结果」时先看这里 —— 一眼看出有没有数据、数据多旧
    const cached = cfg.commands.filter((c) => c.enabled !== false && c.snapshot);
    if (cached.length) {
      const { stale, maxAge } = snapshotLimits(null, cfg);
      console.log(`缓存策略   : 陈旧线 ${stale} 分钟（只提示）｜过期线 ${maxAge} 分钟（超了回退现场抓取）`);
      const sa = cfg.alerts?.stale ?? {};
      console.log(
        `陈旧告警   : ${sa.enabled === false ? '关闭' : `开启（>${sa.afterMinutes ?? 30} 分钟未更新即推，冷却 ${sa.cooldownMinutes ?? 180} 分钟）`}` +
          `　推送目标：${(sa.chats ?? []).join(', ') || '（空 = 只写日志）'}${sa.dryRun === true ? '　[dryRun]' : ''}`,
      );
      for (const c of cached) {
        const snap = readSnapshot(c.snapshot);
        console.log(
          `缓存       : ${c.snapshot} ← ${c.id}　` +
            (snap
              ? `${snap.ok ? '最近一次成功' : `最近一次失败（连续 ${snap.fails ?? '?'} 次）`}，数据时间 ${dataTimeText(snap)}`
              : '还没有数据 → 先跑 --collect'),
        );
      }
    } else {
      console.log('缓存       : （没有命令配 snapshot，全部走现场抓取）');
    }

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
