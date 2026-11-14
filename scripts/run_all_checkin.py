#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
统一每日签到主控 · run_all_checkin.py
════════════════════════════════════════════════════════════
一次运行顺序完成三套签到（均幂等，重复运行安全）：

  0. Trae 续期   node trae_keepalive.mjs        （token 临期才拉起客户端续期，否则秒过）
  1. WorkBuddy  pythonw signin.py silent-poll   （补签：未签才签 + 成长中心）
  2. Qoder      pythonw qoder_checkin.py silent （10:00 额度刷新后可领；查不到活动时本次运行内重查）
  3. Trae CN    node trae_checkin_api.mjs       （纯 API，本地当日去重）

Trae 续期排在签到之前：客户端只在 token 临期/过期时才续期，过期后再签只会反复
LOGIN_REQUIRED，所以先给一次续期机会，同一次运行里就能补上当天签到。

配套计划任务 AllAutoCheckin：每天 10:20 主跑（Qoder 10:00 刷新后）+ 12:20 / 14:20 收旅行礼物
+ 15:00 / 20:30 兜底。各套自身的明细日志写入各自文件（signin.log / qoder_checkin.log /
trae_checkin.log / trae_keepalive.log），本脚本额外把汇总结果写一行 JSON 到 all_checkin.log。

退出码：0=三套全部成功/已签，1=任一套失败或需要重新登录。

需要重新登录也算非零：凭据过期只在日志里留痕，任务计划程序仍显示"成功"，
断签就没人发现（2026-10-29 ~ 11-01 Trae token 过期连续四天）。
"""
import json
import os
import subprocess
import sys
import time

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

HERE = os.path.dirname(os.path.abspath(__file__))
LOG_FILE = os.path.join(HERE, "all_checkin.log")
CREATE_NO_WINDOW = 0x08000000  # pythonw 无控制台，防止子进程弹新窗口

# node 子进程必须剔除 Electron 宿主注入的变量，否则 Trae 脚本链路受干扰
# （ELECTRON_RUN_AS_NODE 会让 Electron 应用以纯 Node 启动）
def clean_env():
    env = dict(os.environ)
    env.pop("ELECTRON_RUN_AS_NODE", None)
    env.pop("NODE_OPTIONS", None)
    return env


def find_node():
    cands = [
        r"C:\Program Files\nodejs\node.exe",
        os.path.join(os.environ.get("LOCALAPPDATA", ""), "Programs", "nodejs", "node.exe"),
        r"C:\Program Files (x86)\nodejs\node.exe",
    ]
    for c in cands:
        if c and os.path.isfile(c):
            return c
    return "node"


def run_step(name, cmd, timeout, env=None, code_map=None):
    """返回 (result, detail)。result: ok / login_required / fail

    各脚本的退出码语义不同（签到脚本 2=今日已签，续期脚本 2=读不到凭据），
    故按步骤传入 code_map；未列出的退出码一律记 fail。
    """
    codes = code_map or {0: "ok", 2: "ok", 3: "login_required"}
    t0 = time.time()
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout,
                           cwd=HERE, env=env or os.environ,
                           creationflags=CREATE_NO_WINDOW)
        dt = int(time.time() - t0)
        tail = (p.stdout or "").strip().splitlines()
        tail = [l for l in tail if l.strip()][-2:]
        detail = " | ".join(tail)[:200] or f"exit={p.returncode}"
        if p.returncode in codes:
            return codes[p.returncode], f"exit={p.returncode} {dt}s {detail}"
        return "fail", f"exit={p.returncode} {dt}s {detail}"
    except subprocess.TimeoutExpired:
        return "fail", f"timeout>{timeout}s"
    except Exception as e:
        return "fail", f"{type(e).__name__}: {e}"


def bj():
    return time.strftime("%Y-%m-%d %H:%M:%S", time.gmtime(time.time() + 8 * 3600))


# ── 明细汇入：各系统日志本次运行新增的行原样搬进 all_checkin.log ─────────
# 各系统脚本仍写各自原生日志（signin.py 是上游代码不动），主控负责搬运，
# all_checkin.log 由此成为"总览 + 三套明细"的唯一查看入口。
SYSTEM_LOGS = {
    "TraeToken": os.path.join(HERE, "trae_keepalive.log"),
    "WorkBuddy": os.path.join(HERE, "signin.log"),
    "Qoder": os.path.join(HERE, "qoder_checkin.log"),
    "TraeCN": os.path.join(HERE, "trae_checkin.log"),
}
# signin.py 每轮写的"待人工"快照（空也写，做完自然清空）
PENDING_FILE = os.path.join(HERE, ".pending_manual.json")


def _file_size(path):
    try:
        return os.path.getsize(path)
    except OSError:
        return 0


def _new_text(path, offset):
    """读取 path 从 offset 字节起的新增内容（文件变小视为轮转，整读）。"""
    try:
        size = os.path.getsize(path)
        with open(path, "rb") as fh:
            fh.seek(offset if offset <= size else 0)
            return fh.read().decode("utf-8", "replace")
    except OSError:
        return ""


def ship_detail(system, offset):
    """把 system 日志自 offset 起的新增行汇入 all_checkin.log，返回新 offset。"""
    path = SYSTEM_LOGS[system]
    new_offset = _file_size(path)
    lines = []
    for line in _new_text(path, offset).splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
            if isinstance(obj, dict) and not obj.get("script"):
                obj["script"] = "signin"  # signin.log 的行无 script 字段，补归属
            lines.append(json.dumps(obj, ensure_ascii=False))
        except ValueError:
            lines.append(json.dumps({"script": "signin", "raw": line[:200]}, ensure_ascii=False))
    if lines:
        try:
            with open(LOG_FILE, "a", encoding="utf-8") as fh:
                fh.write("\n".join(lines) + "\n")
        except Exception as e:
            print("⚠️ 明细汇入失败: %s" % e)
    return new_offset


def last_manual_pending():
    """读 signin.py 落下的待人工项（已接单但进度没满、需真人动手的任务）。

    不能从 signin.log 里捞：轮询空跑不写日志行，日志里只会是上一次真正落盘的内容。
    只认当天的快照，过期的一律忽略，避免拿几天前的清单说事。
    """
    try:
        with open(PENDING_FILE, encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, ValueError):
        return []
    if not isinstance(data, dict):
        return []
    if not str(data.get("savedAt") or "").startswith(bj()[:10]):
        return []
    items = data.get("items")
    return items if isinstance(items, list) else []


def main():
    py = sys.executable  # pythonw 下即 pythonw.exe
    node = find_node()
    steps = [
        # Trae 续期：token 临期/过期时拉起客户端，等待复核最长 90s；充裕时秒过。
        # 退出码 2 在此脚本里是"读不到凭据"，等价于需要人工打开客户端。
        {"name": "TraeToken", "cmd": [node, os.path.join(HERE, "trae_keepalive.mjs"), "--timeout", "90"],
         "timeout": 150, "env": clean_env(), "codes": {0: "ok", 2: "login_required"}},
        {"name": "WorkBuddy", "cmd": [py, os.path.join(HERE, "signin.py"), "silent-poll"], "timeout": 420, "env": None},
        {"name": "Qoder", "cmd": [py, os.path.join(HERE, "qoder_checkin.py"), "silent"], "timeout": 120, "env": None},
        # TraeCN 服务端繁忙时有退避重试（最长约 90s + 请求耗时），放宽超时
        {"name": "TraeCN", "cmd": [node, os.path.join(HERE, "trae_checkin_api.mjs"), "--trigger", "schedule"],
         "timeout": 300, "env": clean_env()},
    ]

    print("=" * 56)
    print("  🤖 统一每日签到  %s" % bj())
    print("=" * 56)

    results = []
    for step in steps:
        name = step["name"]
        offset = _file_size(SYSTEM_LOGS[name])  # 运行前记录各系统日志位置
        result, detail = run_step(name, step["cmd"], step["timeout"], step["env"], step.get("codes"))
        ship_detail(name, offset)               # 运行后把新增明细搬进 all_checkin.log
        mark = "✅" if result == "ok" else ("🔑" if result == "login_required" else "❌")
        print("  %s %-10s %s" % (mark, name, detail))
        results.append({"name": name, "result": result, "detail": detail})

    ok = sum(1 for r in results if r["result"] == "ok")
    lr = sum(1 for r in results if r["result"] == "login_required")
    bad = sum(1 for r in results if r["result"] == "fail")
    print("-" * 56)
    print("  成功 %d · 需登录 %d · 失败 %d" % (ok, lr, bad))
    if lr:
        for r in results:
            if r["result"] == "login_required":
                print("  🔑 %s 需要重新登录：打开一次对应客户端即可恢复" % r["name"])

    pending = last_manual_pending()
    if pending:
        print("  📌 待人工：%s" % "、".join(
            "%s %s" % (p.get("title") or p.get("code"), p.get("progress")) for p in pending))

    try:
        with open(LOG_FILE, "a", encoding="utf-8") as fh:
            fh.write(json.dumps({
                "time": bj(), "script": "run_all_checkin", "trigger": "schedule",
                "summary": {"ok": ok, "login_required": lr, "failed": bad},
                "results": results,
                **({"pending_manual": pending} if pending else {}),
            }, ensure_ascii=False) + "\n")
    except Exception as e:
        print("⚠️ 汇总日志写入失败: %s" % e)

    return 0 if (bad == 0 and lr == 0) else 1


if __name__ == "__main__":
    sys.exit(main())
