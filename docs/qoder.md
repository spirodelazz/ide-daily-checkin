# Qoder 自动签到

脚本改编自 [wallechfox/qoder-checkin](https://github.com/wallechfox/qoder-checkin)（MIT），适配了国内版的安装路径与 token 格式。默认由统一任务 `AllAutoCheckin` 调用；本文的独立任务安装属于可选方案。

## 原理

Qoder 没有公开的登录接口，token 只存在客户端本地。

1. **提取（一次性）**：`qoder_extract.py` 用 DPAPI 解密 `Local State` 里的 AES 密钥，再 AES-GCM 解密 `%APPDATA%\com.qodercn.app.stable\auth.v1.dat`，得到 token 与 refreshToken。设备标识由客户端自带的 `runtime-info.exe`（`<安装目录>\.qoder-versions\<版本>\resources\umid\`，自动取最新版本目录）生成。结果写入 `qoder_config.json` 与 `qoder_accounts.json`，`expiresAt` 统一归一为 epoch 秒。
2. **签到（每日）**：`qoder_checkin.py` 带 `Bearer token` 与 `Cosy-*` 设备头，调 `openapi.qoder.com.cn` 的 `/sash/api/v1/me/campaigns` 查活动，有 `CLAIMABLE` 就 POST claim。claim 本身幂等，重复跑不会重复发币。token 到期前 72 小时自动刷新并回写文件。

## 独立任务（可选）

| 任务名 | 用途 | 触发 | 命令 | 超时 |
|---|---|---|---|---|
| `QoderAutoSignin` | 额度 10:00 刷新后立即领取 | 10:10 | `pythonw.exe qoder_checkin.py silent` | 10 分钟 |
| `QoderSigninPoll` | 轮询兜底，补 10:10 的遗漏 | 11 / 15 / 19 / 23 点 | `pythonw.exe qoder_checkin.py silent-poll` | 5 分钟 |

设置与 WorkBuddy 的任务一致：`-Hidden` 隐藏、`StartWhenAvailable` 补跑、`pythonw.exe` 静默、`IgnoreNew` 防重复。轮询用 4 个独立 Daily 触发器而非重复间隔，因为重复间隔错过后会被永久跳过。

## 首次部署与重新提取

在登录了 Qoder 客户端的同一 Windows 用户下执行：

```powershell
python scripts\qoder_extract.py
powershell -ExecutionPolicy Bypass -File scripts\install-qoder-windows.ps1
```

安装路径自适应，会依次尝试 `D:\Qoder CN\.qoder-versions\*\`、`D:\Qoder CN\`、标准路径与注册表，不需要设 `QODER_UMID_EXE`。`--no-write` 只预览不写盘，`--json` 输出明文 token（仅排错时用，勿外传）。

## 什么时候需要重新提取

看日志最后一个 JSON 行的 `result` 字段：

| result | 含义 | 处理 |
|---|---|---|
| `CLAIMED` | 签到成功 | 无 |
| `ALREADY` | 今日已领（客户端里领过或本轮已领） | 无 |
| `PENDING` | 活动未下发，等下一轮 | 无，轮询任务会兜底 |
| `ERROR` | 网络或接口异常 | 偶发忽略；连续出现再查 |
| `LOGIN_REQUIRED` | token 与 refreshToken 均失效 | 重跑 `qoder_extract.py` |

token 到期前 72 小时脚本会自动刷新。即使刷新接口失效，只要客户端还登录着，重新跑一次提取即可。

## 相关文件

都在 `scripts\` 下。

| 文件 | 说明 |
|---|---|
| `qoder_checkin.py` | 签到主脚本（单文件自包含，纯标准库） |
| `qoder_extract.py` | 凭据提取（DPAPI + AES-GCM + runtime-info.exe） |
| `install-qoder-windows.ps1` | 计划任务安装脚本（可重复运行，`-Force` 覆盖） |
| `qoder_config.json` / `qoder_accounts.json` | 设备标识与账号凭据，含有效 token，已 gitignore |
| `.qoder_token_cache.json` | 刷新后的 token 缓存 |
| `qoder_checkin.log` | 运行日志（JSON Lines，每行一次运行） |

## 已知问题

1. **任务 XML 里时间是 UTC**：`StartBoundary` 存 UTC，`02:10` 对应北京时间 10:10。
2. **凭据文件不能提交**：`qoder_accounts.json` 是有效登录凭据，已在 `.gitignore` 中。改忽略规则前确认这几条还在。
3. **接口是逆向所得**：Qoder 改版可能导致签到失效，需要重新适配。

接口契约、状态机与解密链路的代码级细节见 [qoder-internals.md](qoder-internals.md)。

## 卸载

```powershell
Unregister-ScheduledTask -TaskName "QoderAutoSignin" -Confirm:$false
Unregister-ScheduledTask -TaskName "QoderSigninPoll" -Confirm:$false

# 仅临时停用
Disable-ScheduledTask -TaskName "QoderAutoSignin"
Disable-ScheduledTask -TaskName "QoderSigninPoll"
```
