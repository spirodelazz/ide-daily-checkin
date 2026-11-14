---
doc-type: how-to
reader: 查看、修改或卸载 WorkBuddy 本地定时任务的人
asof: 2026-11-14
---

# WorkBuddy 本地定时任务（Windows 任务计划程序）

> `signin.py` 收录自上游 [88lin/workbuddy-auto-signin](https://github.com/88lin/workbuddy-auto-signin)，本仓库通过统一主控 `AllAutoCheckin` 以 `silent-poll` 模式调用它。
> 本机只注册两个任务：`AllAutoCheckin`（WorkBuddy 签到 + 成长中心在其中一步）与 `WorkBuddyStreakWarmup`（连签保活）。总览见 [README.md](README.md)。

## 原理

```
桌面端登录 → 写入加密凭据（%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\workbuddy-desktop.info）
    ↓ 每日定时
run_all_checkin.py → signin.py silent-poll
    ├─ find_workbuddy_runtime() 定位客户端 → _run_auth_helper() 原生接口解密会话
    ├─ 查询签到状态 → 未签则领取（幂等）→ 成长中心全套（补登卡每轮限用 1 张、抽奖每轮限 1 次）
    ├─ 自设时间预算（轮询 180s，小于主控 420s 的单步时限，保证总能走到写日志）
    └─ 网络退避重试（5 / 15 / 30 / 60 / 90s）→ signin.log → 汇入 all_checkin.log
```

凭据不落盘：运行时拉起客户端安装目录里的 runtime 辅助进程解密磁盘上的凭据文件，GUI 无需正在运行。会话失效时在桌面端重新登录即可，脚本会自动重新探测，无需手工提取。客户端升级不改凭据路径与格式（当前 `sym-v1`），`signin.py doctor` 可随时复核运行时与凭据是否仍被识别。

## 任务总览

| 任务名 | 用途 | 触发计划 | 执行命令 | 时限 | 隐藏 |
|---|---|---|---|---|---|
| `AllAutoCheckin` | 三套签到统一入口，WorkBuddy 是其中一步 | 每天 **10:20** 主跑，**12:20 / 14:20** 收旅行礼物，**15:00 / 20:30** 兜底 | `pythonw.exe run_all_checkin.py`（内部 `pythonw.exe signin.py silent-poll`） | 20 分钟（单步 420s） | 是 |
| `WorkBuddyStreakWarmup` | 每天跑一次无头会话，保成长中心连签 | 每天 **10:00**，失败当日 **18:00** 重试 | `pythonw.exe streak_warmup.py` | 10 分钟 | 否 |

时区约定：触发器 `StartBoundary` 填的是本地时间（`+08:00`），任务 XML 内部存 UTC（10:20 → `02:20:00Z`），改时间时按本地时间填。

### 单系统任务（未注册）

上游 `install-windows.ps1` 会注册两个只跑 WorkBuddy 的任务：`WorkBuddyAutoSignin`（每天 00:05）与 `WorkBuddyGrowthPoll`（每天 01/05/09/13/17/21 点）。本机**没有注册它们**，WorkBuddy 签到由 `AllAutoCheckin` 承担；两者同时存在时同一时点会重复触发，`-MultipleInstances IgnoreNew` 只能挡住同名任务自身的并发。

要单独开启整点高频轮询，直接用上游的 `install-windows.ps1` 注册（它会覆盖同名任务），或参照上文 `AllAutoCheckin` 的五个时点给自己的任务加触发器；两种方式都不要再动统一任务里的 WorkBuddy 那一步。

## 签到与成长中心：自动领哪些、哪些领不到

`silent-poll` 一轮的顺序固定（旅行 → 任务 → 补登 → 连登兑换 → 抽奖 → Buddy 盲盒 → 状态回读），各段独立 try，一段失败不影响其余：

| 项目 | 自动处理 | 说明 |
|---|---|---|
| 每日签到 +100 积分 | ✅ | 未签才领，重复运行不会多领 |
| 派 Buddy 出发旅行 | ✅ | 当日名额用完即止，不再空撞接口 |
| 旅行礼物 | ✅ | 只在 Buddy **到达后**可领，到达时间由目的地决定（2~4 小时）。主跑 10:20 派出后由 12:20 / 14:20 两轮接住，界面上的待领取最长挂约 2 小时 |
| 任务接单 | ✅ | `accept_status=not_accepted` 自动接单 |
| 任务领奖 | ✅ | 只有 `completed` 才发奖，逐条走 `/tasks/{code}/claim` |
| 断登补登 | ✅ | 有可补日期且卡有余量时补，**每轮最多 1 张** |
| 连登兑换 | ✅ | 7d / 14d / 28d 三档，`locked` 档位跳过 |
| 盲盒抽奖 | ✅ | **每轮最多 1 次**，剩余次数留给下一轮 |
| 能量开 Buddy 盲盒 | ✅ | 能量 < `cost_per_open`（当前 10）时开不动，等能量攒够 |
| 需要真人动作的任务 | ❌ | 脚本只能接单，例如「分享一个技能给好友」进度停在 0/1；标题、进度、截止时间与入口写进日志 `manual_pending` |
| 实物奖收件信息 | ❌ | 中奖后日志提示「需到成长中心填写收件信息」，脚本不代填 |

**待人工项不是静默的**：每轮都会把"已接单但进度没满"的任务挑出来，同时写到三个地方——`signin.log` 的 `manual_pending` 字段（含 `title` / `progress` / `deadline` / `open` 入口）、`.pending_manual.json` 快照（空列表也写，做完自动清空）、`all_checkin.log` 汇总行的 `pending_manual`。查看：

```powershell
# 汇总行里的待人工项
Get-Content scripts\all_checkin.log -Tail 1 | ConvertFrom-Json | Select-Object -ExpandProperty pending_manual

# 明细快照（含截止时间与入口）
Get-Content scripts\.pending_manual.json -Raw | ConvertFrom-Json | Select-Object -ExpandProperty items
```

快照独立于日志：轮询空跑不写日志行，只靠日志会丢掉最新状态，所以每轮都重写这个文件。

这里刻意只做汇报、不做代领：`skill_share` 这类任务的判定前提是「真的把技能分享给了某个人」，脚本补一个上报请求等于伪造社交行为，比漏领 100 积分更糟。

因此**成长中心里始终可能留有未被自动领取的项**，都属预期：真人任务（脚本无权代做）、能量不足、档位未解锁、抽奖次数为 0、旅行还在路上。判断脚本是否正常，看 `signin.log` 的 `growth_result` 是否为 `GROWTH`、有没有「失败」字样，而不是看界面有没有红点。

## 两个「连签」不是同一个数

| 名称 | 数据来源 | 增长条件 |
|---|---|---|
| 签到连签 | `/v2/billing/meter/checkin-activity-status` 的 `streak_days` | 每天完成签到即 +1，断一天从头计 |
| 成长中心连签 | `/v2/activity/growth/streak` 的 `streak.days` | 当天有一次**真实 AI 会话**才 +1 |

客户端的「成长计划 / 成长中心」页显示的是**后者**，与签到无关，一天只涨 1，28 天档要攒满才解锁。两者各自累加、数值通常不等，对不上属正常，别当成断签。

### WorkBuddyStreakWarmup（连签保活）

成长中心连签跟随的是**当天有一次真实使用**（一次 AI 会话），与客户端是否运行无关。2026-10-22 ~ 10-24 三天实测：

| 日期 | 脚本动作 | 当日连签变化 |
|---|---|---|
| 10-22 | 结束进程 + 重新拉起，窗口可见 61 秒 | 三次读数全是 21，一整天没动 |
| 10-23 | 无动作 | 15:00 还是 0，19:18 本人开口说话后变 1 |
| 10-24 | 置前 + 两轮结束进程重启，可见 90 秒 | 10:00–10:20 全是 1，11:56 本人开始对话后变 2 |

启动、常驻、每日 03:02 自启、程序化置前、强制重启都不记账；`signin.py` 调 API 也代替不了（`/v2/activity/growth/` 下没有打卡接口）。保活脚本因此用无头 CLI 造一次真实会话：

```
桌面端凭据（CodeBuddyExtension/Data/Public/auth/workbuddy-desktop.info）
    ↓ 解出 accessToken（复用 signin.py 的解密逻辑）
CODEBUDDY_AUTH_TOKEN=<token> node <客户端>\resources\app.asar.unpacked\cli\bin\codebuddy
    -p "回复ok" --tools "" --port <随机>
    ↓ 一次真实的一次性会话（约 6–8 秒，禁用全部工具，不读写任何文件）
probe_streak.py --days 复核天数是否增长 → 写 .streak_state.json
```

- 触发：每天 **10:00**，同日 **18:00** 再试一次（10:00 成功的话 18:00 会直接短路退出），`StartWhenAvailable=true`，时限 10 分钟
- 判定顺序：
  1. `.streak_state.json` 是今天的且 `ok=true` → 直接退出（当天已成功，18:00 那次就靠这个跳过）
  2. `probe_streak.py --days` 读基线
  3. 基线已经比上次记录的大 → 今天此前已被本人记过账，跳过会话，直接记 `ok=true`
  4. 读 accessToken（剩余有效期不足 0.5 天则退出码 2，提示打开客户端续期）
  5. 跑 CLI 会话，随后每 30 秒复探、最多 3 次；天数大于基线即成功
  6. 没涨就再跑一轮；两轮仍没涨退出码 3（说明这条机制不成立，需要重新判断）
- 退出码：`0` 已记账或今天已记过账 / `2` 无可用凭证 / `3` 会话跑了但天数没涨 / `4` CLI 找不到或执行失败
- 全程不触碰桌面客户端进程，也不抢占焦点或窗口
- 手动预演（只打印将要执行什么）：`python scripts\streak_warmup.py --dry-run`
- 手动实跑（真跑一次会话）：`python scripts\streak_warmup.py`
- 注册命令（`<仓库路径>` 换成实际位置，`<pythonw>` 换成 `pythonw.exe` 的绝对路径）：

```powershell
$action = New-ScheduledTaskAction -Execute '<pythonw>' -Argument '"<仓库路径>\scripts\streak_warmup.py"' -WorkingDirectory '<仓库路径>\scripts'
$t1 = New-ScheduledTaskTrigger -Daily -At 10:00
$t2 = New-ScheduledTaskTrigger -Daily -At 18:00
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 10)
Register-ScheduledTask -TaskName 'WorkBuddyStreakWarmup' -Action $action -Trigger @($t1,$t2) -Settings $settings -Force
```

CLI 的定位规则（`scripts\streak_warmup.py` 内）：环境变量 `WORKBUDDY_CLI` 优先，其次是 `WORKBUDDY_HOME`、`D:\WorkBuddy`、`C:\Program Files\WorkBuddy`、`%LOCALAPPDATA%\Programs\WorkBuddy` 下的 `resources\app.asar.unpacked\cli\bin\codebuddy`。node 取 `~/.workbuddy/binaries/node/versions/*/node.exe` 中最新的一个，没有再退回 PATH。

bundle 变体按发行版实际产物选择：`dist\codebuddy-headless.js` 或 `dist\codebuddy.js` 存在时用入口的默认分派；只有 `dist\codebuddy-lite-wb.mjs` 时（WorkBuddy 定制精简包，2026-10 起，5.11.x 仍是这个布局）必须设 `CODEBUDDY_FORCE_LITE_WB_BUNDLE=1`，否则 `bin\codebuddy` 带 `-p` 会分派到 headless 产物并报 `Cannot find module '../dist/codebuddy'`。

### 公共设置

- **错过补跑**：`StartWhenAvailable=true`，关机/睡眠错过的时点开机后会补跑
- **静默运行**：用 `pythonw.exe` 启动，无任何窗口弹出
- **防重复**：`MultipleInstancesPolicy=IgnoreNew`，上一轮没跑完不会叠加新实例
- **运行身份**：当前用户（InteractiveToken，最低权限），电池供电也照常运行
- **隐藏**：`AllAutoCheckin` 带 `-Hidden`，任务计划程序默认不显示；`WorkBuddyStreakWarmup` 不带，始终可见

### 完整执行命令

`pythonw.exe` 的绝对路径由安装脚本在本机探测（PATH → 同目录 → `C:\Python3*` 等通配位置），形如：

```
统一任务:  <pythonw.exe 绝对路径>  "scripts\run_all_checkin.py"
其中一步:  <pythonw.exe 绝对路径>  "scripts\signin.py" silent-poll
保活任务:  <pythonw.exe 绝对路径>  "scripts\streak_warmup.py"
```

## 查看 / 管理方式

### 方式一：图形界面（任务计划程序）

1. 按 `Win + R`，输入 `taskschd.msc` 回车（或开始菜单搜「任务计划程序」）
2. 左侧点「任务计划程序库」
3. **关键一步**：`AllAutoCheckin` 带 `-Hidden` 属性默认不可见 —— 菜单栏「查看(V)」→ 勾选**「显示隐藏的任务」**，列表里才会出现：
   - `AllAutoCheckin`（每天 10:20 主跑，12:20 / 14:20 收旅行礼物，15:00 / 20:30 兜底）
   - `WorkBuddyStreakWarmup`（每天 10:00 连签保活，18:00 重试位，始终可见）
4. 双击任一任务可查看触发器、历史记录；右键「运行」可手动触发一次

### 方式二：命令行

```powershell
# 看两个任务是否存在、状态
Get-ScheduledTask -TaskName 'AllAutoCheckin','WorkBuddyStreakWarmup' | Select-Object TaskName, State

# 看下次运行时间 / 上次运行结果
Get-ScheduledTaskInfo -TaskName 'AllAutoCheckin'
Get-ScheduledTaskInfo -TaskName 'WorkBuddyStreakWarmup'

# 手动立即触发一次（等同图形界面右键「运行」）
Start-ScheduledTask -TaskName 'AllAutoCheckin'
```

### 方式三：翻日志（最直观）

```powershell
Get-Content scripts\all_checkin.log -Tail 5     # 统一汇总（WorkBuddy 明细也汇入这里）
Get-Content scripts\signin.log -Tail 5          # 只看 WorkBuddy 签到与成长中心

# 查成长中心连签状态（连签天数 / 补登卡余额 / 可补日期 / 兑换档位）
python scripts\probe_streak.py

# 只看连签天数（保活脚本内部用的形式）
python scripts\probe_streak.py --days

# 连签保活的会话与复核过程
Get-Content scripts\streak_warmup.log -Tail 20

# 凭据与运行时体检
python scripts\signin.py doctor
```

日志每行一条 JSON，关键字段：`result`（CLAIMED=签到成功 / ALREADY=已签过）、`streak_days` 签到连签天数、`total_credits` 累计积分、`growth_result`（GROWTH=成长中心跑完）、`trigger: "poll"` 表示由轮询触发。

`streak_warmup.log` 是纯文本时间线，每次保活记录基线、会话耗时与回复、复探读数；`.streak_state.json` 用 `date` / `days` / `result` / `ok` 四个字段标记当天是否已达标。

## 常见问题

| 现象 | 原因与处理 |
|---|---|
| 00:00~10:20 之间看客户端显示「今日未签到」 | 正常。签到发生在主跑 10:20（15:00 / 20:30 兜底），零点不跑 |
| 成长中心仍有未领取项 | 见上文「自动领哪些」表：真人任务、能量不足、档位未解锁、抽奖次数为 0、旅行在途，均属预期 |
| 连签天数与签到天数对不上 | 两个独立计数，见上文对照表 |
| `AUTH_ERROR` / `NO_AUTH` | 桌面端重新登录后跑 `python scripts\signin.py doctor` 复核 |
| 客户端升级后签到失败 | 先跑 `doctor` 看 `runtime` 与 `credential_format` 是否仍被识别；升级不改凭据路径，失败多为登录态失效 |
| 保活日志报 `Cannot find module '../dist/codebuddy'` | 新版只剩 lite 产物，须设 `CODEBUDDY_FORCE_LITE_WB_BUNDLE=1`（脚本已自动判断） |

## 相关文件

| 路径 | 说明 |
|---|---|
| `scripts\signin.py` | 主脚本（签到 + 成长中心），收录自上游 [88lin/workbuddy-auto-signin](https://github.com/88lin/workbuddy-auto-signin)（MIT） |
| `scripts\streak_warmup.py` | 连签保活：读 accessToken → 跑一次无头 CLI 会话 → 探针复核天数 → 记录状态 |
| `scripts\probe_streak.py` | 只读探针：查询成长中心连签状态（`/v2/activity/growth/streak`），`--days` 输出供脚本解析 |
| `scripts\run_all_checkin.py` | 统一主控：Trae 续期 → WorkBuddy / Qoder / Trae 签到 → 汇总 |
| `scripts\.streak_state.json` | 状态文件：记录最近一次运行日期、连签天数与是否达标 `ok`（本地生成，不入库） |
| `scripts\.pending_manual.json` | 待人工任务快照：`savedAt` + `items`（标题、进度、截止时间、入口），每轮重写（本地生成，不入库） |
| `scripts\signin.log` / `scripts\streak_warmup.log` | 签到明细 / 保活时间线（前者汇入 `all_checkin.log`） |
| `C:\Windows\System32\Tasks\AllAutoCheckin` / `...\WorkBuddyStreakWarmup` | 任务定义 XML（系统内部存储，只读参考） |

## 卸载 / 停用

```powershell
# 删除
Unregister-ScheduledTask -TaskName "AllAutoCheckin" -Confirm:$false
Unregister-ScheduledTask -TaskName "WorkBuddyStreakWarmup" -Confirm:$false

# 仅临时停用
Disable-ScheduledTask -TaskName "AllAutoCheckin"
Disable-ScheduledTask -TaskName "WorkBuddyStreakWarmup"
```

也可在任务计划程序里右键对应任务选择「删除」或「禁用」。
