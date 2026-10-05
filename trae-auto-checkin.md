# Trae CN 每日自动签到（纯 API，无需启动客户端）

> 参考项目 [BlueChonk/trae-daily-checkin](https://github.com/BlueChonk/trae-daily-checkin)（CDP 模拟点击方案）。
> 本机最终采用**纯 API 方案**（对 Trae CN 0.5.x 逆向所得）：不启动 Trae 窗口、不依赖 GUI，直接调服务端签到接口。
> 核验时间：2026-10-06 01:49 —— 纯 API 签到实测成功（+200 Credits），两计划任务注册并端到端触发验证通过。
> **2026-10-06**：本页的 `TraeAutoSignin` / `TraeSigninPoll` 任务已并入统一任务 `AllAutoCheckin`（README「统一签到任务」），原任务已卸载；`trae_hidden.vbs` 仅独立安装 Trae 任务时需要，统一任务由 pythonw 跑 run_all_checkin.py（无控制台，无需 vbs）。

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
   - token（JWT，约 2 周过期）与 host 都在解密后的 JSON 里，**host/token 跟着凭据走，不用硬编码**
3. **token 续期**：由 Trae 客户端运行时自动刷新并重新加密落盘；脚本每次实时解密 → 自动采用最新 token。
   唯一失效场景：**Trae 连续两周未启动**且 token 过期 → 打开一次 Trae 即恢复。

## 与上游 CDP 方案的对比

| | 上游 CDP 方案 | 本机纯 API 方案（采用） |
|---|---|---|
| 启动 Trae | 需要（带调试端口拉起 GUI） | **不需要** |
| 依赖 | Node + Trae 可执行文件 | Node ≥ 22 |
| 风险 | 本机实测 renderer 崩溃（`CodeWindow: renderer process gone`）；Trae 更新可能改 DOM 类名 | Trae 更换加密方案/接口时需重新逆向 |
| 附带产物 | — | `trae_checkin.mjs`（CDP 版）保留作备用 |

## 任务总览（均隐藏）

| 任务名 | 用途 | 触发计划 | 执行链 | 超时 |
|---|---|---|---|---|
| `TraeAutoSignin` | 每日自动签到 | 每天 **00:20** | `wscript trae_hidden.vbs schedule` → node | 5 分钟 |
| `TraeSigninPoll` | 轮询兜底 | **12:00 / 20:00** | `wscript trae_hidden.vbs poll` → node | 5 分钟 |

- wscript 包装：node 是控制台程序，计划任务直接跑会闪黑窗，vbs 以隐藏窗口执行并把退出码传回
- 日志：`trae_checkin.log`（JSON Lines，无敏感信息）

## 结果语义（重要：服务端字段有坑）

- status 返回的 `did_checked_in` **实测不可靠**（领取成功后仍为 `false`），故脚本用
  **本地日志做当日去重**：当天已有 CLAIMED/ALREADY 记录则直接跳过 claim
- 退出码：0=已领取，1=失败，2=今日已签，3=需重新登录（token 过期，打开一次 Trae 即可）

## 相关文件（均在 `scripts\`）

| 文件 | 说明 |
|---|---|
| `trae_checkin_api.mjs` | 纯 API 签到主脚本（零依赖，Node ≥ 22） |
| `trae_hidden.vbs` | wscript 隐藏包装（传退出码） |
| `install-trae-windows.ps1` | 计划任务安装脚本（可重复运行） |
| `trae_checkin.mjs` | CDP 版备用脚本（需启动 Trae GUI，本机 renderer 崩溃未走通） |
| `trae_checkin.log` | 运行日志（JSON Lines，已 gitignore） |

## 维护

```powershell
# 前台试跑（改代码后必做）
node scripts\trae_checkin_api.mjs
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
2. **token 续期依赖 Trae 运行**：约每 2 周内至少启动一次 Trae CN；日志出现 `LOGIN_REQUIRED` 时打开一次即可
3. **任务 XML 存 UTC**：16:20 = 北京 00:20、04:00 = 北京 12:00
4. Trae 更新若更换加密方案（魔数头变化）或接口路径，脚本会明确报"信封魔数不匹配"——需重新逆向
