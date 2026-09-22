# 架构与扩展指南

## 1. 分层

```
请求 → server.js(handle)
        ├─ 安全头 / 路径前缀归一化
        ├─ 静态资源（/assets /theme-assets /plugin-assets /uploads）
        ├─ Router 匹配（内核路由 + 插件路由，按注册顺序）
        │    └─ route.opts.auth === 'admin' → 统一鉴权
        └─ 页面渲染 → Renderer → 主题 layout + 插件钩子
```

- **内容**：`content/posts/*.md` 是唯一真相，`store` 载入内存索引，`fs.watch` 变更自动重载。
- **数据**：`data/blog.db`（node:sqlite）存设置、会话、插件状态与插件自建表。
- **渲染**：服务端渲染 HTML，前端只用少量原生 JS 做增强（明暗切换、复制代码、评论加载）。

## 2. 一次文章页渲染的数据流

```
GET /post/hello-world
  renderer.ctx(req)                  → 站点配置 + url() + state{}（每请求独立）
  store.getPost(slug)
  markdown.render(raw, { headings }) → HTML（同时收集标题）
  plugins.emit('contentFilter')      → 插件可读 headings/html，返回 {html} 替换正文
  plugins.html('postMeta'/'postHeader'/'postFooter')
  layout.shell(...)                  → 注入 head/navItems/sidebar/footer 钩子产物
```

**并发要点**：钩子上下文按请求创建，临时数据必须放 `ctx.state`，不要挂在插件对象上。

## 3. 插件系统

```
plugins/<name>/
  plugin.json    清单
  index.js       钩子实现（或工厂函数 module.exports = ctx => ({...})）
  public/        静态资源 → <前缀>/plugin-assets/<name>/
```

### 钩子清单

| 钩子 | 时机 | 返回值 |
|:--|:--|:--|
| `setup(ctx)` | 加载 / 热重载时一次 | — |
| `teardown()` | 卸载或重载前 | — |
| `routes(router, ctx)` | 加载时注册路由，`{auth:'admin'}` 表示需登录 | — |
| `head(ctx)` | `</head>` 前 | HTML |
| `navItems(ctx)` | 顶部导航 | `[{label,href,order}]` |
| `postMeta(ctx)` | 文章卡片与文章页元信息行 | HTML |
| `postHeader(ctx)` | 正文之前 | HTML |
| `postFooter(ctx)` | 正文之后 | HTML |
| `sidebar(ctx)` | 侧栏组件 | `[{id,title,html,order}]` |
| `footer(ctx)` | 页脚 | HTML |
| `contentFilter(ctx)` | 正文渲染之后 | `{html}` 替换正文 |
| `adminPanels(ctx)` | 后台页签 | `[{id,title,html,script}]` |
| `widgetTypes(ctx)` | 注册小工具类型（见第 4 节） | `[{type,title,fields,render}]` |

### 上下文（ctx）

| 字段 | 说明 |
|:--|:--|
| `ctx.db` | node:sqlite 句柄（插件表请加 `plugin_<名>_` 前缀） |
| `ctx.settings` / `this.settings` | 插件设置读写（后台自动生成表单） |
| `ctx.http` | `json / text / send / redirect / readJson / readBody / sameOrigin` |
| `ctx.store` | 内容索引（`list / getPost / tags / siteSettings`） |
| `ctx.page(req,{title,content})` | 用当前主题渲染整页 |
| `ctx.url(p)` | 拼 basePath 链接 |
| `ctx.state` | 请求级共享数据（**每请求独立**） |

### 热插拔

后台「插件」页可停用 / 启用 / 重载；重载会清理 `require` 缓存并重新走 `setup` + `routes`。
卸载时按 owner 精确移除该插件注册的所有路由，不会误伤内核路由。

### 示例

见 `plugins/example/`（模板骨架 + README）与 `plugins/comments/`（完整实战：数据表、公开与后台 API、前台组件、后台面板）。

## 4. 小工具系统

「小工具」= 可挂到固定区域、由后台表单配置的组件。它把「加个公告 / 统计 / 友链」这类需求
从「写插件」降级成「填表单」，同时保留插件注册新类型的能力。

```
区域(zone)：homeTop / sidebar / postTop / postBottom / footer
类型(type)：内置 6 种（html / notice / stats / recentPosts / links / quote）
            + 插件通过 widgetTypes 钩子注册
存储：SQLite 表 widgets(id, type, title, zone, config(JSON), sort, enabled)
```

渲染：`renderer` 在对应区域调用 `widgets.renderZone(zone, ctx)`（返回值与插件 `sidebar` 钩子的
组件按 `order` 混排）或 `renderZoneBlocks(zone, ctx)`（包一层统一样式外壳）。
每个小工具独立 try/catch，单个渲染失败不影响页面。

插件注册示例（`plugins/example/index.js`）：

```js
widgetTypes(ctx) {
  return [{
    type: 'example.hello',            // 建议用 <插件名>. 前缀避免冲突
    title: '示例小工具（插件提供）',   // 后台下拉里显示的名字
    description: '一句话说明',
    fields: [{ key: 'text', label: '问候语', type: 'text', default: '你好' }],
    render(config, c) {               // 返回 { title?, html }
      return { html: `<p>${c.utils.escapeHtml(config.text)}</p>` };
    },
  }];
}
```

后台 API：`GET/POST /api/admin/widgets`（action: `create|update|delete|toggle|move|preview`）。
类型表按「插件加载代数」缓存，插件热重载后注册的类型会立即刷新。

## 5. 主题系统

```
themes/<name>/
  theme.json   元信息（title/description/author）
  theme.css    只定义 CSS 变量（深色 + [data-mode="light"] 浅色）
  layout.js    可选：覆盖 shell / postCard 等渲染片段
```

变量契约：`--bg --bg-soft --card --text --text-dim --text-mute --accent --accent-soft
--border --code-bg --radius --shadow --font-sans --font-serif --font-mono` 及高亮色 `--hl-*`。

`layout.js` 可覆盖的片段（未覆盖则用内核默认）：

```js
module.exports = {
  shell(o) { /* 返回完整 HTML 文档 */ },
  postCard(renderer, ctx, post) { /* 返回首页卡片 HTML */ },
};
```

新增主题：复制 `themes/midnight` → 改名 → 改 CSS 变量 → 后台「主题」页启用。

## 6. 安全设计

| 面 | 措施 |
|:--|:--|
| 口令 | scrypt(N=16384) 散列，仅存散列；登录只统计**失败**次数，5 次失败锁定 10 分钟，成功即清零 |
| 会话 | 32 字节随机 token 存 SQLite，HttpOnly + SameSite=Lax（生产加 Secure）Cookie，默认 7 天；**改密即全量注销** |
| CSRF | 三重：SameSite=Lax（跨站 POST 不带 Cookie）+ Origin/Referer 与 Host 同源校验 + JSON Content-Type 预检 |
| XSS | Markdown「先摘链接/代码 → 整体转义 → 再套行内语法」；URL 协议白名单拦截 `javascript:`/`data:`；评论渲染端一律转义 |
| CSP | 每请求 nonce：`script-src 'self' 'nonce-…'` + `object-src 'none'` + `base-uri 'self'` + `frame-ancestors 'self'`；插件内联脚本用 `ctx.nonce` |
| 路径穿越 | 静态资源 / 上传目录 / 插件资源一律 `path.resolve` 后校验前缀，越界回 **403** 并结束响应 |
| 输入校验 | 插件设置写入按 `plugin.json` 声明白名单校验（键名/类型/取值范围）；后台站点设置键名正则限定 |
| 限流 | 登录（失败锁定）、评论（5 条/10 分钟 + 蜜罐 + 长度/链接数）、所有写 API 240 次/分钟/IP |
| 文件权限 | `data/` 0700、`blog.db*` 0600、`config.json` 0600（写入时自动收紧） |
| 审计 | 登录失败、改密、注销会话数写入日志；后台「概览」可看最近请求 |
| 响应头 | `X-Content-Type-Options`、`X-Frame-Options`、`Referrer-Policy`、`Cross-Origin-Opener-Policy`，不下发 `X-Powered-By` |

完整复盘（发现/处置/残余风险）见 [SECURITY.md](SECURITY.md)。

## 7. 性能

- 全站服务端渲染，无前端框架，首屏只有 HTML + 一个 CSS + 两个小 JS；
- 文章索引常驻内存，渲染走字符串拼接；SQLite 用 WAL 模式；
- 静态资源带 ETag 与 `max-age`，主题 CSS 带 mtime 版本号防缓存；
- 单进程即可承载个人博客量级（实测首页本地 <5ms 渲染）。

## 8. 运维

| 场景 | 操作 |
|:--|:--|
| 改配置 | 编辑 `config.json` 后 `kill -HUP <pid>` 热重载 |
| 改内容 | 直接改 `.md` 文件，自动重载 |
| 改插件 | 后台「重载」，或 `kill -HUP <pid>` 全量重载 |
| 备份 | `tar czf blog-$(date +%F).tar.gz content/ data/ config.json` |
| 日志 | `journalctl -u blog -f` 或 nohup 输出文件 |
