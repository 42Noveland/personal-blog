'use strict';
/**
 * 浏览量插件 — 演示插件自建数据表（ctx.db）与多钩子协作
 *  · contentFilter：只有文章详情页会触发 → 在此累加计数，列表页天然不会重复计数
 *  · postMeta     ：日期行显示 👁 数字
 *  · sidebar      ：热门文章排行榜（读 ctx.store 反查标题）
 */
const { escapeHtml } = require('../../lib/utils');

module.exports = {
  setup(ctx) {
    ctx.db.exec(`
      CREATE TABLE IF NOT EXISTS plugin_page_views (
        slug TEXT PRIMARY KEY,
        views INTEGER NOT NULL DEFAULT 0,
        last_at TEXT
      );
    `);
  },

  contentFilter(ctx) {
    if (!ctx.post || ctx.post.isPage) return null;
    try {
      ctx.db.prepare(`
        INSERT INTO plugin_page_views (slug, views, last_at) VALUES (?, 1, ?)
        ON CONFLICT(slug) DO UPDATE SET views = views + 1, last_at = excluded.last_at
      `).run(ctx.post.slug, new Date().toISOString());
    } catch (_) { /* 计数失败不影响页面渲染 */ }
    return null;
  },

  postMeta(ctx) {
    if (!ctx.post || ctx.post.isPage) return '';
    let views = 0;
    try {
      const row = ctx.db.prepare('SELECT views FROM plugin_page_views WHERE slug = ?').get(ctx.post.slug);
      views = row ? row.views : 0;
    } catch (_) {}
    return `<span class="dot">·</span><span class="plugin-meta" title="浏览量">👁 ${views}</span>`;
  },

  sidebar(ctx) {
    const limit = Math.max(1, Math.min(20, Number(this.settings.get('sidebarCount', 5)) || 5));
    let rows = [];
    try {
      rows = ctx.db.prepare('SELECT slug, views FROM plugin_page_views ORDER BY views DESC LIMIT ?').all(limit);
    } catch (_) { return []; }
    const items = [];
    let rank = 1;
    for (const r of rows) {
      const post = ctx.store ? ctx.store.getPost(r.slug, { includeDrafts: false }) : null;
      if (!post) continue;
      items.push(`<li><span class="rank">${String(rank++).padStart(2, '0')}</span>` +
        `<a href="${ctx.url('/post/' + encodeURIComponent(post.slug))}">${escapeHtml(post.title)}</a>` +
        `<span class="count">${r.views}</span></li>`);
    }
    if (!items.length) return [];
    return [{ id: 'page-views-hot', title: '🔥 热门文章', html: `<ul class="widget-list">${items.join('')}</ul>`, order: 20 }];
  },
};
