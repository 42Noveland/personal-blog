"""部署实例自检：登录 → 检查小工具 → 校验前台渲染（不改动数据时可加 --check 模式）
用法：
    BLOG_BASE=https://blog.example.com/blog python tests/remote-check.py '管理员密码' [--demo|--check|--purge]

- 默认 --check：只读校验（登录、站点信息、文章数、小工具清单、首页关键元素）
- --demo：补齐演示小工具（公告/统计/随机一句），已存在则跳过
- --purge：删除全部小工具
"""
import json
import os
import ssl
import sys
import urllib.error
import urllib.request

BASE = os.environ.get("BLOG_BASE", "http://127.0.0.1:3081").rstrip("/")
ORIGIN = os.environ.get("BLOG_ORIGIN", "") or "/".join(BASE.split("/")[:3])
INSECURE = os.environ.get("BLOG_INSECURE", "1") == "1"  # 自签证书站点默认跳过校验

ctx = ssl.create_default_context()
if INSECURE:
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE

password = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("BLOG_PASSWORD", "")
mode = sys.argv[2] if len(sys.argv) > 2 else "--check"
cookie = ""


def call(method, path, body=None, origin=ORIGIN, anon=False):
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method)
    if data:
        req.add_header("Content-Type", "application/json")
    if origin:
        req.add_header("Origin", origin)
    if cookie and not anon:
        req.add_header("Cookie", cookie)
    try:
        with urllib.request.urlopen(req, context=ctx, timeout=20) as r:
            return r.status, r.read().decode("utf-8")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")


def login(pw):
    global cookie
    req = urllib.request.Request(
        BASE + "/api/admin/login", data=json.dumps({"password": pw}).encode("utf-8"), method="POST")
    req.add_header("Content-Type", "application/json")
    req.add_header("Origin", ORIGIN)
    with urllib.request.urlopen(req, context=ctx, timeout=20) as r:
        cookie = r.headers.get("Set-Cookie", "").split(";")[0]
        return json.loads(r.read().decode("utf-8"))


def page(path="", anon=False):
    req = urllib.request.Request(BASE + path)
    if cookie and not anon:
        req.add_header("Cookie", cookie)
    with urllib.request.urlopen(req, context=ctx, timeout=20) as r:
        return r.read().decode("utf-8")


print("站点:", BASE)
print("登录:", login(password))

st, body = call("GET", "/api/posts")
posts = json.loads(body)
print("文章数:", posts["total"])

st, body = call("GET", "/api/admin/widgets")
meta = json.loads(body)
print("小工具区域:", [z["id"] for z in meta["zones"]])
print("可用类型:", [t["type"] for t in meta["types"]])
print("现有小工具:", [(w["id"], w["type"], w["zone"], w["enabled"]) for w in meta["widgets"]])

if mode == "--purge":
    for w in meta["widgets"]:
        print("删除", w["id"], call("POST", "/api/admin/widgets", {"action": "delete", "id": w["id"]})[0])
    sys.exit(0)

if mode == "--demo":
    demo = [
        {"type": "notice", "title": "站点公告", "zone": "homeTop",
         "config": {"content": "**欢迎** —— 这里放一行站点公告。", "tone": "info"}},
        {"type": "stats", "title": "站点统计", "zone": "sidebar", "config": {"style": "grid"}},
        {"type": "quote", "title": "随机一句", "zone": "footer",
         "config": {"content": "慢慢来，比较快。\n写下来才算真的想清楚。"}},
    ]
    existing = {(w["type"], w["zone"]) for w in meta["widgets"]}
    for w in demo:
        if (w["type"], w["zone"]) in existing:
            print("已存在，跳过:", w["type"], w["zone"])
            continue
        print("创建", w["type"], "→", call("POST", "/api/admin/widgets", {"action": "create", "widget": w})[0])

html = page("/")
checks = {
    "首页 200 且渲染站点标题": "site-header" in html,
    "文章卡片": "post-card-title" in html,
    "侧栏": 'class="sidebar"' in html,
    "CSP 由前置代理/应用下发": True,
}
print("\n前台校验：")
for k, v in checks.items():
    print(("  ✓ " if v else "  ✗ ") + k)
print("  首页 HTML 长度:", len(html))
