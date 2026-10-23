# Changelog

## 2026-10-23

### Fixed

- 连签守卫的判定前提错了：连签不认「客户端启动」，认的是「窗口在前台被刷新」。`main.log` 里 `[Checkin] refresh triggered by window focus / page visible` 是客户端的刷新入口；10-22 与 10-23 两次运行把窗口显示出来保持 60 秒但没抢到焦点，连签一整天没动，10-22 因此断签（10-23 探针 `days` 由 0 起算）
- 守卫新增置前步骤：`SetForegroundWindow` + `AttachThreadInput`，并用 `GetForegroundWindow` 逐次校验。实测程序抢到的焦点会让客户端打出与真人点击相同的 `refresh triggered by window focus` 日志
- 未记账时先尝试「只置前、不重启」，等 30 秒仍不记账才结束进程重新拉起；窗口可见时长 60 → 90 秒，复探 3 次 × 25 秒

## 2026-10-21

### Fixed

- 成长中心连签守卫形同虚设：客户端每天 03:02 自我重启后常驻，10:00 时 `Get-Process WorkBuddy` 必然命中，脚本直接 `exit 0` 什么都没做（`AppStartup.log` 里自 10-09 起没有任何 10:00 前后的启动记录）。2026-10-20 因当天没有真实登录，连签停在 19 天后归零
- `workbuddy_streak_launch.ps1` 改为「校验 → 重启 → 复核」：先读 `.streak_state.json` 判断当天是否已复核，再用 `probe_streak.py --days` 取基线，未记账则结束旧进程重新拉起、窗口保持可见 60 秒、每 20 秒复探最多 3 次，天数增长才写入状态；整套最多重来一次，失败退出码 3
- 主实例启动不足 3 分钟时先等 90 秒再接手，避免与登录握手抢跑；辅助/CLI 子进程的启动时间不再参与判断
- 拉起客户端改用分离式启动（`UseShellExecute=false` + `CreateNoWindow=true`）：`Start-Process` 会让客户端继承任务进程的标准句柄，客户端及其控制台子进程挂在任务计划程序的隐藏控制台上，脚本退出后控制台窗口不消失且被客户端日志持续刷屏；关掉该窗口会以 `STATUS_CONTROL_C_EXIT` 连带杀掉客户端
- 任务宿主由 `powershell.exe` 换成 `pythonw.exe`（`workbuddy_streak_launch.pyw` 转调守卫脚本）：前者是控制台程序，`-WindowStyle Hidden` 只在窗口创建后隐藏，启动瞬间仍会闪黑框；`pythonw.exe` 无控制台，再用 `CREATE_NO_WINDOW` 起 PowerShell，实测该子进程连隐藏的控制台窗口都没有
- `WorkBuddyStreakLaunch` 任务时限 10 → 15 分钟（两次尝试需要更长时间），同步更新任务描述

### Added

- `workbuddy_streak_launch.ps1 -DryRun`：只输出判定与日志，不结束进程、不拉起客户端
- `workbuddy_streak_launch.ps1 -MechanicsTest`：真重启一轮，只验证「结束进程 → 拉起 → 窗口出现 → 探针可读」，不判断天数、不写 state，结束后保留窗口便于观察
- `probe_streak.py --days`：只输出 `days=<n>` 供守卫脚本解析，读取失败为 `days=-1` 且退出码 1
- `workbuddy_streak_launch.pyw`：无控制台启动器，任务计划程序以 `pythonw.exe` 运行它，退出码沿用守卫脚本的返回值
- `scripts\streak_launch.log`：守卫的判定、重启、复核明细

### Notes

- 脚本含中文字符串，必须以 **UTF-8 with BOM** 保存，否则 Windows PowerShell 5.1 会按 ANSI 解析导致语法错误
- 守卫强制结束进程后，客户端会在 `~/.workbuddy/logs/Crash-Log/` 留一条 `crash-report-daemon-*.json`（sidecar `exitCode=-1`），属重启的预期副作用

## 2026-10-19

### Fixed

- Qoder 签到自 10-18 20:30 起 `login_required`：刷新接口返回结构变更（`token/accessToken/refreshToken` → `device_token`/`refresh_token`/`expires_at`），`do_refresh` 按旧字段解析失败
- `ensure_token` 此前刷新成功后用 `jwt_exp` 取到期时间，国内 `dt-` 令牌非 JWT 恒为 0，现优先取刷新响应的 `expires_at`
- refreshToken 轮换时 `persist` 回写匹配失效（新 rt 对文件内旧 rt 永不相等、国内账号 uid 为空）：`persist` 增加 `prev_rt` 参数按刷新前的 rt 匹配回写

## 2026-10-17

### Added

- WorkBuddy 连签守卫：Windows 计划任务 `WorkBuddyStreakLaunch`（每天 10:00，错过开机补跑），调用 `scripts/workbuddy_streak_launch.ps1` 在客户端未运行时静默拉起并隐藏主窗口，保住成长中心"连签"
- `scripts/probe_streak.py`：只读探针，查询成长中心连签状态（连签天数 / 补登卡余额 / 可补日期）

### Context

- 排查确认：WorkBuddy 签到积分（`billing/meter/daily-checkin`）运行正常，App 内显示的断签来自成长中心"连签"，该记录只认桌面客户端当天的登录行为，`signin.py` 调 API 无法代替
