# 安全复盘报告（Security Review）

> 对象：夜航船博客引擎（`server.js` + `lib/` + `plugins/` + `public/`）与其线上部署
> 方法：代码走查 + 自动化安全断言（`node tests/smoke.js`）+ 真实浏览器（CDP）验证
> 结论：**15 项发现全部处置完毕，残余风险已在文末明确列出**

## 一、资产与威胁模型

| 资产 | 说明 |
|:--|:--|
| 管理员凭证 | scrypt 散列存于 `config.json`；会话令牌存于 SQLite，随 Cookie 下发 |
| 内容 | `content/*.md`（只有管理员能写） |
| 访客数据 | 评论（昵称/邮箱/IP/UA）存于 `data/blog.db` |
| 服务器 | 单机 ECS，Node 服务只监听 `127.0.0.1`，外部经 nginx TLS 反代进入 |

**对手模型**：① 公网匿名访客（可任意构造 HTTP 请求）；② 恶意页面诱导管理员浏览器发起跨站请求；③ 本地低权限用户读文件；④ 第三方插件代码（视为**可信但当其为易错**：钩子异常不拖垮主流程）。

## 二、发现与处置

| # | 发现 | 风险 | 处置 |
|:--|:--|:--|:--|
| S1 | 静态资源路径穿越（`/uploads/%2e%2e%2f…`）被拦后**没有结束响应**，连接悬挂 | 中：连接/句柄被占用，可被用来做低成本 DoS；排障时表现为「请求卡死」 | 越界一律回 `403` 并结束响应；烟测新增 3 条穿越断言（含 `%2e%2e`、编码斜杠两种形态） |
| S2 | 全站无 CSP，任意注入的 `<script>` 都能执行 | 高：一旦出现 HTML 注入即为任意脚本执行 | 每请求生成 nonce，下发 `Content-Security-Policy: default-src 'self'; script-src 'self' 'nonce-…'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'self'`；所有内联脚本（含插件经 `ctx.nonce` 输出的）带 nonce；浏览器实测 0 条 CSP 告警 |
| S3 | 登录失败计数把**成功登录也计入**，5 次后连同合法登录一起锁死 | 中：可被用来把管理员锁在门外（拒绝服务） | 改为 `LoginGuard`：只统计失败、成功即清零、超限锁定 10 分钟；断言覆盖「达阈值→锁定→锁定期内正确密码也拒绝」 |
| S4 | 修改密码后旧会话仍然有效 | 中高：口令泄漏后改密不能止血 | 改密即 `DELETE FROM sessions` 全量注销，响应带 `relogin: true`，后台自动回到登录页 |
| S5 | 插件设置写入无校验，可写任意键名（`plugin.<name>.<任意>`）与任意类型 | 低中：插件读到畸形配置后行为不可预期 | `validateSetting()` 白名单：插件名/键格式 + **必须在该插件 `plugin.json` 中声明过** + 类型/取值范围/长度校验；非法写入 400 |
| S6 | `data/`（含会话令牌）与 `config.json`（含口令散列）权限过宽 | 中：本机其他用户可读取并直接复用会话 | `data/` 0700、`blog.db*` 0600、`config.json` 0600（写入时自动 chmod） |
| S7 | 写接口无全局限流 | 低中：可脚本化刷接口 | `/api/*` 的 POST/PUT/PATCH/DELETE 每 IP 240 次/分钟；评论（5 条/10 分钟）与登录（5 次失败锁定）另有更严格策略 |
| S8 | 登录失败无审计记录 | 低：无法发现爆破 | 失败日志含 IP/UA/原因；改密日志含注销会话数 |
| S9 | Markdown 行内 HTML 未转义（开发阶段自查发现） | 高 | 渲染器改为「先摘出链接/代码 → 整体转义 → 再套行内语法」，并保留控制字符占位符；断言覆盖 `<script>` 必须转义 |
| S10 | 链接协议未过滤（`javascript:` / `data:`） | 高 | `sanitizeUrl()` 白名单（http/https/mailto/tel/相对/锚点），其余丢弃 |
| S11 | 跨站写操作 | 高 | 三重防线：Cookie `SameSite=Lax`（跨站 POST 不带 Cookie）+ `Origin/Referer` 与 `Host` 同源校验 + 必须 `Content-Type: application/json`（触发预检）；断言覆盖伪造 Origin → 403、无会话 → 401 |
| S12 | 会话 Cookie 标志 | 中 | `HttpOnly` + `SameSite=Lax` + 生产 `Secure`（`server.secureCookies=true`），7 天过期，令牌 32 字节随机 |
| S13 | 评论滥用与注入 | 中 | 服务端清洗控制字符 + 长度/链接数限制 + IP 限流 + 蜜罐字段；渲染端一律转义（不信任存储内容） |
| S14 | 伪造/复用会话令牌 | 中 | 令牌为 256 位随机且仅存于服务端数据库；断言覆盖伪造令牌 → 401 |
| S15 | 技术栈版本泄漏 | 低 | 应用不下发 `X-Powered-By`；nginx 侧对本站路径 `server_tokens off` 隐藏版本号 |

## 三、残余风险（明确接受或留待后续）

| 风险 | 说明与建议 |
|:--|:--|
| 自签证书 | 当前用 IP + 自签证书，无法校验证书链，存在中间人风险。建议：绑定域名 + Let's Encrypt，然后开启 HSTS。**在此之前不要开启 HSTS**（自签场景会把自己锁死） |
| 管理员可信内容 | 文章正文允许原始 HTML、`html` 类型小工具直接输出 HTML（等同 WordPress 的「自定义 HTML」）。一旦管理员账号被攻破即可 XSS。缓解：强口令 + 改密即注销 + 不安装来路不明的插件 |
| 反向代理信任 | `X-Forwarded-For` 未做白名单校验，因此**必须保持应用只监听 `127.0.0.1`**（不要改成 0.0.0.0），否则客户端可伪造来源 IP 绕过限流 |
| 评论无验证码 | 用限流 + 蜜罐 + 可选「先审后发」缓解；如需更强可加验证码插件 |
| 无二次认证 | 单管理员、无 2FA；建议后续加 TOTP 插件（插件体系已支持注册后台面板与路由） |
| 无自动备份 | 备份 = `tar czf blog-$(date +%F).tar.gz -C /root/blog content data config.json`；建议加 cron 并异地存放 |

## 四、复核方式

```bash
node tests/smoke.js          # 115 项端到端断言，其中 24 项为安全相关
```

安全相关断言覆盖：CSP 头与 nonce 一致性、安全响应头、三种路径穿越形态、伪造会话令牌、
Cookie 标志、插件设置越权写入、改密后会话失效、旧密码失效、评论限流、登录爆破锁定、
跨站写操作拒绝、未登录访问后台 API、Markdown 行内 HTML 转义、链接协议白名单。

真实浏览器复核（验证 CSP 没有误伤功能脚本）：

```bash
node tools/cdp-shot.js <站点URL> out.png --port 9444 --eval "document.documentElement.dataset.mode"
# 输出中出现 "CSP/安全告警：无" 即为通过
```

## 五、部署侧加固清单（已执行）

- [x] 应用仅监听 `127.0.0.1:3081`，公网经 nginx TLS 反代
- [x] 反代 `proxy_set_header Host $http_host`（保持 Origin 校验可判断）
- [x] `data/`、`config.json`、`blog.db` 权限收紧
- [x] 后台路径在 `robots.txt` 中 disallow
- [x] 登录/改密/失败事件写入日志（`/var/log/blog.log`）
- [ ] 域名 + 正式证书 + HSTS（待办）
- [ ] 异地定时备份（待办）
