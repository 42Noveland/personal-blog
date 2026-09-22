#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把博客反代片段插入 /etc/nginx/conf.d/dsh.conf（幂等，先备份），然后 nginx -t + reload"""
import os
import re
import shutil
import subprocess
import time

CONF = "/etc/nginx/conf.d/dsh.conf"
SNIPPET = "/root/blog/deploy/nginx-blog-location.conf"

src = open(CONF, encoding="utf-8").read()
if "location /blog/" in src:
    print("ALREADY_PRESENT: 配置里已存在 /blog/ location，跳过插入")
    raise SystemExit(0)

snippet = open(SNIPPET, encoding="utf-8").read()
# 去掉注释行与空行
lines = [l for l in snippet.splitlines() if l.strip() and not l.strip().startswith("#")]
snippet = "\n".join(lines).rstrip()

backup = CONF + ".bak-" + time.strftime("%Y%m%d-%H%M%S")
shutil.copy2(CONF, backup)
print("已备份 →", backup)

body = src.rstrip()
idx = body.rfind("}")
new = body[:idx].rstrip() + "\n\n    # ===== 博客（由 deploy/patch-nginx.py 插入） =====\n"
new += "\n".join("    " + l if l.strip() else l for l in snippet.splitlines()) + "\n}\n"
open(CONF, "w", encoding="utf-8").write(new)
print("已写入新的 dsh.conf")

r = subprocess.run(["nginx", "-t"], capture_output=True, text=True)
print(r.stdout.strip(), r.stderr.strip())
if r.returncode != 0:
    shutil.copy2(backup, CONF)
    print("nginx -t 失败，已回滚配置")
    raise SystemExit(1)

r2 = subprocess.run(["systemctl", "reload", "nginx"], capture_output=True, text=True)
print("reload:", r2.returncode, r2.stderr.strip())
raise SystemExit(r2.returncode)
