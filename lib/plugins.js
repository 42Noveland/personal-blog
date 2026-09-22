'use strict';
/**
 * plugins.js — 插件系统（本项目的扩展主入口）
 *
 * 约定：
 *   plugins/<name>/plugin.json   清单：name/title/version/description/hooks/settings/enabledByDefault
 *   plugins/<name>/index.js      入口：导出若干钩子函数（或工厂函数返回钩子对象）
 *   plugins/<name>/public/*      静态资源，挂载到 <basePath>/plugin-assets/<name>/*
 *
 * 钩子（全部可选）：
 *   setup(ctx)                    加载后初始化
 *   teardown()                    卸载前清理
 *   routes(router, ctx)           注册自有路由（可声明 {auth:'admin'} 要求管理员）
 *   head(ctx)                     → html  注入 </head> 前
 *   navItems(ctx)                 → [{label, href, order}]  顶部导航追加项
 *   postMeta(ctx)                 → html  文章卡/文章页的日期行之后
 *   postHeader(ctx)               → html  文章正文之前
 *   postFooter(ctx)               → html  文章正文之后
 *   sidebar(ctx)                  → [{title, html, order}]  侧栏小组件
 *   footer(ctx)                   → html  页脚
 *   contentFilter(ctx)            → {markdown?, html?}  正文渲染前处理
 *   adminPanels(ctx)              → [{id, title, html, script}]  后台自定义面板
 *
 * 每次请求的临时状态必须放在 ctx.state 上（钩子上下文按请求创建），
 * 不要挂在插件对象上，否则并发请求会串数据。
 */
const fs = require('fs');
const path = require('path');

const HOOKS = [
  'setup', 'teardown', 'routes', 'head', 'navItems', 'postMeta', 'postHeader',
  'postFooter', 'sidebar', 'footer', 'contentFilter', 'adminPanels', 'postListFilter',
  'widgetTypes',
];

class PluginManager {
  constructor({ root, store, config, router, log }) {
    this.dir = path.join(root, 'plugins');
    this.store = store;
    this.config = config;
    this.router = router;
    this.log = log || console;
    this.plugins = new Map(); // name -> { name, dir, manifest, hooks, enabled, error }
    this.manifestCache = new Map();
    this.version = 0; // 插件加载代数：用于让 widget 类型表等缓存感知热重载
  }

  /* ---------------- 发现 ---------------- */

  scan() {
    let names = [];
    try {
      names = fs.readdirSync(this.dir, { withFileTypes: true })
        .filter((d) => d.isDirectory() && !d.name.startsWith('.') && !d.name.startsWith('_'))
        .map((d) => d.name);
    } catch (_) { return []; }
    const out = [];
    for (const name of names) {
      const dir = path.join(this.dir, name);
      const manifestFile = path.join(dir, 'plugin.json');
      if (!fs.existsSync(manifestFile)) continue;
      try {
        const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
        manifest.name = manifest.name || name;
        out.push({ name: manifest.name, dir, manifest });
      } catch (e) {
        out.push({ name, dir, manifest: null, error: `plugin.json 解析失败：${e.message}` });
      }
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  isEnabled(name, manifest) {
    const def = manifest ? manifest.enabledByDefault !== false : true;
    return this.store.pluginEnabled(name, def);
  }

  loadAll() {
    const results = [];
    for (const item of this.scan()) {
      const enabled = this.isEnabled(item.name, item.manifest);
      if (!enabled) {
        this.plugins.set(item.name, { ...item, enabled: false, hooks: {} });
        results.push({ name: item.name, status: 'disabled' });
        continue;
      }
      const r = this.load(item.name);
      results.push({ name: item.name, ...r });
    }
    // 清掉已被删除的插件记录
    const alive = new Set(this.scan().map((x) => x.name));
    for (const name of [...this.plugins.keys()]) if (!alive.has(name)) this.plugins.delete(name);
    return results;
  }

  /** 加载（或重载）单个插件 */
  load(name) {
    const item = this.scan().find((x) => x.name === name);
    if (!item) return { status: 'error', error: '插件不存在' };
    if (!item.manifest) return { status: 'error', error: item.error };

    const entry = path.join(item.dir, item.manifest.main || 'index.js');
    if (!fs.existsSync(entry)) return { status: 'error', error: '缺少 index.js' };

    this.emitLogged('teardown', name);
    this.router.removeByOwner(name);
    purgeRequireCache(item.dir);

    let mod;
    try {
      mod = require(entry);
    } catch (e) {
      this.log.error(`[plugin:${name}] 加载失败：${e.stack || e.message}`);
      this.plugins.set(name, { ...item, enabled: true, hooks: {}, error: e.message });
      return { status: 'error', error: e.message };
    }

    const hooks = typeof mod === 'function' ? mod(this.makeCtx(name, item)) : mod;
    if (!hooks || typeof hooks !== 'object') {
      return { status: 'error', error: 'index.js 必须导出钩子对象或工厂函数' };
    }

    // 给钩子对象挂一个 live 设置访问器：钩子内可用 this.settings.get('key', 默认值)
    const store = this.store;
    const manifest = item.manifest;
    Object.defineProperty(hooks, 'settings', {
      enumerable: false,
      configurable: true,
      get: () => this.settingsApi(name, manifest),
    });

    const instance = { ...item, enabled: true, hooks, ctx: this.makeCtx(name, item), error: null };
    this.plugins.set(name, instance);

    // 校验声明的钩子名
    const unknown = Object.keys(hooks).filter((k) => !HOOKS.includes(k));
    if (unknown.length) this.log.warn(`[plugin:${name}] 未知钩子（已忽略）：${unknown.join(', ')}`);

    try { if (typeof hooks.routes === 'function') hooks.routes(this.scopedRouter(name), instance.ctx); } catch (e) {
      this.log.error(`[plugin:${name}] 路由注册失败：${e.message}`);
    }
    try { if (typeof hooks.setup === 'function') hooks.setup(instance.ctx); } catch (e) {
      this.log.error(`[plugin:${name}] setup 失败：${e.message}`);
      instance.error = 'setup 失败：' + e.message;
    }
    const registered = Object.keys(hooks).filter((k) => HOOKS.includes(k) && typeof hooks[k] === 'function');
    this.version++;
    this.log.info(`[plugin:${name}] 已加载 v${item.manifest.version || '?'} 钩子：${registered.filter((h) => !['teardown', 'setup'].includes(h)).join(', ') || '无'}`);
    return { status: 'loaded', hooks: registered };
  }

  unload(name) {
    const p = this.plugins.get(name);
    if (!p) return;
    this.emitLogged('teardown', name);
    this.router.removeByOwner(name);
    purgeRequireCache(p.dir);
    p.enabled = false;
    p.hooks = {};
    this.version++;
  }

  reload(name) {
    return this.load(name);
  }

  setEnabled(name, enabled) {
    this.store.setPluginEnabled(name, enabled);
    if (enabled) return this.load(name);
    this.unload(name);
    const p = this.plugins.get(name);
    if (p) p.enabled = false;
    return { status: 'disabled' };
  }

  /** 让插件在注册路由时自动带上 owner 与鉴权标记 */
  scopedRouter(name) {
    const make = (method, pattern, handler, opts = {}) => {
      if (typeof handler !== 'function') return this.router;
      this.router.add(method, pattern, handler, { ...opts, owner: name });
      return this.router;
    };
    return {
      get: (p, h, o) => make('GET', p, h, o),
      post: (p, h, o) => make('POST', p, h, o),
      put: (p, h, o) => make('PUT', p, h, o),
      patch: (p, h, o) => make('PATCH', p, h, o),
      delete: (p, h, o) => make('DELETE', p, h, o),
      add: (m, p, h, o) => make(m, p, h, o),
      list: () => this.router.list().filter((r) => r.owner === name),
    };
  }

  makeCtx(name, item) {
    const store = this.store;
    const config = this.config;
    const manager = this;
    return {
      name,
      dir: item.dir,
      manifest: item.manifest || {},
      version: '1.0.0',
      config,
      db: store.db,
      store,
      url: (p) => this.baseUrl(p),
      http: this.http || null,
      log: {
        info: (...a) => console.log(`[plugin:${name}]`, ...a),
        warn: (...a) => console.warn(`[plugin:${name}]`, ...a),
        error: (...a) => console.error(`[plugin:${name}]`, ...a),
      },
      utils: require('./utils'),
      markdown: require('./markdown'),
      settings: this.settingsApi(name, item.manifest),
      theme: { get current() { return manager.themes ? manager.themes.current() : config.theme; } },
      /** 用当前主题渲染一个完整页面：ctx.page(req, {title, content}) → html */
      page: (req, opts = {}) => {
        if (!manager.renderer) return `<!doctype html><html><body>${opts.content || ''}</body></html>`;
        const c = manager.renderer.ctx(req);
        return manager.renderer.doc(c, {
          title: opts.title || config.site.title,
          description: opts.description || '',
          content: `<div class="wrap layout"><section class="content">${opts.content || ''}</section>${manager.renderer.sidebar(c)}</div>`,
          bodyClass: opts.bodyClass || 'page-plugin',
        });
      },
      manager,
    };
  }

  /* ---------------- 钩子调用 ---------------- */

  list(filterEnabled = true) {
    const out = [];
    for (const [name, p] of this.plugins) {
      if (filterEnabled && !p.enabled) continue;
      out.push(p);
    }
    return out.sort((a, b) => {
      const pa = Number(a.manifest.priority || 0), pb = Number(b.manifest.priority || 0);
      return pa - pb || a.name.localeCompare(b.name);
    });
  }

  /** 为指定插件构造设置访问器 */
  settingsApi(name, manifest) {
    const store = this.store;
    return {
      get: (key, def) => store.getSetting(`plugin.${name}.${key}`, def !== undefined ? def : schemaDefault(manifest, key)),
      set: (key, val) => store.setSetting(`plugin.${name}.${key}`, val),
      all: () => schemaAll(manifest, store, name),
    };
  }

  /** basePath 前缀拼接（无请求上下文的钩子也能生成链接） */
  baseUrl(p) {
    const b = this.config.server.basePath || '';
    if (!p) return b || '/';
    return b + (String(p).startsWith('/') ? p : '/' + p);
  }

  /** 补全钩子上下文：无论调用方给了什么，钩子都能拿到 db / settings / config / store / url */
  hookCtx(ctx, pluginInstance) {
    const c = { ...(ctx || {}) };
    if (typeof c.url !== 'function') c.url = (p) => this.baseUrl(p);
    if (!c.db) c.db = this.store.db;
    if (!c.store) c.store = this.store;
    if (!c.config) c.config = this.config;
    if (!c.plugins) c.plugins = this;
    if (!c.state) c.state = {};
    if (!c.settings) c.settings = this.settingsApi(pluginInstance.name, pluginInstance.manifest);
    return c;
  }

  /** 执行钩子，返回每个插件的返回值数组（数组返回值会被拍平） */
  emit(hook, ctx) {
    const out = [];
    for (const p of this.list()) {
      const fn = p.hooks && p.hooks[hook];
      if (typeof fn !== 'function') continue;
      try {
        const r = fn.call(p.hooks, this.hookCtx(ctx, p));
        if (r === undefined || r === null || r === false || r === '') continue;
        if (Array.isArray(r)) out.push(...r.filter((x) => x));
        else out.push(r);
      } catch (e) {
        this.log.error(`[plugin:${p.name}] 钩子 ${hook} 抛错：${e.stack || e.message}`);
      }
    }
    return out;
  }

  /** 钩子返回 html 片段，按 order 排序后拼接 */
  html(hook, ctx) {
    return this.emit(hook, ctx)
      .filter((x) => typeof x === 'string')
      .join('\n');
  }

  /** 钩子返回对象数组（navItems/sidebar/adminPanels） */
  items(hook, ctx) {
    return this.emit(hook, ctx)
      .filter((x) => x && typeof x === 'object' && !Array.isArray(x))
      .sort((a, b) => Number(a.order || 0) - Number(b.order || 0));
  }

  emitLogged(hook, name) {
    const p = this.plugins.get(name);
    if (!p || !p.hooks || typeof p.hooks[hook] !== 'function') return;
    try { p.hooks[hook](); } catch (e) {
      this.log.warn(`[plugin:${name}] ${hook} 失败：${e.message}`);
    }
  }

  /** 解析插件静态资源路径；返回绝对路径或 null（含越界防护） */
  assetPath(name, rel) {
    const p = this.plugins.get(name);
    const dir = p ? p.dir : path.join(this.dir, name);
    const base = path.join(dir, 'public');
    const full = path.resolve(base, rel);
    if (!full.startsWith(path.resolve(base))) return null;
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) return null;
    return full;
  }

  /** 后台面板：插件提供的自定义页签 */
  panels() {
    return this.items('adminPanels', {}).map((p) => ({
      id: p.id,
      title: p.title || p.id,
      plugin: p.plugin || null,
      html: p.html || '',
      script: p.script || '',
    }));
  }

  /** 后台展示用状态 */
  status() {
    const found = this.scan();
    return found.map((item) => {
      const live = this.plugins.get(item.name);
      const enabled = this.isEnabled(item.name, item.manifest);
      const values = schemaAll(item.manifest, this.store, item.name);
      return {
        name: item.name,
        title: (item.manifest && item.manifest.title) || item.name,
        version: (item.manifest && item.manifest.version) || '',
        description: (item.manifest && item.manifest.description) || '',
        author: (item.manifest && item.manifest.author) || '',
        hooks: (item.manifest && item.manifest.hooks) || [],
        settings: ((item.manifest && item.manifest.settings) || []).map((s) => ({ ...s, value: values[s.key] })),
        enabled,
        loaded: !!(live && live.enabled),
        error: (live && live.error) || item.error || null,
        routes: this.router.list().filter((r) => r.owner === item.name).length,
      };
    });
  }

  /** 校验插件设置写入：名/键格式 + 必须声明过 + 类型与取值范围 */
  validateSetting(name, key, value) {
    if (!/^[a-zA-Z0-9_-]{1,40}$/.test(String(name || ''))) return '插件名不合法';
    if (!/^[a-zA-Z0-9_]{1,48}$/.test(String(key || ''))) return '设置键不合法';
    const item = this.scan().find((x) => x.name === name);
    if (!item || !item.manifest) return '插件不存在';
    const field = ((item.manifest.settings) || []).find((s) => s.key === key);
    if (!field) return `该插件未声明名为 ${key} 的设置项`;
    const t = field.type || 'text';
    if (t === 'bool' && typeof value !== 'boolean') return '布尔类型不符';
    if (t === 'number' && !Number.isFinite(Number(value))) return '数值类型不符';
    if (t === 'select') {
      const opts = (field.options || []).map((o) => (typeof o === 'string' ? o : o.value));
      if (!opts.includes(String(value))) return '取值不在允许范围内';
    }
    if (typeof value === 'string' && value.length > 20000) return '内容过长';
    if (value !== null && typeof value === 'object') return '设置值必须是标量';
    return null;
  }

  pluginSettings(name) {
    const item = this.scan().find((x) => x.name === name);
    return schemaAll(item ? item.manifest : null, this.store, name);
  }
}

function schemaDefault(manifest, key) {
  const s = ((manifest && manifest.settings) || []).find((x) => x.key === key);
  return s ? s.default : undefined;
}

function schemaAll(manifest, store, name) {
  const out = {};
  for (const s of (manifest && manifest.settings) || []) {
    out[s.key] = store.getSetting(`plugin.${name}.${s.key}`, s.default);
  }
  return out;
}

/** 递归清理 require 缓存，让插件热重载拿到新代码 */
function purgeRequireCache(dir) {
  const base = path.resolve(dir);
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(base + path.sep)) delete require.cache[key];
  }
}

module.exports = { PluginManager, HOOKS };
