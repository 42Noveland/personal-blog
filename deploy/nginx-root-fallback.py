#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""给 2270 的根 location 加"dsh 不可用时跳转到博客"的兜底（幂等 + 失败回滚）

背景：2270 的 / 反代 dsh(3080)，/blog/ 反代博客(3081)。dsh 没运行时访问 / 会得到 502。
处理：只在**上游连接失败**时触发 error_page → 302 跳到 /blog/；dsh 正常时行为完全不变。
"""
import re
import shutil
import subprocess
import time

CONF = "/etc/nginx/conf.d/dsh.conf"
src = open(CONF, encoding="utf-8").read()

need_fallback = "@dsh_down" not in src
need_error_page = "error_page 502 503 504" not in src
need_intercept = "proxy_intercept_errors" not in src
if not (need_fallback or need_error_page or need_intercept):
    print("ALREADY_PATCHED: 三处配置都已存在，跳过")
    raise SystemExit(0)
print("待补齐：", {"兜底 location": need_fallback, "error_page": need_error_page, "proxy_intercept_errors": need_intercept})

backup = CONF + ".bak-" + time.strftime("%Y%m%d-%H%M%S")
shutil.copy2(CONF, backup)
print("已备份 →", backup)

# 1) 在 location / { ... } 末尾插入 error_page + proxy_intercept_errors
m = re.search(r"\n(\s*)location\s+/\s*\{", src)
if not m:
    print("未找到 location / 块，放弃")
    raise SystemExit(1)
start = m.end() - 1
depth, end = 0, None
for i in range(start, len(src)):
    if src[i] == "{":
        depth += 1
    elif src[i] == "}":
        depth -= 1
        if depth == 0:
            end = i
            break
if end is None:
    print("花括号不匹配，放弃")
    raise SystemExit(1)

indent = m.group(1)
add = ""
if need_intercept:
    add += f"\n{indent}    # 让上游连接失败/502 也能走 error_page（否则 nginx 直接透传 502）\n{indent}    proxy_intercept_errors on;"
if need_error_page:
    add += f"\n{indent}    error_page 502 503 504 = @dsh_down;"
patched = src[:end] + add + f"\n{indent}" + src[end:]

# 2) server 块末尾追加 @dsh_down（只做 302 跳转，配置里不写 HTML，避免引号问题）
if need_fallback:
    fallback = (
        f"\n\n{indent}# 上游（dsh）不可用时的兜底：跳到博客（dsh 正常时不生效）\n"
        f"{indent}location @dsh_down {{\n"
        f"{indent}    return 302 /blog/;\n"
        f"{indent}}}\n"
    )
    last = patched.rstrip().rfind("}")
    patched = patched.rstrip()[:last].rstrip() + "\n" + fallback + "}\n"

open(CONF, "w", encoding="utf-8").write(patched)
print("已写入 dsh.conf")

r = subprocess.run(["nginx", "-t"], capture_output=True, text=True)
out = (r.stdout + r.stderr).strip()
print("--- nginx -t ---")
print(out)
if r.returncode != 0:
    shutil.copy2(backup, CONF)
    print("nginx -t 失败，已回滚")
    raise SystemExit(1)

r2 = subprocess.run(["systemctl", "reload", "nginx"], capture_output=True, text=True)
print("reload:", r2.returncode, r2.stderr.strip())
raise SystemExit(r2.returncode)
