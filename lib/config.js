'use strict';
/**
 * config.js — 站点配置：config.json 提供默认与基础设施配置，
 *             可在线修改的展示类配置存在 SQLite（优先级高于 config.json 的 site 段）。
 */
const fs = require('fs');
const path = require('path');
const { deepMerge, randomToken } = require('./utils');

const ROOT = path.resolve(__dirname, '..');
const CONFIG_FILE = path.join(ROOT, 'config.json');
const DATA_DIR = path.join(ROOT, 'data');

function defaults() {
  return {
    site: {
      title: '夜航船',
      subtitle: '技术笔记与胡思乱想',
      description: '一个安静的角落，用来记录折腾过的东西。',
      aboutShort: '写内核、网络与本地大模型；偶尔折腾服务器和显卡驱动。',
      // 页脚来源标注：支持 HTML，留空则不显示（后台「站点设置」可改）
      poweredBy: 'Powered by <a href="https://hermes-agent.nousresearch.com/docs" target="_blank" rel="noopener">Hermes</a> 手搓博客引擎 · 零依赖 Node',
      author: 'Noveland',
      avatar: '',
      footer: '',
      icp: '',
      lang: 'zh-CN',
      nav: [
        { label: '首页', href: '/' },
        { label: '归档', href: '/archive' },
        { label: '关于', href: '/page/about' },
      ],
      social: [],
    },
    server: {
      host: '127.0.0.1',
      port: 3081,
      basePath: '',
      trustProxy: true,
      secureCookies: false,
    },
    posts: {
      perPage: 8,
      dateFormat: 'YYYY-MM-DD',
      maxSummary: 150,
    },
    markdown: {
      allowRawHtml: true,
      breaks: false,
      highlight: true,
    },
    theme: 'midnight',
    admin: {
      user: 'admin',
      passwordHash: '',
      sessionDays: 7,
      loginMaxFails: 5,
      loginLockMinutes: 10,
    },
    plugins: {
      disabled: [],
    },
    dev: {
      watchContent: true,
      watchPlugins: true,
    },
  };
}

function load() {
  let fileCfg = {};
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      fileCfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    } catch (e) {
      console.error(`[config] config.json 解析失败：${e.message}（使用默认配置）`);
    }
  }
  const cfg = deepMerge(defaults(), fileCfg);
  // 环境变量覆盖（部署友好）
  if (process.env.BLOG_HOST) cfg.server.host = process.env.BLOG_HOST;
  if (process.env.BLOG_PORT) cfg.server.port = Number(process.env.BLOG_PORT);
  if (process.env.BLOG_BASE_PATH !== undefined) cfg.server.basePath = process.env.BLOG_BASE_PATH;
  cfg.server.basePath = normalizeBasePath(cfg.server.basePath);
  return cfg;
}

function normalizeBasePath(p) {
  let s = String(p == null ? '' : p).trim();
  if (!s || s === '/') return '';
  if (!s.startsWith('/')) s = '/' + s;
  return s.replace(/\/+$/, '');
}

function save(cfg) {
  const clean = JSON.parse(JSON.stringify(cfg));
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(clean, null, 2) + '\n', 'utf8');
  try { fs.chmodSync(CONFIG_FILE, 0o600); } catch (_) {} // 含口令散列，仅属主可读写
}

function ensureDirs() {
  for (const d of [
    DATA_DIR,
    path.join(ROOT, 'content', 'posts'),
    path.join(ROOT, 'content', 'pages'),
    path.join(ROOT, 'plugins'),
    path.join(ROOT, 'themes'),
  ]) {
    fs.mkdirSync(d, { recursive: true });
  }
  // data/ 内含会话令牌与全部运行数据：仅属主可访问
  try { fs.chmodSync(DATA_DIR, 0o700); } catch (_) {}
}

/** 首次运行生成随机管理员密码，返回明文供提示（仅此一次） */
function bootstrapAdmin(cfg) {
  if (cfg.admin.passwordHash) return null;
  const { hashPassword } = require('./auth');
  const pw = 'blog-' + randomToken(9).replace(/[^A-Za-z0-9]/g, '').slice(0, 10);
  cfg.admin.passwordHash = hashPassword(pw);
  save(cfg);
  return pw;
}

module.exports = { load, save, defaults, ensureDirs, bootstrapAdmin, ROOT, DATA_DIR, CONFIG_FILE, normalizeBasePath };
