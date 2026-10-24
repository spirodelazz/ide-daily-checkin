#!/usr/bin/env python3
"""成长中心连签保活：每天用无头 CLI 跑一次极简会话。

为什么不用"拉起客户端"：成长中心连签只跟随当天的**真实使用**（一次 AI 会话）。
客户端启动、常驻、程序化置前、强制重启都不记账 —— 2026-10-22 ~ 10-24 连续三天实测：
脚本杀进程重启、窗口置前、保持可见 90 秒，连签天数一次都没动；
而同一天只要本人打开窗口说一句话，天数立刻 +1。

做法：
  1. 读桌面端凭证里的 accessToken，注入 CODEBUDDY_AUTH_TOKEN 给 CLI
  2. 用 node 跑 `codebuddy -p "回复ok" --tools ""`，即一次真实的一次性会话
  3. 跑完用探针复核连签天数是否增长，增长则写入 .streak_state.json

退出码：
  0  连签已记账（或今天此前已被记过账）
  2  拿不到可用凭证（需要打开客户端刷新登录态）
  3  会话跑了但连签没涨
  4  CLI 执行失败（node / codebuddy 找不到或报错）
"""

import glob
import json
import os
import random
import re
import socket
import subprocess
import sys
import time
from datetime import datetime, timedelta

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, SCRIPT_DIR)

import signin  # noqa: E402  复用凭证解密与探针逻辑

STATE_FILE = os.path.join(SCRIPT_DIR, ".streak_state.json")
LOG_FILE = os.path.join(SCRIPT_DIR, "streak_warmup.log")
PROBE = os.path.join(SCRIPT_DIR, "probe_streak.py")

PROMPT = "回复ok"
CLI_TIMEOUT = 180           # 单次 CLI 会话的超时
VERIFY_TRIES = 3            # 每次会话后复探次数
VERIFY_INTERVAL = 30        # 复探间隔（服务端记账可能有延迟）
MAX_ROUNDS = 2              # 整轮（跑会话 + 复探）最多执行次数
STATE_FRESH_DAYS = 2        # 状态文件最多往回看几天才用于"今天已被记账"判断


def log(msg):
    line = "[%s] %s" % (datetime.now().strftime("%Y-%m-%d %H:%M:%S"), msg)
    try:
        with open(LOG_FILE, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except OSError:
        pass
    # pythonw.exe 下 sys.stdout 为 None，不能直接 print
    if sys.stdout is not None:
        try:
            print(line)
        except (OSError, ValueError):
            pass


def read_state():
    try:
        with open(STATE_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def write_state(days, result, ok):
    data = {
        "date": datetime.now().strftime("%Y-%m-%d"),
        "days": days,
        "result": result,
        "ok": bool(ok),
        "verifiedAt": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
    }
    try:
        with open(STATE_FILE, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
    except OSError as e:
        log("写状态文件失败: %s" % e)


def python_console_exe():
    """探针需要能往管道写 stdout：pythonw.exe 下子进程的 sys.stdout 是 None。"""
    exe = sys.executable
    if os.name == "nt" and exe.lower().endswith("pythonw.exe"):
        cand = exe[: -len("pythonw.exe")] + "python.exe"
        if os.path.exists(cand):
            return cand
    return exe


def probe_days():
    """返回连签天数，读失败返回 None。"""
    try:
        p = subprocess.run(
            [python_console_exe(), PROBE, "--days"],
            capture_output=True, text=True, encoding="utf-8",
            errors="replace", timeout=120,
        )
    except (OSError, subprocess.SubprocessError) as e:
        log("探针执行失败: %s" % e)
        return None
    m = re.search(r"days=(-?\d+)", p.stdout or "")
    if not m:
        log("探针输出无法解析: %r" % (p.stdout or "")[:120])
        return None
    days = int(m.group(1))
    return None if days < 0 else days


def find_node():
    home = os.path.expanduser("~")
    pat = os.path.join(home, ".workbuddy", "binaries", "node", "versions", "*", "node.exe")
    cands = sorted(glob.glob(pat))
    if cands:
        exe = cands[-1]
        # versions 目录下同时存在 "22.22.2-6" 与 "current"，current 是链接，优先真实版本目录
        try:
            return os.path.realpath(exe) if os.path.exists(exe) else None
        except OSError:
            return exe
    from shutil import which
    return which("node")


def find_cli():
    """定位 app.asar.unpacked/cli/bin/codebuddy。"""
    override = os.environ.get("WORKBUDDY_CLI")
    if override and os.path.exists(override):
        return override
    home = os.path.expanduser("~")
    local = os.environ.get("LOCALAPPDATA") or os.path.join(home, "AppData", "Local")
    roots = [
        os.environ.get("WORKBUDDY_HOME") or "",
        r"D:\WorkBuddy",
        r"C:\Program Files\WorkBuddy",
        os.path.join(local, "Programs", "WorkBuddy"),
        os.path.join(local, "WorkBuddy"),
    ]
    for root in roots:
        if not root:
            continue
        cand = os.path.join(root, "resources", "app.asar.unpacked", "cli", "bin", "codebuddy")
        if os.path.exists(cand):
            return cand
    return None


def free_port():
    for _ in range(20):
        port = random.randint(51000, 59000)
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            try:
                s.bind(("127.0.0.1", port))
                return port
            except OSError:
                continue
    return 0


def read_token():
    auth_file, looked_in = signin.find_auth_file()
    if not auth_file:
        log("找不到桌面端凭证，检查过: %s" % ", ".join(looked_in))
        return None
    try:
        session = signin.resolve_session(signin.load_session_retry(auth_file))
    except Exception as e:  # noqa: BLE001  凭证格式异常时只报错，不中断定时任务
        log("读取凭证失败: %s" % e)
        return None
    auth = session.get("auth") or {}
    token = auth.get("accessToken")
    if not token:
        log("凭证里没有 accessToken")
        return None
    expires_at = auth.get("expiresAt") or 0
    left_days = (expires_at / 1000.0 - time.time()) / 86400 if expires_at else None
    if left_days is not None and left_days < 0.5:
        log("accessToken 只剩 %.1f 天有效期，请打开客户端续期" % left_days)
        return None
    return token, left_days


def run_cli(node, cli, token, workdir):
    """跑一次一次性会话，返回 (ok, 耗时秒, 输出摘要)。"""
    try:
        os.makedirs(workdir, exist_ok=True)
    except OSError:
        pass
    env = dict(os.environ)
    env["CODEBUDDY_AUTH_TOKEN"] = token
    node_dir = os.path.dirname(node)
    env["PATH"] = node_dir + os.pathsep + env.get("PATH", "")
    # CREATE_NO_WINDOW：宿主是 pythonw，仍然明确不分配控制台窗口
    flags = 0x08000000 if os.name == "nt" else 0
    cmd = [node, cli, "-p", PROMPT, "--tools", "", "--port", str(free_port())]
    t0 = time.time()
    try:
        p = subprocess.run(
            cmd, cwd=workdir, env=env, capture_output=True,
            text=True, encoding="utf-8", errors="replace",
            timeout=CLI_TIMEOUT, creationflags=flags,
        )
    except subprocess.TimeoutExpired:
        log("CLI 超时（>%ds）" % CLI_TIMEOUT)
        return False, time.time() - t0, "timeout"
    except OSError as e:
        log("CLI 启动失败: %s" % e)
        return False, time.time() - t0, str(e)
    elapsed = time.time() - t0
    out = (p.stdout or "").strip()
    err = (p.stderr or "").strip()
    if "Authentication required" in out or "Authentication required" in err:
        log("CLI 鉴权失败：token 可能已失效，需打开客户端续期")
        return False, elapsed, "auth"
    if p.returncode != 0 or not out:
        log("CLI 异常 exit=%s out=%r err=%r" % (p.returncode, out[:160], err[:240]))
        return False, elapsed, "exit=%s" % p.returncode
    return True, elapsed, out.splitlines()[-1][:80]


def main():
    argv = sys.argv[1:]
    dry_run = "--dry-run" in argv

    log("=== 连签保活开始 ===")
    state = read_state()
    today = datetime.now().date()
    if state and state.get("date") == today.strftime("%Y-%m-%d") and state.get("ok") and not dry_run:
        log("今天已校验通过（days=%s，%s），无需处理" % (state.get("days"), state.get("verifiedAt")))
        return 0

    baseline = probe_days()
    log("连签基线 days=%s" % baseline)

    # 状态文件显示今天此前已被记过账（基线已经涨过）→ 不必再跑会话
    if baseline is not None and state and not dry_run:
        try:
            state_date = datetime.strptime(state.get("date", ""), "%Y-%m-%d").date()
            fresh = 0 <= (today - state_date).days <= STATE_FRESH_DAYS
            if fresh and baseline > (state.get("days") or 0):
                log("今天已被记账（基线 %s > 上次 %s），跳过会话" % (baseline, state.get("days")))
                write_state(baseline, "already", True)
                return 0
        except (ValueError, TypeError):
            pass

    tok = read_token()
    if not tok:
        return 2
    token, left_days = tok
    log("凭证可用%s" % ("（剩 %.1f 天）" % left_days if left_days is not None else ""))

    node = find_node()
    cli = find_cli()
    if not node or not cli:
        log("找不到 node（%s）或 codebuddy CLI（%s）" % (node, cli))
        return 4
    log("node=%s" % node)
    log("cli=%s" % cli)

    workdir = os.path.join(os.path.expanduser("~"), ".workbuddy", "streak-warmup")
    if dry_run:
        log("[DryRun] 将执行: %s %s -p %s --tools '' --port <随机>" % (node, cli, PROMPT))
        return 0

    last = baseline
    for rnd in range(1, MAX_ROUNDS + 1):
        if rnd > 1:
            log("第 %d 轮" % rnd)
        ok, elapsed, digest = run_cli(node, cli, token, workdir)
        if not ok:
            if digest == "auth":
                return 2
            if rnd == MAX_ROUNDS:
                return 4
            continue
        log("会话完成，耗时 %.1fs，回复: %s" % (elapsed, digest))

        for i in range(VERIFY_TRIES):
            if i:
                time.sleep(VERIFY_INTERVAL)
            days = probe_days()
            if days is None:
                continue
            last = days
            log("复探 days=%s" % days)
            if baseline is None:
                write_state(days, "unbaselined", True)
                log("基线缺失，按本次读数记录 days=%s（无法判定是否增长）" % days)
                return 0
            if days > baseline:
                write_state(days, "cli", True)
                log("✅ 连签已记账 days=%s → %s" % (baseline, days))
                return 0

    log("❌ %d 轮会话后连签仍是 days=%s（基线 %s），机制可能无效" % (MAX_ROUNDS, last, baseline))
    write_state(last, "no-growth", False)
    return 3


if __name__ == "__main__":
    sys.exit(main())
