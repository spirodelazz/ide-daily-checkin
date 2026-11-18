# Qoder 代码级细节

接口契约、状态机与解密链路。用户视角的部署与排障见 [qoder.md](qoder.md)。Qoder 部分改编自上游 [wallechfox/qoder-checkin](https://github.com/wallechfox/qoder-checkin)（MIT）。

## 文件清单

```
qoder_checkin.py          签到主脚本（单文件自包含，纯标准库）
qoder_extract.py          凭据提取（DPAPI + AES-GCM + runtime-info.exe，一次性/失效重跑）
install-qoder-windows.ps1 注册计划任务 QoderAutoSignin + QoderSigninPoll
qoder_config.json         设备标识（Cosy-*）+ baseUrls + notify + refreshMarginH
qoder_accounts.json       账号数组（accessToken / refreshToken / expiresAt / uid / name）
.qoder_token_cache.json   刷新后 token 的持久化缓存（按账号键隔离）
qoder_checkin.log         运行日志（JSON Lines，每行一次运行）
```

凭据与日志文件都在 `.gitignore` 内，不提交。

## 代码地图

```
路径常量          HERE 下 qoder_ 前缀文件（env QODER_CONFIG_FILE / QODER_ACCOUNTS_FILE 可覆盖）
配置读取          read_json / CONFIG / _env_or_conf（env 优先于 config）
设备头            device_headers()：config.json 的 device 块 → Cosy-* 请求头（env 可覆盖）
HTTP              _raw() 单请求；api_call() 端点轮换：网络错误(0)/404 换下一个 base，
                  其余状态码（含 401）视为该端点已给出结论，记住可用的 _BASE
过期时间          jwt_exp()（JWT 解 exp，国内版 dt- 令牌非 JWT 恒为 0）
                  coerce_exp()：ISO 字符串 / epoch 秒 / epoch 毫秒 → 统一 epoch 秒
token 刷新        do_refresh()：POST /api/v1/deviceToken/refresh {"refresh_token": ...}
持久化            persist()：写缓存 + 回写 accounts.json（token 轮换后不丢）
账号加载          load_accounts()：env QODER_ACCOUNTS + accounts 文件 → 按 uid/refreshToken 去重 → apply_cache
签到核心          ensure_token() 三层策略：
                    1) token 有效（距过期 > refreshMarginH=72h）→ 直接用
                    2) 临近过期 → do_refresh，成功后持久化
                    3) 收到 401 → ensure_token(force=True) 强刷后重试一次
                  run_account() 状态机：claimed / already / pending / login_required / error
                  查不到 CLAIM_BENEFIT 活动时按 pending 处理，并在本次运行内重查
                  （默认 3 次 × 20 秒，env QODER_EMPTY_RETRY / QODER_EMPTY_WAIT 可覆盖）
输出              push()（企业微信/PushPlus/Webhook，配置留空即关）+ log_run()（JSON 行落盘）
入口              main(argv)：silent / silent-poll / poll（仅影响日志 trigger 字段）；
                  pythonw 下 stdout 为 None 已兜底；顶层 try/except 保证异常也落日志
```

### 状态机

`run_account()` 返回的 phase：

| phase | 触发条件 | 后续 |
|---|---|---|
| `claimed` | claim 返回 200 且 status=CLAIMED | 完成，credits 累加 |
| `already` | 活动已 CLAIMED（在 startAt~endAt 内） | 无需处理 |
| `pending` | 无 CLAIM_BENEFIT 活动（重查满次数仍为空），或有活动但均非 CLAIMABLE | 等兜底轮次 |
| `login_required` | 401 且强刷失败 | 重跑 `qoder_extract.py` |
| `error` | HTTP 非 200/401、claim 部分失败、本地异常 | 看 msg 字段定位 |

空列表必须归 `pending`，不能归 `already`。`already` 在下游等价于成功（退出码 0、汇总 ok），归错会导致既没领到也没重试、也没告警。

## 解密链路

```
1. 定位数据目录   %APPDATA%\com.qoder.app.* / com.qodercn.app.*（mtime 最新优先；env QODER_AUTH_DIR 可覆盖）
2. 设备标识       runtime-info.exe --account-stdin → machineToken/machineCode/machineType
                  候选顺序：env QODER_UMID_EXE → D:\Qoder CN\.qoder-versions\<版本>\（最新优先）
                  → D:\Qoder CN\resources\ → 标准安装路径 → 注册表 Uninstall 键
                  version 取所选 exe 旁的 resources/build-manifest.json
3. machineId      数据目录下 auth.machine-id
4. token          auth.v1.dat（前缀须为 b"v10"）
                  → Local State 的 os_crypt.encrypted_key（base64，去 5 字节前缀）
                  → DPAPI CryptUnprotectData（须同一 Windows 用户）得 32 字节 AES 密钥
                  → AES-GCM 解密：nonce=raw[3:15]，密文+tag=raw[15:]（优先 cryptography 库，缺则退回 CNG bcrypt）
5. expiresAt      coerce_exp() 归一为 epoch 秒后写入
                  客户端存的是 ISO 字符串，直接与 time.time() 相减会 TypeError
6. 写回           qoder_config.json（补全默认块）+ qoder_accounts.json（按 uid/refreshToken 去重，
                  优先填充空白账号，否则追加）
```

## 接口契约

以下均为逆向所得，改版会失效。请求统一带 `Authorization: Bearer <accessToken>` 与 `Cosy-ClientType` / `Cosy-MachineOS` / `Cosy-MachineHostname` / `Cosy-MachineId` / `Cosy-MachineToken` / `Cosy-MachineCode` / `Cosy-MachineType` / `Cosy-Version` 请求头。base 为 `https://openapi.qoder.com.cn`，国际服是 `https://openapi.qoder.sh`。

| 端点 | 方法 | 说明 |
|---|---|---|
| `/sash/api/v1/me/campaigns` | GET | 活动列表，形如 `{campaigns:[{campaignId, name, actionType, claimStatus, benefit:{amount}, startAt, endAt}]}`。只关心 `actionType=CLAIM_BENEFIT` 且 `claimStatus=CLAIMABLE` |
| `/sash/api/v1/me/campaigns/{cid}/claim` | POST | body `{}`。成功返回 `{status:"CLAIMED", benefit:{amount}}`，幂等 |
| `/api/v1/deviceToken/refresh` | POST | body `{"refresh_token": ...}`。返回 `device_token` 与 `refresh_token`（可能轮换）、`expires_at`（ISO 字符串） |

## 数据文件格式

```jsonc
// qoder_config.json（设备标识由 extract 写入，一般不手改；notify 留空即关闭推送）
{
  "device": { "clientType": "10", "machineOS": "x86_64_windows", "machineHostname": "...",
              "machineId": "...", "machineToken": "...", "machineCode": "...",
              "machineType": "...", "version": "0.4.3" },
  "notify": { "qywxToken": "", "plusplusToken": "", "webhook": "" },
  "baseUrls": ["https://openapi.qoder.com.cn"],
  "refreshMarginH": 72
}

// qoder_accounts.json（expiresAt 为 epoch 秒；token 轮换后由脚本自动回写）
{ "accounts": [ { "name": "Qoder账号1", "uid": "", "accessToken": "dt-...",
                  "refreshToken": "drt-...", "expiresAt": 1792325634 } ] }

// qoder_checkin.log（每行一次运行；result 取 CLAIMED/ALREADY/PENDING/ERROR，
//                     全部 phase 已领且无失败时为 ALREADY）
{"time": "2026-10-05 17:42:23", "script": "qoder_checkin", "trigger": "poll",
 "result": "ALREADY", "summary": {"claimed": 0, "already": 1, "pending": 0, "failed": 0},
 "results": [{"name": "Qoder账号1", "uid": "-", "phase": "already", "msg": "今日已领取", "credits": 0}]}
```

## 与上游的差异

1. **expiresAt 归一**：国内客户端的 `expiresAt` 是 ISO 字符串，`coerce_exp()` 统一转成 epoch 秒后再参与数值比较
2. **安装路径**：客户端可装在自定义路径（如 `D:\Qoder CN`），注册表 InstallLocation 可能为空，提取脚本按版本目录自动定位 `runtime-info.exe`，无需 `QODER_UMID_EXE`
3. **文件名前缀**：统一加 `qoder_`，与同目录的 signin.py、trae 脚本互不冲突
4. **pythonw 兜底**：stdout/stderr 为 None 时重定向 devnull；顶层异常强制落日志，否则任务被杀当天日志整条丢失
5. **单文件**：上游 `qoder_core.py` 加 `02_checkin.py` 的逻辑合并在一个脚本里，无文件跳转

## 维护

```powershell
# 重新提取（LOGIN_REQUIRED 时；须登录 Qoder 的同一 Windows 用户）
python scripts\qoder_extract.py            # --no-write 预览 / --json 输出明文 token（勿外传）

# 重装计划任务（可重复运行）
powershell -ExecutionPolicy Bypass -File scripts\install-qoder-windows.ps1

# 前台试跑（改代码后必做）
python scripts\qoder_checkin.py

# 卸载任务
Unregister-ScheduledTask -TaskName "QoderAutoSignin","QoderSigninPoll" -Confirm:$false
```

改代码时的几个约束：

- `ensure_token` 的刷新阈值取自 `refreshMarginH`（默认 72h）。刷新接口失效时会沿用未过期的 accessToken，不影响当天签到
- `api_call` 的端点轮换只把 0 和 404 当作「端点不对」。加新 base 时确认这个语义
- 汇总逻辑在 `log_run`，新增 phase 时同步
- 触发时间依据「额度每日 10:00（UTC+8）刷新」设计。10:00 前的运行只能看到昨日 CLAIMED 状态，没有意义
- 计划任务 XML 存 UTC（02:10 对应北京 10:10）
