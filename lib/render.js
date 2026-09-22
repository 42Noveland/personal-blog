'use strict';
/**
 * render.js — HTML 渲染层
 *   默认布局片段集中在 defaultLayout，主题 themes/<name>/layout.js 可覆盖任意片段。
 *   插件通过钩子在固定挂载点注入 HTML（head / navItems / postMeta / postHeader /
 *   postFooter / sidebar / footer）。
 */
const fs = require('fs');
const path = require('path');
const { escapeHtml, escapeAttr, formatDate, truncate, plainText } = require('./utils');
const markdown = require('./markdown');

const ASSET_DIR = path.join(__dirname, '..', 'public', 'assets');

class Renderer {
  constructor({ root, store, config, plugins, themes }) {
    this.root = root;
    this.store = store;
    this.config = config;
    this.plugins = plugins;
    this.themes = themes;
    this._assetVer = {};
  }

  /* ---------------- 基础 ---------------- */

  url(p) {
    const base = this.config.server.basePath || '';
    if (!p) return base || '/';
    if (!p.startsWith('/')) p = '/' + p;
    return base + p;
  }

  asset(name) {
    const file = path.join(ASSET_DIR, name);
    let v = this._assetVer[name];
    if (!v) {
      try { v = String(Math.floor(fs.statSync(file).mtimeMs)); } catch (_) { v = '0'; }
      this._assetVer[name] = v;
    }
    return `${this.url('/assets/' + name)}?v=${v}`;
  }

  site() {
    const s = this.store.siteSettings();
    const nav = Array.isArray(s.nav) ? s.nav.slice() : [];
    const navCtx = {
      site: s,
      config: this.config,
      store: this.store,
      plugins: this.plugins,
      url: (p) => this.url(p),
      state: {},
    };
    const pluginNav = this.plugins.items('navItems', navCtx);
    const merged = nav.concat(pluginNav.map((n) => ({ label: n.label, href: n.href })));
    return {
      ...s,
      nav: merged.map((n) => ({ label: n.label, href: this.url(n.href || '/') })),
    };
  }

  ctx(req, extra = {}) {
    return {
      req,
      nonce: (req && req._nonce) || '',
      site: this.site(),
      config: this.config,
      store: this.store,
      db: this.store.db,
      plugins: this.plugins,
      url: (p) => this.url(p),
      state: {},
      ...extra,
    };
  }

  layout() {
    const t = this.themes.get(this.themes.current());
    return { ...defaultLayout, ...t.layout, __theme: t.name };
  }

  /* ---------------- 文档外壳 ---------------- */

  doc(c, { title, description, bodyClass = '', content, extraHead = '', extraScripts = '', active = '', ogType = 'website', canonical = '', noIndex = false }) {
    const L = this.layout();
    const theme = this.themes.current();
    const head = [
      this.themes.cssUrl(theme, this.config.server.basePath),
      this.asset('blog.css'),
    ].map((href) => `<link rel="stylesheet" href="${escapeAttr(href)}">`).join('\n    ');
    return L.shell({
      site: c.site,
      url: (p) => this.url(p),
      title,
      description,
      bodyClass,
      content,
      active,
      ogType,
      canonical,
      noIndex,
      nonce: c.nonce || '',
      headLinks: head,
      pluginHead: this.plugins.html('head', c),
      footerHtml: [
        this.widgets ? this.widgets.renderZoneBlocks('footer', c, 'footer-widget') : '',
        this.plugins.html('footer', c),
      ].filter(Boolean).join('\n'),
      extraScripts: [this.config.markdown.highlight ? `<script src="${escapeAttr(this.asset('highlight.js'))}" defer></script>` : '', extraScripts].filter(Boolean).join('\n    '),
      renderer: this,
      L,
      ctx: c,
    });
  }

  /* ---------------- 页面 ---------------- */

  home(c, { page = 1, tag = null } = {}) {
    const perPage = this.config.posts.perPage;
    const res = this.store.list({ tag, page, perPage });
    const tags = this.store.tags();
    const site = c.site;
    const title = tag ? `标签：${tag}` : (page > 1 ? `第 ${page} 页` : `${site.title}`);
    const description = tag ? `关于「${tag}」的全部文章` : (site.description || site.subtitle);

    const hero = (!tag && page === 1) ? `
      <section class="hero">
        <h1 class="hero-title">${escapeHtml(site.title)}</h1>
        ${site.subtitle ? `<p class="hero-sub">${escapeHtml(site.subtitle)}</p>` : ''}
        ${site.description ? `<p class="hero-desc">${escapeHtml(site.description)}</p>` : ''}
        <div class="hero-stats">
          <span><strong>${this.store.posts.filter((p) => !p.draft).length}</strong> 篇文章</span>
          <span><strong>${tags.length}</strong> 个标签</span>
        </div>
      </section>` : (tag ? `
      <header class="page-head">
        <h1>标签：${escapeHtml(tag)}</h1>
        <p class="page-sub">共 ${res.total} 篇 · <a href="${escapeAttr(this.url('/'))}">返回全部</a></p>
      </header>` : '');

    const cards = res.items.map((p) => this.layout().postCard(this, c, p)).join('\n');
    const empty = `<div class="empty">还没有文章。去 <a href="${escapeAttr(this.url('/admin'))}">后台</a> 写第一篇吧 ✍️</div>`;

    const inner = `
      <div class="wrap layout">
        <section class="content" id="content">
          ${hero}
          ${this.widgets ? this.widgets.renderZoneBlocks('homeTop', c) : ''}
          <div class="post-list">${res.items.length ? cards : empty}</div>
          ${this.pagination(c, { page: res.page, pages: res.pages, total: res.total, tag })}
        </section>
        ${this.sidebar(c)}
      </div>`;

    return this.doc(c, { title, description, content: inner, bodyClass: 'page-home', active: tag ? '' : 'home' });
  }

  postPage(c, post) {
    const rctx = c;
    rctx.post = post;
    // 1) 正文渲染（收集标题供 TOC 等插件使用）
    const headings = [];
    let html = markdown.render(post.raw, {
      allowRawHtml: this.config.markdown.allowRawHtml,
      breaks: this.config.markdown.breaks,
      headings,
      siteOrigin: '',
    });
    // 2) contentFilter 钩子在“渲染之后”运行，可读取 ctx.headings / ctx.html 并返回 {html} 替换正文
    for (const f of this.plugins.emit('contentFilter', { ...rctx, markdown: post.raw, html, headings })) {
      if (f && typeof f === 'object' && typeof f.html === 'string') html = f.html;
    }
    rctx.headings = headings;
    rctx.html = html;

    const date = formatDate(post.dateObj, this.config.posts.dateFormat);
    const tagsHtml = post.tags.map((t) =>
      `<a class="tag" href="${escapeAttr(this.url('/tag/' + encodeURIComponent(t)))}">#${escapeHtml(t)}</a>`).join('');
    const pluginMeta = this.plugins.html('postMeta', rctx);
    const postHeader = this.plugins.html('postHeader', rctx);
    const postFooter = this.plugins.html('postFooter', rctx);
    const zoneTop = this.widgets ? this.widgets.renderZoneBlocks('postTop', rctx) : '';
    const zoneBottom = this.widgets ? this.widgets.renderZoneBlocks('postBottom', rctx) : '';

    const idx = this.store.posts.indexOf(post);
    const newer = idx > 0 ? this.store.posts[idx - 1] : null;
    const older = idx >= 0 && idx < this.store.posts.length - 1 ? this.store.posts[idx + 1] : null;
    const nav = (newer || older) ? `
      <nav class="post-nav">
        ${older ? `<a class="post-nav-item prev" href="${escapeAttr(this.url('/post/' + encodeURIComponent(older.slug)))}"><span>上一篇</span><strong>${escapeHtml(older.title)}</strong></a>` : '<span></span>'}
        ${newer ? `<a class="post-nav-item next" href="${escapeAttr(this.url('/post/' + encodeURIComponent(newer.slug)))}"><span>下一篇</span><strong>${escapeHtml(newer.title)}</strong></a>` : '<span></span>'}
      </nav>` : '';

    const inner = `
      <div class="wrap layout">
        <article class="post" itemscope itemtype="https://schema.org/BlogPosting">
          <header class="post-head">
            <h1 class="post-title" itemprop="headline">${escapeHtml(post.title)}</h1>
            <div class="post-meta">
              <time datetime="${escapeAttr(post.dateObj.toISOString())}" itemprop="datePublished">${escapeHtml(date)}</time>
              ${tagsHtml ? `<span class="dot">·</span><span class="post-tags">${tagsHtml}</span>` : ''}
              ${pluginMeta}
            </div>
          </header>
          ${postHeader}
          ${zoneTop}
          <div class="prose" itemprop="articleBody">${html}</div>
          ${zoneBottom}
          ${nav}
          ${postFooter}
        </article>
        ${this.sidebar(c)}
      </div>`;

    return this.doc(c, {
      title: `${post.title} · ${c.site.title}`,
      description: post.summary || plainText(post.raw, this.config.posts.maxSummary),
      content: inner,
      bodyClass: 'page-post',
      ogType: 'article',
      canonical: this.url('/post/' + encodeURIComponent(post.slug)),
    });
  }

  staticPage(c, page) {
    const headings = [];
    const html = markdown.render(page.raw, {
      allowRawHtml: this.config.markdown.allowRawHtml,
      headings,
    });
    const inner = `
      <div class="wrap layout">
        <article class="post page-static">
          <header class="post-head"><h1 class="post-title">${escapeHtml(page.title)}</h1></header>
          ${this.widgets ? this.widgets.renderZoneBlocks('postTop', c) : ''}
          <div class="prose">${html}</div>
          ${this.widgets ? this.widgets.renderZoneBlocks('postBottom', c) : ''}
        </article>
        ${this.sidebar(c)}
      </div>`;
    return this.doc(c, { title: `${page.title} · ${c.site.title}`, content: inner, bodyClass: 'page-page' });
  }

  archive(c) {
    const years = this.store.archive();
    const inner = `
      <div class="wrap layout">
        <section class="content">
          <header class="page-head"><h1>归档</h1><p class="page-sub">共 ${this.store.posts.filter((p) => !p.draft).length} 篇</p></header>
          ${years.map(([year, posts]) => `
            <div class="archive-year">
              <h2 class="archive-year-title">${year}<span>${posts.length} 篇</span></h2>
              <ul class="archive-list">
                ${posts.map((p) => `<li><time>${escapeHtml(formatDate(p.dateObj, 'MM-DD'))}</time><a href="${escapeAttr(this.url('/post/' + encodeURIComponent(p.slug)))}">${escapeHtml(p.title)}</a></li>`).join('')}
              </ul>
            </div>`).join('\n')}
        </section>
        ${this.sidebar(c)}
      </div>`;
    return this.doc(c, { title: `归档 · ${c.site.title}`, content: inner, bodyClass: 'page-archive', active: 'archive' });
  }

  search(c, q, page = 1) {
    const res = this.store.list({ q, page, perPage: this.config.posts.perPage });
    const inner = `
      <div class="wrap layout">
        <section class="content">
          <header class="page-head">
            <h1>搜索</h1>
            <form class="search-form" action="${escapeAttr(this.url('/search'))}" method="get">
              <input type="search" name="q" value="${escapeAttr(q)}" placeholder="输入关键词…" autofocus>
              <button type="submit">搜索</button>
            </form>
            <p class="page-sub">${q ? `「${escapeHtml(q)}」共 ${res.total} 条结果` : '输入关键词开始搜索'}</p>
          </header>
          <div class="post-list">${res.items.map((p) => this.layout().postCard(this, c, p)).join('\n')}</div>
          ${this.pagination(c, { page: res.page, pages: res.pages, total: res.total, q })}
        </section>
        ${this.sidebar(c)}
      </div>`;
    return this.doc(c, { title: `搜索${q ? '：' + q : ''} · ${c.site.title}`, content: inner, bodyClass: 'page-search', noIndex: true });
  }

  notFound(c) {
    const inner = `
      <div class="wrap layout">
        <section class="content">
          <div class="error-page">
            <h1>404</h1>
            <p>这里什么都没有，也许是链接过期了。</p>
            <p><a class="btn" href="${escapeAttr(this.url('/'))}">回到首页</a></p>
          </div>
        </section>
        ${this.sidebar(c)}
      </div>`;
    return this.doc(c, { title: `404 · ${c.site.title}`, content: inner, bodyClass: 'page-404', noIndex: true });
  }

  errorPage(c, status, message) {
    const inner = `
      <div class="wrap layout">
        <section class="content">
          <div class="error-page">
            <h1>${status}</h1>
            <p>${escapeHtml(message || '服务器出了点问题')}</p>
            <p><a class="btn" href="${escapeAttr(this.url('/'))}">回到首页</a></p>
          </div>
        </section>
      </div>`;
    return this.doc(c, { title: `${status} · ${c.site.title}`, content: inner, bodyClass: 'page-error', noIndex: true });
  }

  adminShell(c, { title = '', inner = '', extraScripts = '' } = {}) {
    const site = c.site;
    const pageTitle = title || site.title;
    return `<!doctype html>
<html lang="zh-CN" data-mode="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(pageTitle)} · 后台</title>
<link rel="stylesheet" href="${escapeAttr(this.asset('admin.css'))}">
<link rel="stylesheet" href="${escapeAttr(this.themes.cssUrl(this.themes.current(), this.config.server.basePath))}">
<script nonce="${(c && c.nonce) || ''}">window.BLOG = ${JSON.stringify({
      base: this.url(''),
      panels: this.plugins.panels(),
      user: (this.auth && this.auth.session(c.req)) ? this.config.admin.user : null,
    })};</script>
</head>
<body class="admin-body" data-admin="1">
<div id="app">${inner}</div>
<script src="${escapeAttr(this.asset('admin.js'))}" defer></script>
${extraScripts}
</body>
</html>`;
  }

  /* ---------------- 组件 ---------------- */

  sidebar(c) {
    const site = c.site;
    const tags = this.store.tags().slice(0, 18);
    const pluginWidgets = this.plugins.items('sidebar', c);
    const coreWidgets = this.widgets ? this.widgets.renderZone('sidebar', c) : [];
    const widgets = coreWidgets.concat(pluginWidgets)
      .sort((a, b) => Number(a.order || 0) - Number(b.order || 0));
    const aboutShort = String(site.aboutShort || '').trim();
    const about = `
      <section class="widget widget-about">
        <h3 class="widget-title">关于</h3>
        ${site.avatar ? `<img class="avatar" src="${escapeAttr(site.avatar)}" alt="${escapeAttr(site.author || site.title)}">` : ''}
        <p class="about-name">${escapeHtml(site.author || site.title)}</p>
        ${aboutShort ? `<p class="about-desc">${escapeHtml(aboutShort)}</p>` : ''}
        <div class="about-links">
          <a href="${escapeAttr(this.url('/p/about'))}">关于我</a>
          <a href="${escapeAttr(this.url('/feed.xml'))}">RSS</a>
          ${Array.isArray(site.social) ? site.social.map((s) => `<a href="${escapeAttr(s.href)}" target="_blank" rel="noopener">${escapeHtml(s.label)}</a>`).join('') : ''}
        </div>
      </section>`;
    const tagWidget = tags.length ? `
      <section class="widget widget-tags">
        <h3 class="widget-title">标签</h3>
        <div class="tag-cloud">
          ${tags.map((t) => `<a class="tag" href="${escapeAttr(this.url('/tag/' + encodeURIComponent(t.name)))}">${escapeHtml(t.name)}<span>${t.count}</span></a>`).join('')}
        </div>
      </section>` : '';
    return `<aside class="sidebar">
        ${about}
        ${widgets.map((w) => `<section class="widget"${w.id ? ` id="widget-${escapeAttr(w.id)}"` : ''}><h3 class="widget-title">${escapeHtml(w.title || '')}</h3>${w.html || ''}</section>`).join('\n')}
        ${tagWidget}
      </aside>`;
  }

  pagination(c, { page, pages, total, tag = null, q = null }) {
    if (!pages || pages <= 1) return '';
    const link = (p) => {
      if (q !== null) return this.url(`/search?q=${encodeURIComponent(q)}&page=${p}`);
      if (tag) return this.url(`/tag/${encodeURIComponent(tag)}` + (p > 1 ? `/page/${p}` : ''));
      return this.url(p > 1 ? `/page/${p}` : '/');
    };
    const items = [];
    for (let p = 1; p <= pages; p++) {
      if (p === 1 || p === pages || Math.abs(p - page) <= 1) {
        items.push(p === page
          ? `<span class="page-btn current">${p}</span>`
          : `<a class="page-btn" href="${escapeAttr(link(p))}">${p}</a>`);
      } else if (items[items.length - 1] !== '<span class="page-gap">…</span>') {
        items.push('<span class="page-gap">…</span>');
      }
    }
    return `<nav class="pagination" aria-label="分页">
      ${page > 1 ? `<a class="page-btn prev" href="${escapeAttr(link(page - 1))}">← 上一页</a>` : ''}
      ${items.join('')}
      ${page < pages ? `<a class="page-btn next" href="${escapeAttr(link(page + 1))}">下一页 →</a>` : ''}
    </nav>`;
  }

  /* ---------------- 订阅与爬虫 ---------------- */

  feedXml() {
    const site = this.site();
    const items = this.store.list({ page: 1, perPage: 20 }).items;
    const base = (this.config.siteUrl || '') + this.config.server.basePath;
    const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
    return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
<channel>
  <title>${esc(site.title)}</title>
  <link>${esc(base + '/')}</link>
  <description>${esc(site.description || site.subtitle || '')}</description>
  <language>${esc(site.lang || 'zh-CN')}</language>
  <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
  <atom:link href="${esc(base + '/feed.xml')}" rel="self" type="application/rss+xml"/>
  ${items.map((p) => `  <item>
    <title>${esc(p.title)}</title>
    <link>${esc(base + '/post/' + encodeURIComponent(p.slug))}</link>
    <guid isPermaLink="false">${esc(p.slug)}</guid>
    <pubDate>${p.dateObj.toUTCString()}</pubDate>
    ${p.tags.map((t) => `<category>${esc(t)}</category>`).join('')}
    <description>${esc(p.summary || plainText(p.raw, 200))}</description>
  </item>`).join('\n')}
</channel>
</rss>`;
  }

  sitemapXml() {
    const base = (this.config.siteUrl || '') + this.config.server.basePath;
    const urls = [
      { loc: base + '/', pri: '1.0' },
      { loc: base + '/archive', pri: '0.6' },
      ...this.store.posts.filter((p) => !p.draft).map((p) => ({
        loc: base + '/post/' + encodeURIComponent(p.slug),
        lastmod: p.dateObj.toISOString().slice(0, 10),
        pri: '0.8',
      })),
    ];
    return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => `  <url><loc>${u.loc}</loc>${u.lastmod ? `<lastmod>${u.lastmod}</lastmod>` : ''}<priority>${u.pri}</priority></url>`).join('\n')}
</urlset>`;
  }
}

/* ==================== 默认布局（可被主题覆盖） ==================== */

const defaultLayout = {
  shell(o) {
    const { site, title, description, bodyClass, content, headLinks, pluginHead, footerHtml, extraScripts, url, active } = o;
    const nav = site.nav.map((n) => {
      const isActive = active && (n.href === url('/') ? active === 'home' : n.href.includes(active));
      return `<a class="nav-link${isActive ? ' active' : ''}" href="${escapeAttr(n.href)}">${escapeHtml(n.label)}</a>`;
    }).join('');
    return `<!doctype html>
<html lang="${escapeAttr(site.lang || 'zh-CN')}" data-mode="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeAttr(description || '')}">
${o.noIndex ? '<meta name="robots" content="noindex">' : ''}
<link rel="alternate" type="application/rss+xml" title="${escapeAttr(site.title)}" href="${escapeAttr(url('/feed.xml'))}">
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🌙</text></svg>">
${headLinks}
<script nonce="${o.nonce || ''}">
(function(){try{var m=localStorage.getItem('blog-mode');if(m)document.documentElement.dataset.mode=m;}catch(e){}})();
</script>
${pluginHead}
</head>
<body class="${escapeAttr(bodyClass)}">
<a class="skip-link" href="#content">跳到正文</a>
<header class="site-header">
  <div class="wrap header-inner">
    <a class="brand" href="${escapeAttr(url('/'))}">
      <span class="brand-mark">${escapeHtml((site.title || 'B').slice(0, 1))}</span>
      <span class="brand-text">
        <strong>${escapeHtml(site.title)}</strong>
        ${site.subtitle ? `<small>${escapeHtml(site.subtitle)}</small>` : ''}
      </span>
    </a>
    <button class="icon-btn nav-toggle" type="button" aria-label="菜单" data-nav-toggle>☰</button>
    <nav class="site-nav" data-site-nav>${nav}</nav>
    <div class="header-actions">
      <button class="icon-btn" type="button" aria-label="搜索" data-search-toggle>⌕</button>
      <button class="icon-btn" type="button" aria-label="切换明暗" data-theme-toggle>◐</button>
      <a class="icon-btn" href="${escapeAttr(url('/admin'))}" aria-label="后台" title="后台">⚙</a>
    </div>
  </div>
  <div class="search-panel" data-search-panel hidden>
    <div class="wrap">
      <form action="${escapeAttr(url('/search'))}" method="get" class="search-form">
        <input type="search" name="q" placeholder="搜索文章、标签…" autocomplete="off">
        <button type="submit">搜索</button>
      </form>
    </div>
  </div>
</header>
<main id="main">${content}</main>
<footer class="site-footer">
  <div class="wrap footer-inner">
    <div class="footer-main">
      <p>© ${new Date().getFullYear()} ${escapeHtml(site.author || site.title)}</p>
      <p class="footer-note">${escapeHtml(site.footer || '')}</p>
      ${site.icp ? `<p class="footer-note">${escapeHtml(site.icp)}</p>` : ''}
    </div>
    <div class="footer-links">
      <a href="${escapeAttr(url('/feed.xml'))}">RSS</a>
      <a href="${escapeAttr(url('/sitemap.xml'))}">Sitemap</a>
      <a href="${escapeAttr(url('/admin'))}">后台</a>
    </div>
  </div>
  ${footerHtml ? `<div class="wrap footer-plugin">${footerHtml}</div>` : ''}
  <p class="footer-powered">Powered by <a href="https://hermes-agent.nousresearch.com/docs" target="_blank" rel="noopener">Hermes</a> 手搓博客引擎 · 零依赖 Node</p>
</footer>
<script src="${escapeAttr(url('/assets/blog.js'))}" defer></script>
${extraScripts}
</body>
</html>`;
  },

  postCard(r, c, post) {
    const date = formatDate(post.dateObj, r.config.posts.dateFormat);
    const summary = post.summary || plainText(post.raw, r.config.posts.maxSummary);
    const pluginMeta = r.plugins.html('postMeta', { ...c, post });
    return `<article class="post-card${post.pinned ? ' pinned' : ''}">
      <div class="post-card-meta">
        <time datetime="${escapeAttr(post.dateObj.toISOString())}">${escapeHtml(date)}</time>
        ${post.pinned ? '<span class="badge">置顶</span>' : ''}
        ${pluginMeta}
      </div>
      <h2 class="post-card-title"><a href="${escapeAttr(r.url('/post/' + encodeURIComponent(post.slug)))}">${escapeHtml(post.title)}</a></h2>
      ${summary ? `<p class="post-card-summary">${escapeHtml(truncate(summary, 200))}</p>` : ''}
      ${post.tags.length ? `<div class="post-card-tags">${post.tags.map((t) =>
        `<a class="tag" href="${escapeAttr(r.url('/tag/' + encodeURIComponent(t)))}">#${escapeHtml(t)}</a>`).join('')}</div>` : ''}
      <a class="post-card-more" href="${escapeAttr(r.url('/post/' + encodeURIComponent(post.slug)))}" aria-label="阅读全文">阅读 →</a>
    </article>`;
  },
};

module.exports = { Renderer, defaultLayout };
