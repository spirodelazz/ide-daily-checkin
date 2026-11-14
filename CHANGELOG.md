# Changelog

## 2026-11-14

### Added

- `signin.py` 每轮扫 `/growth/tasks`，把「已接单但进度未满」的任务写进日志字段 `manual_pending`（`code` / `title` / `progress` / `deadline` / `open` 入口）与快照 `.pending_manual.json`，报告末尾追加「待人工：…」；`run_all_checkin.py` 读快照写进汇总行的 `pending_manual`，前台运行时同时打印一行。这类任务（如「分享一个技能给好友」）的判定前提是真人完成动作，脚本只汇报不代领

### Changed

- `AllAutoCheckin` 增加 12:20 / 14:20 两个 Daily 触发器：主跑 10:20 派出的 Buddy 要 2~4 小时才到达，原先只靠 15:00 那轮领旅行礼物，界面上待领取最长挂约 2.7 小时；`install-all-checkin.ps1` 同步注册五个时点（10:20 / 12:20 / 14:20 / 15:00 / 20:30）
- 重写 `workbuddy-scheduled-tasks.md`：任务总览改为实际注册的 `AllAutoCheckin`（10:20 主跑，12:20 / 14:20 收旅行礼物，15:00 / 20:30 兜底）与 `WorkBuddyStreakWarmup`（10:00 / 18:00）；上游 `WorkBuddyAutoSignin`（00:05）与 `WorkBuddyGrowthPoll`（01/05/09/13/17/21 点）标注为未注册，并给出可选的单独注册途径
- 新增「签到与成长中心：自动领哪些、哪些领不到」与「两个连签不是同一个数」两张表；README 功能特性、单系统部署说明与常见问题同步
- README 明确 WorkBuddy 单系统任务归上游 `install-windows.ps1` 注册，本仓库不收录该脚本，默认部署不注册它们

### Notes

- 2026-11-13 客户端升级到 5.11.3（Electron 37.10.3）后签到链路实测未受影响：11-14 10:20 签到 +100、签到连签 46 天；`signin.py doctor` 报 `AUTH_READY`（`credential_format=sym-v1`，runtime `D:\WorkBuddy\WorkBuddy.exe`）；连签保活 10:00 记账成功（13→14）。`cli\dist` 仍只有 `codebuddy-lite-wb.mjs`，`CODEBUDDY_FORCE_LITE_WB_BUNDLE=1` 分支继续生效
- 成长中心界面残留的未领取项不是故障：`skill_share` 一类任务需要真人操作（脚本只接单）、能量 8 < 开盒成本 10、28 天档未解锁、抽奖次数 0

## 2026-11-08

### Fixed

- Qoder 空活动列表被当成「今日已领取」：`run_account()` 在 `campaigns` 里查不到 `CLAIM_BENEFIT` 时归 `already`，而 `already` 在下游等价于成功（退出码 0、汇总 `ok`），于是 10:20 那轮既没领到也没重试、也没告警。11-08 当天据此漏签，靠手动补跑才领到 +100 Credits；10-20、11-01 的 10:20 同样命中，只是被 15:00 兜底轮次掩盖
- 空列表改判 `pending`，msg 附带本次连查次数；`already` 只保留「活动已 CLAIMED 且在 startAt~endAt 内」一种含义

### Added

- `run_account()` 在查不到 `CLAIM_BENEFIT` 活动时于本次运行内重查：默认 3 次、间隔 20 秒（`QODER_EMPTY_RETRY` / `QODER_EMPTY_WAIT` 可覆盖），活动列表抽出来后立即继续领取，不再干等到 15:00 兜底轮次
- `query_campaigns()`：把活动列表查询与 401 强刷重试抽成独立函数，重查与首次查询共用同一套 token 处理

### Notes

- 每日活动的 `startAt` 固定为 10:00（UTC+8），但接口在刷新前后会返回空列表；`claim` 本身幂等，重查不会重复发币

## 2026-11-01

### Fixed

- Trae 断签 4 天（10-29 ~ 11-01）：token 于 2026-10-29 02:42 过期后每次运行都只报 `LOGIN_REQUIRED`，而主控把 `login_required` 排除在失败之外，任务计划程序始终显示成功。根因是客户端**只在 token 剩 ≤300 秒或已过期时**才续期，10-16 ~ 10-23 的启动全在刷新窗口之外，10-24 之后再没打开过 Trae
- `run_all_checkin.py` 退出码把 `login_required` 计入失败（只有四步全成功才返回 0），并单独打印需要重新登录的系统
- `streak_warmup.py` 找不到 CLI 主 bundle：WorkBuddy 改版后 `cli\dist` 只剩 `codebuddy-lite-wb.mjs`，`bin\codebuddy` 带 `-p` 会分派到不存在的 `dist\codebuddy-headless`，报 `Cannot find module '../dist/codebuddy'`。改为按发行版实际产物选择 bundle 变体（`CODEBUDDY_FORCE_LITE_WB_BUNDLE=1`），并在入口与产物不匹配时给出可读提示

### Added

- `scripts\trae_keepalive.mjs`：token 剩余不足 3 天（或已过期）时拉起一次 Trae CN 触发客户端续期，再复核 `storage.json` 的 `expiredAt` 是否变新；客户端已在运行则跳过（它会在临期时自行刷新）
- `scripts\trae_auth.mjs`：把凭据读取（`storage.json` + 信封解密 + 设备号）抽成共用模块，签到与续期脚本共用
- `run_all_checkin.py` 新增首步 `TraeToken`——续期排在签到之前，同一次运行即可补上当天；`trae_keepalive.log` 一并汇入 `all_checkin.log`；`AllAutoCheckin` 时限由 15 分钟放宽到 20 分钟
- `trae_checkin_api.mjs` 每条日志记录 `tokenExpiresAt` / `tokenDaysLeft`，剩余不足 3 天时输出预警

### Notes

- 完全静默续期（不拉 GUI）需要 `POST /trae/api/v3/oauth/ExchangeToken` 的 `DeviceProof{Signature,Timestamp,Nonce}` 签名，密钥是安装时生成并存于 userStorage 的设备 RSA 私钥；该方案未实现，续期仍借助客户端完成

## 2026-10-24

### Changed

- 连签方案换向：不再拉起/重启客户端，改为每天用无头 CLI 跑一次极简会话。10-22 ~ 10-24 三天实测证伪了「启动/置前即记账」——脚本把客户端重启、窗口置前、保持可见 90 秒，连签天数一次没动；同期本人打开窗口说一句话，天数立刻 +1（10-23 19:18、10-24 11:56）。连签跟随的是当天的真实使用，与进程和焦点无关
- 新增 `scripts\streak_warmup.py`：解出桌面端 `accessToken` 并注入 `CODEBUDDY_AUTH_TOKEN`，用 `node` 跑 `resources\app.asar.unpacked\cli\bin\codebuddy -p "回复ok" --tools "" --port <随机>`，约 7–9 秒完成一次真实会话；随后每 30 秒复探、最多 3 次，天数增长即记为达标，最多两轮
- 任务 `WorkBuddyStreakLaunch`（10:00，时限 15 分钟）由 `WorkBuddyStreakWarmup`（10:00 + 18:00 重试，时限 10 分钟，宿主仍为 `pythonw.exe`）取代；状态文件的 `ok` 字段决定 18:00 那次是否短路
- 同日已记账时（基线比上次记录的天数大）跳过会话直接记达标，避免重复消耗；`accessToken` 剩余有效期不足 0.5 天时退出码 2 并提示打开客户端续期

### Removed

- `scripts\workbuddy_streak_launch.ps1`、`scripts\workbuddy_streak_launch.pyw`：拉起式守卫的整套窗口置前、杀进程、分离启动逻辑随方案作废（历史版本见 git）

### Notes

- 退出码：`0` 已记账或今天已记过账 / `2` 无可用凭证 / `3` 会话跑了但天数没涨 / `4` CLI 找不到或执行失败。`3` 连续出现说明这条机制不成立，需要重新判断连签的真实触发条件
- CLI 会话复用桌面端凭证，不新建登录；`--tools ""` 禁用全部工具，会话只做一次问答，不读写任何文件

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
