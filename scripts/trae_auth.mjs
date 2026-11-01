// trae_auth.mjs — Trae CN 本地凭据读取（storage.json + byteCrypto 信封解密）
// ═══════════════════════════════════════════════════════════
// 被 trae_checkin_api.mjs（签到）与 trae_keepalive.mjs（到期前续期）共用。
// 信封格式与密钥派生均取自 Trae CN 主进程包 byteCrypto.js，自包含（无需机器密钥）：
//   6 字节魔数头 + 32 字节内嵌 AES 密钥 + AES-128-CBC 密文（前 64 字节为 SHA-512 校验块）
//
// 解密后的凭据字段（Trae CN 0.5.x 实测）：
//   token(JWT, 14 天) / refreshToken(61 字符, 6 个月) / expiredAt / refreshExpiredAt
//   tokenReleaseAt / userId / host / userRegion / account
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const NO = 116, OO = 99, RO = 5, $O = 16, MO = 0, LO = 0, Jm = 6, pv = 32, vh = 64, AES128 = 16, IVLEN = 16, PO = 64;
const qoe = Uint8Array.from([82,9,106,213,48,54,165,56,191,64,163,158,129,243,215,251,124,227,57,130,155,47,255,135,52,142,67,68,196,222,233,203,84,123,148,50,166,194,35,61,238,76,149,11,66,250,195,78,8,46,161,102,40,217,36,178,118,91,162,73,109,139,209,37]);
const zoe = Uint8Array.from([31,221,168,51,136,7,199,49,177,18,16,89,39,128,236,95,96,81,127,169,25,181,74,13,45,229,122,159,147,201,156,239,160,224,59,77,174,42,245,176,200,235,187,60,131,83,153,97,23,43,4,126,186,119,214,38,225,105,20,99,85,33,12,125]);
const sha512 = (u8) => new Uint8Array(crypto.createHash('sha512').update(u8).digest());

export const AUTH_KEY = 'iCubeAuthInfo://icube.cloudide';

export function storagePath() {
  return path.join(os.homedir(), 'AppData', 'Roaming', 'Trae CN', 'User', 'globalStorage', 'storage.json');
}

export function readStorage() {
  return JSON.parse(fs.readFileSync(storagePath(), 'utf-8'));
}

export function decryptBlob(b64) {
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

export function loadAuthInfo(storage = readStorage()) {
  const blob = storage[AUTH_KEY];
  if (!blob) throw new Error('storage.json 中无 iCubeAuthInfo://icube.cloudide（未登录 Trae CN？）');
  const info = JSON.parse(decryptBlob(blob));
  if (!info.token || !info.host) throw new Error('解密后的凭据缺少 token/host');
  return info;
}

// x-device-id 必须是客户端真实注册的纯数字设备号（键名 iCubeAuthInfo://icube-dc:<digits>）。
// 不能用 telemetry.devDeviceId（UUID 格式被服务端拒绝，返回 9074"当前参与用户太多"）。
export function deviceIdFromStorage(storage = readStorage()) {
  const key = Object.keys(storage).find(k => k.toLowerCase().startsWith('icubeauthinfo://icube-dc:'));
  return key ? key.split(':').pop() : '';
}

// 北京时间字符串（与 signin.log / qoder_checkin.log 风格一致）
export function bj() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 19);
}

export function mask(s) {
  return typeof s === 'string' && s.length > 12 ? s.slice(0, 6) + `...(${s.length})` : s;
}

// token 剩余天数（负值表示已过期）
export function daysLeft(info) {
  return (new Date(info.expiredAt).getTime() - Date.now()) / 86400000;
}
