'use strict';
/**
 * server.js — 博客引擎入口
 *
 * 零 npm 依赖：node:http / node:fs / node:crypto / node:sqlite
 * 启动：node server.js   （环境变量 BLOG_HOST / BLOG_PORT / BLOG_BASE_PATH 可覆盖配置）
 */
// 屏蔽 node:sqlite 的实验性告警（其余告警照常）
(function quietExperimental() {
  const emit = process.emitWarning;
  process.emitWarning = function (warning, ...args) {
    const type = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].type);
    const text = typeof warning === 'string' ? warning : (warning && warning.message) || '';
    if (type === 'ExperimentalWarning' && /SQLite/i.test(text)) return;
    return emit.call(process, warning, ...args);
  };
})();

const http = require('http');
const fs = require('fs');
const path = require('path');
const { performance } = require('perf_hooks');

const configLib = require('./lib/config');
const { Store } = require('./lib/store');
const { Router } = require('./lib/router');
const { Auth, sameOrigin } = require('./lib/auth');
const { PluginManager } = require('./lib/plugins');
const { Themes } = require('./lib/themes');
const { Renderer } = require('./lib/render');
const { Widgets } = require('./lib/widgets');
const utils = require('./lib/utils');

const { escapeHtml, clientIp, RateLimiter } = utils;

/* ==================== 上下文 ==================== */

const ROOT = configLib.ROOT;
configLib.ensureDirs();

let config = configLib.load();
const bootPassword = configLib.bootstrapAdmin(config);
config = configLib.load(); // 重新读取（可能写入了新口令散列）

const store = new Store(ROOT, config).init();
const router = new Router();
const auth = new Auth(store, config);
const plugins = new PluginManager({ root: ROOT, store, config, router, log: console });
const themes = new Themes({ root: ROOT, store, config, log: console });
plugins.themes = themes;
const renderer = new Renderer({ root: ROOT, store, config, plugins, themes });
renderer.auth = auth;
plugins.renderer = renderer;
const widgets = new Widgets({ store, config, plugins, renderer }).init();
renderer.widgets = widgets;
plugins.widgets = widgets;

const commentLimiter = new RateLimiter(6, 60000);
const apiWriteLimiter = new RateLimiter(240, 60000); // 每 IP 每分钟写操作总量（防爆破/刷接口）
const requestLog = [];
const startedAt = Date.now();

/* ==================== HTTP 工具 ==================== */

function send(res, status, body, headers = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': buf.length,
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(buf);
}

function json(res, data, status = 200, headers = {}) {
  const body = JSON.stringify(data);
  send(res, status, body, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
}

function text(res, body, status = 200, type = 'text/plain; charset=utf-8') {
  send(res, status, body, { 'Content-Type': type });
}

function redirect(res, location, status = 302) {
  send(res, status, '', { Location: location });
}

function readBody(req, limit = 512 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('请求体过大'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const raw = await readBody(req);
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch (_) {
    throw Object.assign(new Error('JSON 解析失败'), { status: 400 });
  }
}

const MIME = {
  '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
};

function serveFile(req, res, file, { cache = 'public, max-age=300', download = false } = {}) {
  let stat;
  try { stat = fs.statSync(file); } catch (_) { return false; }
  if (!stat.isFile()) return false;
  const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const etag = `W/"${stat.size}-${Math.floor(stat.mtimeMs)}"`;
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { ETag: etag, 'Cache-Control': cache });
    res.end();
    return true;
  }
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': stat.size,
    ETag: etag,
    'Cache-Control': cache,
    'X-Content-Type-Options': 'nosniff',
  });
  if (req.method === 'HEAD') { res.end(); return true; }
  fs.createReadStream(file).pipe(res);
  return true;
}

function requireAdmin(req, res) {
  if (auth.isAdmin(req)) return true;
  json(res, { ok: false, error: '未登录或会话已过期' }, 401);
  return false;
}

/** 同源校验（写操作） */
function requireSameOrigin(req, res) {
  if (sameOrigin(req)) return true;
  json(res, { ok: false, error: '跨站请求被拒绝' }, 403);
  return false;
}

/* 把 HTTP 工具交给插件（插件路由里通过 ctx.http 使用） */
plugins.http = { send, json, text, redirect, readJson, readBody, sameOrigin, clientIp };

/* 载入插件（在 http 工具就绪之后，插件路由与 setup 才能拿到完整上下文） */
plugins.loadAll();

/* ==================== 页面路由 ==================== */

function pageHandler(fn) {
  return (req, res, { params, url }) => {
    const c = renderer.ctx(req);
    const html = fn(c, params, url);
    if (html === null || html === undefined) return send(res, 404, renderer.notFound(c));
    send(res, 200, html, { 'Cache-Control': 'no-cache' });
  };
}

router.get('/', pageHandler((c) => renderer.home(c, { page: 1 })));
router.get('/page/:n', pageHandler((c, p) => {
  const n = Math.max(1, parseInt(p.n, 10) || 1);
  return renderer.home(c, { page: n });
}));
router.get('/post/:slug', pageHandler((c, p) => {
  const post = store.getPost(p.slug);
  return post && !post.isPage ? renderer.postPage(c, post) : null;
}));
router.get('/p/:slug', pageHandler((c, p) => {
  const page = store.getPage(p.slug);
  return page ? renderer.staticPage(c, page) : null;
}));
router.get('/tag/:tag', pageHandler((c, p) => renderer.home(c, { tag: p.tag, page: 1 })));
router.get('/tag/:tag/page/:n', pageHandler((c, p) => renderer.home(c, { tag: p.tag, page: Math.max(1, parseInt(p.n, 10) || 1) })));
router.get('/archive', pageHandler((c) => renderer.archive(c)));
router.get('/search', pageHandler((c, p, url) => renderer.search(c, url.searchParams.get('q') || '', Math.max(1, parseInt(url.searchParams.get('page') || '1', 10) || 1))));
router.get('/about', (req, res) => redirect(res, renderer.url('/p/about')));

router.get('/feed.xml', (req, res) => text(res, renderer.feedXml(), 200, 'application/rss+xml; charset=utf-8'));
router.get('/rss.xml', (req, res) => redirect(res, renderer.url('/feed.xml'), 301));
router.get('/sitemap.xml', (req, res) => text(res, renderer.sitemapXml(), 200, 'application/xml; charset=utf-8'));
router.get('/robots.txt', (req, res) => {
  const base = config.siteUrl || '';
  text(res, `User-agent: *\nAllow: /\nDisallow: ${config.server.basePath}/admin\nSitemap: ${base}${config.server.basePath}/sitemap.xml\n`);
});

/* ==================== 后台页面 ==================== */

router.get('/admin', (req, res) => {
  const c = renderer.ctx(req);
  send(res, 200, renderer.adminShell(c), { 'Cache-Control': 'no-cache' });
});
router.get('/admin/*', (req, res) => {
  const c = renderer.ctx(req);
  send(res, 200, renderer.adminShell(c), { 'Cache-Control': 'no-cache' });
});

/* ==================== 公开 API ==================== */

router.get('/api/site', (req, res) => {
  const c = renderer.ctx(req);
  json(res, { ok: true, site: { ...c.site, nav: undefined }, themes: themes.scan().map((t) => t.name) });
});

router.get('/api/posts', (req, res, { url }) => {
  const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10) || 1);
  const tag = url.searchParams.get('tag') || null;
  const q = url.searchParams.get('q') || null;
  const res1 = store.list({ page, tag, q, perPage: Number(url.searchParams.get('perPage')) || config.posts.perPage });
  json(res, {
    ok: true,
    ...res1,
    items: res1.items.map((p) => ({
      slug: p.slug, title: p.title, date: p.date, tags: p.tags,
      summary: p.summary || utils.plainText(p.raw, 200),
      url: renderer.url('/post/' + encodeURIComponent(p.slug)),
      readingMinutes: p.readingMinutes, words: p.words,
    })),
  });
});

router.get('/api/post/:slug', (req, res, { params }) => {
  const post = store.getPost(params.slug);
  if (!post) return json(res, { ok: false, error: 'not found' }, 404);
  json(res, { ok: true, post: { ...post, raw: post.raw, text: undefined, file: undefined, dateObj: undefined } });
});

router.get('/api/tags', (req, res) => json(res, { ok: true, tags: store.tags() }));

/* ==================== 后台 API ==================== */

router.post('/api/admin/login', async (req, res) => {
  if (!requireSameOrigin(req, res)) return;
  try {
    const body = await readJson(req);
    const { token } = auth.login(body.password, { ip: clientIp(req), ua: req.headers['user-agent'] });
    auth.setSessionCookie(res, token);
    json(res, { ok: true, user: config.admin.user });
  } catch (e) {
    console.warn(`[auth] 登录失败 ip=${clientIp(req)} ua=${String(req.headers['user-agent'] || '').slice(0, 60)} 原因=${e.message}`);
    json(res, { ok: false, error: e.message }, e.status || 400);
  }
});

router.post('/api/admin/logout', (req, res) => {
  auth.logout(req, res);
  json(res, { ok: true });
});

router.get('/api/admin/me', (req, res) => {
  const s = auth.session(req);
  json(res, { ok: true, user: s ? s.username : null, passwordIsDefault: false });
});

router.get('/api/admin/stats', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const st = store.stats();
  json(res, {
    ok: true,
    ...st,
    uptime: Math.round((Date.now() - startedAt) / 1000),
    node: process.version,
    memory: Math.round(process.memoryUsage().rss / 1048576),
    plugins: plugins.list().length,
    theme: themes.current(),
    themeTitle: (themes.scan().find((t) => t.name === themes.current()) || {}).title || themes.current(),
    recent: requestLog.slice(-30).reverse(),
  });
});

router.get('/api/admin/posts', (req, res) => {
  if (!requireAdmin(req, res)) return;
  json(res, {
    ok: true,
    posts: store.posts.map((p) => ({
      slug: p.slug, title: p.title, date: p.date, tags: p.tags, draft: p.draft,
      pinned: p.pinned, words: p.words, updated: p.updated,
      url: renderer.url('/post/' + encodeURIComponent(p.slug)),
    })),
    pages: store.pages.map((p) => ({ slug: p.slug, title: p.title, updated: p.updated, url: renderer.url('/p/' + encodeURIComponent(p.slug)) })),
  });
});

router.get('/api/admin/post', (req, res, { url }) => {
  if (!requireAdmin(req, res)) return;
  const slug = url.searchParams.get('slug');
  const post = store.getPost(slug, { includeDrafts: true });
  if (!post) return json(res, { ok: false, error: '文章不存在' }, 404);
  json(res, {
    ok: true,
    post: {
      slug: post.slug, title: post.title, date: utils.formatDate(post.dateObj, 'YYYY-MM-DD HH:mm'),
      tags: post.tags, summary: post.summary, cover: post.cover, draft: post.draft, pinned: post.pinned,
      isPage: post.isPage, content: post.raw,
    },
  });
});

router.post('/api/admin/post', async (req, res) => {
  if (!requireAdmin(req, res) || !requireSameOrigin(req, res)) return;
  try {
    const body = await readJson(req);
    if (!body.title || !String(body.title).trim()) return json(res, { ok: false, error: '标题不能为空' }, 400);
    const saved = store.savePost({
      originalSlug: body.originalSlug || null,
      slug: body.slug,
      title: body.title,
      date: body.date,
      tags: body.tags,
      summary: body.summary,
      cover: body.cover,
      draft: body.draft,
      pinned: body.pinned,
      isPage: body.isPage,
      content: body.content,
    });
    json(res, { ok: true, slug: saved.slug, url: renderer.url((saved.isPage ? '/p/' : '/post/') + encodeURIComponent(saved.slug)) });
  } catch (e) {
    json(res, { ok: false, error: e.message }, e.status || 500);
  }
});

router.delete('/api/admin/post', async (req, res, { url }) => {
  if (!requireAdmin(req, res) || !requireSameOrigin(req, res)) return;
  const slug = url.searchParams.get('slug');
  const ok = store.deletePost(slug);
  json(res, { ok, error: ok ? undefined : '删除失败' });
});

router.get('/api/admin/settings', (req, res) => {
  if (!requireAdmin(req, res)) return;
  json(res, {
    ok: true,
    site: store.siteSettings(),
    settings: store.allSettings(),
    config: {
      posts: config.posts, markdown: config.markdown, server: config.server,
      theme: themes.current(), siteUrl: config.siteUrl || '',
    },
  });
});

router.post('/api/admin/settings', async (req, res) => {
  if (!requireAdmin(req, res) || !requireSameOrigin(req, res)) return;
  try {
    const body = await readJson(req);
    for (const [k, v] of Object.entries(body.settings || {})) {
      if (/^site\.[a-zA-Z0-9_]+$/.test(k)) store.setSetting(k, v);
    }
    if (body.theme && themes.use(body.theme)) store.setSetting('theme', body.theme);
    json(res, { ok: true });
  } catch (e) {
    json(res, { ok: false, error: e.message }, 400);
  }
});

router.post('/api/admin/password', async (req, res) => {
  if (!requireAdmin(req, res) || !requireSameOrigin(req, res)) return;
  try {
    const body = await readJson(req);
    if (!auth.isAdmin(req)) return json(res, { ok: false, error: '未登录' }, 401);
    const { verifyPassword, hashPassword } = require('./lib/auth');
    if (!verifyPassword(body.current || '', config.admin.passwordHash)) {
      return json(res, { ok: false, error: '当前密码不正确' }, 400);
    }
    if (!body.next || String(body.next).length < 8) {
      return json(res, { ok: false, error: '新密码至少 8 位' }, 400);
    }
    if (String(body.next).length > 200) {
      return json(res, { ok: false, error: '新密码过长' }, 400);
    }
    config.admin.passwordHash = hashPassword(String(body.next));
    configLib.save(config);
    // 改密后让所有旧会话立即失效（包含当前这条），避免泄漏的会话继续可用
    const purged = store.db.prepare('DELETE FROM sessions').run().changes;
    console.warn(`[auth] 管理员密码已更新，已注销 ${purged} 个会话（ip=${clientIp(req)}）`);
    json(res, { ok: true, relogin: true, sessionsPurged: purged });
  } catch (e) {
    json(res, { ok: false, error: e.message }, 400);
  }
});

router.get('/api/admin/plugins', (req, res) => {
  if (!requireAdmin(req, res)) return;
  json(res, { ok: true, plugins: plugins.status(), panels: plugins.panels(), hooks: require('./lib/plugins').HOOKS });
});

router.post('/api/admin/plugins', async (req, res) => {
  if (!requireAdmin(req, res) || !requireSameOrigin(req, res)) return;
  try {
    const body = await readJson(req);
    const { name, action } = body;
    if (!name) return json(res, { ok: false, error: '缺少插件名' }, 400);
    if (action === 'enable') {
      const r = plugins.setEnabled(name, true);
      return json(res, { ok: true, result: r, plugins: plugins.status() });
    }
    if (action === 'disable') {
      plugins.setEnabled(name, false);
      return json(res, { ok: true, plugins: plugins.status() });
    }
    if (action === 'reload') {
      const r = plugins.reload(name);
      return json(res, { ok: !r.error, result: r, plugins: plugins.status() });
    }
    if (action === 'setting') {
      const invalid = plugins.validateSetting(name, body.key, body.value);
      if (invalid) return json(res, { ok: false, error: invalid }, 400);
      store.setSetting(`plugin.${name}.${body.key}`, body.value);
      return json(res, { ok: true, settings: plugins.pluginSettings(name) });
    }
    json(res, { ok: false, error: '未知操作' }, 400);
  } catch (e) {
    json(res, { ok: false, error: e.message }, 400);
  }
});

router.get('/api/admin/themes', (req, res) => {
  if (!requireAdmin(req, res)) return;
  json(res, { ok: true, themes: themes.scan(), current: themes.current() });
});

/* ---------------- 小工具 ---------------- */

router.get('/api/admin/widgets', (req, res) => {
  if (!requireAdmin(req, res)) return;
  json(res, {
    ok: true,
    zones: widgets.zones(),
    types: [...widgets.types().keys()].map((t) => widgets.typeDescriptor(t)),
    widgets: widgets.adminList(),
  });
});

router.post('/api/admin/widgets', async (req, res) => {
  if (!requireAdmin(req, res) || !requireSameOrigin(req, res)) return;
  try {
    const body = await readJson(req);
    const c = renderer.ctx(req);
    switch (body.action) {
      case 'create': return json(res, { ok: true, widget: widgets.create(body.widget || {}) });
      case 'update': return json(res, { ok: true, widget: widgets.update(body.id, body.patch || {}) });
      case 'delete': return json(res, { ok: widgets.remove(body.id) });
      case 'toggle': return json(res, { ok: true, widget: widgets.toggle(body.id, body.enabled) });
      case 'move': return json(res, { ok: widgets.move(body.id, body.dir === 'up' ? 'up' : 'down') });
      case 'preview': return json(res, { ok: true, html: widgets.preview(body.type, body.config, c) });
      default: return json(res, { ok: false, error: '未知操作' }, 400);
    }
  } catch (e) {
    return json(res, { ok: false, error: e.message }, e.status || 400);
  }
});

router.post('/api/admin/themes', async (req, res) => {
  if (!requireAdmin(req, res) || !requireSameOrigin(req, res)) return;
  const body = await readJson(req);
  const ok = themes.use(String(body.name || ''));
  json(res, { ok, current: themes.current(), error: ok ? undefined : '主题不存在' });
});

router.post('/api/preview', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const body = await readJson(req);
  const headings = [];
  const html = require('./lib/markdown').render(String(body.markdown || ''), {
    allowRawHtml: config.markdown.allowRawHtml,
    breaks: config.markdown.breaks,
    headings,
  });
  json(res, { ok: true, html, headings });
});

/* 评论等插件路由挂载在同一 router 上（带 owner 标记，便于热卸载） */

/* ==================== 请求处理 ==================== */

function handleStatic(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;

  if (pathname.startsWith('/assets/')) {
    const rel = pathname.slice('/assets/'.length);
    const baseDir = path.resolve(path.join(ROOT, 'public', 'assets'));
    const file = path.resolve(baseDir, rel);
    if (!file.startsWith(baseDir + path.sep) && file !== baseDir) {
      send(res, 403, 'Forbidden', { 'Content-Type': 'text/plain; charset=utf-8' });
      return true;
    }
    return serveFile(req, res, file) || false;
  }

  if (pathname === '/theme-assets/theme.css') {
    const theme = themes.current();
    const file = path.join(themes.dir, theme, 'theme.css');
    if (fs.existsSync(file)) return serveFile(req, res, file);
    return serveFile(req, res, path.join(ROOT, 'themes', config.theme, 'theme.css'));
  }

  if (pathname.startsWith('/plugin-assets/')) {
    const rest = pathname.slice('/plugin-assets/'.length);
    const [name, ...relParts] = rest.split('/');
    const file = plugins.assetPath(name, relParts.join('/'));
    if (file) return serveFile(req, res, file);
    return false;
  }

  if (pathname.startsWith('/uploads/')) {
    const rel = pathname.slice('/uploads/'.length);
    const base = path.resolve(path.join(ROOT, 'content', 'uploads'));
    const file = path.resolve(base, rel);
    if (!file.startsWith(base + path.sep) && file !== base) {
      send(res, 403, 'Forbidden', { 'Content-Type': 'text/plain; charset=utf-8' });
      return true;
    }
    return serveFile(req, res, file, { cache: 'public, max-age=86400' }) || false;
  }

  return false;
}

async function handle(req, res) {
  const t0 = performance.now();
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  } catch (_) {
    return send(res, 400, 'Bad Request');
  }
  let pathname = decodeURIComponent(url.pathname);
  const base = config.server.basePath;
  if (base && pathname.startsWith(base)) {
    pathname = pathname.slice(base.length) || '/';
  }

  // 每请求 nonce：CSP 只允许带 nonce 的内联脚本，杜绝注入脚本执行
  const nonce = require('crypto').randomBytes(18).toString('base64');
  req._nonce = nonce;
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}'`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "form-action 'self'",
    "frame-ancestors 'self'",
    "base-uri 'self'",
    "object-src 'none'",
  ].join('; '));
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');

  res.on('finish', () => {
    if (pathname.startsWith('/assets/') || pathname.startsWith('/plugin-assets/')) return;
    requestLog.push({
      t: new Date().toISOString(),
      m: req.method,
      p: pathname,
      s: res.statusCode,
      ms: Math.round(performance.now() - t0),
      ip: clientIp(req),
    });
    if (requestLog.length > 300) requestLog.shift();
  });

  try {
    if (handleStatic(req, res, pathname)) return;

    // 写接口全局限流（评论、登录另有更严格的独立限流）
    if (/^(POST|PUT|PATCH|DELETE)$/.test(req.method) && pathname.startsWith('/api/')) {
      if (!apiWriteLimiter.check(clientIp(req))) {
        return json(res, { ok: false, error: '请求过于频繁，请稍后再试' }, 429);
      }
    }

    const m = router.match(req.method, pathname);
    if (m && m.route) {
      const { route, params } = m;
      if (route.opts.auth === 'admin' && !requireAdmin(req, res)) return;
      return await route.handler(req, res, { params, url, route });
    }
    if (m && m.methodNotAllowed) {
      return json(res, { ok: false, error: '方法不允许' }, 405);
    }
    if (req.method === 'GET') {
      const c = renderer.ctx(req);
      return send(res, 404, renderer.notFound(c), { 'Cache-Control': 'no-cache' });
    }
    json(res, { ok: false, error: 'not found' }, 404);
  } catch (e) {
    const status = e.status || 500;
    console.error(`[error] ${req.method} ${pathname}: ${e.stack || e.message}`);
    if (res.headersSent) return res.end();
    if (pathname.startsWith('/api/')) {
      return json(res, { ok: false, error: e.message || '服务器错误' }, status);
    }
    const c = renderer.ctx(req);
    send(res, status, renderer.errorPage(c, status, status === 500 ? '服务器内部错误' : e.message), { 'Cache-Control': 'no-cache' });
  }
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    console.error('[fatal]', e);
    try { res.writeHead(500); res.end('Internal Error'); } catch (_) {}
  });
});

/* ==================== 生命周期 ==================== */

function reloadAll(reason) {
  try {
    config = configLib.load();
    store.config = config;
    auth.config = config;
    plugins.config = config;
    themes.config = config;
    renderer.config = config;
    store.reloadContent();
    plugins.loadAll();
    console.log(`[boot] 已重新加载（${reason}）`);
  } catch (e) {
    console.error('[boot] 重载失败：', e.message);
  }
}

process.on('SIGHUP', () => reloadAll('SIGHUP'));
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

function shutdown() {
  console.log('[boot] 正在退出…');
  for (const p of plugins.list(false)) {
    if (p.hooks && typeof p.hooks.teardown === 'function') {
      try { p.hooks.teardown(); } catch (_) {}
    }
  }
  server.close(() => {
    try { store.db.close(); } catch (_) {}
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 3000);
}

// 定时清理过期会话
setInterval(() => store.purgeSessions(), 3600 * 1000).unref();

server.listen(config.server.port, config.server.host, () => {
  const p = plugins.list();
  console.log(`\n  🌙 ${config.site.title} 已启动`);
  console.log(`     监听      http://${config.server.host}:${config.server.port}${config.server.basePath || '/'}`);
  console.log(`     文章      ${store.posts.length} 篇 / 页面 ${store.pages.length} 个`);
  console.log(`     主题      ${themes.current()}`);
  console.log(`     插件      ${p.map((x) => x.name).join(', ') || '（无）'}`);
  console.log(`     后台      ${config.server.basePath || ''}/admin  （用户 ${config.admin.user}）`);
  if (bootPassword) console.log(`     ⚠ 已生成初始管理密码：${bootPassword}（请尽快修改）`);
  console.log('');
});

module.exports = { server, store, router, plugins, themes, renderer, auth, config };
