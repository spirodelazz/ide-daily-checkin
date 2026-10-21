"""只读探针：查成长中心连签状态（/streak），不写任何服务端状态。

用法：
  python probe_streak.py            # 打印 HTTP 状态与完整 JSON（人工排查）
  python probe_streak.py --days     # 只打印 days=<n>，供计划任务脚本解析（读取失败为 days=-1 且退出码 1）
"""
import json
import sys

import signin

auth_file, _looked = signin.find_auth_file()
session = signin.load_session_retry(auth_file)
session = signin.resolve_session(session)
headers = signin.build_headers(session)
endpoint = ((session.get("auth") or {}).get("endpoint") or signin.DEFAULT_ENDPOINT).rstrip("/")
base = endpoint + "/v2/activity/growth"

code, body = signin.get(base + "/streak", headers)

if "--days" in sys.argv:
    data = body.get("data") if isinstance(body, dict) else None
    streak = data.get("streak") if isinstance(data, dict) else None
    days = streak.get("days") if isinstance(streak, dict) else None
    try:
        days = int(days)
    except (TypeError, ValueError):
        print("days=-1")
        sys.exit(1)
    print("days=%d" % days)
    sys.exit(0)

print("HTTP", code)
print(json.dumps(body, ensure_ascii=False, indent=2)[:4000])
