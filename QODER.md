# QODER.md · 本地 Qoder 签到扩展（开发维护文档）

> Qoder 扩展的代码级开发文档。Qoder 部分改编自上游 [wallechfox/qoder-checkin](https://github.com/wallechfox/qoder-checkin)（MIT）；
> WorkBuddy 部分来自 [88lin/workbuddy-auto-signin](https://github.com/88lin/workbuddy-auto-signin)（MIT），其细节见其仓库 README。
> 用户视角的部署/运维文档在 [qoder-auto-checkin.md](qoder-auto-checkin.md)，三套系统总览见 [README.md](README.md)。

## 一、与上游的关系（git 注意事项）

| 文件 | git 状态 | 说明 |
|---|---|---|
| `qoder_checkin.py` / `qoder_extract.py` / `install-qoder-windows.ps1` | untracked | 本地新增，`git pull` 上游更新不会冲突 |
| `.gitignore` | 本地已修改 | 追加了 qoder 凭据/日志条目；若上游也改了 `.gitignore` 会冲突，**解决时必须保住 qoder_* 与 .qoder_token_cache.json 条目** |
| `qoder_config.json` / `qoder_accounts.json` / `.qoder_token_cache.json` / `qoder_checkin.log` | ignored | 凭据与运行数据，**绝不提交** |

上游更新 signin.py 后直接 pull 即可；Qoder 部分独立演化，互不影响。

## 二、文件清单与职责

```
qoder_checkin.py          签到主脚本（单文件自包含，纯标准库，~490 行）
qoder_extract.py          凭据提取（DPAPI + AES-GCM + runtime-info.exe，一次性/失效重跑）
install-qoder-windows.ps1 注册计划任务 QoderAutoSignin + QoderSigninPoll
qoder_config.json         设备标识（Cosy-*）+ baseUrls + notify + refreshMarginH
qoder_accounts.json       账号数组（accessToken / refreshToken / expiresAt / uid / name）
.qoder_token_cache.json   刷新后 token 的持久化缓存（按账号键隔离）
qoder_checkin.log         运行日志（JSON Lines，每行一次运行）
```

改编自 [wallechfox/qoder-checkin](https://github.com/wallechfox/qoder-checkin)（MIT），本机适配改动见下文「与上游差异」。

## 三、qoder_checkin.py 代码地图

```
路径常量          HERE 下 qoder_ 前缀文件（env QODER_CONFIG_FILE / QODER_ACCOUNTS_FILE 可覆盖）
配置读取          read_json / CONFIG / _env_or_conf（env 优先于 config）
设备头            device_headers()：config.json 的 device 块 → Cosy-* 请求头（env 可覆盖）
HTTP              _raw() 单请求；api_call() 端点轮换：网络错误(0)/404 换下一个 base，
                  其余状态码（含 401）视为该端点已给出结论，记住可用的 _BASE
过期时间          jwt_exp()（JWT 解 exp，本机 dt- 令牌非 JWT 恒为 0）
                  coerce_exp() ★ 修复点：ISO 字符串 / epoch 秒 / epoch 毫秒 → 统一 epoch 秒
token 刷新        do_refresh()：POST /api/v1/deviceToken/refresh {"refresh_token": ...}
持久化            persist()：写缓存 + 回写 accounts.json（token 轮换后不丢）
账号加载          load_accounts()：env QODER_ACCOUNTS + accounts 文件 → 按 uid/refreshToken 去重 → apply_cache
签到核心          ensure_token() 三层策略：
                    1) token 有效（距过期 > refreshMarginH=72h）→ 直接用
                    2) 临近过期 → do_refresh，成功后持久化
                    3) 收到 401 → ensure_token(force=True) 强刷后重试一次
                  run_account() 状态机：claimed / already / pending / login_required / error
输出              push()（企业微信/PushPlus/Webhook，配置留空即关）+ log_run()（JSON 行落盘）
入口              main(argv)：silent / silent-poll / poll（仅影响日志 trigger 字段）；
                  pythonw 下 stdout 为 None 已兜底；顶层 try/except 保证异常也落日志
```

### 状态机（run_account 返回的 phase）

| phase | 触发条件 | 后续 |
|---|---|---|
| `claimed` | claim 返回 200 且 status=CLAIMED | 完成，credits 累加 |
| `already` | 活动已 CLAIMED（在 startAt~endAt 内）或活动列表为空 | 无需处理 |
| `pending` | 有 CLAIM_BENEFIT 活动但均非 CLAIMABLE（每日未下发） | 等轮询兜底 |
| `login_required` | 401 且强刷失败 | 重跑 qoder_extract.py |
| `error` | HTTP 非 200/401、claim 部分失败、本地异常 | 看 msg 字段定位 |

## 四、qoder_extract.py 解密链路

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
5. expiresAt      coerce_exp() 转 epoch 秒后写入（上游直接写 ISO 字符串会导致签到脚本 TypeError）
6. 写回           qoder_config.json（补全默认块）+ qoder_accounts.json（按 uid/refreshToken 去重，
                  优先填充空白账号，否则追加）
```

## 五、接口契约（逆向所得，改版会失效）

均带 `Authorization: Bearer <accessToken>` + `Cosy-ClientType/Cosy-MachineOS/Cosy-MachineHostname/Cosy-MachineId/Cosy-MachineToken/Cosy-MachineCode/Cosy-MachineType/Cosy-Version` 请求头，base 为 `https://openapi.qoder.com.cn`（国际服 `https://openapi.qoder.sh`）。

| 端点 | 方法 | 说明 |
|---|---|---|
| `/sash/api/v1/me/campaigns` | GET | 活动列表：`{campaigns:[{campaignId, name, actionType, claimStatus, benefit:{amount}, startAt, endAt}]}`；只关心 `actionType=CLAIM_BENEFIT` 且 `claimStatus=CLAIMABLE` |
| `/sash/api/v1/me/campaigns/{cid}/claim` | POST | body `{}`；成功返回 `{status:"CLAIMED", benefit:{amount}}`；**幂等**，重复领不重复发币 |
| `/api/v1/deviceToken/refresh` | POST | body `{"refresh_token": ...}`；返回 token/accessToken + refreshToken（可能轮换） |

## 六、数据文件格式

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

## 七、与上游 wallechfox/qoder-checkin 的差异（改动原因）

1. **coerce_exp**：国内客户端 `expiresAt` 是 ISO 字符串，上游与 `time.time()` 直接相减会 TypeError → 统一转 epoch 秒
2. **安装路径**：本机装在 `D:\Qoder CN` 且注册表 InstallLocation 为空 → 提取脚本按版本目录自动定位 runtime-info.exe，无需 QODER_UMID_EXE
3. **文件名 `qoder_` 前缀**：与上游 signin.py 共目录不冲突
4. **pythonw 兜底**：stdout/stderr 为 None 时重定向 devnull；顶层异常强制落日志（否则任务被杀当天日志整条丢失）
5. **单文件**：合并上游 qoder_core.py + 02_checkin.py，减少文件跳转

## 八、维护 runbook

```powershell
# 重新提取（LOGIN_REQUIRED 时；须登录 Qoder 的同一 Windows 用户）
python qoder_extract.py            # --no-write 预览 / --json 输出明文 token（勿外传）

# 重装计划任务（可重复运行）
powershell -ExecutionPolicy Bypass -File .\install-qoder-windows.ps1

# 前台试跑（改代码后必做）
python qoder_checkin.py

# 卸载任务
Unregister-ScheduledTask -TaskName "QoderAutoSignin","QoderSigninPoll" -Confirm:$false
```

改代码注意：
- `ensure_token` 的刷新阈值来自 `refreshMarginH`（默认 72h），token 到期前 3 天就会尝试刷新；刷新接口失效时会"沿用未过期 accessToken"，不影响当天签到
- `api_call` 的端点轮换只认 0/404 为"端点不对"；加新 base 时确认这个语义
- 日志 `result` 汇总逻辑在 `log_run`，新增 phase 时记得同步
- 计划任务触发时间依据「额度每日 10:00（UTC+8）刷新」设计：主签 10:10，轮询 11/15/19/23 点；10:00 前的运行只能看到昨日 CLAIMED 状态，没有意义
- 计划任务 XML 存 UTC（02:10 = 北京 10:10），核对触发时间别误判
