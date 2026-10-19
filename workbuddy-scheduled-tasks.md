---
doc-type: how-to
reader: 查看、修改或卸载 WorkBuddy 本地定时任务的人
asof: 2026-10-17
---

# WorkBuddy 本地定时任务（Windows 任务计划程序）

> WorkBuddy 签到系统详情：任务配置、查看方式与卸载方法。
> `WorkBuddyAutoSignin` / `WorkBuddyGrowthPoll` 由**上游仓库**的 `install-windows.ps1` 注册（本仓库只收录 `scripts\signin.py`）；
> `WorkBuddyStreakLaunch` 由本仓库维护（注册命令见下文）。
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
| `WorkBuddyStreakLaunch` | 拉起客户端，保成长中心连签 | 每天 **10:00** | `powershell.exe workbuddy_streak_launch.ps1` | 10 分钟 |

### WorkBuddyStreakLaunch（连签守卫）

成长中心"连签"只认桌面客户端当天的登录行为，`signin.py` 调 API 无法代替，由该任务每天拉起客户端记上这一天。

- 每天 **10:00** 触发，`StartWhenAvailable=true`（关机错过则开机补跑）
- 守卫脚本 `scripts\workbuddy_streak_launch.ps1`：客户端已在运行则直接退出，不会重复拉起；未运行才拉起，并在主窗口出现后将其隐藏到后台（App 自带 closeToTray 支持，托盘图标可恢复，再次双击 WorkBuddy.exe 也可唤回窗口）
- 不带 `-Hidden` 属性，任务计划程序中默认可见
- 注册命令（`<仓库路径>` 换成本仓库实际位置）：

```powershell
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "<仓库路径>\scripts\workbuddy_streak_launch.ps1"'
$trigger = New-ScheduledTaskTrigger -Daily -At 10:00
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 10)
Register-ScheduledTask -TaskName 'WorkBuddyStreakLaunch' -Action $action -Trigger $trigger -Settings $settings -Force
```

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
   - `WorkBuddyStreakLaunch`（每天 10:00 连签守卫，不带隐藏属性，始终可见）
4. 双击任一任务可查看触发器、历史记录；右键「运行」可手动触发一次

### 方式二：命令行

```powershell
# 看三个任务是否存在、状态
Get-ScheduledTask -TaskName 'WorkBuddyAutoSignin','WorkBuddyGrowthPoll','WorkBuddyStreakLaunch' | Select-Object TaskName, State

# 看下次运行时间 / 上次运行结果
Get-ScheduledTaskInfo -TaskName 'WorkBuddyAutoSignin'
Get-ScheduledTaskInfo -TaskName 'WorkBuddyGrowthPoll'
Get-ScheduledTaskInfo -TaskName 'WorkBuddyStreakLaunch'

# 手动立即触发一次（等同图形界面右键「运行」）
Start-ScheduledTask -TaskName 'WorkBuddyAutoSignin'
```

### 方式三：翻日志（最直观）

```powershell
Get-Content scripts\signin.log -Tail 5

# 查成长中心连签状态（连签天数 / 补登卡余额 / 可补日期）
python scripts\probe_streak.py
```

日志每行一条 JSON，关键字段：`result`（CLAIMED=签到成功 / ALREADY=已签过）、`streak_days` 连续天数、`total_credits` 累计积分、`trigger: "poll"` 表示由轮询任务触发。

## 相关文件

| 路径 | 说明 |
|---|---|
| `scripts\signin.py` | 主脚本（签到 + 成长中心轮询逻辑），收录自上游 [88lin/workbuddy-auto-signin](https://github.com/88lin/workbuddy-auto-signin)（MIT） |
| `scripts\workbuddy_streak_launch.ps1` | 连签守卫脚本：客户端未运行才拉起，拉起后隐藏主窗口到后台 |
| `scripts\probe_streak.py` | 调试探针：只读查询成长中心连签状态（`/v2/activity/growth/streak`） |
| 上游仓库根目录 `install-windows.ps1` | 注册上游两个任务的安装脚本，未收录进本仓库 |
| `scripts\signin.log` | 运行日志（统一任务会把新增行汇入 `all_checkin.log`） |
| `C:\Windows\System32\Tasks\WorkBuddyAutoSignin` / `...\WorkBuddyGrowthPoll` / `...\WorkBuddyStreakLaunch` | 任务定义 XML（系统内部存储，只读参考） |

## 卸载 / 停用

```powershell
# 删除（各任务分别执行）
Unregister-ScheduledTask -TaskName "WorkBuddyAutoSignin" -Confirm:$false
Unregister-ScheduledTask -TaskName "WorkBuddyGrowthPoll" -Confirm:$false
Unregister-ScheduledTask -TaskName "WorkBuddyStreakLaunch" -Confirm:$false

# 仅临时停用
Disable-ScheduledTask -TaskName "WorkBuddyAutoSignin"
Disable-ScheduledTask -TaskName "WorkBuddyGrowthPoll"
Disable-ScheduledTask -TaskName "WorkBuddyStreakLaunch"
```

也可在任务计划程序里右键对应任务选择「删除」或「禁用」。
