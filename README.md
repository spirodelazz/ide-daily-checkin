<div align="center">

# ide-daily-checkin

**Windows 上 WorkBuddy / Qoder / Trae CN 三合一每日自动签到**

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-Windows%2010%20%7C%2011-0078D4.svg)](#环境要求)
[![Python](https://img.shields.io/badge/python-3.9%2B-3776AB.svg)](#环境要求)
[![CI](https://github.com/spirodelazz/ide-daily-checkin/actions/workflows/ci.yml/badge.svg)](https://github.com/spirodelazz/ide-daily-checkin/actions/workflows/ci.yml)

</div>

用一个 Windows 计划任务，在每天固定时点静默完成 WorkBuddy（腾讯）、Qoder（阿里）、Trae CN（字节）三个 AI IDE 的每日签到与积分领取。全程无窗口，重复运行不会多领，错过的时点开机后自动补跑。

> **非官方工具**：与腾讯、阿里、字节均无隶属关系。签到接口由客户端本地凭据与网络请求逆向得到，可能随时变更且不另行通知。请仅用于自己的账号，风险自负。

## 支持情况

| 客户端 | 每日收益 | 凭据来源 |
|---|---|---|
| WorkBuddy | 每日积分 + 成长中心全套 | 桌面端登录写入的加密凭据，运行时经客户端原生接口解密 |
| Qoder | 100 Credits | `qoder_extract.py` 一次性解密提取（DPAPI + AES-GCM） |
| Trae CN | 200 积分 | 每次运行实时解密 `storage.json`，自包含信封无需客户端参与；token 不足 3 天时借客户端续期 |

三套的接口契约与踩坑记录见[文档](#文档)。

## 环境要求

- Windows 10 / 11
- Python 3.9+，无第三方依赖（计划任务用 `pythonw.exe` 静默运行）
- Node.js ≥ 22，可选，仅 Trae 签到需要
- 三个客户端各登录一次

## 快速开始

无需管理员权限。

```powershell
git clone https://github.com/spirodelazz/ide-daily-checkin.git
cd ide-daily-checkin

# ① 提取 Qoder 凭据（只需一次；须用登录 Qoder 的同一 Windows 用户运行）
python scripts\qoder_extract.py

# ② 注册统一计划任务（10:20 主跑，12:20 / 14:20 收旅行礼物，15:00 / 20:30 兜底）
powershell -ExecutionPolicy Bypass -File scripts\install-all-checkin.ps1

# ③ 查看结果
Get-Content scripts\all_checkin.log -Tail 5
```

WorkBuddy 与 Trae 没有提取步骤，脚本每次运行自动读取客户端凭据。

安装脚本默认先注销六个单系统任务，`-KeepExisting` 可保留已有任务。卸载：

```powershell
Unregister-ScheduledTask -TaskName "AllAutoCheckin" -Confirm:$false
```

单系统独立部署与统一任务二选一：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install-qoder-windows.ps1
powershell -ExecutionPolicy Bypass -File scripts\install-trae-windows.ps1
```

WorkBuddy 的单系统任务（`WorkBuddyAutoSignin`、`WorkBuddyGrowthPoll`）由上游仓库的 `install-windows.ps1` 注册，本仓库不收录该脚本，默认部署也不注册它们。要单独开启整点高频轮询，见 [docs/workbuddy.md](docs/workbuddy.md)。

## 使用

| 操作 | 命令 |
|---|---|
| 立即跑一次 | `Start-ScheduledTask -TaskName 'AllAutoCheckin'` |
| 前台看输出 | `python scripts\run_all_checkin.py` |
| 查 WorkBuddy 状态 | `python scripts\signin.py status` |
| 查连签天数 | `python scripts\probe_streak.py`（加 `--days` 只输出天数） |
| 看待人工任务 | `Get-Content scripts\all_checkin.log -Tail 1 \| ConvertFrom-Json \| Select-Object -ExpandProperty pending_manual` |
| 单跑 Trae | `node scripts\trae_checkin_api.mjs --trigger manual` |
| 查 Trae 凭据剩余天数 | `node scripts\trae_keepalive.mjs --status` |
| 手动续期 Trae | `node scripts\trae_keepalive.mjs`（加 `--dry-run` 只看会不会动手） |
| 查任务状态 | `Get-ScheduledTask -TaskName 'AllAutoCheckin'` |

## 计划任务

| 任务名 | 触发（北京时间） | 内容 |
|---|---|---|
| `AllAutoCheckin` | 10:20 主跑，12:20 / 14:20 收旅行礼物，15:00 / 20:30 兜底 | 先做 Trae 凭据续期（临期才动手），再顺序跑三套签到，时限 20 分钟 |
| `WorkBuddyStreakWarmup` | 10:00，失败当日 18:00 重试 | 连签保活：用无头 CLI 跑一次极简会话，再用探针复核天数是否增长，时限 10 分钟 |

两个任务都用 `pythonw.exe` 启动，不弹控制台。主跑时间定在 10:20，是因为 Qoder 额度在 10:00（UTC+8）刷新；12:20 与 14:20 两轮专收旅行礼物，Buddy 在主跑时派出后要 2~4 小时才到达。轮询用多个独立 Daily 触发器而非重复间隔，后者错过会永久跳过。任务在任务计划程序中默认隐藏，需要「查看 → 显示隐藏的任务」；任务 XML 里存的是 UTC 时间。

时点选择、触发器语义与单系统任务的关系见 [docs/workbuddy.md](docs/workbuddy.md)。

## 目录结构

```
ide-daily-checkin/
├── scripts/
│   ├── run_all_checkin.py           统一主控（续期 + 三套签到，汇总 all_checkin.log）
│   ├── install-all-checkin.ps1      注册统一任务
│   ├── signin.py                    WorkBuddy 签到
│   ├── streak_warmup.py             连签保活（无头 CLI 会话 + 复核）
│   ├── probe_streak.py              连签状态探针（只读）
│   ├── qoder_checkin.py             Qoder 签到
│   ├── qoder_extract.py             Qoder 凭据提取
│   ├── trae_auth.mjs                Trae 凭据读取（解密 + 设备号），被下面两个脚本共用
│   ├── trae_keepalive.mjs           Trae 登录态续期（临期拉起客户端并复核）
│   └── trae_checkin_api.mjs         Trae 签到（纯 API）
├── docs/
│   ├── workbuddy.md                 WorkBuddy 原理与任务配置
│   ├── qoder.md                     Qoder 部署与排障
│   ├── qoder-internals.md           Qoder 接口契约与解密链路
│   └── trae.md                      Trae 纯 API 方案与字段坑
└── CHANGELOG.md
```

`qoder_config.json`、`qoder_accounts.json`、`.qoder_token_cache.json`、全部 `*.log` 与运行状态（`.streak_state.json`、`.pending_manual.json`）已在 `.gitignore` 中排除。

## 日志

日常只需要看 `scripts/all_checkin.log`：每次运行先汇入各步的新增明细行（`script` 字段区分归属），最后一行是汇总。各脚本另有自己的原生日志，`trae_keepalive.log` 记凭据剩余天数与续期结果，`streak_warmup.log` 是连签保活的会话与复核过程。

## 常见问题

| 现象 | 处理 |
|---|---|
| Qoder `LOGIN_REQUIRED` | 同一 Windows 用户重跑 `python scripts\qoder_extract.py` |
| Qoder `PENDING` | 每日活动未下发，等后续轮询兜底 |
| Qoder 连续 `ERROR` | 清空 `HTTP(S)_PROXY` 后重试 |
| WorkBuddy `AUTH_*` 或断签 | 桌面端重新登录，再跑 `python scripts\signin.py doctor` |
| WorkBuddy 凌晨显示「今日未签到」 | 正常，签到在主跑 10:20，零点不跑 |
| WorkBuddy 成长中心仍有未领取项 | 真人任务、能量不足、档位未解锁、抽奖次数为 0、旅行在途，都属预期。详见 [docs/workbuddy.md](docs/workbuddy.md#成长中心自动领哪些哪些领不到) |
| 成长中心连签与签到连签对不上 | 两个独立计数，见 [docs/workbuddy.md](docs/workbuddy.md#两个连签不是同一个数) |
| Trae `LOGIN_REQUIRED` | token 已过期，`node scripts\trae_keepalive.mjs` 可自动续期；仍失败则手动打开一次 Trae 确认登录态 |
| Trae `tokenDaysLeft` 持续下降 | 正常，有效期 14 天。低于 3 天时续期步骤会自动接管 |

客户端不运行时，Qoder 与 Trae 可以签到（纯 HTTP 调用）。WorkBuddy 需要客户端已安装，因为要拉起内部辅助进程解密凭据，但 GUI 不必在运行。

## 安全

- 凭据文件与日志仅存在本地，已在 `.gitignore`。修改忽略规则前确认这几条还在。
- 脚本默认不打印令牌。`qoder_extract.py --json` 会输出明文 token，仅排错时使用。
- Qoder 凭据解密依赖 DPAPI，必须在登录 Qoder 的同一 Windows 用户下提取。

## 文档

- [docs/workbuddy.md](docs/workbuddy.md)：原理、任务配置与连签保活
- [docs/qoder.md](docs/qoder.md)：原理、部署与已知问题
- [docs/qoder-internals.md](docs/qoder-internals.md)：接口契约、状态机与解密链路
- [docs/trae.md](docs/trae.md)：纯 API 方案与字段坑
- [CHANGELOG.md](CHANGELOG.md)：版本变更

## 贡献

欢迎 Issue 与 PR。改动脚本后至少跑一次语法检查（与 CI 一致）：

```powershell
python -m py_compile scripts\run_all_checkin.py scripts\qoder_checkin.py scripts\qoder_extract.py scripts\signin.py scripts\streak_warmup.py
node --check scripts\trae_auth.mjs
node --check scripts\trae_checkin_api.mjs
node --check scripts\trae_keepalive.mjs
```

## 许可证

[MIT](LICENSE) © 2026 spirodelazz。`signin.py` 来自 [88lin/workbuddy-auto-signin](https://github.com/88lin/workbuddy-auto-signin)，Qoder 脚本改编自 [wallechfox/qoder-checkin](https://github.com/wallechfox/qoder-checkin)，Trae 方案参考 [BlueChonk/trae-daily-checkin](https://github.com/BlueChonk/trae-daily-checkin)。
