// trae_keepalive.mjs — Trae CN 登录态到期前续期（避免签到脚本静默断签）
// ═══════════════════════════════════════════════════════════
// 为什么需要它：
//   Trae 的 JWT 只有 14 天有效期，客户端**只在 token 剩 ≤300 秒或已过期时**才用
//   refreshToken 续期并重新加密落盘。也就是说「偶尔打开一次」几乎无效——打开得太早，
//   客户端认为不必刷新；等 token 真过期时若没再打开过，签到脚本就只能反复报
//   LOGIN_REQUIRED（2026-10-29 ~ 11-01 实测连续四天断签）。
//
// 做法：剩量低于阈值时拉起一次 Trae CN，让客户端自己完成续期，再复核 storage.json
//       里的 expiredAt 是否变新。客户端已在运行则直接跳过（它会在临期时自己刷新）。
//
// 用法：node trae_keepalive.mjs [--threshold 3] [--timeout 120] [--dry-run] [--status]
// 退出码：0=无需处理/已续期成功  1=续期失败  2=凭据读取失败（未登录或信封变更）
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadAuthInfo, readStorage, bj, daysLeft, storagePath } from './trae_auth.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LOG_FILE = path.join(HERE, 'trae_keepalive.log');

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const value = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d;
};

const THRESHOLD_DAYS = Number(value('threshold', 3));   // 剩余不足该天数就续期
const LAUNCH_TIMEOUT = Number(value('timeout', 120)) * 1000;
const POLL_INTERVAL = 5000;
const DRY_RUN = flag('dry-run');
const STATUS_ONLY = flag('status');

function logRun(rec) {
  if (STATUS_ONLY || DRY_RUN) return;
  try {
    fs.appendFileSync(LOG_FILE, JSON.stringify({ script: 'trae_keepalive', time: bj(), ...rec }) + '\n', 'utf-8');
  } catch (e) {
    console.error('[WARN] 日志写入失败:', e.message);
  }
}

function traeExe() {
  const local = process.env.LOCALAPPDATA || '';
  const pf = process.env.ProgramFiles || 'C:\\Program Files';
  const cands = [
    process.env.TRAE_EXE || '',
    path.join(local, 'Programs', 'Trae CN', 'Trae CN.exe'),
    path.join(pf, 'Trae CN', 'Trae CN.exe'),
    path.join(local, 'Trae CN', 'Trae CN.exe'),
  ];
  return cands.find(p => p && fs.existsSync(p)) || null;
}

function traeRunning() {
  try {
    const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq Trae CN.exe', '/NH'], {
      encoding: 'utf-8', windowsHide: true, timeout: 15000,
    });
    return /Trae CN\.exe/i.test(out);
  } catch {
    return false;   // 探测失败按"未运行"处理，最多多拉一次（单实例应用，无害）
  }
}

// 只比较 expiredAt：客户端启动时会重写 storage.json，别的字段变化不代表已续期
function currentExpiry() {
  try {
    return loadAuthInfo(readStorage()).expiredAt;
  } catch {
    return null;
  }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function main() {
  let info;
  try {
    info = loadAuthInfo();
  } catch (e) {
    console.log('❌ 读取凭据失败:', e.message);
    logRun({ result: 'ERROR', msg: `读取凭据失败: ${e.message}` });
    return 2;
  }

  const left = daysLeft(info);
  console.log(`[INFO] token 到期 ${info.expiredAt}（剩 ${left.toFixed(1)} 天）| uid ${info.userId} | 阈值 ${THRESHOLD_DAYS} 天`);
  if (STATUS_ONLY) return 0;

  if (left > THRESHOLD_DAYS) {
    console.log('[OK] 剩余有效期充足，无需续期');
    logRun({ result: 'SKIP', msg: `剩 ${left.toFixed(1)} 天`, daysLeft: Number(left.toFixed(1)), expiresAt: info.expiredAt, uid: info.userId });
    return 0;
  }

  if (traeRunning()) {
    console.log('[OK] Trae CN 正在运行，客户端会在临期时自行续期');
    logRun({ result: 'RUNNING', msg: `剩 ${left.toFixed(1)} 天，客户端已在运行`, daysLeft: Number(left.toFixed(1)), expiresAt: info.expiredAt, uid: info.userId });
    return 0;
  }

  const exe = traeExe();
  if (!exe) {
    console.log('❌ 找不到 Trae CN.exe，请设置 TRAE_EXE 环境变量');
    logRun({ result: 'ERROR', msg: '找不到 Trae CN.exe', uid: info.userId });
    return 1;
  }

  console.log(`[INFO] 拉起 ${exe}（可能出现一个 Trae 窗口，续期完成后可关闭）`);
  if (DRY_RUN) {
    console.log('[DryRun] 跳过实际启动与复核');
    return 0;
  }

  const before = info.expiredAt;
  try {
    // detached + unref：本进程退出后客户端继续存活
    const child = spawn(exe, [], { detached: true, stdio: 'ignore', windowsHide: false });
    child.unref();
  } catch (e) {
    console.log('❌ 启动失败:', e.message);
    logRun({ result: 'ERROR', msg: `启动失败: ${e.message}`, uid: info.userId });
    return 1;
  }

  const deadline = Date.now() + LAUNCH_TIMEOUT;
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL);
    const after = currentExpiry();
    if (after && after !== before) {
      const newLeft = (new Date(after).getTime() - Date.now()) / 86400000;
      console.log(`✅ 已续期：${before} → ${after}（剩 ${newLeft.toFixed(1)} 天）`);
      logRun({ result: 'REFRESHED', msg: `${before} → ${after}`, daysLeft: Number(newLeft.toFixed(1)), expiresAt: after, uid: info.userId });
      return 0;
    }
  }

  console.log(`❌ ${LAUNCH_TIMEOUT / 1000}s 内未见新 token，需要手动打开一次 Trae 确认登录态`);
  logRun({ result: 'TIMEOUT', msg: `${LAUNCH_TIMEOUT / 1000}s 内 storage.json 的 expiredAt 未变化`, daysLeft: Number(left.toFixed(1)), expiresAt: before, uid: info.userId });
  return 1;
}

process.exit(await main());
