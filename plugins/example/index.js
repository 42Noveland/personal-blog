'use strict';
/**
 * example 插件 — 把这份文件复制成 plugins/<你的插件名>/index.js 就能开工
 *
 * 生命周期：setup(ctx) 加载时执行 → 各钩子按请求执行 → teardown() 卸载/重载前执行
 * 可用的 ctx：db / settings / http / log / utils / markdown / config / store / url / state
 */
module.exports = {
  /* 加载时执行一次：建表、预热数据都可以放这里 */
  setup(ctx) {
    ctx.db.exec(`
      CREATE TABLE IF NOT EXISTS plugin_example_hits (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at TEXT NOT NULL
      );
    `);
    ctx.log.info('example 插件已就绪');
  },

  /* 卸载或热重载前执行 */
  teardown() {
    // 这里释放定时器、关闭连接等
  },

  /* 注入顶部导航（order 越小越靠前） */
  navItems(ctx) {
    if (!this.settings.get('showNav', true)) return [];
    return [{ label: '示例', href: ctx.url('/example'), order: 50 }];
  },

  /* 注入页脚 */
  footer(ctx) {
    return `<span class="plugin-example">✦ ${escapeHtml(String(this.settings.get('greeting', '')))}</span>`;
  },

  /* 注入一个"小工具"区域：既演示 widgetTypes 钩子，也演示插件小工具如何渲染 */
  widgetTypes(ctx) {
    const self = this;
    return [{
      type: 'example.hello',
      title: '示例小工具（插件提供）',
      description: '插件注册的 widget 类型：显示问候语与点击计数',
      source: 'plugin:example',
      fields: [
        { key: 'text', label: '问候语', type: 'text', default: '你好，这是插件注册的小工具' },
      ],
      render(cfg, c) {
        let hits = 0;
        try { hits = c.db.prepare('SELECT COUNT(*) AS c FROM plugin_example_hits').get().c; } catch (_) {}
        return {
          html: `<p style="margin:0 0 8px">${escapeHtml(String(cfg.text || ''))}</p>` +
            `<p class="muted" style="margin:0;font-size:13px">插件记录到的点击数：<strong>${hits}</strong></p>`,
        };
      },
    }];
  },

  /* 注册自有路由：公开路由直接写，后台路由加 { auth: 'admin' } */
  routes(router, ctx) {
    /* 插件也可以提供整页：用 ctx.page(req, {...}) 套用当前主题 */
    router.get('/example', (req, res) => {
      const posts = ctx.store.list({ perPage: 5 }).items;
      const html = `<header class="page-head">
          <h1>example 插件页面</h1>
          <p class="page-sub">这个页面完全由插件提供路由与内容，但复用了主题的排版。</p>
        </header>
        <div class="widget">
          <h3 class="widget-title">最新文章</h3>
          <ul class="widget-list">
            ${posts.map((p) => `<li><a href="${ctx.url('/post/' + encodeURIComponent(p.slug))}">${escapeHtml(p.title)}</a></li>`).join('')}
          </ul>
        </div>
        <p style="margin-top:24px"><button class="btn" data-hit-btn>记一次点击</button>
        &nbsp;当前点击数：<strong id="hits">—</strong></p>
        <script nonce="${req._nonce || ''}">
          document.querySelector('[data-hit-btn]').addEventListener('click', function () {
            fetch('${ctx.url('/api/example/hit')}', { method: 'POST' }).then(function () {
              var el = document.getElementById('hits');
              el.textContent = Number(el.textContent === '—' ? 0 : el.textContent) + 1;
            });
          });
        </script>`;
      ctx.http.send(res, 200, ctx.page(req, { title: '示例页面 · ' + ctx.config.site.title, content: html }));
    });

    router.get('/api/example/hello', (req, res) => {
      ctx.http.json(res, {
        ok: true,
        message: '你好，这是 example 插件注册的接口',
        time: new Date().toISOString(),
      });
    });

    router.get('/api/example/hits', (req, res) => {
      const n = ctx.db.prepare('SELECT COUNT(*) AS c FROM plugin_example_hits').get().c;
      ctx.http.json(res, { ok: true, hits: n });
    }, { auth: 'admin' });

    router.post('/api/example/hit', (req, res) => {
      ctx.db.prepare('INSERT INTO plugin_example_hits (at) VALUES (?)').run(new Date().toISOString());
      ctx.http.json(res, { ok: true });
    });
  },
};

const { escapeHtml } = require('../../lib/utils');
