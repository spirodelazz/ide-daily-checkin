# WorkBuddy 本地定时任务（Windows 任务计划程序）

> WorkBuddy 签到系统详情：单系统独立部署（可选）的任务配置、查看方式与卸载方法。
> 统一部署时由 `AllAutoCheckin` 以 `silent-poll` 模式调用 `signin.py`，总览见 [README.md](README.md)。

## 任务总览

| 任务名 | 用途 | 触发计划 | 执行命令 | 超时 |
|---|---|---|---|---|
| `WorkBuddyAutoSignin` | 每日自动签到（静默、零 token） | 每天 **00:05** | `pythonw.exe signin.py silent` | 10 分钟 |
| `WorkBuddyGrowthPoll` | 轮询（补签 + 成长中心） | 每天 **01/05/09/13/17/21** 点 | `pythonw.exe signin.py silent-poll` | 5 分钟 |

### 公共设置（两个任务一致）

- **隐藏任务**：安装脚本（`install-windows.ps1`）创建时带了 `-Hidden` 参数，任务计划程序默认不显示
- **错过补跑**：`StartWhenAvailable=true`，关机/睡眠错过的时点开机后会补跑
- **静默运行**：用 `pythonw.exe` 启动，无任何窗口弹出
- **防重复**：`MultipleInstancesPolicy=IgnoreNew`，上一轮没跑完不会叠加新实例
- **运行身份**：当前用户（InteractiveToken，最低权限），电池供电也照常运行

### 完整执行命令

```
签到:  %LOCALAPPDATA%\Programs\Python\Python312\pythonw.exe
       "scripts\signin.py" silent

轮询:  %LOCALAPPDATA%\Programs\Python\Python312\pythonw.exe
       "scripts\signin.py" silent-poll
```

## 查看 / 管理方式

### 方式一：图形界面（任务计划程序）

1. 按 `Win + R`，输入 `taskschd.msc` 回车（或开始菜单搜「任务计划程序」）
2. 左侧点「任务计划程序库」
3. **关键一步**：任务带 `-Hidden` 属性默认不可见 —— 菜单栏「查看(V)」→ 勾选**「显示隐藏的任务」**，列表里才会出现：
   - `WorkBuddyAutoSignin`（每天 00:05 签到）
   - `WorkBuddyGrowthPoll`（每天 01/05/09/13/17/21 点轮询）
4. 双击任一任务可查看触发器、历史记录；右键「运行」可手动触发一次

### 方式二：命令行

```powershell
# 看两个任务是否存在、状态
Get-ScheduledTask -TaskName 'WorkBuddyAutoSignin','WorkBuddyGrowthPoll' | Select-Object TaskName, State

# 看下次运行时间 / 上次运行结果
Get-ScheduledTaskInfo -TaskName 'WorkBuddyAutoSignin'
Get-ScheduledTaskInfo -TaskName 'WorkBuddyGrowthPoll'

# 手动立即触发一次（等同图形界面右键「运行」）
Start-ScheduledTask -TaskName 'WorkBuddyAutoSignin'
```

### 方式三：翻日志（最直观）

```powershell
Get-Content scripts\signin.log -Tail 5
```

日志每行一条 JSON，关键字段：`result`（CLAIMED=签到成功 / ALREADY=已签过）、`streak_days` 连续天数、`total_credits` 累计积分、`trigger: "poll"` 表示由轮询任务触发。

## 相关文件

| 路径 | 说明 |
|---|---|
| `scripts\signin.py` | 主脚本（签到 + 成长中心轮询逻辑） |
| `scripts\install-windows.ps1` | Windows 安装脚本（注册这两个任务的就是它） |
| `scripts\signin.log` | 运行日志 |
| `scripts\signin.py` | 主脚本（自上游 88lin/workbuddy-auto-signin 收录，MIT） |
| `C:\Windows\System32\Tasks\WorkBuddyAutoSignin` / `...\WorkBuddyGrowthPoll` | 任务定义 XML（系统内部存储，只读参考） |

## 卸载 / 停用

```powershell
# 删除（两个任务各自执行）
Unregister-ScheduledTask -TaskName "WorkBuddyAutoSignin" -Confirm:$false
Unregister-ScheduledTask -TaskName "WorkBuddyGrowthPoll" -Confirm:$false

# 仅临时停用
Disable-ScheduledTask -TaskName "WorkBuddyAutoSignin"
Disable-ScheduledTask -TaskName "WorkBuddyGrowthPoll"
```

也可在任务计划程序里右键对应任务选择「删除」或「禁用」。
