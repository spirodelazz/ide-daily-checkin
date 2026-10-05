# ide-daily-checkin · 三合一自动签到（WorkBuddy + Qoder + Trae CN）

> Windows 任务计划程序驱动的每日自动签到合集：一个统一任务顺序完成三套签到，全部幂等、静默、错过补跑。
> 签到接口均从各客户端逆向所得，仅供学习交流，请用于自己的账号并自担风险。
> 详细文档：[workbuddy-scheduled-tasks.md](workbuddy-scheduled-tasks.md) · [qoder-auto-checkin.md](qoder-auto-checkin.md) · [trae-auto-checkin.md](trae-auto-checkin.md)

## 快速开始

### 前置条件

- Windows 10/11，三款客户端各登录一次：WorkBuddy、Qoder、Trae CN
- Python 3.8+（计划任务用 pythonw 静默运行）
- Node.js ≥ 22（仅 Trae 签到需要）

### 三步部署（无需管理员权限）

```powershell
# ① 提取 Qoder 凭据（只需一次；须用登录 Qoder 的同一 Windows 用户运行）
python scripts\qoder_extract.py

# ② 注册统一计划任务（每天 10:20 主跑 + 15:00 / 20:30 兜底，全程静默无窗口）
powershell -ExecutionPolicy Bypass -File scripts\install-all-checkin.ps1

# ③ 查看日志确认
Get-Content scripts\all_checkin.log -Tail 5
```

WorkBuddy / Trae **没有提取步骤**——脚本每次运行自动从客户端本地存储读取凭据；
Trae 的 token 由客户端运行时自动续期，约每两周启动一次 Trae 即可保持登录态。

卸载：`Unregister-ScheduledTask -TaskName "AllAutoCheckin" -Confirm:$false`

## 一、系统总览

| 系统 | 领什么 | 凭据来源 | 签到接口 | 详细文档 |
|---|---|---|---|---|
| **WorkBuddy** | 每日积分 + 成长中心（礼物/任务/补登/兑换/抽奖） | WorkBuddy 桌面端登录后自动写入的加密凭据文件，运行时经客户端原生态解密 | `copilot.tencent.com/v2/billing/meter/*`（逆向所得） | [workbuddy-scheduled-tasks.md](workbuddy-scheduled-tasks.md) |
| **Qoder** | 每日 100 Credits | `qoder_extract.py` 从 Qoder 客户端本地解密（DPAPI + AES-GCM），一次性提取 | `openapi.qoder.com.cn/sash/api/v1/me/campaigns/*`（逆向所得） | [qoder-auto-checkin.md](qoder-auto-checkin.md) |
| **Trae CN** | 每日 200 积分 | 每次运行实时解密 `storage.json` 里的加密登录态（自包含信封，无需客户端参与） | `api.trae.cn/trae/api/v2/ug/checkin_credits/*`（逆向所得） | [trae-auto-checkin.md](trae-auto-checkin.md) |

### 统一签到任务

| 任务名 | 触发（独立 Daily 触发器） | 执行 | 时限 |
|---|---|---|---|
| `AllAutoCheckin` | 每天 **10:20**（主跑）+ **15:00 / 20:30**（兜底） | `pythonw run_all_checkin.py` 顺序跑三套 | 15 分钟 |

- **主跑选 10:20 的原因**：Qoder 额度 10:00（UTC+8）刷新后立即可领；WorkBuddy / Trae 当天任意时间签均有效
- 三套全部幂等，重复运行安全：WorkBuddy 用 `silent-poll`（未签才签）、Qoder claim 幂等、Trae 本地当日去重
- 顺序执行、单系统超时隔离（WB 420s / Qoder 120s / Trae 120s），任一失败不影响其余
- 日志：**`all_checkin.log` 是唯一需要查看的文件**——每次运行先汇入三套各自的新增明细行（`script` 字段区分归属），最后一行是 `run_all_checkin` 汇总；`signin.log` / `qoder_checkin.log` / `trae_checkin.log` 保留为脚本原生日志（上游兼容），日常无需查看
- 也可单系统独立部署：分别运行 `scripts\install-windows.ps1` / `install-qoder-windows.ps1` / `install-trae-windows.ps1`（与统一任务二选一，同时装会造成重复触发点）
- 手动立即跑一次：`Start-ScheduledTask -TaskName 'AllAutoCheckin'`，或前台 `python run_all_checkin.py`
- 注意：WorkBuddy 的 `silent-poll` 空跑（当天已签且成长中心无事可做）不落明细行，但汇总行始终存在

### 公共设计约定（三套系统一致，改动前先读）

- **pythonw 静默**：无窗口运行，结果只落 JSON 行日志（`signin.log` / `qoder_checkin.log` / `trae_checkin.log`），每行一次运行
- **隐藏任务**：任务计划程序需「查看 → 显示隐藏的任务」才可见；命令行用 `Get-ScheduledTask`
- **错过补跑**：`StartWhenAvailable=true`，关机/睡眠错过的时点开机后补跑
- **防重复实例**：`MultipleInstancesPolicy=IgnoreNew`
- **轮询用多个独立 Daily 触发器**，不用"重复间隔"——后者错过会被永久跳过且不补跑（实测教训，见 install 脚本注释）
- **幂等领取**：重复运行不会重复发币，轮询兜底零风险
- **任务 XML 里时间是 UTC**（如 16:10 = 北京 00:10），核对时注意
- **凭据文件全部在 `.gitignore`**，绝不提交

## 二、目录结构

```
ide-daily-checkin\
├── README.md                        ← 本文件：总览 + 维护手册
├── workbuddy-scheduled-tasks.md     ← WorkBuddy 系统详情
├── qoder-auto-checkin.md            ← Qoder 系统详情
├── trae-auto-checkin.md             ← Trae 系统详情
├── LICENSE                          ← MIT（含第三方归属声明）
├── .gitignore                       ← 凭据与日志绝不入库
└── scripts\
    ├── run_all_checkin.py           统一主控：顺序跑三套签到，汇总 all_checkin.log
    ├── install-all-checkin.ps1      统一任务安装脚本（注册 AllAutoCheckin）
    ├── signin.py                    WorkBuddy 签到（来自上游 88lin，见 LICENSE 归属）
    ├── qoder_checkin.py             Qoder 签到（改编自 wallechfox/qoder-checkin）
    ├── qoder_extract.py             Qoder 凭据提取（DPAPI + AES-GCM，一次性）
    ├── trae_checkin_api.mjs         Trae 签到（纯 API，无需启动客户端）
    ├── trae_hidden.vbs              Trae 独立安装时的隐藏包装
    ├── trae_checkin.mjs             Trae CDP 参考实现（改编自 BlueChonk 上游，需启动 GUI）
    ├── install-qoder-windows.ps1 / install-trae-windows.ps1   单系统任务安装脚本
    ├── qoder_config.json / qoder_accounts.json / .qoder_token_cache.json   Qoder 凭据（已 gitignore）
    └── signin.log / qoder_checkin.log / trae_checkin.log / all_checkin.log 日志（已 gitignore）
```

## 三、整体流程

### WorkBuddy（凭据不落地，运行时解密）

```
桌面端登录 → 自动写加密凭据文件（CodeBuddyExtension/Data/Public/auth/workbuddy-desktop.info）
    ↓ 每天 00:05 / 6 轮轮询
signin.py silent(-poll)
    ├─ find_workbuddy_runtime() 定位客户端 → _run_auth_helper() 原生接口解密会话
    ├─ 查签到状态 → 未签则领取（幂等）→ 成长中心全套（补登卡每轮限用 1 张）
    ├─ 自设时间预算（签到 420s/轮询 180s，小于任务时限，保证总能走到写日志）
    └─ 网络退避重试 (5,15,30,60,90s) → signin.log
```

凭据失效处理：桌面端**重新登录即可**，脚本自动重新探测，无需手工提取。

### Qoder（凭据落盘，运行时读文件）

```
【一次性】qoder_extract.py
    ├─ 定位客户端：env → D:\Qoder CN\.qoder-versions\<版本>\ → D:\Qoder CN\resources\ → 注册表
    ├─ runtime-info.exe 生成 Cosy-* 设备标识
    ├─ DPAPI 解密 Local State 的 AES 密钥 → AES-GCM 解密 auth.v1.dat → token/refreshToken
    └─ 写 qoder_config.json + qoder_accounts.json（expiresAt 统一转 epoch 秒）

【每日】qoder_checkin.py silent(-poll)
    ├─ ensure_token：有效直用 → 到期前 72h 自动刷新（refresh 接口）→ 401 强刷兜底
    ├─ GET campaigns → 筛 CLAIM_BENEFIT 且 CLAIMABLE → POST claim（幂等）
    ├─ 刷新/轮换后的 token 写回 accounts.json + 缓存文件
    └─ qoder_checkin.log（出现 LOGIN_REQUIRED 时重跑 qoder_extract.py）
```

## 四、日常维护手册

```powershell
# 看最新签到结果（各看一行 JSON）
Get-Content scripts\signin.log -Tail 1
Get-Content scripts\qoder_checkin.log -Tail 1

# 手动触发（补跑/测试，三套一起跑）
Start-ScheduledTask -TaskName 'AllAutoCheckin'

# 前台调试（直接看输出，不写计划任务）
python scripts\qoder_checkin.py
python scripts\signin.py status

# 任务状态（XML 核实最可靠：C:\Windows\System32\Tasks\<任务名>，UTF-16）
Get-ScheduledTask -TaskName 'AllAutoCheckin' | Select TaskName,State
```

### 故障排查

| 现象 | 定位 | 处理 |
|---|---|---|
| Qoder 日志 `LOGIN_REQUIRED` | token 与 refreshToken 均失效 | 同一 Windows 用户重跑 `python qoder_extract.py` |
| Qoder 日志 `PENDING` | 每日活动未下发 | 无需处理，轮询任务会兜底 |
| Qoder 连续 `ERROR` 查询失败 | 接口可能改版 / 代理拦截 | 清 `HTTP(S)_PROXY` 环境变量试一次；看上游仓库是否有适配更新 |
| WorkBuddy 断签 / `AUTH_*` 错误 | 凭据或客户端版本问题 | 桌面端重新登录；`python signin.py doctor` 离线体检 |
| 任务"不存在"但曾配好 | 隐藏任务被过滤 | 「查看 → 显示隐藏的任务」；或直接读任务 XML |
| 改了脚本想重装任务 | — | 重跑对应 install-*.ps1（可重复执行，`-Force` 覆盖） |

### 卸载

```powershell
# 统一任务
Unregister-ScheduledTask -TaskName "AllAutoCheckin" -Confirm:$false
# 或恢复为按系统的 6 个独立任务：分别运行三个 install-*.ps1 / install-windows.ps1
```

## 五、常见问题

**Q：本地不运行 WorkBuddy / Qoder 客户端，也能自动签到吗？**

| 系统 | 客户端不运行 | 客户端被卸载/凭据被清 | 说明 |
|---|---|---|---|
| Qoder | ✅ 完全可以 | ❌ 无法再提取，签到会断 | 签到是纯 HTTP 调用（token + Cosy-* 静态设备头），客户端只在提取凭据时需要。token 到期前 72h 自动刷新（纯服务端接口）；token 与 refreshToken 都失效才需要打开客户端登录一次并重跑 `qoder_extract.py`。上游项目本就面向无客户端的 NAS/青龙部署 |
| WorkBuddy | ⚠️ 可以，但依赖客户端**已安装** | ❌ 签到会断 | 每次运行时脚本会短暂拉起客户端安装目录里的 runtime 辅助进程解密磁盘上的凭据文件（`workbuddy-desktop.info`），GUI 无需正在运行；但卸载客户端或凭据文件丢失后无法解密。会话失效时需桌面端重新登录 |
| Trae CN | ✅ 完全可以（纯 API） | ❌ 签到会断 | 凭据从本地加密存储实时解密，签到是纯 HTTP 调用。注意：token 约 2 周过期、续期靠 Trae 客户端运行时刷新——**每两周内至少启动一次 Trae**，否则日志报 LOGIN_REQUIRED |

**Q：电脑整机关机呢？** 本方案依赖开机——错过的时点开机后补跑（StartWhenAvailable）。Qoder 单日错过整天则当日额度作废；若需 7×24 领取，Qoder 可迁往常开的 NAS/青龙面板（上游设计目标，把 qoder_config.json / qoder_accounts.json 带上即可），WorkBuddy 也可部署到任何装了客户端并登录过的常开机器（上游另有 macOS launchd 配置示例；Linux 端 CodeBuddy CLI 写出的凭据格式相同）。

## 六、安全红线

1. `qoder_accounts.json` / `qoder_config.json` / `.qoder_token_cache.json` 是**有效登录凭据**，已在 `.gitignore`；改动 `.gitignore` 前确认这几条还在
2. 各脚本均不打印令牌；Qoder 的 `qoder_extract.py --json` 会输出明文 token，仅排障时用、勿外传
3. Qoder 凭据解密依赖 DPAPI，**必须在登录 Qoder 的同一 Windows 用户下运行**提取脚本
4. 三套签到接口均为逆向所得，客户端升级可能导致失效：WorkBuddy 修复看上游 [88lin/workbuddy-auto-signin](https://github.com/88lin/workbuddy-auto-signin)，Qoder 看 [wallechfox/qoder-checkin](https://github.com/wallechfox/qoder-checkin)

## 七、归属与致谢

- `scripts/signin.py` 来自 [88lin/workbuddy-auto-signin](https://github.com/88lin/workbuddy-auto-signin)（MIT），按许可证原样收录
- `scripts/qoder_checkin.py` / `qoder_extract.py` 改编自 [wallechfox/qoder-checkin](https://github.com/wallechfox/qoder-checkin)（MIT）
- `scripts/trae_checkin.mjs`（CDP 备用方案）改编自 [BlueChonk/trae-daily-checkin](https://github.com/BlueChonk/trae-daily-checkin)
- Trae 纯 API 路线、Qoder 10:00 刷新时间等均经实机验证

