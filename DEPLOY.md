# 部署方法

三种规模，从「本机跑起来」到「服务器 + nginx TLS 反代」。全部步骤都不依赖 npm。

## 0. 环境要求

- Node.js **22.5+**（需要内置 `node:sqlite`；实测 24.x 最佳）
- 可选：nginx（做 TLS 终止与路径反代）
- 无需数据库、无需构建工具、**无需 `npm install`**

## 1. 本地运行

```bash
git clone <repo> && cd personal-blog
node server.js                      # → http://127.0.0.1:3081
node tools/set-password.js '你的密码' # 首次设置后台密码（写入 config.json 的 scrypt 散列）
node tests/smoke.js                 # 端到端自检（115 项断言）
```

首次启动若未设置密码，会生成随机密码并打印在日志里。

环境变量（优先级高于 config.json）：`BLOG_HOST` / `BLOG_PORT` / `BLOG_BASE_PATH` / `BLOG_DATA_DIR`。

## 2. 服务器常驻（systemd 可选）

```bash
# 部署到 /opt/blog
sudo mkdir -p /opt/blog && sudo chown "$USER" /opt/blog
git clone <repo> /opt/blog && cd /opt/blog
node tools/set-password.js '强密码'

# 方式 A：systemd（推荐，开机自启 + 崩溃重启）
sudo cp deploy/blog.service /etc/systemd/system/blog.service
sudo systemctl daemon-reload && sudo systemctl enable --now blog
journalctl -u blog -f

# 方式 B：脚本启动（与 nohup 等价，不安装系统服务）
bash deploy/start-blog.sh          # 内含端口占用清理 + 健康检查
tail -f /var/log/blog.log
```

## 3. 反向代理

### 3.1 独立端口（有可用公网端口时）

```nginx
server {
    listen 443 ssl;
    server_name blog.example.com;
    ssl_certificate     /etc/letsencrypt/live/blog.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/blog.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:3081;
        proxy_http_version 1.1;
        proxy_set_header Host $http_host;          # 必须 $http_host，$host 会剥掉端口导致同源校验 403
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

### 3.2 复用已有站点的端口做子路径（没有多余公网端口时）

把下面这段加进**已有的** server 块（不要新建同端口 server 块），然后在 `config.json` 里设置 `"server": { "basePath": "/blog" }`：

```nginx
    location = /blog { return 301 /blog/; }
    location /blog/ {
        server_tokens off;                          # 隐藏 nginx 版本号
        proxy_pass http://127.0.0.1:3081/;          # 结尾 / 表示剥掉 /blog 前缀
        proxy_http_version 1.1;
        proxy_set_header Host $http_host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Prefix /blog;
    }
```

改完 `nginx -t && systemctl reload nginx`。脚本版（幂等 + 校验失败自动回滚）见 `deploy/patch-nginx.py`。
站点地址随之变成 `https://<host>:<port>/blog/`，后台 `<前缀>/admin`。

### 3.3 安全清单

- [ ] 应用**只监听 127.0.0.1**（否则客户端可伪造 `X-Forwarded-For` 绕过限流）
- [ ] 用域名 + Let's Encrypt 正式证书（自签证书无法验证书链，且**不要**在自签场景开 HSTS）
- [ ] 后台路径已在 `robots.txt` 中 disallow
- [ ] 上线后立刻在「站点设置」里改掉初始密码
- [ ] 备份：`tar czf blog-$(date +%F).tar.gz -C /opt/blog content data config.json`（建议 cron + 异地）

## 4. 备份与迁移

- **内容**：`content/` 全量就是文章与页面（纯 markdown，可直接 git 管理）
- **运行数据**：`data/blog.db`（设置、会话、评论、浏览量、小工具）
- **配置**：`config.json`（含口令散列，权限 0600）
- 迁移：三样拷到新机器 → `node server.js` 即可，无需迁移脚本

## 5. 升级

```bash
git pull
bash deploy/start-blog.sh     # 或 systemctl restart blog
```
内容与插件支持热重载（`fs.watch` / 后台「重载」按钮），只有内核代码改动才需要重启。

## 6. 常见问题

| 现象 | 原因与处理 |
|:--|:--|
| 页面样式正常但链接全 404 | `basePath` 没配（子路径部署时必须设为 `/blog` 之类） |
| 后台登录后立刻 401 | 反代没传 `Host $http_host`，Origin 校验不通过 |
| `crypto.randomUUID is not a function` 之类的 Web Crypto 报错 | 页面不在安全上下文：必须 HTTPS（自签也可以） |
| 启动报 `Cannot find module 'node:sqlite'` | Node 版本过低，需要 22.5+ |
| 端口被占用导致启动失败 | `ss -tlnp \| grep :3081` 取 PID 后 kill（别用 `pkill -f`，会误杀自己的 SSH 会话） |
