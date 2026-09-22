'use strict';
/**
 * router.js — 极简路由器：支持 :param 与 *，按注册顺序匹配。
 * 每个路由可声明 owner（插件名），便于插件热卸载时精确移除。
 */
class Router {
  constructor() {
    this.routes = [];
  }

  add(method, pattern, handler, opts = {}) {
    const keys = [];
    const src = pattern
      .split('/')
      .map((seg) => {
        if (seg.startsWith(':')) { keys.push(seg.slice(1)); return '([^/]+)'; }
        if (seg === '*') { keys.push('wildcard'); return '(.*)'; }
        return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      })
      .join('/');
    this.routes.push({
      method: method.toUpperCase(),
      pattern,
      regex: new RegExp(`^${src}/?$`),
      keys,
      handler,
      opts,
      owner: opts.owner || 'core',
    });
    return this;
  }

  get(p, h, o) { return this.add('GET', p, h, o); }
  post(p, h, o) { return this.add('POST', p, h, o); }
  put(p, h, o) { return this.add('PUT', p, h, o); }
  patch(p, h, o) { return this.add('PATCH', p, h, o); }
  delete(p, h, o) { return this.add('DELETE', p, h, o); }

  /** 返回 { route, params } / { methodNotAllowed: true } / null */
  match(method, pathname) {
    let pathExists = false;
    for (const route of this.routes) {
      const m = route.regex.exec(pathname);
      if (!m) continue;
      pathExists = true;
      if (route.method !== method.toUpperCase()) continue;
      const params = {};
      route.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1] || ''); });
      return { route, params };
    }
    return pathExists ? { methodNotAllowed: true } : null;
  }

  removeByOwner(owner) {
    const before = this.routes.length;
    this.routes = this.routes.filter((r) => r.owner !== owner);
    return before - this.routes.length;
  }

  list() {
    return this.routes.map((r) => ({ method: r.method, pattern: r.pattern, owner: r.owner }));
  }
}

module.exports = { Router };
