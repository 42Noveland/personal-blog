"""验证 site.poweredBy 可在后台改/清空：清空 → 页脚不再输出该行；复原 → 恢复"""
import json
import os
import ssl
import sys
import urllib.error
import urllib.request

BASE = os.environ.get("BLOG_BASE", "https://47.99.48.84:2270/blog").rstrip("/")
ORIGIN = "https://47.99.48.84:2270"
ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE

pw = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("BLOG_PASSWORD", "")
DEFAULT = 'Powered by <a href="https://hermes-agent.nousresearch.com/docs" target="_blank" rel="noopener">Hermes</a> 手搓博客引擎 · 零依赖 Node'
cookie = ""


def login():
    global cookie
    req = urllib.request.Request(BASE + "/api/admin/login", data=json.dumps({"password": pw}).encode(), method="POST")
    req.add_header("Content-Type", "application/json")
    req.add_header("Origin", ORIGIN)
    with urllib.request.urlopen(req, context=ctx, timeout=20) as r:
        cookie = r.headers.get("Set-Cookie", "").split(";")[0]
        return json.loads(r.read().decode()).get("ok")


def set_powered_by(value):
    body = json.dumps({"settings": {"site.poweredBy": value}}).encode()
    req = urllib.request.Request(BASE + "/api/admin/settings", data=body, method="POST")
    req.add_header("Content-Type", "application/json")
    req.add_header("Origin", ORIGIN)
    req.add_header("Cookie", cookie)
    with urllib.request.urlopen(req, context=ctx, timeout=20) as r:
        return json.loads(r.read().decode())


def footer_snippet():
    req = urllib.request.Request(BASE + "/")
    with urllib.request.urlopen(req, context=ctx, timeout=20) as r:
        html = r.read().decode()
    i = html.find('class="footer-powered"')
    return "（无该行）" if i < 0 else html[i:i + 90].replace("\n", " ")


print("登录:", login())
print("现状 :", footer_snippet())

print("\n清空 site.poweredBy →", set_powered_by(""))
print("结果 :", footer_snippet())

print("\n改成自定义署名 →", set_powered_by('© Noveland · 自己写的引擎'))
print("结果 :", footer_snippet())

print("\n复原默认 →", set_powered_by(DEFAULT))
print("结果 :", footer_snippet())
