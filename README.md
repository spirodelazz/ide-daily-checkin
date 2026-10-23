<div align="center">

# ide-daily-checkin

**Windows 上 WorkBuddy / Qoder / Trae CN 三合一每日自动签到**

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-Windows%2010%20%7C%2011-0078D4.svg)](#环境要求)
[![Python](https://img.shields.io/badge/python-3.9%2B-3776AB.svg)](#环境要求)
[![CI](https://github.com/spirodelazz/ide-daily-checkin/actions/workflows/ci.yml/badge.svg)](https://github.com/spirodelazz/ide-daily-checkin/actions/workflows/ci.yml)

</div>

用一个 Windows 计划任务，在每天固定时点静默完成 WorkBuddy（腾讯）、Qoder（阿里）、Trae CN（字节）三个 AI IDE 的每日签到与积分领取。全程无窗口、幂等、错过时点开机后自动补跑。

> **非官方工具**：与腾讯、阿里、字节均无隶属关系。签到接口由客户端本地凭据与网络请求逆向得到，可能随时变更且不另行通知。请仅用于自己的账号，风险自负。

## 功能特性

- **三套一次跑完**：统一任务 `AllAutoCheckin` 顺序执行，每日覆盖 WorkBuddy 积分、Qoder 100 Credits、Trae CN 200 积分。
- **幂等安全**：均为「未领才领」，重复运行不会多领。
- **成长中心**：WorkBuddy 侧自动领旅行礼物、派 Buddy、领任务奖励、断签补登、连签兑换与盲盒抽奖。
- **静默运行**：`pythonw` / `wscript` 包装，无窗口无弹窗，结果只写 JSON 行日志。
- **健壮**：错过补跑、防重复实例、单系统超时隔离、网络退避重试。
- **凭据自管理**：Qoder token 到期前 72 小时自动刷新；仓库不含任何密钥。

## 支持的系统

| 系统 | 每日收益 | 凭据来源 |
| --- | --- | --- |
| WorkBuddy | 每日积分 + 成长中心全套 | 桌面端登录写入的加密凭据，运行时经客户端原生接口解密 |
| Qoder | 100 Credits | `qoder_extract.py` 一次性解密提取（DPAPI + AES-GCM） |
| Trae CN | 200 积分 | 每次运行实时解密 `storage.json`（自包含信封，无需客户端参与） |

各系统的接口契约、任务配置与踩坑记录见[文档](#文档)。

## 环境要求

- **Windows 10 / 11**
- **Python 3.9+**，无第三方依赖（计划任务用 `pythonw.exe` 静默运行）
- **Node.js ≥ 22**（可选，仅 Trae 签到需要）
- 三个客户端各**登录一次**

## 快速开始

无需管理员权限。

```powershell
git clone https://github.com/spirodelazz/ide-daily-checkin.git
cd ide-daily-checkin

# ① 提取 Qoder 凭据（只需一次；须用登录 Qoder 的同一 Windows 用户运行）
python scripts\qoder_extract.py

# ② 注册统一计划任务（每天 10:20 主跑，15:00 / 20:30 兜底）
powershell -ExecutionPolicy Bypass -File scripts\install-all-checkin.ps1

# ③ 查看结果
Get-Content scripts\all_checkin.log -Tail 5
```

WorkBuddy 与 Trae 没有提取步骤，脚本每次运行自动读取本机客户端凭据。Trae 的 token 由客户端运行时续期，约每两周启动一次 Trae 即可保持登录态。

安装脚本支持 `-KeepExisting` 保留已有任务；默认会先注销六个单系统任务。卸载：

```powershell
Unregister-ScheduledTask -TaskName "AllAutoCheckin" -Confirm:$false
```

单系统独立部署（可选，与统一任务二选一）：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install-qoder-windows.ps1
powershell -ExecutionPolicy Bypass -File scripts\install-trae-windows.ps1
```

## 使用

| 操作 | 命令 |
| --- | --- |
| 立即跑一次 | `Start-ScheduledTask -TaskName 'AllAutoCheckin'` |
| 前台看输出 | `python scripts\run_all_checkin.py` |
| 查 WorkBuddy 状态 | `python scripts\signin.py status` |
| 查连签天数 | `python scripts\probe_streak.py`（加 `--days` 只输出天数） |
| 单跑 Trae | `node scripts\trae_checkin_api.mjs --trigger manual` |
| 查任务状态 | `Get-ScheduledTask -TaskName 'AllAutoCheckin'` |

## 计划任务

| 任务名 | 触发（北京时间） | 内容 |
| --- | --- | --- |
| `AllAutoCheckin` | 10:20 主跑，15:00 / 20:30 兜底 | 顺序跑三套签到，时限 15 分钟 |
| `WorkBuddyStreakLaunch` | 每天 10:00 | 校验成长中心当天是否已记账；未记账先把客户端窗口置前等 30 秒，仍不记账才结束旧进程重新拉起并保持可见 90 秒；探针复核通过才收工，时限 15 分钟。宿主为 `pythonw.exe`，全程不弹控制台 |

几条设计约定：主跑选 10:20 是因为 Qoder 额度在 10:00（UTC+8）刷新；轮询用多个独立 Daily 触发器而非「重复间隔」（后者错过会永久跳过）；`StartWhenAvailable` 补跑、`IgnoreNew` 防重复实例。任务在任务计划程序中默认为隐藏，需「查看 → 显示隐藏的任务」；任务 XML 里时间是 **UTC**。

## 目录结构

```
ide-daily-checkin/
├── scripts/
│   ├── run_all_checkin.py           统一主控（汇总 all_checkin.log）
│   ├── install-all-checkin.ps1      注册统一任务
│   ├── signin.py                    WorkBuddy 签到
│   ├── workbuddy_streak_launch.ps1  连签守卫
│   ├── workbuddy_streak_launch.pyw  无控制台启动器（任务宿主）
│   ├── probe_streak.py              连签状态探针（只读）
│   ├── qoder_checkin.py             Qoder 签到
│   ├── qoder_extract.py             Qoder 凭据提取
│   ├── trae_checkin_api.mjs         Trae 签到（纯 API）
│   └── trae_checkin.mjs             Trae CDP 参考实现
├── workbuddy-scheduled-tasks.md     WorkBuddy 详情（原理 / 任务配置）
├── qoder-auto-checkin.md            Qoder 详情
├── trae-auto-checkin.md             Trae 详情
├── QODER.md                         Qoder 代码级开发文档
└── CHANGELOG.md
```

凭据（`qoder_config.json`、`qoder_accounts.json`、`.qoder_token_cache.json`）、全部 `*.log` 与守卫状态 `.streak_state.json` 已在 `.gitignore` 中排除。

## 日志

只需要看 `scripts/all_checkin.log`：每次运行先汇入三套的新增明细行（`script` 字段区分归属），最后一行是汇总。`signin.log` / `qoder_checkin.log` / `trae_checkin.log` 是各脚本原生日志；`streak_launch.log` 是连签守卫的判定与复核过程。

## 常见问题

| 现象 | 处理 |
| --- | --- |
| Qoder `LOGIN_REQUIRED` | 同一 Windows 用户重跑 `python scripts\qoder_extract.py` |
| Qoder `PENDING` | 每日活动未下发，等后续轮询兜底 |
| Qoder 连续 `ERROR` | 清空 `HTTP(S)_PROXY` 后重试；关注上游适配更新 |
| WorkBuddy `AUTH_*` / 断签 | 桌面端重新登录；`python scripts\signin.py doctor` 体检 |
| WorkBuddy 成长中心断连签 | 连签只认客户端窗口当天**在前台被刷新过**（常驻进程、03:02 自启、窗口只显示不聚焦都不算）；看 `scripts\streak_launch.log` 与 `python scripts\probe_streak.py`，必要时手动跑一次 `scripts\workbuddy_streak_launch.ps1` |
| Trae `LOGIN_REQUIRED` | 超过两周未启动 Trae，token 过期；打开一次即可 |

**客户端不运行也能签到吗？** Qoder 与 Trae 可以（纯 HTTP 调用）；WorkBuddy 需要客户端**已安装**（运行时拉起内部辅助进程解密凭据），但 GUI 不必在运行。

## 安全说明

- 凭据文件与日志仅在本地，已在 `.gitignore`；修改忽略规则前确认这几条还在。
- 脚本默认不打印令牌；`qoder_extract.py --json` 会输出明文 token，仅排错时使用。
- Qoder 凭据解密依赖 DPAPI，必须在登录 Qoder 的**同一 Windows 用户**下提取。

## 文档

- [workbuddy-scheduled-tasks.md](workbuddy-scheduled-tasks.md)：WorkBuddy 原理、任务配置与连签守卫
- [qoder-auto-checkin.md](qoder-auto-checkin.md)：Qoder 原理、部署与已知坑
- [trae-auto-checkin.md](trae-auto-checkin.md)：Trae 纯 API 方案与服务端字段坑
- [QODER.md](QODER.md)：Qoder 接口契约、状态机与维护 runbook
- [CHANGELOG.md](CHANGELOG.md)：版本变更

## 贡献

欢迎 Issue 与 PR。改动脚本后至少跑一次语法检查（与 CI 一致）：

```powershell
python -m py_compile scripts\run_all_checkin.py scripts\qoder_checkin.py scripts\qoder_extract.py scripts\signin.py
node --check scripts\trae_checkin_api.mjs
```

## 许可证

[MIT](LICENSE) © 2026 ide-daily-checkin contributors。`signin.py` 来自 [88lin/workbuddy-auto-signin](https://github.com/88lin/workbuddy-auto-signin)，Qoder 脚本改编自 [wallechfox/qoder-checkin](https://github.com/wallechfox/qoder-checkin)，Trae CDP 实现改编自 [BlueChonk/trae-daily-checkin](https://github.com/BlueChonk/trae-daily-checkin)。
