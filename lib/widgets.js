'use strict';
/**
 * widgets.js — 小工具系统
 *
 * 设计目标：站上任何位置都能挂"小工具"，且**不写代码也能加**（后台选择类型 → 填表 → 挑区域）。
 *
 *  - 区域（zone）：homeTop / sidebar / postTop / postBottom / footer
 *  - 类型（type）：内置 6 种 + 插件通过 widgetTypes 钩子自注册（插件作者可定义新小工具）
 *  - 存储：SQLite 表 widgets（type/zone/config/sort/enabled）
 *  - 渲染：renderer 在对应区域调用 renderZone()，与插件注入的组件按 order 合并排序
 *
 * 安全约定：小工具内容由管理员填写（等同于站点可信内容）；但类型渲染一律返回 HTML 字符串，
 * 插件类型若渲染用户输入必须自行转义（ctx.utils.escapeHtml）。
 */
const { escapeHtml, formatDate, plainText, truncate } = require('./utils');

const ZONES = [
  { id: 'homeTop', title: '首页顶部', desc: '首页 Hero 之下、文章列表之上' },
  { id: 'sidebar', title: '侧栏', desc: '所有页面的右侧栏（与插件组件按顺序混排）' },
  { id: 'postTop', title: '文章上方', desc: '文章正文之前' },
  { id: 'postBottom', title: '文章下方', desc: '文章正文之后（评论之前）' },
  { id: 'footer', title: '页脚', desc: '站脚区域，全站显示' },
];

/* ==================== 内置小工具类型 ==================== */

const CORE_TYPES = [
  {
    type: 'html',
    title: '自定义 HTML / 文本',
    description: '直接粘贴任意 HTML 片段（仅管理员可编辑，视为可信内容）',
    fields: [
      { key: 'content', label: '内容', type: 'textarea', rows: 6, placeholder: '<p>你好</p>' },
    ],
    render(cfg) {
      return { html: String(cfg.content || '') };
    },
  },
  {
    type: 'notice',
    title: '公告（Markdown）',
    description: '用 Markdown 写一段公告，支持加粗/链接/列表',
    fields: [
      { key: 'content', label: '公告内容', type: 'textarea', rows: 5, placeholder: '**注意**：本周服务器维护' },
      { key: 'tone', label: '风格', type: 'select', default: 'info', options: [
        { value: 'info', label: '信息（蓝）' },
        { value: 'warn', label: '提醒（橙）' },
        { value: 'ok', label: '完成（绿）' },
      ] },
    ],
    render(cfg, ctx) {
      const md = require('./markdown');
      const body = md.render(String(cfg.content || ''), { allowRawHtml: false });
      return { html: `<div class="widget-notice ${escapeHtml(cfg.tone || 'info')}">${body}</div>` };
    },
  },
  {
    type: 'stats',
    title: '站点统计',
    description: '文章数、标签数、评论数、浏览量',
    fields: [
      { key: 'style', label: '展示方式', type: 'select', default: 'grid', options: [
        { value: 'grid', label: '方格' },
        { value: 'list', label: '列表' },
      ] },
    ],
    render(cfg, ctx) {
      const store = ctx.store;
      const posts = store.posts.filter((p) => !p.draft).length;
      const tags = store.tags().length;
      const words = store.posts.reduce((n, p) => n + (p.draft ? 0 : p.words), 0);
      let comments = 0, views = 0;
      try { comments = ctx.db.prepare('SELECT COUNT(*) AS c FROM plugin_comments').get().c; } catch (_) {}
      try { views = ctx.db.prepare('SELECT COALESCE(SUM(views),0) AS v FROM plugin_page_views').get().v; } catch (_) {}
      const items = [['文章', posts], ['标签', tags], ['字数', words], ['评论', comments], ['浏览', views]];
      if ((cfg.style || 'grid') === 'list') {
        return { html: `<ul class="widget-list stat-list">${items.map(([k, v]) =>
          `<li><span>${escapeHtml(k)}</span><span class="count">${v}</span></li>`).join('')}</ul>` };
      }
      return { html: `<div class="stat-grid">${items.map(([k, v]) =>
        `<div class="stat-cell"><span class="v">${v}</span><span class="k">${escapeHtml(k)}</span></div>`).join('')}</div>` };
    },
  },
  {
    type: 'recentPosts',
    title: '最新文章',
    description: '按时间列出最近的文章',
    fields: [
      { key: 'count', label: '条数', type: 'number', default: 5 },
      { key: 'showDate', label: '显示日期', type: 'bool', default: false },
    ],
    render(cfg, ctx) {
      const n = Math.max(1, Math.min(20, Number(cfg.count) || 5));
      const items = ctx.store.list({ perPage: n }).items;
      if (!items.length) return { html: '<p class="muted">暂无文章</p>' };
      return {
        html: `<ul class="widget-list">${items.map((p) => `<li>` +
          `<a href="${ctx.url('/post/' + encodeURIComponent(p.slug))}">${escapeHtml(p.title)}</a>` +
          (cfg.showDate ? `<span class="count">${escapeHtml(formatDate(p.dateObj, 'MM-DD'))}</span>` : '') +
          `</li>`).join('')}</ul>`,
      };
    },
  },
  {
    type: 'links',
    title: '友链 / 链接列表',
    description: '每行一条：名称 | https://链接',
    fields: [
      { key: 'content', label: '链接（每行：名称 | URL）', type: 'textarea', rows: 5, placeholder: '示例站点 | https://example.com' },
      { key: 'target', label: '新窗口打开', type: 'bool', default: true },
    ],
    render(cfg, ctx) {
      const lines = String(cfg.content || '').split('\n').map((l) => l.split('|').map((x) => x.trim())).filter((x) => x[0] && x[1]);
      if (!lines.length) return { html: '' };
      const t = cfg.target !== false ? ' target="_blank" rel="noopener noreferrer"' : '';
      const safe = (u) => (/^javascript:/i.test(u) ? '#' : u);
      return {
        html: `<ul class="widget-list">${lines.map(([name, url]) =>
          `<li><a href="${escapeHtml(safe(url))}"${t}>${escapeHtml(name)}</a></li>`).join('')}</ul>`,
      };
    },
  },
  {
    type: 'quote',
    title: '随机一句',
    description: '每次刷新随机展示一行（可用于签名、名言、状态）',
    fields: [
      { key: 'content', label: '候选内容（每行一条）', type: 'textarea', rows: 5, placeholder: '慢慢来，比较快。' },
    ],
    render(cfg, ctx) {
      const lines = String(cfg.content || '').split('\n').map((s) => s.trim()).filter(Boolean);
      if (!lines.length) return { html: '' };
      const pick = lines[Math.floor(Math.random() * lines.length)];
      return { html: `<blockquote class="widget-quote">${escapeHtml(pick)}</blockquote>` };
    },
  },
];

/* ==================== 管理器 ==================== */

class Widgets {
  constructor({ store, config, plugins, renderer }) {
    this.store = store;
    this.config = config;
    this.plugins = plugins;
    this.renderer = renderer;
    this._types = null;
    this._typesGen = -1;
  }

  init() {
    this.store.db.exec(`
      CREATE TABLE IF NOT EXISTS widgets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        zone TEXT NOT NULL DEFAULT 'sidebar',
        config TEXT NOT NULL DEFAULT '{}',
        sort INTEGER NOT NULL DEFAULT 0,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_widgets_zone ON widgets(zone, sort);
    `);
    return this;
  }

  /** 区域定义 */
  zones() {
    return ZONES;
  }

  /** 类型表：内置 + 插件注册（按插件加载代数缓存） */
  types() {
    const gen = typeof this.plugins.version === 'number' ? this.plugins.version : 0;
    if (this._types && this._typesGen === gen) return this._types;
    const map = new Map();
    for (const t of CORE_TYPES) map.set(t.type, { ...t, source: 'core' });
    let pluginTypes = [];
    try {
      pluginTypes = this.plugins.items('widgetTypes', { config: this.config, store: this.store, db: this.store.db })
        .filter((t) => t && t.type && typeof t.render === 'function');
    } catch (e) {
      console.error('[widgets] 插件类型解析失败：', e.message);
    }
    for (const t of pluginTypes) {
      map.set(t.type, {
        type: t.type,
        title: t.title || t.type,
        description: t.description || '',
        fields: t.fields || [],
        render: t.render,
        source: t.source || 'plugin',
      });
    }
    this._types = map;
    this._typesGen = gen;
    return map;
  }

  typeDescriptor(type) {
    const t = this.types().get(type);
    if (!t) return null;
    return { type: t.type, title: t.title, description: t.description, fields: t.fields || [], source: t.source || 'core' };
  }

  /* ---------------- CRUD ---------------- */

  list({ zone, enabledOnly = false } = {}) {
    const rows = zone
      ? this.store.db.prepare('SELECT * FROM widgets WHERE zone = ? ORDER BY sort, id').all(zone)
      : this.store.db.prepare('SELECT * FROM widgets ORDER BY zone, sort, id').all();
    return rows
      .filter((r) => !enabledOnly || r.enabled)
      .map((r) => ({ ...r, enabled: !!r.enabled, config: safeJson(r.config) }));
  }

  get(id) {
    const r = this.store.db.prepare('SELECT * FROM widgets WHERE id = ?').get(Number(id));
    return r ? { ...r, enabled: !!r.enabled, config: safeJson(r.config) } : null;
  }

  create({ type, title, zone, config }) {
    if (!this.types().has(type)) throw bad(`未知的小工具类型：${type}`);
    const z = ZONES.some((x) => x.id === zone) ? zone : 'sidebar';
    const max = this.store.db.prepare('SELECT COALESCE(MAX(sort),0) AS m FROM widgets WHERE zone = ?').get(z).m;
    const now = new Date().toISOString();
    const r = this.store.db.prepare(
      'INSERT INTO widgets (type, title, zone, config, sort, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)'
    ).run(String(type), String(title || ''), z, JSON.stringify(config || {}), Number(max) + 10, now, now);
    return this.get(r.lastInsertRowid);
  }

  update(id, patch = {}) {
    const w = this.get(id);
    if (!w) throw bad('小工具不存在');
    const next = {
      type: patch.type && this.types().has(patch.type) ? patch.type : w.type,
      title: patch.title !== undefined ? String(patch.title) : w.title,
      zone: patch.zone && ZONES.some((x) => x.id === patch.zone) ? patch.zone : w.zone,
      config: patch.config && typeof patch.config === 'object' ? patch.config : w.config,
      enabled: patch.enabled === undefined ? w.enabled : !!patch.enabled,
      sort: patch.sort === undefined ? w.sort : Number(patch.sort) || 0,
    };
    this.store.db.prepare(
      'UPDATE widgets SET type = ?, title = ?, zone = ?, config = ?, enabled = ?, sort = ?, updated_at = ? WHERE id = ?'
    ).run(next.type, next.title, next.zone, JSON.stringify(next.config), next.enabled ? 1 : 0, next.sort, new Date().toISOString(), w.id);
    return this.get(w.id);
  }

  remove(id) {
    const r = this.store.db.prepare('DELETE FROM widgets WHERE id = ?').run(Number(id));
    return !!r.changes;
  }

  toggle(id, enabled) {
    const w = this.get(id);
    if (!w) return null;
    return this.update(id, { enabled: enabled === undefined ? !w.enabled : !!enabled });
  }

  /** 区域内存排序：dir = 'up' | 'down' */
  move(id, dir) {
    const w = this.get(id);
    if (!w) return false;
    const list = this.list({ zone: w.zone });
    const i = list.findIndex((x) => x.id === w.id);
    const j = dir === 'up' ? i - 1 : i + 1;
    if (j < 0 || j >= list.length) return false;
    const a = list[i], b = list[j];
    const now = new Date().toISOString();
    const set = this.store.db.prepare('UPDATE widgets SET sort = ?, updated_at = ? WHERE id = ?');
    set.run(b.sort === a.sort ? b.sort + (dir === 'up' ? -1 : 1) : b.sort, now, a.id);
    set.run(a.sort, now, b.id);
    return true;
  }

  /* ---------------- 渲染 ---------------- */

  /** 补全渲染上下文，保证类型渲染函数拿到 url/db/store/config */
  fillCtx(c) {
    const o = { ...(c || {}) };
    if (typeof o.url !== 'function') {
      const base = this.config.server.basePath || '';
      o.url = (p) => base + (String(p || '/').startsWith('/') ? p : '/' + p);
    }
    if (!o.db) o.db = this.store.db;
    if (!o.store) o.store = this.store;
    if (!o.config) o.config = this.config;
    if (!o.state) o.state = {};
    o.widgets = this;
    return o;
  }

  /** 渲染单个小工具 → { id, title, html, order } */
  renderOne(widget, ctx) {
    const t = this.types().get(widget.type);
    if (!t) return { id: `w${widget.id}`, title: widget.title, html: `<p class="muted">未知小工具类型：${escapeHtml(widget.type)}</p>`, order: widget.sort };
    let out = null;
    try {
      out = t.render(widget.config || {}, this.fillCtx(ctx)) || {};
    } catch (e) {
      console.error(`[widgets] #${widget.id}(${widget.type}) 渲染失败：${e.message}`);
      return { id: `w${widget.id}`, title: widget.title, html: '', order: widget.sort };
    }
    return {
      id: `w${widget.id}`,
      widgetId: widget.id,
      zone: widget.zone,
      type: widget.type,
      title: widget.title || out.title || '',
      html: out.html || '',
      order: widget.sort,
    };
  }

  /** 渲染某区域的全部小工具（已排序、已启用） */
  renderZone(zone, ctx) {
    return this.list({ zone, enabledOnly: true })
      .map((w) => this.renderOne(w, ctx))
      .filter((x) => x.html);
  }

  /** 区域包裹：把工具包成统一外壳（首页/文章上下方、页脚用） */
  renderZoneBlocks(zone, ctx, cls = 'widget-block') {
    const items = this.renderZone(zone, ctx);
    if (!items.length) return '';
    return items.map((w) => `<section class="${cls}"${w.id ? ` id="${escapeHtml(w.id)}"` : ''}>` +
      (w.title ? `<h3 class="widget-block-title">${escapeHtml(w.title)}</h3>` : '') +
      `${w.html}</section>`).join('\n');
  }

  /** 后台预览：给定 type + config 立即渲染 */
  preview(type, config, ctx) {
    const t = this.types().get(type);
    if (!t) return '';
    const out = t.render(config || {}, this.fillCtx(ctx)) || {};
    return out.html || '';
  }

  /** 后台展示用列表（带类型标题） */
  adminList() {
    return this.list().map((w) => ({
      ...w,
      typeTitle: (this.types().get(w.type) || {}).title || w.type,
      source: (this.types().get(w.type) || {}).source || 'core',
    }));
  }
}

function safeJson(s) {
  try { const v = JSON.parse(s); return v && typeof v === 'object' ? v : {}; } catch (_) { return {}; }
}

function bad(msg) {
  const e = new Error(msg);
  e.status = 400;
  return e;
}

module.exports = { Widgets, ZONES, CORE_TYPES };
