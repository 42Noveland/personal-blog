'use strict';
/**
 * 评论插件 — 完整示例：自带数据表、公开 API、后台 API、后台面板、静态资源
 *
 * 前台：postFooter 注入评论区（结构 + data-* 参数），public/comments.js 负责取数与提交
 * 后台：adminPanels 注册「评论管理」页签，public/admin.js 负责审核 UI
 * 安全：IP 限流 + 蜜罐字段 + 长度限制 + 控制字符清洗；渲染端一律转义
 */
const { escapeHtml, clientIp, RateLimiter } = require('../../lib/utils');

const postLimiter = new RateLimiter(5, 10 * 60000); // 每 IP 十分钟最多 5 条

module.exports = {
  setup(ctx) {
    ctx.db.exec(`
      CREATE TABLE IF NOT EXISTS plugin_comments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        slug TEXT NOT NULL,
        author TEXT NOT NULL,
        email TEXT,
        content TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'approved',
        ip TEXT,
        ua TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_comments_slug_status ON plugin_comments(slug, status);
    `);
    this.http = null;
  },

  head(ctx) {
    const v = '1';
    return `<link rel="stylesheet" href="${ctx.url('/plugin-assets/comments/comments.css?v=' + v)}">
    <script src="${ctx.url('/plugin-assets/comments/comments.js?v=' + v)}" defer></script>`;
  },

  postFooter(ctx) {
    const post = ctx.post;
    if (!post || !ctx.settings.get('enabled', true)) return '';
    return `<section class="comments" id="comments"
      data-comments data-slug="${escapeHtml(post.slug)}" data-base="${escapeHtml(ctx.url(''))}"
      data-moderation="${ctx.settings.get('moderation', false) ? '1' : '0'}">
      <h2 class="comments-title">💬 评论 <span class="comments-count" data-count></span></h2>
      <div class="comments-list" data-list><p class="comments-empty">加载中…</p></div>
      <form class="comment-form" data-form autocomplete="off">
        <div class="cf-row">
          <input type="text" name="author" placeholder="昵称 *" maxlength="40" required aria-label="昵称">
          <input type="email" name="email" placeholder="邮箱（仅站长可见，选填）" maxlength="120" aria-label="邮箱（选填）">
        </div>
        <textarea name="content" rows="4" placeholder="说点什么…（支持换行，不允许 HTML）" required aria-label="评论内容"></textarea>
        <input type="text" name="website" class="cf-hp" tabindex="-1" aria-hidden="true" autocomplete="off">
        <div class="cf-actions">
          <span class="cf-msg" data-msg></span>
          <button type="submit" class="btn">发表评论</button>
        </div>
      </form>
    </section>`;
  },

  adminPanels() {
    return [{
      id: 'comments',
      title: '评论管理',
      html: `<div class="card">
        <div class="row" style="align-items:center">
          <h2 style="margin:0">评论审核</h2>
          <span class="muted" data-cmt-total></span>
          <div style="flex:1"></div>
          <select data-cmt-filter style="width:auto">
            <option value="all">全部</option>
            <option value="approved">已通过</option>
            <option value="pending">待审核</option>
            <option value="spam">垃圾</option>
          </select>
          <button class="btn sm" data-cmt-refresh>刷新</button>
        </div>
      </div>
      <div class="card" style="padding:6px 10px"><table class="tbl"><tbody data-cmt-rows></tbody></table></div>`,
      script: '/plugin-assets/comments/admin.js',
    }];
  },

  routes(router, ctx) {
    const http = () => ctx.http;

    /* ---------- 公开 API ---------- */
    router.get('/api/comments/:slug', (req, res, { params, url }) => {
      const perPage = Math.max(1, Math.min(50, Number(ctx.settings.get('perPage', 20)) || 20));
      const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10) || 1);
      const total = ctx.db.prepare('SELECT COUNT(*) AS c FROM plugin_comments WHERE slug = ? AND status = \'approved\'').get(params.slug).c;
      const rows = ctx.db.prepare(
        'SELECT id, author, content, created_at FROM plugin_comments WHERE slug = ? AND status = \'approved\' ORDER BY id DESC LIMIT ? OFFSET ?'
      ).all(params.slug, perPage, (page - 1) * perPage);
      return http().json(res, {
        ok: true,
        total,
        pages: Math.max(1, Math.ceil(total / perPage)),
        page,
        comments: rows.map(publicShape),
      });
    });

    router.post('/api/comments/:slug', async (req, res, { params }) => {
      const send = http();
      if (!ctx.settings.get('enabled', true)) return send.json(res, { ok: false, error: '评论已关闭' }, 403);
      if (!send.sameOrigin(req)) return send.json(res, { ok: false, error: '跨站请求被拒绝' }, 403);

      const ip = clientIp(req);
      if (!postLimiter.check(ip)) return send.json(res, { ok: false, error: '发言太快了，请稍后再试' }, 429);

      let body;
      try { body = await send.readJson(req); } catch (e) { return send.json(res, { ok: false, error: '请求格式错误' }, 400); }

      if (body.website) return send.json(res, { ok: true, pending: true, message: '评论已提交' }); // 蜜罐命中：静默丢弃

      const author = clean(body.author, 40);
      const content = clean(body.content, Math.max(10, Math.min(5000, Number(ctx.settings.get('maxLength', 1000)) || 1000)));
      const email = clean(body.email, 120);
      if (!author) return send.json(res, { ok: false, error: '请填写昵称' }, 400);
      if (!content || content.length < 2) return send.json(res, { ok: false, error: '评论内容太短' }, 400);
      if ((content.match(/https?:\/\//g) || []).length > 3) return send.json(res, { ok: false, error: '链接太多了' }, 400);
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return send.json(res, { ok: false, error: '邮箱格式不对' }, 400);

      const moderation = !!ctx.settings.get('moderation', false);
      const status = moderation ? 'pending' : 'approved';
      ctx.db.prepare(
        'INSERT INTO plugin_comments (slug, author, email, content, status, ip, ua, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(params.slug, author, email || null, content, status, ip, String(req.headers['user-agent'] || '').slice(0, 200), new Date().toISOString());

      return send.json(res, {
        ok: true,
        pending: moderation,
        message: moderation ? '评论已提交，等待站长审核后展示' : '评论已发布',
      });
    });

    /* ---------- 后台 API（{auth:'admin'} 由内核统一拦截） ---------- */
    router.get('/api/admin/comments', (req, res, { url }) => {
      const status = url.searchParams.get('status') || 'all';
      const rows = status === 'all'
        ? ctx.db.prepare('SELECT * FROM plugin_comments ORDER BY id DESC LIMIT 300').all()
        : ctx.db.prepare('SELECT * FROM plugin_comments WHERE status = ? ORDER BY id DESC LIMIT 300').all(status);
      const counts = {};
      for (const r of ctx.db.prepare('SELECT status, COUNT(*) AS c FROM plugin_comments GROUP BY status').all()) counts[r.status] = r.c;
      return http().json(res, { ok: true, comments: rows, counts });
    }, { auth: 'admin' });

    router.post('/api/admin/comments/:id', async (req, res, { params }) => {
      const send = http();
      const body = await send.readJson(req);
      if (!['approve', 'pending', 'spam'].includes(body.action)) return send.json(res, { ok: false, error: '未知操作' }, 400);
      const status = { approve: 'approved', pending: 'pending', spam: 'spam' }[body.action];
      const r = ctx.db.prepare('UPDATE plugin_comments SET status = ? WHERE id = ?').run(status, Number(params.id));
      return send.json(res, { ok: !!r.changes });
    }, { auth: 'admin' });

    router.delete('/api/admin/comments/:id', (req, res, { params }) => {
      const r = ctx.db.prepare('DELETE FROM plugin_comments WHERE id = ?').run(Number(params.id));
      return http().json(res, { ok: !!r.changes });
    }, { auth: 'admin' });
  },
};

/** 清洗：去控制字符、去首尾空白、截断长度（HTML 一律在渲染端转义） */
function clean(v, max) {
  return String(v == null ? '' : v)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .trim()
    .slice(0, max);
}

function publicShape(row) {
  return { id: row.id, author: row.author, content: row.content, createdAt: row.created_at };
}
