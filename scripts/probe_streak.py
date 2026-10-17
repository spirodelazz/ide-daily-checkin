"""临时探针：查成长中心连签状态（/streak），只读不写。"""
import json
import signin

auth_file, _looked = signin.find_auth_file()
session = signin.load_session_retry(auth_file)
session = signin.resolve_session(session)
headers = signin.build_headers(session)
endpoint = ((session.get("auth") or {}).get("endpoint") or signin.DEFAULT_ENDPOINT).rstrip("/")
base = endpoint + "/v2/activity/growth"

code, body = signin.get(base + "/streak", headers)
print("HTTP", code)
print(json.dumps(body, ensure_ascii=False, indent=2)[:4000])
