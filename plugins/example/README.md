# 扩展示例插件

把整个目录复制成 `plugins/<你的插件名>/`，改 `plugin.json` 里的 `name`，然后编辑 `index.js`。

## 最小骨架

```js
module.exports = {
  setup(ctx) { /* 加载时执行：建表、初始化 */ },
  postMeta(ctx) { return '<span>卡片/文章页元信息</span>'; },
  routes(router, ctx) {
    router.get('/api/mine/hello', (req, res) => ctx.http.json(res, { ok: true }));
  },
};
```

## 可用钩子

| 钩子 | 时机 | 返回值 |
|:--|:--|:--|
| `setup(ctx)` | 插件加载 / 重载时一次 | 无 |
| `teardown()` | 卸载或重载前 | 无 |
| `routes(router, ctx)` | 加载时注册路由 | 无（`{auth:'admin'}` 选项要求登录） |
| `head(ctx)` | `</head>` 前 | HTML 字符串 |
| `navItems(ctx)` | 顶部导航 | `[{label, href, order}]` |
| `postMeta(ctx)` | 文章卡片与文章页的日期行 | HTML 字符串 |
| `postHeader(ctx)` | 文章正文之前 | HTML 字符串 |
| `postFooter(ctx)` | 文章正文之后 | HTML 字符串 |
| `sidebar(ctx)` | 侧栏组件 | `[{id, title, html, order}]` |
| `footer(ctx)` | 页脚 | HTML 字符串 |
| `contentFilter(ctx)` | 正文渲染完成后 | `{html}` 替换正文 |
| `adminPanels(ctx)` | 后台页签 | `[{id, title, html, script}]` |

## 上下文（ctx）

- `ctx.db` — node:sqlite 句柄（插件自建表请以 `plugin_<插件名>_` 前缀命名）
- `ctx.settings.get/set/all` — 插件设置（也可在钩子内用 `this.settings.get(...)`）
- `ctx.http` — `json / text / send / redirect / readJson / readBody / sameOrigin`
- `ctx.log`、`ctx.utils`、`ctx.markdown`、`ctx.store`、`ctx.url(p)`、`ctx.post`
- `ctx.state` — **每次请求独有**，请求内跨钩子共享数据必须放这里

## 静态资源

放在 `public/` 下，访问路径是 `<站点前缀>/plugin-assets/<插件名>/<文件>`，
例如 `plugins/example/public/panel.js` → `/plugin-assets/example/panel.js`。

## 后台面板

`adminPanels` 返回的 `html` 会插入面板容器，`script` 会被加载一次，脚本里注册：

```js
window.BlogAdminPanels = window.BlogAdminPanels || {};
window.BlogAdminPanels['你的面板id'] = function (root, api) {
  // api.api(path, {method, body})  api.toast(msg, kind)  api.esc(str)  api.U(path)
};
```

## 调试

后台「插件」页可停用 / 启用 / 热重载；也可以直接改文件后在服务器上执行：

```bash
cd /root/blog && curl -s -X POST -b cookie.txt \
  -H 'Content-Type: application/json' -H "Origin: https://<host>" \
  -d '{"name":"你的插件名","action":"reload"}' http://127.0.0.1:3081/api/admin/plugins
```
