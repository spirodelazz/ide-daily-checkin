---
doc-type: how-to
reader: 查看、修改或卸载 WorkBuddy 本地定时任务的人
asof: 2026-10-21
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
| `WorkBuddyStreakLaunch` | 每天真实登录一次，保成长中心连签 | 每天 **10:00** | `pythonw.exe workbuddy_streak_launch.pyw` | 15 分钟 |

### WorkBuddyStreakLaunch（连签守卫）

成长中心"连签"只认桌面客户端当天的**一次真实登录**：客户端每天 03:02 自我重启一次后常驻，常驻进程与后台自启都不记账，`signin.py` 调 API 也无法代替（`/v2/activity/growth/` 下没有登录上报接口）。

守卫每天 10:00 校验当天是否已记账，未记账就结束旧进程、重新拉起、让窗口可见 60 秒，再用探针复核天数是否增长；复核通过才把当天写入状态文件，因此一天最多折腾一次。

- 触发：每天 **10:00**，`StartWhenAvailable=true`（关机错过则开机补跑），时限 15 分钟
- 判定与执行顺序：
  1. `scripts\.streak_state.json` 记录的日期是今天 → 直接退出（当天已复核）
  2. `probe_streak.py --days` 读连签基线（读不到则本轮只保证"起来一次"）
  3. 主实例启动不足 3 分钟时先等 90 秒，避免和登录握手抢跑；随后结束所有 `WorkBuddy` 进程
  4. 拉起客户端，主窗口出现后**保持可见 60 秒**（等首页加载与登录上报），再隐藏到托盘
  5. 每 20 秒复探一次（最多 3 次），天数大于基线即成功，写入 `.streak_state.json`
  6. 仍未记账则整套重来一次；两次都失败退出码 3，明细在 `scripts\streak_launch.log`
- 隐藏用 `ShowWindowAsync(hwnd, 0)`；App 自带 closeToTray，托盘图标或再次双击 `WorkBuddy.exe` 可唤回窗口
- 任务的宿主是 `pythonw.exe`（GUI 子系统，自身无控制台），由 `scripts\workbuddy_streak_launch.pyw` 用 `CREATE_NO_WINDOW` 起 PowerShell：直接让任务计划程序起 `powershell.exe` 时，`-WindowStyle Hidden` 只能隐藏已经创建的窗口，启动瞬间仍会闪一下黑框，而 `CREATE_NO_WINDOW` 连控制台窗口都不分配
- 拉起用 `ProcessStartInfo(UseShellExecute=false, CreateNoWindow=true)` 分离启动，不用 `Start-Process`：后者让客户端继承任务进程的标准句柄，客户端及其控制台子进程会挂在任务进程那个控制台上——脚本退出后窗口不消失，还被客户端日志持续刷屏（关掉该窗口会以 `STATUS_CONTROL_C_EXIT` 连带杀掉客户端）
- 强制结束进程会让客户端在 `~/.workbuddy/logs/Crash-Log/` 留一条 `crash-report-daemon-*.json`（sidecar 以 `exitCode=-1` 退出），属重启的预期副作用，不代表客户端异常
- 手动预演（不结束进程、不拉起客户端）：`powershell -ExecutionPolicy Bypass -File scripts\workbuddy_streak_launch.ps1 -DryRun`
- 冒烟自检（真重启一轮，但不判断天数、不写状态、结束时保留窗口）：`powershell -ExecutionPolicy Bypass -File scripts\workbuddy_streak_launch.ps1 -MechanicsTest`
- 注册命令（`<仓库路径>` 换成实际位置，`<pythonw>` 换成 `pythonw.exe` 的绝对路径）：

```powershell
$action = New-ScheduledTaskAction -Execute '<pythonw>' -Argument '"<仓库路径>\scripts\workbuddy_streak_launch.pyw"'
$trigger = New-ScheduledTaskTrigger -Daily -At 10:00
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 15)
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

# 只看连签天数（守卫脚本内部用的形式）
python scripts\probe_streak.py --days

# 连签守卫的判定与复核过程
Get-Content scripts\streak_launch.log -Tail 20
```

日志每行一条 JSON，关键字段：`result`（CLAIMED=签到成功 / ALREADY=已签过）、`streak_days` 连续天数、`total_credits` 累计积分、`trigger: "poll"` 表示由轮询任务触发。

## 相关文件

| 路径 | 说明 |
|---|---|
| `scripts\signin.py` | 主脚本（签到 + 成长中心轮询逻辑），收录自上游 [88lin/workbuddy-auto-signin](https://github.com/88lin/workbuddy-auto-signin)（MIT） |
| `scripts\workbuddy_streak_launch.ps1` | 连签守卫：校验当天是否记账 → 结束旧进程 → 重新拉起并保留窗口 60 秒 → 探针复核 → 记录状态 |
| `scripts\workbuddy_streak_launch.pyw` | 无控制台启动器：任务计划程序用它当宿主，再以 `CREATE_NO_WINDOW` 起 PowerShell |
| `scripts\probe_streak.py` | 只读探针：查询成长中心连签状态（`/v2/activity/growth/streak`），`--days` 输出供脚本解析 |
| `scripts\.streak_state.json` | 守卫状态文件：记录最近一次复核通过的日期与连签天数（本地生成，不入库） |
| `scripts\streak_launch.log` | 守卫运行日志（每次判定、重启、复核结果各一行） |
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
