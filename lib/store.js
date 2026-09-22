'use strict';
/**
 * store.js — 内容与数据存储
 *   · 文章/页面：content/posts 与 content/pages 下的 markdown（文件即真相，git 友好）
 *   · 运行数据：data/blog.db（node:sqlite，零依赖）——设置、会话、插件状态、插件自建表
 */
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const {
  parseFrontmatter, buildFrontmatter, parseDate, plainText, readingMinutes,
  slugify, uniqSlug, countWords, formatDate,
} = require('./utils');

class Store {
  constructor(root, config) {
    this.root = root;
    this.config = config;
    this.postsDir = path.join(root, 'content', 'posts');
    this.pagesDir = path.join(root, 'content', 'pages');
    this.dataDir = process.env.BLOG_DATA_DIR || path.join(root, 'data');
    this.posts = [];
    this.pages = [];
    this._watchTimer = null;
  }

  /* ---------------- 初始化 ---------------- */

  init() {
    fs.mkdirSync(this.postsDir, { recursive: true });
    fs.mkdirSync(this.pagesDir, { recursive: true });
    fs.mkdirSync(this.dataDir, { recursive: true });
    this.db = new DatabaseSync(path.join(this.dataDir, 'blog.db'));
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.chmodSync(path.join(this.dataDir, 'blog.db' + suffix), 0o600); } catch (_) {}
    }
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        token TEXT PRIMARY KEY, username TEXT, ip TEXT, ua TEXT,
        created_at TEXT NOT NULL, expires_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS plugin_state (
        name TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
    `);
    this.purgeSessions();
    this.reloadContent();
    if (this.config.dev.watchContent) this.watchContent();
    return this;
  }

  /* ---------------- 内容加载 ---------------- */

  reloadContent() {
    this.posts = this._loadDir(this.postsDir, true);
    this.pages = this._loadDir(this.pagesDir, false);
    return this.posts.length;
  }

  _loadDir(dir, isPost) {
    let files = [];
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith('.md') || f.endsWith('.markdown'));
    } catch (_) { return []; }
    const out = [];
    for (const f of files) {
      const full = path.join(dir, f);
      let stat, raw;
      try {
        stat = fs.statSync(full);
        raw = fs.readFileSync(full, 'utf8');
      } catch (_) { continue; }
      const { data, content } = parseFrontmatter(raw);
      const base = f.replace(/\.(md|markdown)$/i, '');
      const slug = String(data.slug || base).trim();
      const d = parseDate(data.date) || stat.mtime;
      const words = countWords(content).total;
      out.push({
        slug,
        title: String(data.title || base),
        date: d.toISOString(),
        dateObj: d,
        updated: stat.mtime.toISOString(),
        tags: normalizeTags(data.tags),
        summary: String(data.summary || '').trim(),
        cover: String(data.cover || data.image || '').trim(),
        author: String(data.author || '').trim(),
        draft: data.draft === true || String(data.draft || '').toLowerCase() === 'true',
        pinned: data.pinned === true || String(data.pinned || '').toLowerCase() === 'true',
        raw: content,
        text: plainText(content, 100000),
        words,
        readingMinutes: readingMinutes(content),
        isPage: !isPost,
        file: full,
      });
    }
    out.sort((a, b) => b.dateObj - a.dateObj);
    return out;
  }

  watchContent() {
    const handler = () => {
      clearTimeout(this._watchTimer);
      this._watchTimer = setTimeout(() => {
        try {
          const n = this.reloadContent();
          console.log(`[store] 内容已重新加载（${n} 篇文章）`);
        } catch (e) { console.error('[store] 重载失败', e.message); }
      }, 250);
    };
    for (const dir of [this.postsDir, this.pagesDir]) {
      try { fs.watch(dir, handler); } catch (_) {}
    }
  }

  /* ---------------- 文章查询 ---------------- */

  list({ tag, q, includeDrafts = false, page = 1, perPage = 10 } = {}) {
    let items = this.posts.slice();
    if (!includeDrafts) items = items.filter((p) => !p.draft);
    if (tag) {
      const t = String(tag).toLowerCase();
      items = items.filter((p) => p.tags.some((x) => x.toLowerCase() === t));
    }
    if (q) {
      const needle = String(q).toLowerCase().trim();
      items = items
        .map((p) => ({ p, score: scorePost(p, needle) }))
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score || b.p.dateObj - a.p.dateObj)
        .map((x) => x.p);
      const total = items.length;
      const start = (page - 1) * perPage;
      return {
        items: items.slice(start, start + perPage),
        total,
        page,
        perPage,
        pages: Math.max(1, Math.ceil(total / perPage)),
        isSearch: true,
      };
    }
    // 置顶优先
    const pinned = items.filter((p) => p.pinned);
    const rest = items.filter((p) => !p.pinned);
    items = pinned.concat(rest);
    const total = items.length;
    const start = (page - 1) * perPage;
    return {
      items: items.slice(start, start + perPage),
      total,
      page,
      perPage,
      pages: Math.max(1, Math.ceil(total / perPage)),
    };
  }

  getPost(slug, { includeDrafts = false } = {}) {
    const p = this.posts.find((x) => x.slug === slug) || this.pages.find((x) => x.slug === slug);
    if (!p) return null;
    if (p.draft && !includeDrafts) return null;
    return p;
  }

  getPage(slug) {
    return this.pages.find((x) => x.slug === slug) || null;
  }

  tags() {
    const map = new Map();
    for (const p of this.posts) {
      if (p.draft) continue;
      for (const t of p.tags) map.set(t, (map.get(t) || 0) + 1);
    }
    return [...map.entries()].map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  }

  archive() {
    const map = new Map();
    for (const p of this.posts) {
      if (p.draft) continue;
      const y = p.dateObj.getFullYear();
      if (!map.has(y)) map.set(y, []);
      map.get(y).push(p);
    }
    return [...map.entries()].sort((a, b) => b[0] - a[0]);
  }

  /* ---------------- 文章写入 ---------------- */

  savePost(input) {
    const existingSlugs = new Set([...this.posts, ...this.pages].map((p) => p.slug));
    let slug = slugify(input.slug || input.title || 'untitled');
    const current = input.originalSlug ? this.getPost(input.originalSlug, { includeDrafts: true }) : null;
    if (current) existingSlugs.delete(current.slug);
    slug = uniqSlug(slug, existingSlugs);

    const date = parseDate(input.date) || new Date();
    const dir = input.isPage ? this.pagesDir : this.postsDir;
    const file = path.join(dir, slug + '.md');
    const data = {
      title: String(input.title || slug).trim(),
      date: formatDate(date, 'YYYY-MM-DD HH:mm'),
      tags: normalizeTags(input.tags),
      summary: String(input.summary || '').trim(),
      cover: String(input.cover || '').trim(),
      draft: !!input.draft,
      pinned: !!input.pinned,
    };
    if (input.author) data.author = String(input.author);
    const body = buildFrontmatter(data, String(input.content || ''));
    fs.writeFileSync(file, body, 'utf8');

    // 改名（slug 变化）时删除旧文件
    if (current && current.file !== file && fs.existsSync(current.file)) {
      try { fs.unlinkSync(current.file); } catch (_) {}
    }
    this.reloadContent();
    return this.getPost(slug, { includeDrafts: true });
  }

  deletePost(slug) {
    const p = this.getPost(slug, { includeDrafts: true });
    if (!p) return false;
    try { fs.unlinkSync(p.file); } catch (_) { return false; }
    this.reloadContent();
    return true;
  }

  /* ---------------- 设置 ---------------- */

  getSetting(key, fallback = null) {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    if (!row) return fallback;
    try { return JSON.parse(row.value); } catch (_) { return fallback; }
  }

  setSetting(key, value) {
    this.db.prepare(
      'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at'
    ).run(String(key), JSON.stringify(value === undefined ? null : value), new Date().toISOString());
    return value;
  }

  deleteSetting(key) {
    this.db.prepare('DELETE FROM settings WHERE key = ?').run(String(key));
  }

  allSettings() {
    const rows = this.db.prepare('SELECT key, value FROM settings').all();
    const out = {};
    for (const r of rows) {
      try { out[r.key] = JSON.parse(r.value); } catch (_) { out[r.key] = null; }
    }
    return out;
  }

  /** 站点展示配置：DB 覆盖 config.json */
  siteSettings() {
    const db = this.allSettings();
    const merged = {};
    for (const [k, v] of Object.entries(db)) {
      const m = k.match(/^site\.(.+)$/);
      if (m) merged[m[1]] = v;
    }
    return { ...this.config.site, ...merged };
  }

  /* ---------------- 插件状态 ---------------- */

  pluginEnabled(name, defaultEnabled) {
    const row = this.db.prepare('SELECT enabled FROM plugin_state WHERE name = ?').get(name);
    if (row) return !!row.enabled;
    return defaultEnabled !== false;
  }

  setPluginEnabled(name, enabled) {
    this.db.prepare(
      'INSERT INTO plugin_state (name, enabled, updated_at) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at'
    ).run(String(name), enabled ? 1 : 0, new Date().toISOString());
  }

  /* ---------------- 会话 ---------------- */

  createSession(token, username, ip, ua, days) {
    const now = new Date();
    const exp = new Date(now.getTime() + days * 86400000);
    this.db.prepare(
      'INSERT INTO sessions (token, username, ip, ua, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(token, username, String(ip || ''), String(ua || '').slice(0, 200), now.toISOString(), exp.toISOString());
    return exp;
  }

  getSession(token) {
    if (!token) return null;
    const row = this.db.prepare('SELECT * FROM sessions WHERE token = ?').get(String(token));
    if (!row) return null;
    if (new Date(row.expires_at).getTime() < Date.now()) {
      this.deleteSession(token);
      return null;
    }
    return row;
  }

  deleteSession(token) {
    this.db.prepare('DELETE FROM sessions WHERE token = ?').run(String(token));
  }

  purgeSessions() {
    try {
      const r = this.db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(new Date().toISOString());
      if (r.changes) console.log(`[store] 清理过期会话 ${r.changes} 条`);
    } catch (_) {}
  }

  /* ---------------- 统计 ---------------- */

  stats() {
    let comments = 0, views = 0;
    try { comments = this.db.prepare('SELECT COUNT(*) AS c FROM plugin_comments').get().c; } catch (_) {}
    try { views = this.db.prepare('SELECT COALESCE(SUM(views),0) AS v FROM plugin_page_views').get().v; } catch (_) {}
    return {
      posts: this.posts.length,
      drafts: this.posts.filter((p) => p.draft).length,
      pages: this.pages.length,
      tags: this.tags().length,
      comments,
      views,
      db: path.join(this.dataDir, 'blog.db'),
    };
  }
}

function normalizeTags(tags) {
  if (!tags) return [];
  const arr = Array.isArray(tags) ? tags : String(tags).split(/[,，;；]/);
  return [...new Set(arr.map((t) => String(t).trim()).filter(Boolean))].slice(0, 12);
}

function scorePost(p, needle) {
  if (!needle) return 0;
  const title = p.title.toLowerCase();
  const tags = p.tags.join(' ').toLowerCase();
  const text = (p.text || '').toLowerCase();
  let s = 0;
  if (title === needle) s += 100;
  if (title.includes(needle)) s += 40;
  if (tags.includes(needle)) s += 20;
  if (text.includes(needle)) s += 8;
  const parts = needle.split(/\s+/).filter(Boolean);
  if (parts.length > 1) {
    for (const part of parts) {
      if (title.includes(part)) s += 12;
      else if (text.includes(part)) s += 3;
    }
  }
  return s;
}

module.exports = { Store };
