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
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const argValue = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
};
const TRIGGER = argValue('trigger') || 'manual';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LOG_FILE = path.join(HERE, 'trae_checkin.log');

// ── byteCrypto.js 信封解密（常量与算法均取自 Trae CN 主进程包）──────────
const NO = 116, OO = 99, RO = 5, $O = 16, MO = 0, LO = 0, Jm = 6, pv = 32, vh = 64, AES128 = 16, IVLEN = 16, PO = 64;
const qoe = Uint8Array.from([82,9,106,213,48,54,165,56,191,64,163,158,129,243,215,251,124,227,57,130,155,47,255,135,52,142,67,68,196,222,233,203,84,123,148,50,166,194,35,61,238,76,149,11,66,250,195,78,8,46,161,102,40,217,36,178,118,91,162,73,109,139,209,37]);
const zoe = Uint8Array.from([31,221,168,51,136,7,199,49,177,18,16,89,39,128,236,95,96,81,127,169,25,181,74,13,45,229,122,159,147,201,156,239,160,224,59,77,174,42,245,176,200,235,187,60,131,83,153,97,23,43,4,126,186,119,214,38,225,105,20,99,85,33,12,125]);
const sha512 = (u8) => new Uint8Array(crypto.createHash('sha512').update(u8).digest());

function decryptBlob(b64) {
  const t = new Uint8Array(Buffer.from(b64, 'base64'));
  if (t[0] !== NO || t[1] !== OO || t[2] !== RO || t[3] !== $O || t[4] !== MO || t[5] !== LO) {
    throw new Error(`信封魔数不匹配: ${[...t.slice(0, 6)]}（Trae 版本可能已更换加密方案）`);
  }
  const key32 = t.slice(Jm, Jm + pv); // 32 字节密钥内嵌于头部
  const n = new Uint8Array(PO + 64);
  n.set(sha512(key32), 0);
  n.set(Uint8Array.from(qoe.map((b, i) => b ^ zoe[i])), 64);
  const c = sha512(n);
  const d = crypto.createDecipheriv('aes-128-cbc', c.slice(0, AES128), c.slice(AES128, AES128 + IVLEN));
  const plain = Buffer.concat([d.update(t.slice(pv + Jm)), d.final()]);
  const u8 = new Uint8Array(plain);
  for (let i = 0; i < vh; i++) {
    if (sha512(u8.slice(vh))[i] !== u8[i]) throw new Error('SHA-512 完整性校验失败');
  }
  return new TextDecoder().decode(u8.slice(vh));
}

function loadAuthInfo() {
  const sj = path.join(os.homedir(), 'AppData', 'Roaming', 'Trae CN', 'User', 'globalStorage', 'storage.json');
  const data = JSON.parse(fs.readFileSync(sj, 'utf-8'));
  const blob = data['iCubeAuthInfo://icube.cloudide'];
  if (!blob) throw new Error('storage.json 中无 iCubeAuthInfo://icube.cloudide（未登录 Trae CN？）');
  const info = JSON.parse(decryptBlob(blob));
  if (!info.token || !info.host) throw new Error('解密后的凭据缺少 token/host');
  return info;
}

// ── 日志（JSON Lines，风格与 signin.log / qoder_checkin.log 一致）────────
function bj() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 19);
}
function logRun(rec) {
  try {
    fs.appendFileSync(LOG_FILE, JSON.stringify({ script: 'trae_checkin_api', time: bj(), trigger: TRIGGER, ...rec }) + '\n', 'utf-8');
  } catch (e) {
    console.error('[WARN] 日志写入失败:', e.message);
  }
}

function mask(s) { return typeof s === 'string' && s.length > 12 ? s.slice(0, 6) + `...(${s.length})` : s; }

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
  console.log(`[INFO] token ${mask(info.token)} 到期 ${info.expiredAt}${expired ? '（已过期）' : ''}`);
  console.log(`[INFO] host ${info.host} | userId ${info.userId}`);

  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Cloud-IDE-JWT ${info.token}`,
    'x-device-id': String(JSON.parse(fs.readFileSync(path.join(os.homedir(), 'AppData', 'Roaming', 'Trae CN', 'User', 'globalStorage', 'storage.json'), 'utf-8'))['telemetry.devDeviceId'] || ''),
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
    logRun({ result: 'LOGIN_REQUIRED', msg: `token 过期于 ${info.expiredAt}`, uid: info.userId });
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
