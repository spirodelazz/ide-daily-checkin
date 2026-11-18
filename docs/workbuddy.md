# WorkBuddy 定时任务

`signin.py` 收录自上游 [88lin/workbuddy-auto-signin](https://github.com/88lin/workbuddy-auto-signin)，本仓库通过统一任务 `AllAutoCheckin` 以 `silent-poll` 模式调用它。

## 原理

```
桌面端登录 → 写入加密凭据（%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\workbuddy-desktop.info）
    ↓ 每日定时
run_all_checkin.py → signin.py silent-poll
    ├─ find_workbuddy_runtime() 定位客户端 → _run_auth_helper() 原生接口解密会话
    ├─ 查询签到状态 → 未签则领取（幂等）→ 成长中心（补登卡每轮限 1 张、抽奖每轮限 1 次）
    ├─ 自设时间预算（轮询 180s，小于主控 420s 的单步时限，保证总能走到写日志）
    └─ 网络退避重试（5 / 15 / 30 / 60 / 90s）→ signin.log → 汇入 all_checkin.log
```

凭据不落盘。运行时拉起客户端安装目录里的 runtime 辅助进程解密磁盘上的凭据文件，GUI 不必在运行。会话失效时在桌面端重新登录，脚本会自动重新探测，无需手工提取。客户端升级不改凭据路径与格式（当前 `sym-v1`），`signin.py doctor` 可随时复核运行时与凭据是否仍被识别。

## 任务

| 任务名 | 用途 | 触发 | 时限 | 隐藏 |
|---|---|---|---|---|
| `AllAutoCheckin` | 三套签到统一入口，WorkBuddy 是其中一步 | 10:20 主跑，12:20 / 14:20 收旅行礼物，15:00 / 20:30 兜底 | 20 分钟（单步 420s） | 是 |
| `WorkBuddyStreakWarmup` | 跑一次无头会话，保成长中心连签 | 10:00，失败当日 18:00 重试 | 10 分钟 | 否 |

触发器 `StartBoundary` 按本地时间填，任务 XML 内部存 UTC（10:20 对应 `02:20:00Z`）。

上游 `install-windows.ps1` 还会注册两个只跑 WorkBuddy 的任务：`WorkBuddyAutoSignin`（00:05）与 `WorkBuddyGrowthPoll`（01/05/09/13/17/21 点）。本仓库不收录该脚本，默认部署也不注册这两个任务，WorkBuddy 签到由 `AllAutoCheckin` 承担。两者同时存在会在同一时点重复触发，`-MultipleInstances IgnoreNew` 只能挡住同名任务自身的并发。需要整点高频轮询时，用上游脚本注册，或参照 `AllAutoCheckin` 的时点自建任务。

## 成长中心：自动领哪些、哪些领不到

`silent-poll` 一轮顺序固定：旅行 → 任务 → 补登 → 连登兑换 → 抽奖 → Buddy 盲盒 → 状态回读。各段独立 try，一段失败不影响其余。

| 项目 | 自动处理 | 说明 |
|---|---|---|
| 每日签到 +100 积分 | 是 | 未签才领，重复运行不会多领 |
| 派 Buddy 出发旅行 | 是 | 当日名额用完即止 |
| 旅行礼物 | 是 | 只在 Buddy 到达后可领，到达时间由目的地决定（2~4 小时）。10:20 派出后由 12:20 / 14:20 两轮接住 |
| 任务接单 | 是 | `accept_status=not_accepted` 自动接单 |
| 任务领奖 | 是 | 只有 `completed` 才发奖，逐条走 `/tasks/{code}/claim` |
| 断登补登 | 是 | 有可补日期且卡有余量时补，每轮最多 1 张 |
| 连登兑换 | 是 | 7d / 14d / 28d 三档，`locked` 档位跳过 |
| 盲盒抽奖 | 是 | 每轮最多 1 次，剩余次数留给下一轮 |
| 能量开 Buddy 盲盒 | 是 | 能量低于 `cost_per_open`（当前 10）时开不动 |
| 需要真人动作的任务 | 否 | 脚本只接单，例如「分享一个技能给好友」进度停在 0/1。标题、进度、截止时间与入口写进日志 `manual_pending` |
| 实物奖收件信息 | 否 | 中奖后日志提示到成长中心填写，脚本不代填 |

待人工项同时写到三个地方：`signin.log` 的 `manual_pending` 字段（含 `title` / `progress` / `deadline` / `open`）、`.pending_manual.json` 快照（空列表也写，做完自动清空）、`all_checkin.log` 汇总行的 `pending_manual`。快照独立于日志，因为轮询空跑不写日志行，只靠日志会丢掉最新状态。

```powershell
# 汇总行里的待人工项
Get-Content scripts\all_checkin.log -Tail 1 | ConvertFrom-Json | Select-Object -ExpandProperty pending_manual

# 明细快照（含截止时间与入口）
Get-Content scripts\.pending_manual.json -Raw | ConvertFrom-Json | Select-Object -ExpandProperty items
```

`skill_share` 这类任务的判定前提是真的把技能分享出去，脚本补一个上报请求等于伪造社交行为，因此只汇报不代领。成长中心里留下未领取的项属于预期：真人任务、能量不足、档位未解锁、抽奖次数为 0、旅行在途。判断脚本是否正常，看 `signin.log` 的 `growth_result` 是否为 `GROWTH`、有没有「失败」字样，不看界面有没有红点。

## 两个「连签」不是同一个数

| 名称 | 数据来源 | 增长条件 |
|---|---|---|
| 签到连签 | `/v2/billing/meter/checkin-activity-status` 的 `streak_days` | 每天完成签到即 +1，断一天从头计 |
| 成长中心连签 | `/v2/activity/growth/streak` 的 `streak.days` | 当天有一次真实 AI 会话才 +1 |

客户端「成长计划」页显示的是后者，与签到无关，一天只涨 1，28 天档要攒满才解锁。两者各自累加、数值通常不等，对不上不是断签。

## 连签保活

成长中心连签跟随的是当天有一次真实使用（一次 AI 会话），与客户端是否运行无关。启动、常驻、每日 03:02 自启、程序化置前、强制重启都不记账，`signin.py` 调 API 也代替不了（`/v2/activity/growth/` 下没有打卡接口）。

保活脚本因此用无头 CLI 造一次真实会话：

```
桌面端凭据（CodeBuddyExtension/Data/Public/auth/workbuddy-desktop.info）
    ↓ 解出 accessToken（复用 signin.py 的解密逻辑）
CODEBUDDY_AUTH_TOKEN=<token> node <客户端>\resources\app.asar.unpacked\cli\bin\codebuddy
    -p "回复ok" --tools "" --port <随机>
    ↓ 一次真实的一次性会话（约 6~8 秒，禁用全部工具，不读写任何文件）
probe_streak.py --days 复核天数是否增长 → 写 .streak_state.json
```

判定顺序：

1. `.streak_state.json` 是今天的且 `ok=true`，直接退出（18:00 那次靠这个跳过）
2. `probe_streak.py --days` 读基线
3. 基线已比上次记录的大，说明今天此前已被记过账，跳过会话直接记 `ok=true`
4. 读 accessToken（剩余有效期不足 0.5 天则退出码 2，提示打开客户端续期）
5. 跑 CLI 会话，随后每 30 秒复探、最多 3 次；天数大于基线即成功
6. 没涨就再跑一轮；两轮仍没涨退出码 3，说明这条机制不再成立

退出码：`0` 已记账或今天已记过账，`2` 无可用凭证，`3` 会话跑了但天数没涨，`4` CLI 找不到或执行失败。全程不触碰桌面客户端进程，不抢占焦点或窗口。

```powershell
python scripts\streak_warmup.py --dry-run   # 只打印将要执行什么
python scripts\streak_warmup.py             # 真跑一次会话
```

手动注册：

```powershell
$action = New-ScheduledTaskAction -Execute '<pythonw>' -Argument '"<仓库路径>\scripts\streak_warmup.py"' -WorkingDirectory '<仓库路径>\scripts'
$t1 = New-ScheduledTaskTrigger -Daily -At 10:00
$t2 = New-ScheduledTaskTrigger -Daily -At 18:00
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 10)
Register-ScheduledTask -TaskName 'WorkBuddyStreakWarmup' -Action $action -Trigger @($t1,$t2) -Settings $settings -Force
```

CLI 定位规则（`scripts\streak_warmup.py` 内）：`WORKBUDDY_CLI` 优先，其次是 `WORKBUDDY_HOME`、`D:\WorkBuddy`、`C:\Program Files\WorkBuddy`、`%LOCALAPPDATA%\Programs\WorkBuddy` 下的 `resources\app.asar.unpacked\cli\bin\codebuddy`。node 取 `~/.workbuddy/binaries/node/versions/*/node.exe` 中最新的一个，没有再退回 PATH。

bundle 变体按发行版实际产物选择：存在 `dist\codebuddy-headless.js` 或 `dist\codebuddy.js` 时用入口的默认分派；只有 `dist\codebuddy-lite-wb.mjs` 时（约 2026-10 起的精简包）必须设 `CODEBUDDY_FORCE_LITE_WB_BUNDLE=1`，否则 `bin\codebuddy` 带 `-p` 会分派到 headless 产物并报 `Cannot find module '../dist/codebuddy'`。

## 公共设置

- 错过补跑：`StartWhenAvailable=true`，关机或睡眠错过的时点开机后补跑
- 静默运行：`pythonw.exe` 启动，不弹窗口
- 防重复：`MultipleInstancesPolicy=IgnoreNew`
- 运行身份：当前用户（InteractiveToken，最低权限），电池供电照常运行
- 隐藏：`AllAutoCheckin` 带 `-Hidden`，任务计划程序默认不显示；`WorkBuddyStreakWarmup` 不带

`pythonw.exe` 的绝对路径由安装脚本探测（PATH → 同目录 → `C:\Python3*` 等通配位置），最终执行形式为：

```
统一任务:  <pythonw.exe 绝对路径>  "scripts\run_all_checkin.py"
其中一步:  <pythonw.exe 绝对路径>  "scripts\signin.py" silent-poll
保活任务:  <pythonw.exe 绝对路径>  "scripts\streak_warmup.py"
```

## 查看与排障

任务计划程序（`taskschd.msc`）里默认看不到隐藏任务，需要「查看 → 显示隐藏的任务」。

```powershell
# 任务状态
Get-ScheduledTask -TaskName 'AllAutoCheckin','WorkBuddyStreakWarmup' | Select-Object TaskName, State
Get-ScheduledTaskInfo -TaskName 'AllAutoCheckin'

# 手动跑一次
Start-ScheduledTask -TaskName 'AllAutoCheckin'

# 日志
Get-Content scripts\all_checkin.log -Tail 5     # 统一汇总（WorkBuddy 明细也汇入这里）
Get-Content scripts\signin.log -Tail 5          # 只看 WorkBuddy 签到与成长中心
Get-Content scripts\streak_warmup.log -Tail 20  # 连签保活的会话与复核过程

# 连签状态
python scripts\probe_streak.py                  # 天数 / 补登卡余额 / 可补日期 / 兑换档位
python scripts\probe_streak.py --days

# 凭据与运行时体检
python scripts\signin.py doctor
```

日志每行一条 JSON，关键字段：`result`（CLAIMED 签到成功 / ALREADY 已签过）、`streak_days` 签到连签天数、`total_credits` 累计积分、`growth_result`（GROWTH 成长中心跑完）、`trigger: "poll"` 表示轮询触发。`streak_warmup.log` 是纯文本时间线，记录基线、会话耗时与复探读数；`.streak_state.json` 用 `date` / `days` / `result` / `ok` 四个字段标记当天是否达标。

| 现象 | 原因与处理 |
|---|---|
| 00:00~10:20 之间客户端显示「今日未签到」 | 正常。签到发生在 10:20（15:00 / 20:30 兜底），零点不跑 |
| 成长中心仍有未领取项 | 见上文列表：真人任务、能量不足、档位未解锁、抽奖次数为 0、旅行在途 |
| 连签天数与签到天数对不上 | 两个独立计数，见上文对照表 |
| `AUTH_ERROR` / `NO_AUTH` | 桌面端重新登录后跑 `python scripts\signin.py doctor` 复核 |
| 客户端升级后签到失败 | 先跑 `doctor` 看 `runtime` 与 `credential_format` 是否仍被识别；升级不改凭据路径，失败多为登录态失效 |
| 保活日志报 `Cannot find module '../dist/codebuddy'` | 新版只剩 lite 产物，须设 `CODEBUDDY_FORCE_LITE_WB_BUNDLE=1`（脚本已自动判断） |

## 相关文件

| 路径 | 说明 |
|---|---|
| `scripts\signin.py` | 主脚本（签到 + 成长中心），收录自上游 |
| `scripts\streak_warmup.py` | 连签保活：读 accessToken → 跑无头 CLI 会话 → 探针复核 → 记录状态 |
| `scripts\probe_streak.py` | 只读探针，查 `/v2/activity/growth/streak`；`--days` 输出供脚本解析 |
| `scripts\run_all_checkin.py` | 统一主控 |
| `scripts\.streak_state.json` | 运行状态（本地生成，不入库） |
| `scripts\.pending_manual.json` | 待人工任务快照（本地生成，不入库） |
| `scripts\signin.log` / `scripts\streak_warmup.log` | 签到明细 / 保活时间线（前者汇入 `all_checkin.log`） |

## 卸载

```powershell
Unregister-ScheduledTask -TaskName "AllAutoCheckin" -Confirm:$false
Unregister-ScheduledTask -TaskName "WorkBuddyStreakWarmup" -Confirm:$false

# 仅临时停用
Disable-ScheduledTask -TaskName "AllAutoCheckin"
Disable-ScheduledTask -TaskName "WorkBuddyStreakWarmup"
```
