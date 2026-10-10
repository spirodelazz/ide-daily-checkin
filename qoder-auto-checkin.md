# Qoder 每日自动签到（Windows 任务计划程序）

> Qoder 签到系统详情：原理、单系统独立部署（可选）、排障与卸载。
> 脚本改编自 [wallechfox/qoder-checkin](https://github.com/wallechfox/qoder-checkin)（MIT），适配国内版安装路径与 token 格式。
> 默认由统一任务 `AllAutoCheckin` 调用（见 [README.md](README.md)「统一签到任务」）；本文的独立任务安装为可选方案。
> 相关：代码级细节（接口契约/数据格式/上游差异）见 [QODER.md](QODER.md)。

## 原理

Qoder 没有公开登录接口，token 只存在客户端本地：

1. **提取（一次性）**：`qoder_extract.py` 用 DPAPI 解密 `Local State` 里的 AES 密钥，再 AES-GCM 解密 `%APPDATA%\com.qodercn.app.stable\auth.v1.dat` 得到 token/refreshToken；设备标识由客户端自带 `runtime-info.exe`（`<安装目录>\.qoder-versions\<版本>\resources\umid\`，自动取最新版本目录）生成。结果写入 `qoder_config.json` + `qoder_accounts.json`，`expiresAt` 一律归一为 epoch 秒
2. **签到（每日）**：`qoder_checkin.py` 带 `Bearer token` + `Cosy-*` 设备头调 `openapi.qoder.com.cn` 的 `/sash/api/v1/me/campaigns` 查活动，有 `CLAIMABLE` 就 POST claim（**幂等**，重复跑不会重复发币）。token 到期前 72h 自动刷新并回写文件

## 任务总览

| 任务名 | 用途 | 触发计划 | 执行命令 | 超时 |
|---|---|---|---|---|
| `QoderAutoSignin` | 每日自动签到（额度 10:00 刷新后立即领取） | 每天 **10:10** | `pythonw.exe qoder_checkin.py silent` | 10 分钟 |
| `QoderSigninPoll` | 轮询兜底（刷新延迟/10:10 错过时补领） | 每天 **11/15/19/23** 点 | `pythonw.exe qoder_checkin.py silent-poll` | 5 分钟 |

### 公共设置（与 WorkBuddy 两任务一致）

- **隐藏任务**：`-Hidden`，任务计划程序需「查看 → 显示隐藏的任务」才可见
- **错过补跑**：`StartWhenAvailable=true`，关机/睡眠错过的时点开机后补跑
- **静默运行**：`pythonw.exe` 无窗口；每次运行追加一行 JSON 到 `qoder_checkin.log`
- **防重复**：`MultipleInstancesPolicy=IgnoreNew`
- **轮询用 4 个独立 Daily 触发器**（11/15/19/23 点，非重复间隔）：重复间隔错过会被永久跳过，独立触发器配合 `StartWhenAvailable` 才会补跑

## 首次部署 / 重新提取

在**登录了 Qoder 客户端的同一 Windows 用户**下执行：

```powershell
cd scripts
python qoder_extract.py            # 提取并写回配置
python install-qoder-windows.ps1   # 注册/重装两个计划任务
```

- 安装路径自适应：自动尝试 `D:\Qoder CN\.qoder-versions\*\`、`D:\Qoder CN\`、标准路径与注册表，无需设 `QODER_UMID_EXE`
- 预览不写盘：`python qoder_extract.py --no-write`；需要明文 token 时用 `--json`（勿外传）

## 什么时候需要重新提取

看日志最后一个 JSON 行的 `result` 字段：

| result | 含义 | 处理 |
|---|---|---|
| `CLAIMED` | 签到成功 | 无 |
| `ALREADY` | 今日已领（客户端里领过或本轮已领） | 无 |
| `PENDING` | 活动未下发，等下一轮 | 无（轮询任务会兜底） |
| `ERROR` | 网络/接口异常 | 偶发忽略；连续出现再查 |
| `LOGIN_REQUIRED` | token 与 refreshToken 均失效 | 重跑 `qoder_extract.py` |

token 到期前 72h 脚本会自动刷新；即使刷新接口失效，只要还登录着 Qoder 客户端，重新跑一次提取即可。

## 相关文件（均在 `scripts\`）

| 文件 | 说明 |
|---|---|
| `qoder_checkin.py` | 签到主脚本（单文件自包含，纯标准库） |
| `qoder_extract.py` | 凭据提取脚本（DPAPI + AES-GCM + runtime-info.exe） |
| `install-qoder-windows.ps1` | 计划任务安装脚本（可重复运行，`-Force` 覆盖） |
| `qoder_config.json` / `qoder_accounts.json` | 设备标识 + 账号凭据（**含有效 token，已加 .gitignore，绝不提交**） |
| `.qoder_token_cache.json` | 刷新后的 token 持久化缓存 |
| `qoder_checkin.log` | 运行日志（JSON Lines，每行一次运行） |

```powershell
# 看日志
Get-Content scripts\qoder_checkin.log -Tail 5
# 手动触发一次
Start-ScheduledTask -TaskName 'QoderAutoSignin'
```

## 卸载 / 停用

```powershell
Unregister-ScheduledTask -TaskName "QoderAutoSignin" -Confirm:$false
Unregister-ScheduledTask -TaskName "QoderSigninPoll" -Confirm:$false
# 仅临时停用
Disable-ScheduledTask -TaskName "QoderAutoSignin"
Disable-ScheduledTask -TaskName "QoderSigninPoll"
```

## 已知坑

1. **任务 XML 里时间是 UTC**：`StartBoundary` 存 UTC，如 `02:10` 对应北京时间 10:10，核对时别误判
2. **凭据文件绝不能提交 git**：`qoder_accounts.json` 是有效登录凭据，已在 `.gitignore` 中；改动 `.gitignore` 前务必确认这几条还在
3. **客户端升级可能使接口失效**：签到接口是逆向所得，Qoder 改版可能需要重新适配（上游仓库会跟进）
