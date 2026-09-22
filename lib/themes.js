'use strict';
/**
 * themes.js — 主题系统
 *   themes/<name>/theme.json  清单（title/description/author/version/color）
 *   themes/<name>/theme.css   CSS 变量 + 主题专属样式（公共布局样式在 public/assets/blog.css）
 *   themes/<name>/layout.js   可选，覆盖渲染片段（shell / postCard / sidebar / header / footer）
 *
 * 变量约定（theme.css 必须定义）：
 *   --bg --bg-soft --card --text --text-dim --text-mute --accent --accent-soft
 *   --border --code-bg --radius --shadow --font-sans --font-mono --font-serif
 *   浅色模式通过 :root[data-mode="light"] 覆盖同一组变量。
 */
const fs = require('fs');
const path = require('path');

class Themes {
  constructor({ root, store, config, log }) {
    this.dir = path.join(root, 'themes');
    this.store = store;
    this.config = config;
    this.log = log || console;
    this.cache = new Map(); // name -> { manifest, layout, mtime }
  }

  scan() {
    let names = [];
    try {
      names = fs.readdirSync(this.dir, { withFileTypes: true })
        .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
        .map((d) => d.name);
    } catch (_) { return []; }
    const out = [];
    for (const name of names) {
      const manifestFile = path.join(this.dir, name, 'theme.json');
      let manifest = { name, title: name };
      try {
        if (fs.existsSync(manifestFile)) manifest = { ...manifest, ...JSON.parse(fs.readFileSync(manifestFile, 'utf8')) };
      } catch (e) {
        manifest.error = `theme.json 解析失败：${e.message}`;
      }
      const css = path.join(this.dir, name, 'theme.css');
      manifest.hasCss = fs.existsSync(css);
      manifest.hasLayout = fs.existsSync(path.join(this.dir, name, 'layout.js'));
      manifest.name = name;
      out.push(manifest);
    }
    return out.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  }

  current() {
    const name = this.store.getSetting('theme', this.config.theme);
    const exists = this.scan().some((t) => t.name === name);
    return exists ? name : this.config.theme;
  }

  use(name) {
    if (!this.scan().some((t) => t.name === name)) return false;
    this.store.setSetting('theme', name);
    return true;
  }

  get(name) {
    const theme = name || this.current();
    const dir = path.join(this.dir, theme);
    let layout = {};
    const layoutFile = path.join(dir, 'layout.js');
    if (fs.existsSync(layoutFile)) {
      try {
        purgeRequireCache(dir);
        layout = require(layoutFile) || {};
      } catch (e) {
        this.log.error(`[theme:${theme}] layout.js 加载失败：${e.message}`);
      }
    }
    return { name: theme, dir, layout };
  }

  /** 主题 CSS 的对外 URL（带版本参数防缓存） */
  cssUrl(theme, basePath) {
    const p = path.join(this.dir, theme, 'theme.css');
    let v = '0';
    try { v = String(Math.floor(fs.statSync(p).mtimeMs)); } catch (_) {}
    return `${basePath || ''}/theme-assets/theme.css?v=${v}`;
  }
}

function purgeRequireCache(dir) {
  const base = path.resolve(dir);
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(base + path.sep)) delete require.cache[key];
  }
}

module.exports = { Themes };
