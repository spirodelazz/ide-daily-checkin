---
doc-type: how-to
reader: 在 Windows 上部署、排查或卸载 Trae CN 每日签到的人
asof: 2026-11-01
---

# Trae CN 每日自动签到（纯 API，无需启动客户端）

> 参考 [BlueChonk/trae-daily-checkin](https://github.com/BlueChonk/trae-daily-checkin)（CDP 模拟点击方案），本项目采用**纯 API 方案**（对 Trae CN 逆向所得）：不启动 Trae 窗口、不依赖 GUI。
> 默认由统一任务 `AllAutoCheckin` 调用（见 [README.md](README.md)）；`trae_hidden.vbs` 仅单系统独立部署时需要。

## 原理

1. **凭据**：Trae 把登录态加密存于 `%APPDATA%\Trae CN\User\globalStorage\storage.json` 的
   `iCubeAuthInfo://icube.cloudide` 键。信封格式（`byteCrypto.js`）：`6 字节魔数头(74 63 05 10 00 00)
   + 32 字节随机 AES 密钥（内嵌！）
   + AES-128-CBC 密文（前 64 字节为 SHA-512 校验块）`。
   密钥派生 = SHA-512(key) ⊕连接 硬编码 64 字节表 → 再 SHA-512 → 前 16 字节为 AES key、次 16 字节为 IV。
   **解密自包含，无需机器密钥**，脚本每次运行实时解密。
2. **签到接口**：`https://api.trae.cn`
   - `POST /trae/api/v2/ug/checkin_credits/status`（查状态）
   - `POST /trae/api/v2/ug/checkin_credits/claim`（领取，服务端按天幂等）
   - 鉴权头：`Authorization: Cloud-IDE-JWT <token>` + `x-device-id`
   - token（JWT，**有效期固定 14 天**）与 host 都在解密后的 JSON 里，**host/token 跟着凭据走，不用硬编码**
3. **token 续期**：客户端**只在 token 剩 ≤300 秒或已过期时**才用 `refreshToken`（约 6 个月有效）换新 token 并重新加密落盘。
   因此「偶尔打开一次 Trae」几乎无效——打开得太早，客户端认为不必刷新；10-16 ~ 10-23 连续启动 6 次都没续期，
   10-24 之后没再打开，token 在 10-29 02:42 过期，签到便一直 `LOGIN_REQUIRED`。
   兜底由 `trae_keepalive.mjs` 负责：剩量低于 3 天时拉起一次 Trae 让客户端续期，复核 `expiredAt` 变新后退出；
   客户端已在运行时直接跳过（它会在临期时自己刷新）。

## 与上游 CDP 方案的对比

| | 上游 CDP 方案 | 纯 API 方案（本项目采用） |
|---|---|---|
| 启动 Trae | 需要（带调试端口拉起 GUI） | **不需要** |
| 依赖 | Node + Trae 可执行文件 | Node ≥ 22 |
| 风险 | 需操作 GUI，实测存在 renderer 进程崩溃风险；Trae 更新可能改 DOM 类名 | Trae 更换加密方案/接口时需重新逆向 |
| 附带产物 | — | `trae_checkin.mjs`（CDP 版）保留作备用 |

## 任务总览

默认部署下 Trae 的两步都挂在统一任务 `AllAutoCheckin` 里（见 [README.md](README.md)）：

| 步骤 | 用途 | 顺序 | 说明 |
|---|---|---|---|
| `TraeToken` | 登录态续期 | 三套签到之前 | `trae_keepalive.mjs`，临期才动手，充裕时秒过；下限漏了就退回"需登录" |
| `TraeCN` | 每日自动签到 | 续期之后 | `trae_checkin_api.mjs`，纯 API，本地当日去重 |

单系统独立部署（`install-trae-windows.ps1`）仍注册下面两个隐藏任务：

| 任务名 | 用途 | 触发计划 | 执行链 | 超时 |
|---|---|---|---|---|
| `TraeAutoSignin` | 每日自动签到 | 每天 **00:20** | `wscript trae_hidden.vbs schedule` → node | 5 分钟 |
| `TraeSigninPoll` | 轮询兜底 | **12:00 / 20:00** | `wscript trae_hidden.vbs poll` → node | 5 分钟 |

- wscript 包装：node 是控制台程序，计划任务直接跑会闪黑窗，vbs 以隐藏窗口执行并把退出码传回
- 日志：`trae_checkin.log`（签到）、`trae_keepalive.log`（续期），均为 JSON Lines，无敏感信息

## 结果语义（重要：服务端字段有坑）

- status 返回的 `did_checked_in` **实测不可靠**（领取成功后仍为 `false`），故脚本用
  **本地日志做当日去重**：当天已有 CLAIMED/ALREADY 记录则直接跳过 claim
- 服务端高峰限流（HTTP 200 + code!=0 + "当前参与用户太多，请稍后再试"）视为临时繁忙，
  claim 自动退避重试 3 次（15s/30s/45s）；当日未签时后续兜底任务也会继续重试
- 退出码：0=已领取，1=失败，2=今日已签，3=需重新登录（token 过期，先跑 `trae_keepalive.mjs`）
- 每条日志都带 `tokenExpiresAt` / `tokenDaysLeft`，凭据到期时间可直接从 `all_checkin.log` 回溯；
  剩余不足 3 天时该条记录还会多一个 `warn` 字段

## 相关文件（均在 `scripts\`）

| 文件 | 说明 |
|---|---|
| `trae_auth.mjs` | 凭据读取共用模块（信封解密 / `storage.json` / 设备号 / 剩余天数） |
| `trae_checkin_api.mjs` | 纯 API 签到主脚本（零依赖，Node ≥ 22） |
| `trae_keepalive.mjs` | 登录态续期（临期拉起客户端 + 复核；`--status` 只看剩余天数） |
| `trae_hidden.vbs` | wscript 隐藏包装（传退出码） |
| `install-trae-windows.ps1` | 单系统计划任务安装脚本（可重复运行） |
| `trae_checkin.mjs` | CDP 版参考脚本（改编自上游，需启动 Trae GUI） |
| `trae_checkin.log` / `trae_keepalive.log` | 运行日志（JSON Lines，已 gitignore） |

## 维护

```powershell
# 前台试跑（改代码后必做）
node scripts\trae_checkin_api.mjs
# 看凭据还剩几天
node scripts\trae_keepalive.mjs --status
# 手动续期（--dry-run 只看会不会拉起客户端）
node scripts\trae_keepalive.mjs
# 手动触发
Start-ScheduledTask -TaskName 'TraeAutoSignin'
# 重装任务
powershell -ExecutionPolicy Bypass -File scripts\install-trae-windows.ps1
# 卸载
Unregister-ScheduledTask -TaskName "TraeAutoSignin","TraeSigninPoll" -Confirm:$false
```

## 已知坑

1. **ELECTRON_RUN_AS_NODE**：从 WorkBuddy / VS Code 等 Electron 宿主的终端里手动运行时，
   该环境变量会让 Trae 以纯 Node 模式启动（CDP 版受影响；纯 API 版不启动 Trae，不受影响）
2. **x-device-id 必须用真实设备号**：claim 接口校验设备号，须取 storage.json 键名
   `iCubeAuthInfo://icube-dc:<纯数字>` 中的数字。用 `telemetry.devDeviceId`（UUID 格式）会被
   服务端拒绝，返回 `code:9074 "当前参与用户太多，请稍后再试"`——该文案有误导性，实为设备校验不通过
3. **「两周内启动一次」是不够的**：客户端只在 token 剩 ≤300 秒或已过期时才续期，提前打开等于没打开。
   要么在剩不足 3 天时交给 `trae_keepalive.mjs` 处理，要么接受"过期后再打开只补当天、中间天数全丢"
4. **任务是隐藏的**：单系统部署下 `TraeAutoSignin` / `TraeSigninPoll` 在任务计划程序里需「查看 → 显示隐藏的任务」
5. **任务 XML 存 UTC**：16:20 = 北京 00:20、04:00 = 北京 12:00
6. Trae 更新若更换加密方案（魔数头变化）或接口路径，脚本会明确报"信封魔数不匹配"——需重新逆向
7. 脚本遇到 9074 会退避重试；但若连续多轮全天候 9074，应优先排查设备号是否有效（见坑 2），而非当作服务端拥堵
