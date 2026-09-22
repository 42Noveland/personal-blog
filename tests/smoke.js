'use strict';
/**
 * tests/smoke.js — 端到端烟测
 * 自行拉起服务进程（独立端口 3181 + 独立数据目录），跑完整 HTTP 断言，再清理退出。
 * 用法：node tests/smoke.js [--keep]
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.SMOKE_PORT || 3181);
const BASE = `http://127.0.0.1:${PORT}`;
const PASSWORD = 'SmokeTest2026!';

let pass = 0, fail = 0;
const failures = [];

function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; failures.push(name + (extra ? ` — ${extra}` : '')); console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
}

let cookie = '';
async function req(method, p, { body, headers = {}, raw = false } = {}) {
  const h = { ...headers };
  if (cookie && !h.Cookie) h.Cookie = cookie;
  if (body !== undefined) h['Content-Type'] = 'application/json';
  if (!h.Origin && !h['no-origin']) h.Origin = BASE;
  const res = await fetch(BASE + p, {
    method, headers: h,
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual',
    signal: AbortSignal.timeout(8000), // 防某路由悬挂导致整套烟测卡死
  });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  const text = await res.text();
  if (raw) return { status: res.status, text, headers: res.headers };
  let data = null;
  try { data = JSON.parse(text); } catch (_) {}
  return { status: res.status, text, data, headers: res.headers };
}

async function waitPort(timeoutMs = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(BASE + '/api/site');
      if (r.status < 500) return true;
    } catch (_) {}
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

(async function main() {
  // 独立数据目录（带 pid，避免上次运行的残留），避免污染开发数据
  const dataDir = path.join(ROOT, 'data-smoke-' + process.pid);
  fs.rmSync(dataDir, { recursive: true, force: true });

  // 先写入已知密码（服务进程启动时会读取 config.json），测试结束后还原
  const configFile = path.join(ROOT, 'config.json');
  const originalConfig = fs.existsSync(configFile) ? fs.readFileSync(configFile, 'utf8') : null;
  const configLib = require('../lib/config');
  const { hashPassword } = require('../lib/auth');
  const cfg = configLib.load();
  cfg.admin.passwordHash = hashPassword(PASSWORD);
  configLib.save(cfg);

  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      BLOG_PORT: String(PORT),
      BLOG_HOST: '127.0.0.1',
      BLOG_DATA_DIR: dataDir,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  child.stdout.on('data', (d) => { serverLog += d.toString(); });
  child.stderr.on('data', (d) => { serverLog += d.toString(); });

  const cleanup = () => {
    try { child.kill('SIGKILL'); } catch (_) {}
  };
  process.on('exit', cleanup);

  try {
    if (!(await waitPort())) {
      console.error('服务未能在超时内启动：\n' + serverLog);
      cleanup();
      process.exit(1);
    }

    console.log('\n【页面】');
    let r = await req('GET', '/');
    ok('首页 200', r.status === 200, 'status=' + r.status);
    ok('首页含站点标题', r.text.includes('夜航船'));
    ok('首页含文章卡片', (r.text.match(/post-card-title/g) || []).length >= 5, 'cards=' + (r.text.match(/post-card-title/g) || []).length);
    ok('首页含插件元信息（阅读时长）', r.text.includes('约 '));

    r = await req('GET', '/post/hello-world');
    ok('文章页 200', r.status === 200);
    ok('文章页含标题', r.text.includes('开张'));
    ok('文章页含评论区（插件注入）', r.text.includes('data-comments'), 'len=' + r.text.length);
    ok('文章页含浏览量', r.text.includes('👁'));

    r = await req('GET', '/');
    ok('首页含热门文章组件（读过文章后）', r.text.includes('热门文章'));

    r = await req('GET', '/post/wifi-driver-from-zero');
    ok('长文含目录（TOC 插件）', r.text.includes('id="post-toc"'));
    ok('长文含代码高亮标记', r.text.includes('language-c'));
    ok('文章页引入高亮脚本', r.text.includes('assets/highlight.js'));
    ok('内联脚本均带 CSP nonce', !/<script(?![^>]*\bsrc=)(?![^>]*\bnonce=)/.test(r.text), '存在无 nonce 的内联脚本');

    r = await req('GET', '/tag/Linux');
    ok('标签页 200 且含目标文章', r.status === 200 && r.text.includes('mac80211'));

    r = await req('GET', '/search?q=ROCm');
    ok('搜索命中', r.status === 200 && r.text.includes('9070 XT'));
    r = await req('GET', '/search?q=不存在的关键词xyz');
    ok('搜索空结果正常', r.status === 200 && r.text.includes('0 条结果'));

    r = await req('GET', '/p/about');
    ok('独立页面 200', r.status === 200 && r.text.includes('关于这个站点'));
    r = await req('GET', '/archive');
    ok('归档页 200', r.status === 200 && r.text.includes('archive-year'));
    r = await req('GET', '/page/2');
    ok('分页 200', r.status === 200 || r.status === 404);
    r = await req('GET', '/this-page-does-not-exist');
    ok('404 页面', r.status === 404 && r.text.includes('404'));

    console.log('\n【订阅 / 静态资源】');
    r = await req('GET', '/feed.xml');
    ok('RSS 200 且格式正确', r.status === 200 && r.text.includes('<rss') && r.text.includes('<item>'));
    r = await req('GET', '/sitemap.xml');
    ok('Sitemap 200', r.status === 200 && r.text.includes('<urlset'));
    r = await req('GET', '/robots.txt');
    ok('robots.txt 200', r.status === 200 && r.text.includes('Sitemap'));
    r = await req('GET', '/assets/blog.css');
    ok('CSS 200', r.status === 200 && r.text.includes('--border'));
    r = await req('GET', '/theme-assets/theme.css');
    ok('主题 CSS 200', r.status === 200 && r.text.includes('--accent'));
    r = await req('GET', '/plugin-assets/comments/comments.js');
    ok('插件静态资源 200', r.status === 200 && r.text.includes('data-comments'));
    r = await req('GET', '/plugin-assets/../server.js');
    ok('插件资源越界被拒', r.status === 404 || r.status === 400, 'status=' + r.status);

    console.log('\n【公开 API】');
    r = await req('GET', '/api/posts');
    ok('文章列表 API', r.status === 200 && r.data.ok && r.data.items.length >= 5);
    r = await req('GET', '/api/tags');
    ok('标签 API', r.status === 200 && r.data.tags.length >= 4);
    r = await req('GET', '/api/post/hello-world');
    ok('单篇 API', r.status === 200 && r.data.post.title.includes('开张'));

    console.log('\n【评论插件】');
    r = await req('POST', '/api/comments/hello-world', { body: { author: '测试君', content: '第一条测试评论 https://example.com' } });
    ok('发表评论', r.status === 200 && r.data.ok, JSON.stringify(r.data));
    r = await req('GET', '/api/comments/hello-world');
    ok('评论列表可见', r.data.total === 1 && r.data.comments[0].author === '测试君');
    r = await req('POST', '/api/comments/hello-world', { body: { author: '', content: 'x' } });
    ok('空昵称被拒', r.status === 400);
    r = await req('POST', '/api/comments/hello-world', { body: { author: 'spam', content: 'bot', website: 'http://spam.example' } });
    ok('蜜罐命中静默丢弃', r.status === 200 && r.data.pending === true);
    r = await req('GET', '/api/comments/hello-world');
    ok('蜜罐内容未入库', r.data.total === 1);
    r = await req('POST', '/api/comments/hello-world', { body: { author: 'csrf', content: 'x' }, headers: { Origin: 'http://evil.example' } });
    ok('跨站评论被拒', r.status === 403);

    console.log('\n【后台认证】');
    r = await req('GET', '/api/admin/stats');
    ok('未登录访问后台 API 401', r.status === 401);
    r = await req('POST', '/api/admin/login', { body: { password: 'wrong-password' } });
    ok('错误密码 401', r.status === 401);
    r = await req('POST', '/api/admin/login', { body: { password: PASSWORD } });
    ok('正确密码登录成功', r.status === 200 && r.data.ok && !!cookie);
    r = await req('GET', '/api/admin/stats');
    ok('登录后可见统计', r.status === 200 && r.data.ok && r.data.posts >= 6);
    r = await req('GET', '/api/admin/plugins');
    ok('插件列表', r.status === 200 && r.data.plugins.length >= 5, 'n=' + (r.data.plugins || []).length);
    ok('评论插件已加载', (r.data.plugins || []).some((p) => p.name === 'comments' && p.enabled));
    r = await req('GET', '/api/admin/comments');
    ok('评论审核 API（插件 + admin 路由）', r.status === 200 && r.data.comments.length === 1);
    r = await req('GET', '/api/admin/themes');
    ok('主题列表', r.status === 200 && r.data.themes.length === 2);

    console.log('\n【后台写文章】');
    const slug = 'smoke-test-post';
    r = await req('POST', '/api/admin/post', {
      body: { title: '烟测文章', slug, date: '2026-09-22 12:00', tags: ['测试'], content: '# 标题\n\n正文内容 **加粗**。', draft: false },
    });
    ok('新建文章', r.status === 200 && r.data.ok, JSON.stringify(r.data));
    r = await req('GET', '/post/' + slug);
    ok('新文章可访问', r.status === 200 && r.text.includes('烟测文章'));
    r = await req('GET', '/api/admin/post?slug=' + slug);
    ok('后台读取原文', r.status === 200 && r.data.post.content.includes('正文内容'));
    r = await req('POST', '/api/admin/post', { body: { originalSlug: slug, title: '烟测文章（改）', slug, date: '2026-09-22 12:00', tags: ['测试'], content: '改过的内容' } });
    ok('编辑文章', r.status === 200 && r.data.ok);
    r = await req('GET', '/api/admin/post?slug=' + slug);
    ok('编辑已落盘', r.data.post.content.includes('改过的内容') && r.data.post.title.includes('（改）'));
    r = await req('POST', '/api/admin/post', { body: { title: 'csrf', content: 'x' }, headers: { Origin: 'http://evil.example' } });
    ok('跨站写文章被拒', r.status === 403);
    r = await req('DELETE', '/api/admin/post?slug=' + slug);
    ok('删除文章', r.status === 200 && r.data.ok);
    r = await req('GET', '/post/' + slug);
    ok('删除后 404', r.status === 404);

    console.log('\n【小工具】');
    r = await req('GET', '/api/admin/widgets');
    ok('小工具元数据（5 个区域 / 6+ 类型）', r.status === 200 && r.data.zones.length === 5 && r.data.types.length >= 6, JSON.stringify({ z: (r.data.zones || []).length, t: (r.data.types || []).length }));

    r = await req('POST', '/api/admin/widgets', { body: { action: 'create', widget: { type: 'html', title: '公告板', zone: 'sidebar', config: { content: '<p id="w-test">侧栏小工具内容</p>' } } } });
    ok('创建侧栏小工具', r.status === 200 && r.data.ok && r.data.widget.id > 0);
    const wid = r.data.widget.id;
    r = await req('GET', '/');
    ok('侧栏渲染小工具', r.text.includes('id="w-test"') && r.text.includes('公告板'));
    r = await req('GET', '/post/hello-world');
    ok('小工具全站可见（文章页侧栏）', r.text.includes('id="w-test"'));

    r = await req('POST', '/api/admin/widgets', { body: { action: 'toggle', id: wid, enabled: false } });
    ok('停用小工具', r.status === 200 && r.data.widget.enabled === false);
    r = await req('GET', '/');
    ok('停用后不再渲染', !r.text.includes('id="w-test"'));

    r = await req('POST', '/api/admin/widgets', { body: { action: 'update', id: wid, patch: { enabled: true, title: '改名后的公告板', config: { content: '<p id="w-test2">更新过的内容</p>' } } } });
    ok('更新小工具', r.status === 200 && r.data.widget.title === '改名后的公告板');
    r = await req('GET', '/');
    ok('更新立即生效', r.text.includes('id="w-test2"') && r.text.includes('改名后的公告板'));

    r = await req('POST', '/api/admin/widgets', { body: { action: 'create', widget: { type: 'notice', title: '站点公告', zone: 'homeTop', config: { content: '**维护通知**：周末升级', tone: 'warn' } } } });
    const widHome = r.data.widget.id;
    r = await req('GET', '/');
    ok('首页顶部小工具生效', r.text.includes('widget-notice warn') && r.text.includes('维护通知'));
    r = await req('GET', '/tag/Linux');
    ok('首页顶部区域仅首页/标签页复用规则一致', r.status === 200 && r.text.includes('维护通知'));

    r = await req('POST', '/api/admin/widgets', { body: { action: 'create', widget: { type: 'stats', title: '站点统计', zone: 'sidebar', config: { style: 'grid' } } } });
    ok('统计类小工具创建', r.status === 200 && r.data.ok);
    r = await req('GET', '/');
    ok('统计小工具渲染数字', r.text.includes('stat-grid') && r.text.includes('文章'));

    r = await req('POST', '/api/admin/widgets', { body: { action: 'create', widget: { type: 'recentPosts', title: '最新文章', zone: 'footer', config: { count: 3 } } } });
    const widFooter = r.data.widget.id;
    r = await req('GET', '/');
    ok('页脚小工具生效', r.text.includes('footer-widget') && r.text.includes('最新文章'));

    r = await req('POST', '/api/admin/widgets', { body: { action: 'create', widget: { type: 'not-a-real-type', zone: 'sidebar', config: {} } } });
    ok('未知类型被拒 400', r.status === 400);

    r = await req('POST', '/api/admin/widgets', { body: { action: 'preview', type: 'notice', config: { content: '预览**加粗**', tone: 'ok' } } });
    ok('小工具预览接口', r.status === 200 && r.data.html.includes('<strong>加粗</strong>'));

    r = await req('POST', '/api/admin/widgets', { body: { action: 'move', id: wid, dir: 'down' } });
    const movedDown = r.data.ok === true;
    r = await req('POST', '/api/admin/widgets', { body: { action: 'move', id: wid, dir: 'up' } });
    ok('小工具排序（下移后再上移）', movedDown && r.status === 200 && r.data.ok === true, 'down=' + movedDown);
    r = await req('POST', '/api/admin/widgets', { body: { action: 'move', id: wid, dir: 'up' } });
    ok('已在顶端时上移返回 false', r.data.ok === false);
    r = await req('POST', '/api/admin/widgets', { body: { action: 'delete', id: wid } });
    ok('删除小工具', r.status === 200 && r.data.ok === true);
    r = await req('GET', '/');
    ok('删除后消失', !r.text.includes('id="w-test2"'));
    r = await req('POST', '/api/admin/widgets', { body: { action: 'delete', id: widHome } });
    await req('POST', '/api/admin/widgets', { body: { action: 'delete', id: widFooter } });
    ok('清理测试小工具', r.status === 200);

    console.log('\n【插件热插拔】');
    r = await req('POST', '/api/admin/plugins', { body: { name: 'example', action: 'enable' } });
    ok('启用 example 插件', r.status === 200 && r.data.ok, JSON.stringify(r.data && r.data.result));
    r = await req('POST', '/api/admin/plugins', { body: { name: 'example', action: 'setting', key: 'greeting', value: '由 example 插件注入' } });
    ok('插件设置可写', r.status === 200);
    r = await req('GET', '/api/example/hello');
    ok('插件自有路由生效', r.status === 200 && r.data.ok);
    r = await req('GET', '/');
    ok('插件注入导航项', r.text.includes('>示例<'));
    ok('插件注入页脚', r.text.includes('example 插件注入'));
    r = await req('GET', '/example');
    ok('插件提供整页（复用主题）', r.status === 200 && r.text.includes('example 插件页面') && r.text.includes('site-header'));
    r = await req('GET', '/api/admin/plugins');
    ok('插件设置读取', (r.data.plugins.find((p) => p.name === 'example') || {}).settings.length === 2);
    r = await req('POST', '/api/admin/plugins', { body: { name: 'example', action: 'setting', key: 'greeting', value: '改过的问候' } });
    ok('修改插件设置', r.status === 200 && r.status === 200);
    r = await req('GET', '/');
    ok('插件设置即时生效', r.text.includes('改过的问候'));
    r = await req('POST', '/api/admin/plugins', { body: { name: 'example', action: 'reload' } });
    ok('插件热重载', r.status === 200 && r.data.ok);
    r = await req('GET', '/api/admin/widgets');
    ok('插件注册了 widget 类型', (r.data.types || []).some((t) => t.type === 'example.hello'));
    r = await req('POST', '/api/admin/widgets', { body: { action: 'create', widget: { type: 'example.hello', title: '插件小工具', zone: 'sidebar', config: { text: '来自插件的问候' } } } });
    const widPlugin = r.data.widget.id;
    r = await req('GET', '/');
    ok('插件小工具渲染', r.text.includes('来自插件的问候') && r.text.includes('插件记录到的点击数'));
    r = await req('POST', '/api/admin/widgets', { body: { action: 'delete', id: widPlugin } });
    ok('插件小工具可删除', r.status === 200);
    r = await req('POST', '/api/admin/plugins', { body: { name: 'example', action: 'disable' } });
    ok('停用插件', r.status === 200);
    r = await req('GET', '/api/example/hello');
    ok('停用后路由消失', r.status === 404);

    console.log('\n【安全】');
    r = await req('GET', '/', { raw: true });
    const csp = r.headers.get('content-security-policy') || '';
    ok('CSP 响应头存在且脚本用 nonce', /script-src 'self' 'nonce-[A-Za-z0-9+/=]{16,}/.test(csp), csp.slice(0, 60));
    ok('CSP 禁止对象与 base 变更', csp.includes("object-src 'none'") && csp.includes("base-uri 'self'") && csp.includes("frame-ancestors 'self'"));
    const nonceInHeader = (csp.match(/'nonce-([^']+)'/) || [])[1] || '';
    ok('页内联脚本带同一 nonce', nonceInHeader && r.text.includes(`<script nonce="${nonceInHeader}">`));
    ok('安全响应头齐备', r.headers.get('x-content-type-options') === 'nosniff' && r.headers.get('x-frame-options') === 'SAMEORIGIN' && !!r.headers.get('referrer-policy'));
    ok('未泄漏技术栈版本头', !r.headers.get('x-powered-by'));

    r = await req('GET', '/assets/%2e%2e/server.js', { raw: true });
    ok('静态资源路径穿越被拦（%2e%2e）', r.status === 404 || r.status === 403, 'status=' + r.status);
    r = await req('GET', '/uploads/%2e%2e%2f%2e%2e%2fetc%2fpasswd', { raw: true });
    ok('uploads 路径穿越被拦（403 且不悬挂）', r.status === 403, 'status=' + r.status);
    r = await req('GET', '/plugin-assets/comments/%2e%2e/%2e%2e/config.json', { raw: true });
    ok('插件资源越界被拦', r.status === 404 || r.status === 400 || r.status === 403, 'status=' + r.status);

    r = await req('GET', '/api/admin/stats', { raw: true, headers: { Cookie: 'blog_sid=forged-token-value' } });
    ok('伪造会话令牌无效', r.status === 401);
    const setCookie = (await req('POST', '/api/admin/login', { body: { password: PASSWORD }, raw: true })).headers.get('set-cookie') || '';
    ok('会话 Cookie 具备 HttpOnly / SameSite', /HttpOnly/i.test(setCookie) && /SameSite=Lax/i.test(setCookie), setCookie.slice(0, 80));

    r = await req('POST', '/api/admin/plugins', { body: { name: 'comments', action: 'setting', key: 'moderation', value: 'not-a-bool' } });
    ok('插件设置类型校验（bool 传字符串被拒）', r.status === 400);
    r = await req('POST', '/api/admin/plugins', { body: { name: 'comments', action: 'setting', key: 'noSuchKey', value: true } });
    ok('未声明的插件设置项被拒', r.status === 400);
    r = await req('POST', '/api/admin/plugins', { body: { name: '../../etc/passwd', action: 'setting', key: 'x', value: 1 } });
    ok('非法插件名被拒', r.status === 400);
    r = await req('POST', '/api/admin/plugins', { body: { name: 'comments', action: 'setting', key: 'moderation', value: true } });
    ok('合法设置项可写', r.status === 200);

    r = await req('POST', '/api/admin/password', { body: { current: PASSWORD, next: 'Temp-Password-1' } });
    ok('改密成功并要求重登', r.status === 200 && r.data.relogin === true, JSON.stringify(r.data));
    r = await req('GET', '/api/admin/stats');
    ok('改密后旧会话立即失效', r.status === 401);
    r = await req('POST', '/api/admin/login', { body: { password: PASSWORD } });
    ok('旧密码不可用', r.status === 401);
    r = await req('POST', '/api/admin/login', { body: { password: 'Temp-Password-1' } });
    ok('新密码可登录', r.status === 200 && r.data.ok);
    r = await req('POST', '/api/admin/password', { body: { current: 'Temp-Password-1', next: PASSWORD } });
    ok('密码改回原值', r.status === 200 && r.data.ok);
    r = await req('POST', '/api/admin/login', { body: { password: PASSWORD } });
    ok('恢复后可正常登录（续用会话）', r.status === 200);

    // 评论限流：连续提交直到被拒（插件内 5 条/10 分钟）
    let hit429 = false;
    for (let i = 0; i < 10 && !hit429; i++) {
      r = await req('POST', '/api/comments/hello-world', { body: { author: '限流测试', content: 'spam ' + i } });
      if (r.status === 429) hit429 = true;
    }
    ok('评论频率限制生效（429）', hit429);

    // 登录爆破锁定（放在最后，会锁定本机 IP 一段时间）
    // 注意：达阈值的这一次仍返回 401，锁定从下一次请求开始生效，故多试几次
    let locked = false;
    for (let i = 0; i < 6 && !locked; i++) {
      r = await req('POST', '/api/admin/login', { body: { password: 'wrong-' + i } });
      if (r.status === 429) locked = true;
    }
    ok('登录失败次数超限后锁定（429）', locked);
    r = await req('POST', '/api/admin/login', { body: { password: PASSWORD } });
    ok('锁定期内正确密码同样被拒', r.status === 429, 'status=' + r.status);

    console.log('\n【后台页面】');
    r = await req('GET', '/admin');
    ok('后台页 200', r.status === 200 && r.text.includes('window.BLOG'));
    r = await req('GET', '/admin/anything');
    ok('后台子路径 200', r.status === 200);

    console.log('\n【预览 API】');
    r = await req('POST', '/api/preview', { body: { markdown: '普通段落里的 <script>alert(1)</script> 应当被转义' } });
    ok('预览：行内 HTML 被转义', r.status === 200 && r.data.html.includes('&lt;script&gt;'), r.data && r.data.html);
    r = await req('POST', '/api/preview', { body: { markdown: '# 标题\n\n**加粗**' } });
    ok('预览：Markdown 正常渲染', r.status === 200 && r.data.html.includes('<strong>'), r.data && r.data.html);

    console.log('\n【主题切换】');
    r = await req('POST', '/api/admin/themes', { body: { name: 'paper' } });
    ok('切换到 paper', r.status === 200 && r.data.ok);
    r = await req('GET', '/theme-assets/theme.css');
    ok('主题 CSS 已切换', r.text.includes('宣纸') || r.text.includes('--bg: #fdfaf4'));
    r = await req('POST', '/api/admin/themes', { body: { name: 'midnight' } });
    ok('切回 midnight', r.data.ok);
  } catch (e) {
    fail++;
    failures.push('异常：' + e.message);
    console.error('\n[异常]', e.stack);
  } finally {
    cleanup();
  }

  console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
  if (failures.length) {
    console.log('失败项：');
    failures.forEach((f) => console.log('  - ' + f));
  }
  if (fail) console.log('\n服务端日志尾部：\n' + serverLog.split('\n').slice(-40).join('\n'));
  if (originalConfig !== null) fs.writeFileSync(configFile, originalConfig, 'utf8');
  await new Promise((r) => setTimeout(r, 400));
  try { fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch (_) {}
  process.exit(fail ? 1 : 0);
})();
