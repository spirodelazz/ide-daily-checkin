#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Qoder 每日自动签到 · qoder_checkin.py
════════════════════════════════════════════════════════════
合并自 wallechfox/qoder-checkin（MIT）的 qoder_core.py + 02_checkin.py，
与 workbuddy-auto-signin 同目录、同计划任务模式运行。

流程：读 qoder_config.json（Cosy-* 设备标识）+ qoder_accounts.json（token），
逐个账号：临近过期刷新 token → GET 活动列表 → 有 CLAIMABLE 就 POST claim → 写 JSON 行日志。

与上游的差异（本机适配）：
  · expiresAt 兼容 ISO 字符串 / epoch 秒 / epoch 毫秒（上游拿到 ISO 字符串会 TypeError）
  · 文件名加 qoder_ 前缀，避免与 signin.py 的文件混淆
  · pythonw（无控制台）下安全运行；每次运行追加一行 JSON 到 qoder_checkin.log
  · claim 幂等，重复运行不会重复发币

用法：
    python qoder_checkin.py               # 手动前台跑一次
    pythonw qoder_checkin.py silent       # 计划任务：每日签到
    pythonw qoder_checkin.py silent-poll  # 计划任务：白天轮询（活动未下发时兜底）

凭据来源：先在本机跑一次 qoder_extract.py（token 到期彻底失效后重新提取）。
"""
import base64
import json
import os
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone

# pythonw 下 sys.stdout/stderr 为 None，先兜底
if sys.stdout is None:
    sys.stdout = open(os.devnull, "w", encoding="utf-8")
if sys.stderr is None:
    sys.stderr = open(os.devnull, "w", encoding="utf-8")
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

HERE = os.path.dirname(os.path.abspath(__file__))
CONFIG_FILE = os.getenv("QODER_CONFIG_FILE", "").strip() or os.path.join(HERE, "qoder_config.json")
ACCOUNTS_FILE = os.getenv("QODER_ACCOUNTS_FILE", "").strip() or os.path.join(HERE, "qoder_accounts.json")
CACHE_FILE = os.path.join(HERE, ".qoder_token_cache.json")
LOG_FILE = os.path.join(HERE, "qoder_checkin.log")

DEFAULT_BASES = ["https://openapi.qoder.com.cn"]
UA = "Qoder/claim"

PATH_CAMPAIGNS = "/sash/api/v1/me/campaigns"
PATH_CLAIM = "/sash/api/v1/me/campaigns/{cid}/claim"
PATH_REFRESH = "/api/v1/deviceToken/refresh"

QYWX_URL = "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key="
PUSHPLUS_URL = "https://www.pushplus.plus/send"

# 设备标识：qoder_config.json 的键 -> Cosy-* 请求头 -> 环境变量 -> 默认值
DEVICE_KEYS = [
    ("clientType", "Cosy-ClientType", "QODER_COSY_CLIENT_TYPE", "10"),
    ("machineOS", "Cosy-MachineOS", "QODER_COSY_MACHINE_OS", ""),
    ("machineHostname", "Cosy-MachineHostname", "QODER_COSY_MACHINE_HOSTNAME", ""),
    ("machineId", "Cosy-MachineId", "QODER_COSY_MACHINE_ID", ""),
    ("machineToken", "Cosy-MachineToken", "QODER_COSY_MACHINE_TOKEN", ""),
    ("machineCode", "Cosy-MachineCode", "QODER_COSY_MACHINE_CODE", ""),
    ("machineType", "Cosy-MachineType", "QODER_COSY_MACHINE_TYPE", ""),
    ("version", "Cosy-Version", "QODER_COSY_VERSION", ""),
]


# ── 配置读取 ──────────────────────────────────────────────
def read_json(path, default):
    try:
        with open(path, "r", encoding="utf-8-sig", errors="replace") as fh:
            text = fh.read().lstrip("\ufeff").strip()
        return json.loads(text) if text else default
    except (FileNotFoundError, OSError, ValueError, TypeError):
        return default


CONFIG = read_json(CONFIG_FILE, {})
if not isinstance(CONFIG, dict):
    CONFIG = {}


def _env_or_conf(env, conf_path, default=""):
    v = os.getenv(env, "").strip()
    if v:
        return v
    node = CONFIG
    for k in conf_path:
        if not isinstance(node, dict):
            return default
        node = node.get(k)
    return default if node in (None, "") else node


def qywx_token():
    return str(_env_or_conf("QYWX_TOKEN", ("notify", "qywxToken"))).strip()


def plusplus_token():
    return str(_env_or_conf("PLUSPLUS_TOKEN", ("notify", "plusplusToken"))).strip()


def webhook_url():
    return str(_env_or_conf("QODER_WEBHOOK", ("notify", "webhook"))).strip()


def base_urls():
    env = os.getenv("QODER_BASE_URL", "").strip()
    if env:
        return [u.strip() for u in env.split(",") if u.strip()]
    v = CONFIG.get("baseUrls")
    if isinstance(v, list) and v:
        return [str(u).strip() for u in v if str(u).strip()]
    return DEFAULT_BASES


def refresh_margin():
    try:
        return int(CONFIG.get("refreshMarginH", 72))
    except (TypeError, ValueError):
        return 72


def device_headers():
    dev = CONFIG.get("device") if isinstance(CONFIG.get("device"), dict) else {}
    h = {}
    for cfg_key, header, env, default in DEVICE_KEYS:
        v = os.getenv(env, "").strip()
        if not v:
            v = str(dev.get(cfg_key) or "").strip() or str(default or "")
        if v:
            h[header] = v
    h.setdefault("Cosy-ClientType", "10")
    return h


def bj(fmt="%Y-%m-%d %H:%M:%S"):
    return time.strftime(fmt, time.gmtime(time.time() + 8 * 3600))


# ── HTTP ─────────────────────────────────────────────────
_opener = urllib.request.build_opener()


def _raw(base, path, method, token="", body=None):
    url = base.rstrip("/") + path
    headers = {"Accept": "application/json", "User-Agent": UA}
    headers.update(device_headers())
    if token:
        headers["Authorization"] = "Bearer " + token
    data = None
    if method == "POST":
        headers["Content-Type"] = "application/json"
        data = json.dumps(body or {}).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with _opener.open(req, timeout=30) as resp:
            text = resp.read().decode("utf-8", "replace")
            status = resp.status
    except urllib.error.HTTPError as e:
        try:
            text = e.read().decode("utf-8", "replace")
        except Exception:
            text = ""
        status = e.code
    except Exception as e:
        return 0, str(e), base
    try:
        body = json.loads(text)
    except Exception:
        body = text
    return status, body, base


_BASE = ""


def api_call(path, method="GET", token="", body=None):
    """尝试各端点。网络错误(0) / 404 视作端点不对换下一个；其余（含 401）视为该端点已给出结论。"""
    global _BASE
    bases = base_urls()
    if _BASE and _BASE in bases:
        bases = [_BASE] + [b for b in bases if b != _BASE]
    last = (0, "no base", "")
    for base in bases:
        status, data, _ = _raw(base, path, method, token, body)
        if status in (0, 404):
            last = (status, data, base)
            continue
        _BASE = base
        return status, data, base
    return last


# ── JWT / 过期时间 ────────────────────────────────────────
def _b64(seg):
    seg += "=" * (-len(seg) % 4)
    try:
        return json.loads(base64.urlsafe_b64decode(seg))
    except Exception:
        return {}


def jwt_exp(token):
    parts = str(token or "").split(".")
    if len(parts) != 3:
        return 0
    try:
        return int(_b64(parts[1]).get("exp") or 0)
    except (TypeError, ValueError):
        return 0


def jwt_uid(token):
    parts = str(token or "").split(".")
    if len(parts) != 3:
        return ""
    data = _b64(parts[1])
    for k in ("sub", "uid", "user_id", "userId", "id"):
        if data.get(k):
            return str(data[k])
    return ""


def coerce_exp(v):
    """把 expiresAt 统一成 epoch 秒。兼容：int/float、纯数字字符串（秒或毫秒）、
    ISO 字符串（如 2026-10-18T12:13:54Z）。解析失败返回 0（视为未知，靠 401 兜底强刷）。
    上游 qoder_core 拿 ISO 字符串直接和 time.time() 相减会 TypeError，这里是修复点。"""
    if v in (None, "", 0, "0"):
        return 0
    if isinstance(v, bool):
        return 0
    if isinstance(v, (int, float)):
        n = float(v)
        return int(n / 1000) if n > 1e12 else int(n)
    s = str(v).strip()
    if s.isdigit():
        n = float(s)
        return int(n / 1000) if n > 1e12 else int(n)
    try:
        dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return int(dt.timestamp())
    except Exception:
        return 0


# ── token 刷新 ───────────────────────────────────────────
def do_refresh(refresh_token):
    if not refresh_token:
        return None
    status, data, _ = api_call(PATH_REFRESH, "POST", body={"refresh_token": refresh_token})
    if status != 200 or not isinstance(data, dict):
        return None
    tok = data.get("token") or data.get("accessToken") or data.get("access_token")
    if not tok:
        return None
    return {"accessToken": tok,
            "refreshToken": data.get("refreshToken") or data.get("refresh_token") or refresh_token}


# ── 账号持久化（轮换后的 token 写回文件，避免越用越失效）──
def atomic_write_json(path, data):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=False, indent=2)
    os.replace(tmp, path)


def _acct_key(acc):
    return (str(acc.get("uid") or "").strip()
            or str(acc.get("refreshToken") or "")[:24]
            or str(acc.get("accessToken") or "")[:24]
            or "default")


def persist(acc):
    key = _acct_key(acc)
    cache = read_json(CACHE_FILE, {})
    if not isinstance(cache, dict):
        cache = {}
    cache[key] = {"accessToken": acc.get("accessToken", ""),
                  "refreshToken": acc.get("refreshToken", ""),
                  "expiresAt": acc.get("expiresAt") or 0,
                  "uid": acc.get("uid", ""),
                  "updatedAt": int(time.time())}
    try:
        atomic_write_json(CACHE_FILE, cache)
    except Exception as e:
        print("⚠️ [缓存] 写入失败: %s" % e)
    if os.path.isfile(ACCOUNTS_FILE):
        _write_back_accounts(acc)


def _write_back_accounts(acc):
    try:
        doc = read_json(ACCOUNTS_FILE, None)
        accounts = doc.get("accounts") if isinstance(doc, dict) else doc
        if not isinstance(accounts, list):
            return
        hit = False
        for a in accounts:
            if not isinstance(a, dict):
                continue
            same = (acc.get("uid") and str(a.get("uid")) == str(acc["uid"])) or \
                   (acc.get("refreshToken") and a.get("refreshToken") == acc.get("refreshToken"))
            if same:
                a["accessToken"] = acc.get("accessToken", "")
                a["refreshToken"] = acc.get("refreshToken", "")
                a["expiresAt"] = acc.get("expiresAt") or 0
                a["uid"] = acc.get("uid", "")
                hit = True
                break
        if hit:
            atomic_write_json(ACCOUNTS_FILE, doc if isinstance(doc, dict) else {"accounts": accounts})
    except Exception as e:
        print("⚠️ [回写] %s 失败: %s" % (os.path.basename(ACCOUNTS_FILE), e))


def apply_cache(accounts):
    cache = read_json(CACHE_FILE, {})
    if not isinstance(cache, dict) or not cache:
        return accounts
    for a in accounts:
        rec = cache.get(_acct_key(a))
        if isinstance(rec, dict) and rec.get("accessToken"):
            a["accessToken"] = rec["accessToken"]
            a["refreshToken"] = rec.get("refreshToken") or a.get("refreshToken", "")
            a["expiresAt"] = rec.get("expiresAt") or 0
    return accounts


# ── 账号加载 ─────────────────────────────────────────────
def _pick(d, *names):
    if not isinstance(d, dict):
        return ""
    for n in names:
        for k, v in d.items():
            if str(k).lower() == str(n).lower() and v not in (None, ""):
                return v
    return ""


def normalize(a, i):
    return {"accessToken": str(_pick(a, "accessToken", "access_token", "token") or ""),
            "refreshToken": str(_pick(a, "refreshToken", "refresh_token") or ""),
            "uid": str(_pick(a, "uid", "userId", "user_id", "sub", "id") or ""),
            "name": str(_pick(a, "name", "nickname") or "账号%d" % (i + 1))}


def _from_list(items):
    out = []
    for i, item in enumerate(items):
        if isinstance(item, dict):
            out.append(normalize(item, i))
    return out


def load_accounts():
    accounts = []
    env = os.getenv("QODER_ACCOUNTS", "").strip()
    if env:
        try:
            data = json.loads(env)
        except ValueError:
            data = None
        if isinstance(data, dict):
            data = data.get("accounts", [data])
        if isinstance(data, list):
            accounts += _from_list(data)
    doc = read_json(ACCOUNTS_FILE, None)
    if isinstance(doc, dict):
        accounts += _from_list(doc.get("accounts", []))
    elif isinstance(doc, list):
        accounts += _from_list(doc)

    uniq, seen = [], set()
    for a in accounts:
        if not (a.get("refreshToken") or a.get("accessToken")):
            continue
        k = a.get("uid") or a.get("refreshToken", "")[:24] or a.get("accessToken", "")[:24]
        if k in seen:
            continue
        seen.add(k)
        uniq.append(a)
    return apply_cache(uniq)


# ── 签到流程 ─────────────────────────────────────────────
def ensure_token(acc, force=False):
    margin = refresh_margin() * 3600
    at = acc.get("accessToken") or ""
    exp = coerce_exp(acc.get("expiresAt")) or (jwt_exp(at) if at else 0)
    if at and not force and (not exp or exp - time.time() > margin):
        return True, ""
    rt = acc.get("refreshToken") or ""
    if not rt:
        return False, "没有 refreshToken，且 accessToken 不可用"
    r = do_refresh(rt)
    if not r:
        if at and (not exp or exp > time.time()):
            return True, "刷新失败，沿用未过期 accessToken"
        return False, "refreshToken 刷新失败，需重新运行 qoder_extract.py 提取"
    acc["accessToken"] = r["accessToken"]
    acc["refreshToken"] = r["refreshToken"]
    acc["expiresAt"] = jwt_exp(r["accessToken"])
    if not acc.get("uid"):
        acc["uid"] = jwt_uid(r["accessToken"])
    persist(acc)
    return True, "已刷新"


def _fmt(v):
    try:
        return "{:,.0f}".format(float(v))
    except (TypeError, ValueError):
        return str(v)


def run_account(acc):
    name = acc.get("name") or acc.get("uid") or _acct_key(acc)
    r = {"name": name, "uid": acc.get("uid") or "-", "phase": "error", "msg": "", "credits": 0}

    ok, msg = ensure_token(acc)
    if not ok:
        r["phase"] = "login_required"
        r["msg"] = msg
        return r

    status, data, _ = api_call(PATH_CAMPAIGNS, token=acc["accessToken"])
    if status == 401:
        ok2, _ = ensure_token(acc, force=True)
        if ok2:
            status, data, _ = api_call(PATH_CAMPAIGNS, token=acc["accessToken"])
    if status == 401:
        r["phase"] = "login_required"
        r["msg"] = "token 无效且刷新失败，请重新提取（qoder_extract.py）"
        return r
    if status != 200 or not isinstance(data, dict):
        r["phase"] = "error"
        r["msg"] = "查询失败 HTTP %s: %s" % (status, str(data)[:120])
        return r

    campaigns = data.get("campaigns")
    if not isinstance(campaigns, list):
        campaigns = []
    benefits = [c for c in campaigns if isinstance(c, dict) and c.get("actionType") == "CLAIM_BENEFIT"]
    claimable = [c for c in benefits if c.get("claimStatus") == "CLAIMABLE"]

    if claimable:
        got, fail = 0, 0
        for c in claimable:
            cid = str(c.get("campaignId") or "")
            s2, d2, _ = api_call(PATH_CLAIM.replace("{cid}", cid), "POST", token=acc["accessToken"], body={})
            dd = d2.get("data") if isinstance(d2, dict) and isinstance(d2.get("data"), dict) else d2
            okk = s2 == 200 and isinstance(dd, dict) and dd.get("status") == "CLAIMED"
            if okk:
                amt = (dd.get("benefit") or {}).get("amount") if isinstance(dd, dict) else 0
                amt = amt or (c.get("benefit") or {}).get("amount") or 0
                try:
                    got += float(amt)
                except (TypeError, ValueError):
                    pass
            else:
                fail += 1
        if fail:
            r["phase"] = "error"
            r["msg"] = "%d/%d 个活动领取失败" % (fail, len(claimable))
        else:
            r["phase"] = "claimed"
            r["credits"] = got
            r["msg"] = "签到成功 +%s Credits" % _fmt(got)
        return r

    now = time.time()
    claimed = [c for c in benefits if c.get("claimStatus") == "CLAIMED"
               and (c.get("startAt") or 0) <= now < (c.get("endAt") or 0)]
    if claimed:
        r["phase"] = "already"
        r["msg"] = "今日已领取"
        return r
    if not benefits:
        r["phase"] = "already"
        r["msg"] = "活动列表为空（活动结束或未开放）"
        return r
    r["phase"] = "pending"
    r["msg"] = "活动未下发，等下轮"
    return r


# ── 推送（留空即关闭）─────────────────────────────────────
def push(title, text):
    key = qywx_token().split("key=")[-1].strip()
    if key:
        try:
            req = urllib.request.Request(
                QYWX_URL + key,
                data=json.dumps({"msgtype": "text", "text": {"content": "%s\n%s" % (title, text)}}).encode("utf-8"),
                headers={"Content-Type": "application/json"})
            rr = json.loads(urllib.request.urlopen(req, timeout=10).read().decode("utf-8"))
            print("%s [企业微信] errcode=%s" % ("✅" if rr.get("errcode") == 0 else "❌", rr.get("errcode")))
        except Exception as e:
            print("❌ [企业微信] %s" % e)
    pp = plusplus_token()
    if pp:
        try:
            req = urllib.request.Request(
                PUSHPLUS_URL,
                data=json.dumps({"token": pp, "title": title, "content": text, "template": "txt"}).encode("utf-8"),
                headers={"Content-Type": "application/json"}, method="POST")
            urllib.request.urlopen(req, timeout=10)
            print("✅ [PushPlus] 推送成功")
        except Exception as e:
            print("❌ [PushPlus] %s" % e)
    hook = webhook_url()
    if hook:
        try:
            req = urllib.request.Request(
                hook,
                data=json.dumps({"title": title, "content": text}).encode("utf-8"), method="POST",
                headers={"Content-Type": "application/json"})
            urllib.request.urlopen(req, timeout=10)
            print("✅ [Webhook] 推送成功")
        except Exception as e:
            print("❌ [Webhook] %s" % e)


# ── 日志（JSON Lines，风格与 signin.log 一致）─────────────
def log_run(trigger, results, claimed, already, pending, bad):
    rec = {
        "time": bj(),
        "script": "qoder_checkin",
        "trigger": trigger,
        "result": "CLAIMED" if claimed else ("ALREADY" if already and not bad and not pending
                                             else ("PENDING" if pending and not bad else
                                                   ("ERROR" if bad else "NONE"))),
        "summary": {"claimed": claimed, "already": already, "pending": pending, "failed": bad},
        "results": results,
    }
    try:
        with open(LOG_FILE, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(rec, ensure_ascii=False, default=str) + "\n")
    except Exception as e:
        print("⚠️ [日志] 写入失败: %s" % e)


# ── 主流程 ───────────────────────────────────────────────
PHASE_LABEL = {"claimed": "✅ 签到成功", "already": "☑️ 已领取", "pending": "⏳ 待下发",
               "login_required": "🔑 需重新提取", "error": "❌ 失败"}


def main(argv):
    args = [a.lower() for a in argv]
    if "--help" in args or "-h" in args:
        print(__doc__)
        return 0
    trigger = "poll" if ("silent-poll" in args or "poll" in args) else "checkin"

    accounts = load_accounts()
    if not accounts:
        print("❌ 没有可用账号。请先在本机运行 qoder_extract.py 提取凭据")
        log_run(trigger, [{"name": "-", "uid": "-", "phase": "login_required",
                           "msg": "没有账号凭据，先运行 qoder_extract.py", "credits": 0}],
                0, 0, 0, 1)
        return 1

    print("=" * 56)
    print("  🤖 Qoder 每日自动签到  %s  (trigger=%s)" % (bj(), trigger))
    print("  账号 %d 个 · 端点 %s" % (len(accounts), base_urls()[0]))
    print("=" * 56)

    results = []
    for acc in accounts:
        name = acc.get("name") or acc.get("uid") or _acct_key(acc)
        try:
            r = run_account(acc)
        except Exception as e:
            r = {"name": name, "uid": acc.get("uid") or "-", "phase": "error", "msg": str(e), "credits": 0}
        label = PHASE_LABEL.get(r["phase"], r["phase"])
        credits = "（+%s）" % _fmt(r["credits"]) if r.get("credits") else ""
        print("  %s %s: %s%s" % (label, name, r["msg"], credits))
        results.append(r)

    claimed = sum(1 for r in results if r["phase"] == "claimed")
    already = sum(1 for r in results if r["phase"] == "already")
    pending = sum(1 for r in results if r["phase"] == "pending")
    bad = sum(1 for r in results if r["phase"] in ("login_required", "error"))
    print("-" * 56)
    print("  成功 %d · 已领 %d · 待下发 %d · 失败 %d" % (claimed, already, pending, bad))

    log_run(trigger, results, claimed, already, pending, bad)

    lines = ["🤖 Qoder 每日签到 %s" % bj(),
             "成功 %d · 已领 %d · 待下发 %d · 失败 %d" % (claimed, already, pending, bad)]
    for r in results:
        lines.append("%s %s(%s): %s" % (PHASE_LABEL.get(r["phase"], r["phase"]), r["name"], r["uid"], r["msg"]))
    push("🤖 Qoder 每日签到", "\n".join(lines))

    return 0 if bad == 0 else 2


if __name__ == "__main__":
    try:
        _code = main(sys.argv[1:])
    except Exception as _e:
        # 计划任务静默运行时的最后防线：异常也要落到日志里
        try:
            log_run("fatal", [{"name": "-", "uid": "-", "phase": "error",
                               "msg": "%s: %s" % (type(_e).__name__, _e), "credits": 0}], 0, 0, 0, 1)
        except Exception:
            pass
        print("💥 未捕获异常: %s: %s" % (type(_e).__name__, _e))
        _code = 2
    sys.exit(_code)
