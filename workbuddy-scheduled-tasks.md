---
doc-type: how-to
reader: 查看、修改或卸载 WorkBuddy 本地定时任务的人
asof: 2026-10-24
---

# WorkBuddy 本地定时任务（Windows 任务计划程序）

> WorkBuddy 签到系统详情：任务配置、查看方式与卸载方法。
> `WorkBuddyAutoSignin` / `WorkBuddyGrowthPoll` 由**上游仓库**的 `install-windows.ps1` 注册（本仓库只收录 `scripts\signin.py`）；
> `WorkBuddyStreakWarmup` 由本仓库维护（注册命令见下文）。
> 统一部署时由 `AllAutoCheckin` 以 `silent-poll` 模式调用 `signin.py`，总览见 [README.md](README.md)。

## 原理

```
桌面端登录 → 写入加密凭据（CodeBuddyExtension/Data/Public/auth/workbuddy-desktop.info）
    ↓ 每日定时
signin.py silent-poll
    ├─ find_workbuddy_runtime() 定位客户端 → _run_auth_helper() 原生接口解密会话
    ├─ 查询签到状态 → 未签则领取（幂等）→ 成长中心全套（补登卡每轮限用 1 张）
    ├─ 自设时间预算（签到 420s / 轮询 180s，小于任务时限，保证总能走到写日志）
    └─ 网络退避重试（5 / 15 / 30 / 60 / 90s）→ signin.log
```

凭据不落盘：运行时拉起客户端安装目录里的 runtime 辅助进程解密磁盘上的凭据文件，GUI 无需正在运行。会话失效时在桌面端重新登录即可，脚本会自动重新探测，无需手工提取。

## 任务总览

| 任务名 | 用途 | 触发计划 | 执行命令 | 超时 |
|---|---|---|---|---|
| `WorkBuddyAutoSignin` | 每日自动签到（静默、零 token） | 每天 **00:05** | `pythonw.exe signin.py silent` | 10 分钟 |
| `WorkBuddyGrowthPoll` | 轮询（补签 + 成长中心） | 每天 **01/05/09/13/17/21** 点 | `pythonw.exe signin.py silent-poll` | 5 分钟 |
| `WorkBuddyStreakWarmup` | 每天跑一次无头会话，保成长中心连签 | 每天 **10:00**，失败当日 **18:00** 重试 | `pythonw.exe streak_warmup.py` | 10 分钟 |

### WorkBuddyStreakWarmup（连签保活）

成长中心"连签"跟随的是**当天有一次真实使用**（一次 AI 会话），与客户端是否运行无关。2026-10-22 ~ 10-24 三天实测：

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
    ↓ 一次真实的一次性会话（约 7–9 秒，禁用全部工具，不读写任何文件）
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

### 公共设置（两个上游任务一致）

- **隐藏任务**：注册时带 `-Hidden` 属性，任务计划程序默认不显示（需「查看 → 显示隐藏的任务」）
- **错过补跑**：`StartWhenAvailable=true`，关机/睡眠错过的时点开机后会补跑
- **静默运行**：用 `pythonw.exe` 启动，无任何窗口弹出
- **防重复**：`MultipleInstancesPolicy=IgnoreNew`，上一轮没跑完不会叠加新实例
- **运行身份**：当前用户（InteractiveToken，最低权限），电池供电也照常运行

### 完整执行命令

`pythonw.exe` 的绝对路径由安装脚本在本机探测（PATH → 同目录 → `C:\Python3*` 等通配位置），形如：

```
签到:  <pythonw.exe 绝对路径>  "scripts\signin.py" silent
轮询:  <pythonw.exe 绝对路径>  "scripts\signin.py" silent-poll
```

## 查看 / 管理方式

### 方式一：图形界面（任务计划程序）

1. 按 `Win + R`，输入 `taskschd.msc` 回车（或开始菜单搜「任务计划程序」）
2. 左侧点「任务计划程序库」
3. **关键一步**：`WorkBuddyAutoSignin` / `WorkBuddyGrowthPoll` 带 `-Hidden` 属性默认不可见 —— 菜单栏「查看(V)」→ 勾选**「显示隐藏的任务」**，列表里才会出现：
   - `WorkBuddyAutoSignin`（每天 00:05 签到）
   - `WorkBuddyGrowthPoll`（每天 01/05/09/13/17/21 点轮询）
   - `WorkBuddyStreakWarmup`（每天 10:00 连签保活，18:00 重试位，不带隐藏属性，始终可见）
4. 双击任一任务可查看触发器、历史记录；右键「运行」可手动触发一次

### 方式二：命令行

```powershell
# 看三个任务是否存在、状态
Get-ScheduledTask -TaskName 'WorkBuddyAutoSignin','WorkBuddyGrowthPoll','WorkBuddyStreakWarmup' | Select-Object TaskName, State

# 看下次运行时间 / 上次运行结果
Get-ScheduledTaskInfo -TaskName 'WorkBuddyAutoSignin'
Get-ScheduledTaskInfo -TaskName 'WorkBuddyGrowthPoll'
Get-ScheduledTaskInfo -TaskName 'WorkBuddyStreakWarmup'

# 手动立即触发一次（等同图形界面右键「运行」）
Start-ScheduledTask -TaskName 'WorkBuddyAutoSignin'
```

### 方式三：翻日志（最直观）

```powershell
Get-Content scripts\signin.log -Tail 5

# 查成长中心连签状态（连签天数 / 补登卡余额 / 可补日期）
python scripts\probe_streak.py

# 只看连签天数（保活脚本内部用的形式）
python scripts\probe_streak.py --days

# 连签保活的会话与复核过程
Get-Content scripts\streak_warmup.log -Tail 20
```

日志每行一条 JSON，关键字段：`result`（CLAIMED=签到成功 / ALREADY=已签过）、`streak_days` 连续天数、`total_credits` 累计积分、`trigger: "poll"` 表示由轮询任务触发。

`streak_warmup.log` 是纯文本时间线，每次保活记录基线、会话耗时与回复、复探读数；`.streak_state.json` 用 `date` / `days` / `result` / `ok` 四个字段标记当天是否已达标。

## 相关文件

| 路径 | 说明 |
|---|---|
| `scripts\signin.py` | 主脚本（签到 + 成长中心轮询逻辑），收录自上游 [88lin/workbuddy-auto-signin](https://github.com/88lin/workbuddy-auto-signin)（MIT） |
| `scripts\streak_warmup.py` | 连签保活：读 accessToken → 跑一次无头 CLI 会话 → 探针复核天数 → 记录状态 |
| `scripts\probe_streak.py` | 只读探针：查询成长中心连签状态（`/v2/activity/growth/streak`），`--days` 输出供脚本解析 |
| `scripts\.streak_state.json` | 状态文件：记录最近一次运行日期、连签天数与是否达标 `ok`（本地生成，不入库） |
| `scripts\streak_warmup.log` | 保活运行日志（基线、会话结果、复探读数、结论） |
| 上游仓库根目录 `install-windows.ps1` | 注册上游两个任务的安装脚本，未收录进本仓库 |
| `scripts\signin.log` | 运行日志（统一任务会把新增行汇入 `all_checkin.log`） |
| `C:\Windows\System32\Tasks\WorkBuddyAutoSignin` / `...\WorkBuddyGrowthPoll` / `...\WorkBuddyStreakWarmup` | 任务定义 XML（系统内部存储，只读参考） |

## 卸载 / 停用

```powershell
# 删除（各任务分别执行）
Unregister-ScheduledTask -TaskName "WorkBuddyAutoSignin" -Confirm:$false
Unregister-ScheduledTask -TaskName "WorkBuddyGrowthPoll" -Confirm:$false
Unregister-ScheduledTask -TaskName "WorkBuddyStreakWarmup" -Confirm:$false

# 仅临时停用
Disable-ScheduledTask -TaskName "WorkBuddyAutoSignin"
Disable-ScheduledTask -TaskName "WorkBuddyGrowthPoll"
Disable-ScheduledTask -TaskName "WorkBuddyStreakWarmup"
```

也可在任务计划程序里右键对应任务选择「删除」或「禁用」。
