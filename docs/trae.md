# Trae CN 自动签到

参考 [BlueChonk/trae-daily-checkin](https://github.com/BlueChonk/trae-daily-checkin)（CDP 模拟点击方案）。本项目采用纯 API 方案，不启动 Trae 窗口。默认由统一任务 `AllAutoCheckin` 调用；`trae_hidden.vbs` 只在单系统独立部署时需要。

## 原理

1. **凭据**：Trae 把登录态加密存在 `%APPDATA%\Trae CN\User\globalStorage\storage.json` 的 `iCubeAuthInfo://icube.cloudide` 键下。信封格式见 `byteCrypto.js`：

   ```
   6 字节魔数头（74 63 05 10 00 00）
   + 32 字节随机 AES 密钥（随信封内嵌）
   + AES-128-CBC 密文（前 64 字节为 SHA-512 校验块）
   ```

   密钥派生：`SHA-512(key) ⊕ 硬编码 64 字节表`，再 SHA-512，前 16 字节为 AES key、次 16 字节为 IV。解密自包含，不需要机器密钥，脚本每次运行实时解密。

2. **签到接口**：base 为 `https://api.trae.cn`。

   - `POST /trae/api/v2/ug/checkin_credits/status` 查状态
   - `POST /trae/api/v2/ug/checkin_credits/claim` 领取，服务端按天幂等
   - 鉴权头：`Authorization: Cloud-IDE-JWT <token>` 与 `x-device-id`
   - token 是 JWT，有效期固定 14 天。host 与 token 都从解密后的 JSON 取，不硬编码

3. **token 续期**：客户端只在 token 剩 ≤300 秒或已过期时才用 refreshToken（约 6 个月有效）换新 token 并重新加密落盘。「偶尔打开一次 Trae」因此几乎无效，打开得太早客户端认为不必刷新。`trae_keepalive.mjs` 负责兜底：剩余不足 3 天时拉起一次 Trae 让客户端续期，复核 `expiredAt` 变新后退出；客户端已在运行时直接跳过，它会在临期时自己刷新。

## 为什么不用 CDP

| | CDP 方案 | 纯 API（本项目） |
|---|---|---|
| 启动 Trae | 需要，带调试端口拉起 GUI | 不需要 |
| 依赖 | Node 与 Trae 可执行文件 | Node ≥ 22 |
| 风险 | 需操作 GUI，renderer 进程有崩溃风险；Trae 更新可能改 DOM 类名 | 更换加密方案或接口时需要重新逆向 |

## 任务

默认部署下 Trae 的两步都挂在 `AllAutoCheckin` 里：

| 步骤 | 用途 | 顺序 | 说明 |
|---|---|---|---|
| `TraeToken` | 登录态续期 | 三套签到之前 | `trae_keepalive.mjs`，临期才动手，充裕时秒过 |
| `TraeCN` | 每日签到 | 续期之后 | `trae_checkin_api.mjs`，纯 API，本地当日去重 |

单系统独立部署（`install-trae-windows.ps1`）注册下面两个隐藏任务：

| 任务名 | 用途 | 触发 | 执行链 | 超时 |
|---|---|---|---|---|
| `TraeAutoSignin` | 每日签到 | 00:20 | `wscript trae_hidden.vbs schedule` → node | 5 分钟 |
| `TraeSigninPoll` | 轮询兜底 | 12:00 / 20:00 | `wscript trae_hidden.vbs poll` → node | 5 分钟 |

node 是控制台程序，计划任务直接跑会闪黑窗，所以用 wscript 包装：以隐藏窗口执行并把退出码传回。日志有 `trae_checkin.log` 与 `trae_keepalive.log`，都是 JSON Lines，不含敏感信息。

## 结果语义

- status 返回的 `did_checked_in` 不可靠，领取成功后仍为 `false`。脚本因此用本地日志做当日去重：当天已有 CLAIMED 或 ALREADY 记录就直接跳过 claim。
- 服务端高峰限流会返回 HTTP 200 加 `code!=0`（「当前参与用户太多，请稍后再试」），视为临时繁忙，claim 自动退避重试 3 次（15s / 30s / 45s）。当日未签时后续兜底任务也会继续重试。
- 退出码：`0` 已领取，`1` 失败，`2` 今日已签，`3` 需重新登录（token 过期，先跑 `trae_keepalive.mjs`）。
- 每条日志带 `tokenExpiresAt` 与 `tokenDaysLeft`，剩余不足 3 天时多一个 `warn` 字段。

## 相关文件

都在 `scripts\` 下。

| 文件 | 说明 |
|---|---|
| `trae_auth.mjs` | 凭据读取共用模块（信封解密 / `storage.json` / 设备号 / 剩余天数） |
| `trae_checkin_api.mjs` | 签到主脚本（零依赖，Node ≥ 22） |
| `trae_keepalive.mjs` | 登录态续期（临期拉起客户端并复核；`--status` 只看剩余天数） |
| `trae_hidden.vbs` | wscript 隐藏包装，透传退出码 |
| `install-trae-windows.ps1` | 单系统计划任务安装脚本（可重复运行） |

## 维护

```powershell
node scripts\trae_checkin_api.mjs           # 前台试跑，改代码后必做
node scripts\trae_keepalive.mjs --status    # 凭据还剩几天
node scripts\trae_keepalive.mjs             # 手动续期（--dry-run 只看会不会拉起客户端）
Start-ScheduledTask -TaskName 'TraeAutoSignin'
```

## 已知问题

1. **`ELECTRON_RUN_AS_NODE`**：从 WorkBuddy、VS Code 等 Electron 宿主的终端里手动运行时，该变量会让 Trae 以纯 Node 模式启动。纯 API 版不启动 Trae，不受影响。
2. **`x-device-id` 必须用真实设备号**：claim 校验设备号，须取 `storage.json` 键名 `iCubeAuthInfo://icube-dc:<纯数字>` 中的数字。用 `telemetry.devDeviceId`（UUID 格式）会被服务端拒绝，返回 `code:9074 "当前参与用户太多，请稍后再试"`。这条文案有误导性，实际是设备校验不通过。
3. **「两周内启动一次」不够**：客户端只在 token 剩 ≤300 秒或已过期时才续期。要么在剩不足 3 天时交给 `trae_keepalive.mjs`，要么接受过期后再打开只补当天、中间天数全丢。
4. **任务是隐藏的**：单系统部署下需要「查看 → 显示隐藏的任务」。
5. **任务 XML 存 UTC**：16:20 对应北京 00:20，04:00 对应北京 12:00。
6. **加密方案可能变**：Trae 更新若更换魔数头或接口路径，脚本会明确报「信封魔数不匹配」，需要重新逆向。
7. **9074 连续出现**：先排查设备号是否有效（见第 2 条），不要当成服务端拥堵。
