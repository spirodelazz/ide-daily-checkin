// trae_checkin_api.mjs — Trae CN 每日签到（纯 API，无需启动 Trae 客户端）
// ═══════════════════════════════════════════════════════════
// 原理（本机逆向 Trae CN 0.5.x 得出）：
//   1. 凭据：Trae 把登录态加密存于 %APPDATA%\Trae CN\User\globalStorage\storage.json
//      的 "iCubeAuthInfo://icube.cloudide" 键。信封 = 6 字节魔数头 + 32 字节随机 AES 密钥
//      + AES-128-CBC 密文（自带 SHA-512 校验块），解密算法自包含（byteCrypto.js），无需机器密钥
//   2. 签到：POST {host}/trae/api/v2/ug/checkin_credits/status（查状态）
//           POST {host}/trae/api/v2/ug/checkin_credits/claim （领取，幂等）
//      鉴权：Authorization: Cloud-IDE-JWT <token>；host 与 token 都在解密后的 JSON 里
//   3. token 续期：token 约 2 周过期，由 Trae 客户端运行时自动刷新并重新加密落盘；
//      本脚本每次运行实时解密，自动采用最新 token。唯一失效场景：Trae 连续两周未启动
//      且 token 过期 → result=LOGIN_REQUIRED，打开一次 Trae 登录态即可恢复
//
// 输出：JSON 行日志追加到同目录 trae_checkin.log（不打印任何 token 明文）
// 退出码：0=已领取 1=失败 2=今日已签 3=需重新登录（打开一次 Trae 即可）
//
// 用法：node trae_checkin_api.mjs [--trigger schedule|poll|manual]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadAuthInfo, deviceIdFromStorage, bj, mask, daysLeft } from './trae_auth.mjs';

const argv = process.argv.slice(2);
const argValue = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
};
const TRIGGER = argValue('trigger') || 'manual';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LOG_FILE = path.join(HERE, 'trae_checkin.log');

// 剩余有效期低于该天数即在日志里显式告警（客户端只在 token 剩 ≤300s 或已过期时才续期，
// 所以"很久没打开 Trae"必然走到过期，提前 N 天给出可操作提示）
const EXPIRY_WARN_DAYS = 3;

// ── 日志（JSON Lines，风格与 signin.log / qoder_checkin.log 一致）────────
// 每条记录都带上 token 到期信息，便于从日志回溯"什么时候开始失效"
let TOKEN_FIELDS = {};
function logRun(rec) {
  try {
    fs.appendFileSync(LOG_FILE, JSON.stringify({ script: 'trae_checkin_api', time: bj(), trigger: TRIGGER, ...TOKEN_FIELDS, ...rec }) + '\n', 'utf-8');
  } catch (e) {
    console.error('[WARN] 日志写入失败:', e.message);
  }
}

// ── 主流程 ───────────────────────────────────────────────
async function main() {
  let info;
  try {
    info = loadAuthInfo();
  } catch (e) {
    console.log('🔑 需重新登录:', e.message);
    logRun({ result: 'LOGIN_REQUIRED', msg: e.message });
    return 3;
  }

  const expired = new Date(info.expiredAt).getTime() < Date.now();
  const left = daysLeft(info);
  TOKEN_FIELDS = { tokenExpiresAt: info.expiredAt, tokenDaysLeft: Number(left.toFixed(1)) };
  console.log(`[INFO] token ${mask(info.token)} 到期 ${info.expiredAt}（剩 ${left.toFixed(1)} 天）${expired ? '（已过期）' : ''}`);
  console.log(`[INFO] host ${info.host} | userId ${info.userId}`);
  if (!expired && left < EXPIRY_WARN_DAYS) {
    console.log(`⚠️ token 剩 ${left.toFixed(1)} 天，Trae 客户端只在临期/过期时才续期；` +
      `建议先跑 trae_keepalive.mjs 或手动打开一次 Trae`);
    TOKEN_FIELDS.warn = `token 剩 ${left.toFixed(1)} 天`;
  }

  // x-device-id 必须是客户端真实注册的纯数字设备号（键名 iCubeAuthInfo://icube-dc:<digits>）。
  // 不能用 telemetry.devDeviceId（UUID 格式会被服务端拒绝，返回 9074"当前参与用户太多"——
  // 该文案具有误导性，实际是设备校验不通过，2026-10 起 Trae 收紧了此校验）
  const deviceId = deviceIdFromStorage();
  if (!/^\d{12,20}$/.test(deviceId)) throw new Error('未能从 storage.json 提取真实设备号（iCubeAuthInfo://icube-dc:*）');
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Cloud-IDE-JWT ${info.token}`,
    'x-device-id': deviceId,
  };

  const call = async (ep) => {
    const res = await fetch(info.host + ep, { method: 'POST', headers, body: '{}' });
    const text = await res.text();
    let body = null;
    try { body = JSON.parse(text); } catch { /* 保留原文 */ }
    return { http: res.status, body, text: text.slice(0, 400) };
  };

  // token 过期直接判定需登录（打开一次 Trae 客户端即可刷新凭据）
  if (expired) {
    console.log('🔑 token 已过期，请打开一次 Trae CN 客户端（登录态会自动续期）');
    logRun({ result: 'LOGIN_REQUIRED', msg: `token 过期于 ${info.expiredAt}（已过期 ${(-left).toFixed(1)} 天）`, uid: info.userId });
    return 3;
  }

  // 本地当日去重：服务端 did_checked_in 字段语义不稳定（实测领取成功后仍为 false），
  // 以本地日志为准——今天已有成功记录就不再发 claim（claim 幂等，重复只是多余请求）
  try {
    const today = bj().slice(0, 10);
    const log = fs.readFileSync(LOG_FILE, 'utf-8');
    if (log.split('\n').some(l => l.includes(`"time":"${today}`) && /"result":"(CLAIMED|ALREADY)"/.test(l))) {
      console.log('☑️ 今日已签（本地当日记录）');
      logRun({ result: 'ALREADY', msg: '今日已签（本地当日记录）', uid: info.userId });
      return 2;
    }
  } catch { /* 日志不存在则继续 */ }

  console.log('[INFO] 查询签到状态...');
  let st;
  try {
    st = await call('/trae/api/v2/ug/checkin_credits/status');
  } catch (e) {
    console.log('❌ 网络失败:', e.message);
    logRun({ result: 'ERROR', msg: 'status 网络失败: ' + e.message, uid: info.userId });
    return 1;
  }
  if (st.http === 401 || st.http === 403) {
    console.log('🔑 鉴权失效（HTTP', st.http + '），请打开一次 Trae CN 客户端');
    logRun({ result: 'LOGIN_REQUIRED', msg: `status HTTP ${st.http}`, uid: info.userId });
    return 3;
  }
  if (st.http !== 200 || !st.body || st.body.code !== 0) {
    console.log('❌ 状态查询失败: HTTP', st.http, st.text);
    logRun({ result: 'ERROR', msg: `status HTTP ${st.http} ${st.text.slice(0, 120)}`, uid: info.userId });
    return 1;
  }
  console.log('[INFO] 状态:', JSON.stringify(st.body));

  if (st.body.did_checked_in) {
    console.log('☑️ 今日已签');
    logRun({ result: 'ALREADY', msg: '今日已签', uid: info.userId, credits: st.body.credits });
    return 2;
  }
  if (st.body.enable === false) {
    console.log('☑️ 签到活动未开启');
    logRun({ result: 'ALREADY', msg: '签到活动未开启', uid: info.userId });
    return 2;
  }

  console.log('[INFO] 领取签到...');
  // 服务端高峰限流会返回 HTTP 200 + code!=0 + "当前参与用户太多，请稍后再试"，
  // 属于临时性繁忙而非真失败，做有界退避重试（15s/30s/45s）
  const BUSY_RE = /用户太多|稍后再试|too many|busy|rate limit/i;
  const MAX_ATTEMPTS = 4;
  let cl = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      cl = await call('/trae/api/v2/ug/checkin_credits/claim');
    } catch (e) {
      console.log('❌ 网络失败:', e.message);
      logRun({ result: 'ERROR', msg: 'claim 网络失败: ' + e.message, uid: info.userId });
      return 1;
    }
    if (cl.http === 401 || cl.http === 403) {
      console.log('🔑 鉴权失效（HTTP', cl.http + '）');
      logRun({ result: 'LOGIN_REQUIRED', msg: `claim HTTP ${cl.http}`, uid: info.userId });
      return 3;
    }
    if (cl.http === 200 && cl.body && cl.body.code === 0) {
      console.log('✅ 签到成功 +200 Credits');
      logRun({ result: 'CLAIMED', msg: '签到成功 +200 Credits', uid: info.userId, credits: 200, response: cl.body });
      return 0;
    }
    const msg = cl.body?.message || cl.text;
    if (/已签|already|checked/i.test(msg)) {
      console.log('☑️ 今日已签（领取接口返回幂等结果）');
      logRun({ result: 'ALREADY', msg, uid: info.userId });
      return 2;
    }
    if (BUSY_RE.test(msg) && attempt < MAX_ATTEMPTS) {
      const wait = 15 * attempt;
      console.log(`⏳ 服务端繁忙（${msg}），${wait}s 后重试（重试 ${attempt}/${MAX_ATTEMPTS - 1}）`);
      logRun({ result: 'RETRY', msg: `claim 繁忙: ${msg}，${wait}s 后重试`, uid: info.userId, attempt });
      await new Promise(r => setTimeout(r, wait * 1000));
      continue;
    }
    break;
  }
  const msg = cl.body?.message || cl.text;
  console.log('❌ 领取失败: HTTP', cl.http, cl.text);
  logRun({ result: 'ERROR', msg: `claim HTTP ${cl.http} ${msg}`, uid: info.userId });
  return 1;
}

try {
  process.exit(await main());
} catch (e) {
  console.error('[ERROR]', e.message);
  try { logRun({ result: 'ERROR', msg: String(e.message).slice(0, 200) }); } catch { /* ignore */ }
  process.exit(1);
}
