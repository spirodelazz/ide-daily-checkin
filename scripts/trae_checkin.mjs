// trae_checkin.mjs
// 通过 Chrome DevTools Protocol (CDP) 自动完成 Trae CN 每日签到（每天 200 积分）。
// 改编自 BlueChonk/trae-daily-checkin（CDP 思路与 DOM 选择器同源），本机适配：
//   1. 定位支持 Trae CN（Trae CN.exe），不再只认 TRAE SOLO CN
//   2. 「运行中但无调试端口」默认跳过本轮（不强杀用户会话，等轮询兜底），退出码 3
//   3. --close 只关闭「本次由脚本拉起」的实例，不动用户自己开着的 Trae
//   4. 每次运行追加一行 JSON 到同目录 trae_checkin.log（与 signin.log / qoder_checkin.log 同风格）
// 零第三方依赖：Node >= 22（自带 fetch / WebSocket 全局对象）。
// 进程匹配按安装目录前缀（exeDir\*）而非 exe 名，兼容 Trae CN / TRAE SOLO CN。

import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// -------------------------------------------------------------
// 0. 参数解析（命令行 > 环境变量 > 自动定位）
//   --exe / --dir <path>   Trae 可执行文件路径（不传则自动定位）
//   --port <n>             CDP 调试端口（默认 9222）
//   --force                运行中但无调试端口时，强制重启 Trae（可能丢未保存内容！）
//   --profile <path>       独立 user-data-dir，隔离测试用
//   --close                签到完成后关闭「本次由脚本拉起」的 Trae
//   --trigger <name>       触发来源，仅写入日志（manual / schedule / poll）
// -------------------------------------------------------------
function parseOptions() {
  const argv = process.argv.slice(2);
  const argValue = (name) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
  };
  return {
    help: argv.includes('--help') || argv.includes('-h'),
    exe: argValue('exe') || argValue('dir') || process.env.TRAECHECKIN_EXE?.trim() || '',
    port: Number(argValue('port') || process.env.TRAECHECKIN_PORT || 9222),
    force: argv.includes('--force') || argValue('force') === '1' || process.env.TRAECHECKIN_FORCE_RELAUNCH === '1',
    profile: argValue('profile') || process.env.TRAECHECKIN_USER_DATA_DIR?.trim() || '',
    close: argv.includes('--close') || argValue('close') === '1' || process.env.TRAECHECKIN_CLOSE === '1',
    trigger: argValue('trigger') || 'manual',
  };
}

const OPTS = parseOptions();

if (OPTS.help) {
  console.log(`用法：
  node trae_checkin.mjs [选项]

选项：
  --exe / --dir <path>   Trae 可执行文件路径（不传则自动定位）
  --port <n>             CDP 调试端口（默认 9222）
  --force                运行中但无调试端口时强制重启 Trae（可能丢未保存内容，慎用）
  --profile <path>       独立 user-data-dir，隔离测试用
  --close                完成后关闭「本次由脚本拉起」的 Trae
  --trigger <name>       触发来源标记，写入日志（默认 manual）

示例：
  node trae_checkin.mjs                                # 前台手动跑一次
  node trae_checkin.mjs --exe "C:\\...\\Trae CN.exe" --close   # 指定路径，签到后关闭
`);
  process.exit(0);
}

const DEBUG_PORT = OPTS.port;
const FORCE_RELAUNCH = OPTS.force;
const USER_DATA_DIR = OPTS.profile;
const CLOSE_AFTER_CHECKIN = OPTS.close;
const TRIGGER = OPTS.trigger;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LOG_FILE = path.join(HERE, 'trae_checkin.log');

// 本机已知安装位置（自动定位失败时的兜底，按存在性校验）
const KNOWN_EXES = [
  path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Trae CN', 'Trae CN.exe'),
  'C:\\Program Files\\TRAE SOLO CN\\TRAE SOLO CN.exe',
];

// 候选 exe 名（注册表/目录扫描时用）
const EXE_NAMES = ['Trae CN.exe', 'TRAE SOLO CN.exe', 'Trae.exe', 'TRAE.exe'];

// 常见安装根目录（有限深度扫描）
const COMMON_INSTALL_DIRS = [
  'C:\\Program Files',
  'C:\\Program Files (x86)',
  'D:\\Program Files',
  path.join(process.env.LOCALAPPDATA || '', 'Programs'),   // 本机 Trae CN 在这里
  'D:\\Software',
  'E:\\Software',
];

function debugLaunchArgs() {
  const args = [`--remote-debugging-port=${DEBUG_PORT}`];
  if (USER_DATA_DIR) args.push(`--user-data-dir="${USER_DATA_DIR}"`);
  return args.join(' ');
}

// -------------------------------------------------------------
// 1. 定位 Trae 可执行文件
//    优先级：--exe > 已知路径 > 运行中进程 > 注册表 > 常见目录扫描
// -------------------------------------------------------------
function looksLikeTraeExe(p) {
  if (!p || typeof p !== 'string') return false;
  const name = path.basename(p).toLowerCase();
  return /trae.*\.exe$/.test(name) && !p.toLowerCase().includes('agent-tool-host');
}

async function runPs(script) {
  return new Promise((resolve) => {
    const p = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', script]);
    let out = '';
    p.stdout.on('data', d => out += d.toString());
    p.on('close', () => resolve(out.trim()));
    p.on('error', () => resolve(''));
  });
}

async function scanRunningProcess() {
  const out = await runPs(
    `Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath } | Select-Object -ExpandProperty ExecutablePath -Unique`
  );
  for (const line of out.split(/\r?\n/)) {
    const p = line.trim();
    if (looksLikeTraeExe(p) && fs.existsSync(p)) return p;
  }
  return null;
}

async function scanRegistry() {
  const out = await runPs(`
    $roots = @(
      'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
      'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
      'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall'
    )
    $hits = foreach ($r in $roots) {
      if (Test-Path $r) {
        Get-ChildItem $r | ForEach-Object {
          $v = (Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue)
          if ($v.DisplayName -like '*Trae*') { $v.InstallLocation }
        }
      }
    }
    $hits | Where-Object { $_ } | Sort-Object -Unique
  `);
  for (const line of out.split(/\r?\n/)) {
    const dir = line.trim();
    if (!dir) continue;
    for (const name of EXE_NAMES) {
      const candidate = path.join(dir, name);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

function scanCommonDirs(maxDepth = 3) {
  const hit = [];
  const walk = (dir, depth) => {
    if (hit.length || depth > maxDepth) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name.toLowerCase().includes('trae')) {
          for (const n of EXE_NAMES) {
            const exe = path.join(full, n);
            if (fs.existsSync(exe)) { hit.push(exe); return; }
          }
        }
        walk(full, depth + 1);
      } else if (e.name.toLowerCase().endsWith('.exe') && looksLikeTraeExe(full)) {
        hit.push(full); return;
      }
    }
  };
  for (const base of COMMON_INSTALL_DIRS) {
    if (!base || !fs.existsSync(base)) continue;
    walk(base, 0);
    if (hit.length) break;
  }
  return hit.length ? hit[0] : null;
}

function resolveTraePath() {
  if (OPTS.exe) {
    if (!fs.existsSync(OPTS.exe)) throw new Error(`--exe/--dir 指定的路径不存在：${OPTS.exe}`);
    return OPTS.exe;
  }
  for (const known of KNOWN_EXES) {
    if (known && fs.existsSync(known)) {
      console.log(`[INFO] 使用已知安装路径: ${known}`);
      return known;
    }
  }
  console.log('[INFO] 自动定位 Trae（运行中进程 -> 注册表 -> 常见目录）...');
  return null; // 由异步定位流程继续
}

async function resolveTraePathAsync() {
  const sync = resolveTraePath();
  if (sync) return sync;
  const found = (await scanRunningProcess()) || (await scanRegistry()) || scanCommonDirs();
  if (found) return found;
  throw new Error('未找到 Trae 可执行文件，请用 --exe 指定完整路径');
}

const TRAE_EXE = await resolveTraePathAsync();
const TRAE_DIR_PREFIX = path.dirname(TRAE_EXE) + path.sep; // 进程匹配前缀：安装目录\*

// 强制 127.0.0.1（IPv4），避免 localhost 解析到 IPv6 连到别的应用
const DEBUG_URL = `http://127.0.0.1:${DEBUG_PORT}`;

// -------------------------------------------------------------
// 2. 调试端口管理
// -------------------------------------------------------------
class SkipError extends Error {} // 不算失败：运行中无端口，跳过等下轮

async function isPortOpen() {
  try {
    const res = await fetch(`${DEBUG_URL}/json/version`, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

async function isTraeRunning() {
  const out = await runPs(
    `Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -like '${TRAE_DIR_PREFIX}*' } | Select-Object -First 1 ProcessId`
  );
  return /ProcessId/.test(out) && out.trim().length > 0;
}

// 宿主环境净化：WorkBuddy / VS Code 等 Electron 宿主的终端会注入
// ELECTRON_RUN_AS_NODE=1（令 Trae 以纯 Node 启动 → "bad option"）与 NODE_OPTIONS（宿主 shim），
// 子进程会继承，必须在拉起 Trae 前剔除。计划任务环境本无这些变量，此为双保险。
function launchEnv() {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  return env;
}

function launchTraeWithDebug() {
  // start 脱离当前进程，避免 Node 持有子进程句柄导致退出时崩溃
  const cmd = `start "" "${TRAE_EXE}" ${debugLaunchArgs()}`;
  spawn('cmd', ['/c', cmd], { detached: true, stdio: 'ignore', windowsHide: true, env: launchEnv() }).unref();
}

async function closeTrae() {
  const cmd = `Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -like '${TRAE_DIR_PREFIX}*' -or $_.Name -eq 'agent-tool-host.exe' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
  await runPs(cmd);
}

async function waitForPort(timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await isPortOpen()) return;
    await sleep(500);
  }
  throw new Error('等待调试端口超时');
}

let launchedByUs = false; // 本次运行是否由脚本拉起 Trae

async function ensureDebugPort() {
  if (await isPortOpen()) {
    console.log('[OK] 调试端口已开放');
    return;
  }
  const running = await isTraeRunning();
  if (!running) {
    console.log('[INFO] Trae 未运行，正在启动并开放调试端口...');
    launchTraeWithDebug();
    launchedByUs = true;
    await waitForPort(30_000);
    return;
  }
  if (FORCE_RELAUNCH) {
    console.log('[WARN] 强制重启 Trae 以开放调试端口（可能丢失未保存内容）...');
    await closeTrae();
    launchTraeWithDebug();
    launchedByUs = true;
    await waitForPort(30_000);
    return;
  }
  // 无人值守安全策略：不强杀用户会话，跳过本轮等轮询兜底
  throw new SkipError('Trae 正在运行但无调试端口，本轮跳过（轮询稍后再试）');
}

// -------------------------------------------------------------
// 3. CDP 连接与 DOM 操作（与上游一致）
// -------------------------------------------------------------
async function connectCDP() {
  const res = await fetch(`${DEBUG_URL}/json`);
  const targets = await res.json();
  const pageTarget = targets.find(t => t.type === 'page');
  if (!pageTarget) throw new Error('未找到 page 类型的 CDP target');

  const ws = new WebSocket(pageTarget.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', reject);
  });

  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', ev => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  });

  const send = (method, params) => new Promise((resolve) => {
    const myId = ++id;
    pending.set(myId, resolve);
    ws.send(JSON.stringify({ id: myId, method, params: params || {} }));
  });

  await send('Runtime.enable');
  return { ws, evaluate: expr => send('Runtime.evaluate', { expression: expr, returnByValue: true }) };
}

async function performCheckIn(cdp) {
  const { evaluate } = cdp;

  // 打开账户菜单（状态感知，避免重复点击关闭菜单）
  const menuAlreadyOpen = await evaluate(`!!document.querySelector('[class*="accountPopover"]')`);
  if (!menuAlreadyOpen.result.result.value) {
    console.log('[INFO] 点击左下角头像...');
    await evaluate(`
      (() => {
        const el = document.querySelector('[class*="accountTrigger"]');
        if (el) { el.click(); return true; }
        return false;
      })()
    `);
    for (let i = 0; i < 10; i++) {
      await sleep(500);
      const open = await evaluate(`!!document.querySelector('[class*="accountPopover"]')`);
      if (open.result.result.value) break;
    }
  } else {
    console.log('[INFO] 账户菜单已经打开');
  }

  // 读取签到按钮状态
  const inspect = await evaluate(`
    (() => {
      const btn = document.querySelector('[class*="accountCheckinButton"]');
      const label = document.querySelector('[class*="accountCheckinButtonLabel"]');
      if (!btn) return { error: 'checkin_button_not_found' };
      return {
        buttonText: label ? (label.textContent || '').trim() : (btn.textContent || '').trim(),
        title: (document.querySelector('[class*="accountCheckinTitle"]')?.textContent || '').trim()
      };
    })()
  `);
  const state = inspect.result.result.value;
  console.log(`[INFO] 签到按钮状态: ${JSON.stringify(state)}`);

  if (state.error) {
    // 区分「未登录」与「类名已变化」
    const loginHint = await evaluate(`
      (() => {
        const menu = document.querySelector('[class*="accountPopover"]');
        if (!menu) return { menuOpen: false };
        const t = (menu.textContent || '');
        return {
          menuOpen: true,
          hasLogin: /登录|扫码|立即登录|手机号/.test(t),
          sample: t.replace(/\\s+/g, ' ').slice(0, 80)
        };
      })()
    `);
    const hint = loginHint.result.result.value;
    if (hint.menuOpen && hint.hasLogin) {
      return { status: 'not_logged_in', detail: hint.sample };
    }
    throw new Error('未找到每日签到按钮，可能类名已变化');
  }

  if (/已签/.test(state.buttonText)) {
    return { status: 'already_signed', detail: state.buttonText };
  }

  // 点击签到按钮
  console.log('[INFO] 尝试点击签到按钮...');
  const clicked = await evaluate(`
    (() => {
      const btn = document.querySelector('[class*="accountCheckinButton"]');
      if (!btn) return false;
      btn.click();
      return true;
    })()
  `);
  if (!clicked.result.result.value) {
    return { status: 'click_failed' };
  }

  await sleep(2000);

  // 验证：按钮文字是否变成「今日已签」
  const verify = await evaluate(`
    (() => {
      const label = document.querySelector('[class*="accountCheckinButtonLabel"]');
      const btn = document.querySelector('[class*="accountCheckinButton"]');
      return label ? (label.textContent || '').trim() : (btn ? (btn.textContent || '').trim() : 'button_gone');
    })()
  `);
  const afterText = verify.result.result.value;
  if (/已签/.test(afterText)) {
    return { status: 'success', detail: afterText };
  }
  return { status: 'unknown', detail: afterText };
}

// -------------------------------------------------------------
// 4. 日志（JSON Lines，与 signin.log / qoder_checkin.log 同风格）
// -------------------------------------------------------------
function bj(fmt = '%Y-%m-%d %H:%M:%S') {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  return d.toISOString().replace('T', ' ').replace('Z', '').slice(0, 19);
}

function logRun(result, detail) {
  const rec = {
    time: bj(),
    script: 'trae_checkin',
    trigger: TRIGGER,
    result,
    status: result,
    detail: detail || '',
  };
  try {
    fs.appendFileSync(LOG_FILE, JSON.stringify(rec) + '\n', 'utf-8');
  } catch (e) {
    console.error('[WARN] 日志写入失败:', e.message);
  }
}

// -------------------------------------------------------------
// 5. 主流程
// -------------------------------------------------------------
async function main() {
  try {
    await ensureDebugPort();
    console.log('[INFO] 连接 CDP...');
    const cdp = await connectCDP();
    const result = await performCheckIn(cdp);
    cdp.ws.close();
    await sleep(300);

    console.log('[RESULT]', JSON.stringify(result));
    logRun(result.status, result.detail || '');

    if (CLOSE_AFTER_CHECKIN && launchedByUs) {
      console.log('[INFO] --close 已指定且 Trae 由本次脚本拉起，正在关闭...');
      await closeTrae();
      console.log('[INFO] Trae 已关闭');
    }

    if (result.status === 'success') process.exit(0);
    else if (result.status === 'already_signed') process.exit(2);
    else process.exit(1);
  } catch (err) {
    if (err instanceof SkipError) {
      console.log('[SKIP]', err.message);
      logRun('skipped_running', err.message);
      process.exit(3);
    }
    console.error('[ERROR]', err.message);
    logRun('ERROR', err.message);
    process.exit(1);
  }
}

main();
