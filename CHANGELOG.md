# Changelog

## 2026-10-17

### Added

- WorkBuddy 连签守卫：Windows 计划任务 `WorkBuddyStreakLaunch`（每天 10:00，错过开机补跑），调用 `scripts/workbuddy_streak_launch.ps1` 在客户端未运行时静默拉起并隐藏主窗口，保住成长中心"连签"
- `scripts/probe_streak.py`：只读探针，查询成长中心连签状态（连签天数 / 补登卡余额 / 可补日期）

### Context

- 排查确认：WorkBuddy 签到积分（`billing/meter/daily-checkin`）运行正常，App 内显示的断签来自成长中心"连签"，该记录只认桌面客户端当天的登录行为，`signin.py` 调 API 无法代替
