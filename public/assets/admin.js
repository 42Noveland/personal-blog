/* admin.js — 后台单页应用（零依赖，原生 DOM） */
(function () {
  'use strict';

  var BOOT = window.BLOG || {};
  var U = function (p) { return (BOOT.base || '') + p; };
  var state = {
    view: 'dashboard',
    user: BOOT.user || null,
    posts: [], pages: [], stats: null, plugins: [], themes: [], settings: {},
    editing: null, editorDirty: false, panelsMounted: {},
  };
  var app = document.getElementById('app');

  /* ---------------- 工具 ---------------- */
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function h(html) { var t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; }

  async function api(path, opts) {
    opts = opts || {};
    var res = await fetch(U(path), {
      method: opts.method || 'GET',
      credentials: 'same-origin',
      headers: opts.body ? { 'Content-Type': 'application/json' } : {},
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    var data = null;
    try { data = await res.json(); } catch (e) { data = { ok: false, error: '响应解析失败 (' + res.status + ')' }; }
    if (!res.ok && data && data.error === '未登录或会话已过期') {
      state.user = null;
      render();
      throw new Error('登录已过期');
    }
    if (!res.ok && !data.error) data.error = 'HTTP ' + res.status;
    data.__status = res.status;
    return data;
  }

  function toast(msg, kind) {
    var el = h('<div class="toast ' + (kind || '') + '">' + esc(msg) + '</div>');
    document.body.appendChild(el);
    setTimeout(function () { el.remove(); }, 3200);
  }

  function confirmBox(msg) { return window.confirm(msg); }
  function fmtDate(s) {
    if (!s) return '';
    var d = new Date(s);
    if (isNaN(d)) return s;
    var p = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  /* ---------------- 视图 ---------------- */
  function render() {
    if (!state.user) return renderLogin();
    app.innerHTML = '';
    var shell = h(
      '<div class="admin-shell">' +
        '<aside class="admin-side">' +
          '<div class="admin-brand"><span class="dot"></span> 博客后台 <small>' + esc(BOOT.base || '/') + '</small></div>' +
          '<nav class="admin-nav" id="nav"></nav>' +
          '<div class="spacer"></div>' +
          '<div class="side-foot">' +
            '<a class="btn sm" href="' + esc(U('/')) + '" target="_blank" rel="noopener">查看站点</a>' +
            '<button class="btn sm" data-act="logout">退出</button>' +
          '</div>' +
        '</aside>' +
        '<main class="admin-main" id="main"></main>' +
      '</div>');
    app.appendChild(shell);
    renderNav();
    renderView();
  }

  var NAV = [
    { id: 'dashboard', label: '📊 概览' },
    { id: 'posts', label: '📝 文章' },
    { id: 'editor', label: '✍️ 写文章' },
    { id: 'pages', label: '📄 独立页面' },
    { id: 'widgets', label: '🧰 小工具' },
    { id: 'panel-group', label: '插件面板' },
    { id: 'plugins', label: '🧩 插件' },
    { id: 'themes', label: '🎨 主题' },
    { id: 'settings', label: '⚙️ 站点设置' },
  ];

  function renderNav() {
    var nav = document.getElementById('nav');
    if (!nav) return;
    var panels = BOOT.panels || [];
    var items = NAV.slice();
    var insertAt = items.findIndex(function (n) { return n.id === 'panel-group'; });
    panels.forEach(function (p) { items.splice(insertAt + 1, 0, { id: 'panel:' + p.id, label: '🔌 ' + p.title }); });
    nav.innerHTML = items.map(function (n) {
      if (n.id === 'panel-group') return '<div class="nav-group">插件扩展</div>';
      var active = state.view === n.id || (n.id === 'panel-group' && false);
      return '<button data-view="' + esc(n.id) + '" class="' + (active ? 'active' : '') + '">' + esc(n.label) + '</button>';
    }).join('');
  }

  async function go(view) {
    if (state.editorDirty && !confirmBox('编辑器有未保存的修改，确定离开？')) return;
    state.view = view;
    state.editorDirty = false;
    renderNav();
    await renderView();
  }

  async function renderView() {
    var main = document.getElementById('main');
    if (!main) return;
    var v = state.view;
    try {
      if (v === 'dashboard') { await loadStats(); main.innerHTML = viewDashboard(); return; }
      if (v === 'posts') { await loadPosts(); main.innerHTML = viewPosts(); return; }
      if (v === 'pages') { await loadPosts(); main.innerHTML = viewPages(); return; }
      if (v === 'editor') { main.innerHTML = viewEditor(); afterEditor(); return; }
      if (v === 'plugins') { await loadPlugins(); main.innerHTML = viewPlugins(); return; }
      if (v === 'themes') { await loadThemes(); main.innerHTML = viewThemes(); return; }
      if (v === 'settings') { await loadSettings(); main.innerHTML = viewSettings(); return; }
      if (v === 'widgets') { await loadWidgets(); main.innerHTML = viewWidgets(); return; }
      if (v.indexOf('panel:') === 0) { main.innerHTML = viewPanel(v.slice(6)); mountPanel(v.slice(6)); return; }
      main.innerHTML = '<div class="card">未知视图</div>';
    } catch (e) {
      main.innerHTML = '<div class="card">加载失败：' + esc(e.message) + '</div>';
    }
  }

  /* ---------------- 登录 ---------------- */
  function renderLogin() {
    app.innerHTML = '';
    var card = h(
      '<div class="login-wrap"><div class="login-card">' +
        '<h1>博客后台</h1>' +
        '<p class="sub">请输入管理密码以继续</p>' +
        '<label class="field"><span>密码</span><input type="password" id="pw" autocomplete="current-password"></label>' +
        '<button class="btn primary" id="loginBtn" style="width:100%;justify-content:center">登录</button>' +
        '<div class="form-msg" id="msg"></div>' +
      '</div></div>');
    app.appendChild(card);
    var pw = card.querySelector('#pw'), msg = card.querySelector('#msg');
    async function doLogin() {
      msg.className = 'form-msg';
      msg.textContent = '登录中…';
      try {
        var r = await api('/api/admin/login', { method: 'POST', body: { password: pw.value } });
        if (!r.ok) { msg.className = 'form-msg err'; msg.textContent = r.error || '登录失败'; return; }
        state.user = r.user;
        toast('欢迎回来', 'ok');
        render();
      } catch (e) {
        msg.className = 'form-msg err';
        msg.textContent = e.message;
      }
    }
    card.querySelector('#loginBtn').addEventListener('click', doLogin);
    pw.addEventListener('keydown', function (e) { if (e.key === 'Enter') doLogin(); });
    pw.focus();
  }

  /* ---------------- 概览 ---------------- */
  async function loadStats() {
    state.stats = await api('/api/admin/stats');
    try {
      var p = await api('/api/admin/posts');
      state.recentPosts = (p.posts || []).slice(0, 6);
    } catch (e) { state.recentPosts = []; }
  }

  function fmtDuration(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    if (sec < 60) return sec + ' 秒';
    if (sec < 3600) return Math.floor(sec / 60) + ' 分钟';
    var h = Math.floor(sec / 3600);
    return h + ' 小时 ' + Math.floor((sec % 3600) / 60) + ' 分钟';
  }

  function viewDashboard() {
    var s = state.stats || {};
    var stat = function (k, v) { return '<div class="stat"><div class="k">' + esc(k) + '</div><div class="v">' + esc(v) + '</div></div>'; };
    var rows = (s.recent || []).slice(0, 10).map(function (r) {
      var cls = r.s >= 500 ? 's-5' : r.s >= 400 ? 's-4' : 's-2';
      return '<div class="log-row">' +
        '<span class="' + cls + '">' + r.s + '</span>' +
        '<span class="log-path" title="' + esc(r.m + ' ' + r.p) + '">' + esc(r.m + ' ' + r.p) + '</span>' +
        '<span class="log-ms">' + r.ms + 'ms</span>' +
        '<span class="log-ip" title="' + esc(r.ip || '') + '">' + esc(r.ip || '') + '</span>' +
      '</div>';
    }).join('') || '<div class="muted">暂无请求</div>';
    var more = (s.recent || []).length > 10 ? '<div class="log-more">…共 ' + s.recent.length + ' 条最近请求</div>' : '';
    var kv = function (k, v) { return '<tr><th>' + esc(k) + '</th><td>' + esc(v) + '</td></tr>'; };
    return '<div class="admin-head"><h1>概览</h1><div class="spacer"></div>' +
        '<button class="btn" data-act="reload-all">重载内容与插件</button>' +
        '<button class="btn primary" data-view="editor">写新文章</button></div>' +
      '<div class="grid-stats">' +
        stat('文章', s.posts || 0) + stat('草稿', s.drafts || 0) + stat('页面', s.pages || 0) +
        stat('评论', s.comments || 0) + stat('浏览量', s.views || 0) + stat('启用插件', s.plugins || 0) +
      '</div>' +
      '<div class="dash-grid" style="margin-top:18px">' +
        '<div class="card"><h2>运行状态</h2>' +
          '<table class="tbl"><tbody>' +
            kv('Node', s.node || '') +
            kv('内存占用', (s.memory || 0) + ' MB') +
            kv('运行时长', fmtDuration(s.uptime)) +
            kv('当前主题', s.themeTitle ? (s.themeTitle + '（' + s.theme + '）') : (s.theme || '')) +
            kv('站点前缀', BOOT.base || '/') +
            kv('数据库', 'data/blog.db') +
          '</tbody></table></div>' +
        '<div class="card"><h2>最近请求</h2><div class="log-list">' + rows + '</div>' + more + '</div>' +
        '<div class="card wide"><h2>最近文章</h2>' +
          '<table class="tbl"><tbody>' +
            ((state.recentPosts || []).map(function (p) {
              return '<tr><td><div class="title-clamp"><strong>' + esc(p.title) + '</strong>' + (p.draft ? ' <span class="pill warn">草稿</span>' : '') + '</div>' +
                '<div class="muted" style="font-size:12px">' + esc(fmtDate(p.date)) + ' · ' + esc(p.slug) + ' · ' + (p.words || 0) + ' 字</div></td>' +
                '<td class="actions"><a class="btn sm" href="' + esc(U(p.url || '/')) + '" target="_blank" rel="noopener">查看</a> ' +
                '<button class="btn sm" data-act="edit" data-slug="' + esc(p.slug) + '" data-page="0">编辑</button></td></tr>';
            }).join('') || '<tr><td class="muted">还没有文章</td></tr>') +
          '</tbody></table></div>' +
      '</div>';
  }

  /* ---------------- 文章列表 ---------------- */
  async function loadPosts() {
    var r = await api('/api/admin/posts');
    state.posts = r.posts || [];
    state.pages = r.pages || [];
  }

  function postsTable(items, isPage) {
    if (!items.length) return '<div class="card muted">还没有内容，点右上角开始写。</div>';
    return '<div class="card" style="padding:6px 10px"><table class="tbl"><thead><tr>' +
      '<th>标题</th><th>日期</th><th>标签</th><th>状态</th><th></th></tr></thead><tbody>' +
      items.map(function (p) {
        return '<tr>' +
          '<td><strong>' + esc(p.title) + '</strong><div class="muted" style="font-size:12px">' + esc(p.slug) + '</div></td>' +
          '<td class="muted">' + esc(fmtDate(p.date)) + '</td>' +
          '<td>' + (p.tags || []).map(function (t) { return '<span class="pill">' + esc(t) + '</span>'; }).join(' ') + '</td>' +
          '<td>' + (p.draft ? '<span class="pill warn">草稿</span>' : '<span class="pill on">已发布</span>') +
              (p.pinned ? ' <span class="pill">置顶</span>' : '') + '</td>' +
          '<td class="actions">' +
            '<a class="btn sm" href="' + esc(U(p.url || '/')) + '" target="_blank" rel="noopener">查看</a> ' +
            '<button class="btn sm" data-act="edit" data-slug="' + esc(p.slug) + '" data-page="' + (isPage ? 1 : 0) + '">编辑</button> ' +
            '<button class="btn sm danger" data-act="delete" data-slug="' + esc(p.slug) + '">删除</button>' +
          '</td></tr>';
      }).join('') + '</tbody></table></div>';
  }

  function viewPosts() {
    return '<div class="admin-head"><h1>文章 <span class="muted">(' + state.posts.length + ')</span></h1><div class="spacer"></div>' +
      '<button class="btn primary" data-act="new-post">写新文章</button></div>' + postsTable(state.posts, false);
  }
  function viewPages() {
    return '<div class="admin-head"><h1>独立页面 <span class="muted">(' + state.pages.length + ')</span></h1><div class="spacer"></div>' +
      '<button class="btn primary" data-act="new-page">新建页面</button></div>' + postsTable(state.pages, true);
  }

  /* ---------------- 编辑器 ---------------- */
  function viewEditor() {
    var p = state.editing || { title: '', slug: '', date: '', tags: [], summary: '', draft: false, pinned: false, isPage: false, content: '' };
    var tags = (p.tags || []).join(', ');
    return '<div class="admin-head">' +
        '<h1>' + (p.originalSlug ? '编辑' : '新建') + (p.isPage ? '页面' : '文章') + '</h1>' +
        '<div class="spacer"></div>' +
        '<button class="btn" data-act="cancel-edit">取消</button>' +
        '<button class="btn primary" data-act="save-post">保存 (⌘/Ctrl+S)</button>' +
      '</div>' +
      '<div class="card">' +
        '<div class="row">' +
          '<label class="field" style="flex:2;min-width:240px"><span>标题</span><input type="text" id="f-title" value="' + esc(p.title) + '"></label>' +
          '<label class="field" style="flex:1;min-width:180px"><span>标识 slug <em>（留空自动生成）</em></span><input type="text" id="f-slug" value="' + esc(p.slug) + '"></label>' +
          '<label class="field" style="flex:0 0 190px"><span>日期</span><input type="text" id="f-date" value="' + esc(p.date) + '" placeholder="2026-09-22 10:00"></label>' +
        '</div>' +
        '<div class="row">' +
          '<label class="field" style="flex:1;min-width:200px"><span>标签 <em>（逗号分隔）</em></span><input type="text" id="f-tags" value="' + esc(tags) + '"></label>' +
          '<label class="field" style="flex:2;min-width:240px"><span>摘要 <em>（留空自动截取）</em></span><input type="text" id="f-summary" value="' + esc(p.summary || '') + '"></label>' +
          '<div style="padding-top:22px;display:flex;gap:16px">' +
            '<label class="check"><input type="checkbox" id="f-draft"' + (p.draft ? ' checked' : '') + '> 草稿</label>' +
            '<label class="check"><input type="checkbox" id="f-pinned"' + (p.pinned ? ' checked' : '') + '> 置顶</label>' +
          '</div>' +
        '</div>' +
      '</div>' +
      '<div class="editor-grid">' +
        '<textarea id="f-content" spellcheck="false" placeholder="# 标题&#10;&#10;开始写作…">' + esc(p.content || '') + '</textarea>' +
        '<div class="preview-pane prose" id="preview"><div class="muted">预览区 — 输入内容后自动更新</div></div>' +
      '</div>';
  }

  var previewTimer = null;
  function afterEditor() {
    var ta = document.getElementById('f-content');
    if (!ta) return;
    ta.focus();
    var run = function () { updatePreview(ta.value); };
    ta.addEventListener('input', function () {
      state.editorDirty = true;
      clearTimeout(previewTimer);
      previewTimer = setTimeout(run, 350);
    });
    run();
  }

  async function updatePreview(md) {
    var pane = document.getElementById('preview');
    if (!pane) return;
    try {
      var r = await api('/api/preview', { method: 'POST', body: { markdown: md } });
      pane.innerHTML = r.ok ? (r.html || '<div class="muted">空白内容</div>') : '<div class="muted">' + esc(r.error) + '</div>';
      if (window.BlogHighlight) {
        pane.querySelectorAll('pre > code').forEach(function (c) {
          var lang = (c.className.match(/language-([\w+-]+)/) || [])[1] || '';
          window.BlogHighlight.apply(c, lang);
        });
      }
    } catch (e) {
      pane.innerHTML = '<div class="muted">' + esc(e.message) + '</div>';
    }
  }

  async function savePost() {
    var g = function (id) { var el = document.getElementById(id); return el ? el.value : ''; };
    var body = {
      originalSlug: state.editing && state.editing.originalSlug || null,
      title: g('f-title'),
      slug: g('f-slug'),
      date: g('f-date'),
      tags: g('f-tags').split(/[,，]/).map(function (s) { return s.trim(); }).filter(Boolean),
      summary: g('f-summary'),
      draft: document.getElementById('f-draft').checked,
      pinned: document.getElementById('f-pinned').checked,
      isPage: !!(state.editing && state.editing.isPage),
      content: g('f-content'),
    };
    if (!body.title.trim()) return toast('标题不能为空', 'err');
    var r = await api('/api/admin/post', { method: 'POST', body: body });
    if (!r.ok) return toast(r.error || '保存失败', 'err');
    state.editorDirty = false;
    state.editing = null;
    toast('已保存：' + r.slug, 'ok');
    state.view = body.isPage ? 'pages' : 'posts';
    renderNav();
    await renderView();
  }

  async function editPost(slug, isPage) {
    var r = await api('/api/admin/post?slug=' + encodeURIComponent(slug));
    if (!r.ok) return toast(r.error || '读取失败', 'err');
    state.editing = { ...r.post, originalSlug: r.post.slug, isPage: !!r.post.isPage };
    state.view = 'editor';
    renderNav();
    await renderView();
  }

  async function deletePost(slug) {
    if (!confirmBox('确定删除「' + slug + '」？该操作会删除源文件，不可恢复。')) return;
    var r = await api('/api/admin/post?slug=' + encodeURIComponent(slug), { method: 'DELETE' });
    if (!r.ok) return toast(r.error || '删除失败', 'err');
    toast('已删除', 'ok');
    await renderView();
  }

  /* ---------------- 插件 ---------------- */
  async function loadPlugins() { var r = await api('/api/admin/plugins'); state.plugins = r.plugins || []; BOOT.panels = r.panels || BOOT.panels || []; }

  function viewPlugins() {
    return '<div class="admin-head"><h1>插件</h1><div class="spacer"></div>' +
      '<span class="muted">plugins/&lt;name&gt;/ 目录即插件，改动后点「重载」即可生效</span></div>' +
      '<div class="grid-2">' + state.plugins.map(function (p) {
        var settings = (p.settings || []).map(function (s) {
          var val = s.value;
          var input = '';
          if (s.type === 'bool') {
            input = '<label class="check"><input type="checkbox" data-pset="' + esc(p.name) + ':' + esc(s.key) + '"' + (val ? ' checked' : '') + '> ' + esc(s.label || s.key) + '</label>';
          } else if (s.type === 'select') {
            input = '<label class="field"><span>' + esc(s.label || s.key) + '</span><select data-pset="' + esc(p.name) + ':' + esc(s.key) + '">' +
              (s.options || []).map(function (o) { var ov = typeof o === 'string' ? o : o.value, ol = typeof o === 'string' ? o : o.label; return '<option value="' + esc(ov) + '"' + (String(val) === String(ov) ? ' selected' : '') + '>' + esc(ol) + '</option>'; }).join('') + '</select></label>';
          } else {
            input = '<label class="field"><span>' + esc(s.label || s.key) + '</span><input type="' + (s.type === 'number' ? 'number' : 'text') + '" data-pset="' + esc(p.name) + ':' + esc(s.key) + '" value="' + esc(val == null ? '' : val) + '"></label>';
          }
          return input;
        }).join('');
        return '<div class="card plugin-card">' +
          '<div class="head"><h3>' + esc(p.title) + '</h3>' +
            (p.enabled ? '<span class="pill on">已启用</span>' : '<span class="pill off">已停用</span>') +
            (p.error ? '<span class="pill warn">错误：' + esc(p.error) + '</span>' : '') +
            '<span class="muted">v' + esc(p.version) + '</span>' +
            '<div class="spacer" style="flex:1"></div>' +
            '<button class="btn sm" data-act="plugin-toggle" data-name="' + esc(p.name) + '" data-on="' + (p.enabled ? 0 : 1) + '">' + (p.enabled ? '停用' : '启用') + '</button>' +
            '<button class="btn sm" data-act="plugin-reload" data-name="' + esc(p.name) + '">重载</button>' +
          '</div>' +
          '<div class="desc">' + esc(p.description || '（无说明）') + '</div>' +
          '<div class="hook-chips">' + (p.hooks || []).map(function (hk) { return '<span class="chip">' + esc(hk) + '</span>'; }).join('') +
            '<span class="chip">路由 ' + (p.routes || 0) + '</span></div>' +
          settings +
        '</div>';
      }).join('') + '</div>';
  }

  /* ---------------- 小工具 ---------------- */
  async function loadWidgets() {
    var r = await api('/api/admin/widgets');
    state.zones = r.zones || [];
    state.widgetTypes = r.types || [];
    state.widgetList = r.widgets || [];
  }

  function widgetTypeDesc(type) {
    return (state.widgetTypes || []).find(function (t) { return t.type === type; }) || { fields: [] };
  }

  function fieldInput(scope, f, value) {
    var id = 'wf-' + scope + '-' + f.key;
    var label = '<span>' + esc(f.label || f.key) + '</span>';
    if (f.type === 'bool') {
      return '<label class="check" style="margin-bottom:14px"><input type="checkbox" id="' + id + '"' + (value !== false && value !== undefined ? ' checked' : '') + '> ' + esc(f.label || f.key) + '</label>';
    }
    if (f.type === 'select') {
      return '<label class="field">' + label + '<select id="' + id + '">' +
        (f.options || []).map(function (o) {
          var ov = typeof o === 'string' ? o : o.value, ol = typeof o === 'string' ? o : o.label;
          return '<option value="' + esc(ov) + '"' + (String(value == null ? f.default : value) === String(ov) ? ' selected' : '') + '>' + esc(ol) + '</option>';
        }).join('') + '</select></label>';
    }
    if (f.type === 'textarea') {
      return '<label class="field">' + label + '<textarea id="' + id + '" rows="' + (f.rows || 5) + '" placeholder="' + esc(f.placeholder || '') + '">' + esc(value == null ? '' : value) + '</textarea></label>';
    }
    return '<label class="field">' + label + '<input type="' + (f.type === 'number' ? 'number' : 'text') + '" id="' + id + '" value="' + esc(value == null ? (f.default == null ? '' : f.default) : value) + '" placeholder="' + esc(f.placeholder || '') + '"></label>';
  }

  function widgetEditor() {
    var e = state.widgetEdit;
    if (!e) return '';
    var desc = widgetTypeDesc(e.type);
    var cfg = e.config || {};
    return '<div class="card" id="widget-editor" style="border-color:var(--a-accent)">' +
      '<h2>' + (e.id ? '编辑小工具 #' + e.id : '添加小工具') + '</h2>' +
      '<div class="row">' +
        '<label class="field" style="flex:1;min-width:200px"><span>标题 <em>（可留空）</em></span><input type="text" id="wf-title" value="' + esc(e.title || '') + '"></label>' +
        '<label class="field" style="flex:1;min-width:180px"><span>放置区域</span><select id="wf-zone">' +
          (state.zones || []).map(function (z) {
            return '<option value="' + esc(z.id) + '"' + (e.zone === z.id ? ' selected' : '') + '>' + esc(z.title) + '</option>';
          }).join('') + '</select></label>' +
        '<label class="field" style="flex:1;min-width:200px"><span>类型</span><select id="wf-type"' + (e.id ? ' disabled' : '') + '>' +
          (state.widgetTypes || []).map(function (t) {
            return '<option value="' + esc(t.type) + '"' + (e.type === t.type ? ' selected' : '') + '>' + esc(t.title) + (t.source === 'plugin' ? '（插件）' : '') + '</option>';
          }).join('') + '</select></label>' +
      '</div>' +
      '<p class="muted" style="margin-top:-4px">' + esc(desc.description || '') + '</p>' +
      (desc.fields || []).map(function (f) { return fieldInput('w', f, cfg[f.key]); }).join('') +
      '<div class="row">' +
        '<button class="btn primary" data-act="widget-save">保存</button>' +
        '<button class="btn" data-act="widget-preview">预览</button>' +
        '<button class="btn" data-act="widget-cancel">取消</button>' +
        (state.zones || []).length ? '<span class="muted">区域说明：' + esc((state.zones.find(function (z) { return z.id === e.zone; }) || {}).desc || '') + '</span>' : '' +
      '</div>' +
      '<div class="preview-pane" id="widget-preview" style="min-height:0;max-height:320px;margin-top:12px;display:none"></div>' +
    '</div>';
  }

  function viewWidgets() {
    var list = state.widgetList || [];
    var zones = state.zones || [];
    var sections = zones.map(function (z) {
      var items = list.filter(function (w) { return w.zone === z.id; });
      return '<div class="card"><div class="row" style="align-items:center">' +
          '<h2 style="margin:0">' + esc(z.title) + '</h2>' +
          '<span class="muted">' + esc(z.desc) + '</span>' +
          '<div style="flex:1"></div>' +
          '<button class="btn sm" data-act="widget-new" data-zone="' + esc(z.id) + '">+ 添加</button>' +
        '</div>' +
        (items.length ? '<table class="tbl" style="margin-top:10px"><tbody>' + items.map(function (w) {
          return '<tr>' +
            '<td style="width:60px" class="muted">#' + w.id + '</td>' +
            '<td><strong>' + esc(w.title || '(无标题)') + '</strong>' +
              '<div class="muted" style="font-size:12px">' + esc(w.typeTitle) + (w.source === 'plugin' ? ' · 插件提供' : '') + '</div></td>' +
            '<td style="width:90px">' + (w.enabled ? '<span class="pill on">启用</span>' : '<span class="pill off">停用</span>') + '</td>' +
            '<td class="actions">' +
              '<button class="btn sm" data-act="widget-move" data-id="' + w.id + '" data-dir="up">↑</button> ' +
              '<button class="btn sm" data-act="widget-move" data-id="' + w.id + '" data-dir="down">↓</button> ' +
              '<button class="btn sm" data-act="widget-toggle" data-id="' + w.id + '" data-on="' + (w.enabled ? 0 : 1) + '">' + (w.enabled ? '停用' : '启用') + '</button> ' +
              '<button class="btn sm" data-act="widget-edit" data-id="' + w.id + '">编辑</button> ' +
              '<button class="btn sm danger" data-act="widget-delete" data-id="' + w.id + '">删除</button>' +
            '</td></tr>';
        }).join('') + '</tbody></table>' : '<p class="muted" style="margin:10px 0 0">该区域还没有小工具</p>') +
      '</div>';
    }).join('');
    return '<div class="admin-head"><h1>小工具</h1><div class="spacer"></div>' +
      '<span class="muted">不写代码即可在首页 / 侧栏 / 文章上下方 / 页脚放置小组件；插件也能注册新类型</span></div>' +
      widgetEditor() + sections;
  }

  function collectWidgetForm() {
    var e = state.widgetEdit;
    var desc = widgetTypeDesc(e.type);
    var cfg = {};
    (desc.fields || []).forEach(function (f) {
      var el = document.getElementById('wf-' + 'w' + '-' + f.key);
      if (!el) return;
      if (f.type === 'bool') cfg[f.key] = el.checked;
      else if (f.type === 'number') cfg[f.key] = Number(el.value) || 0;
      else cfg[f.key] = el.value;
    });
    return {
      type: e.type,
      title: document.getElementById('wf-title').value,
      zone: document.getElementById('wf-zone').value,
      config: cfg,
    };
  }

  /* ---------------- 主题 ---------------- */
  async function loadThemes() { var r = await api('/api/admin/themes'); state.themes = r.themes || []; state.currentTheme = r.current; }

  function viewThemes() {
    return '<div class="admin-head"><h1>主题</h1><div class="spacer"></div><span class="muted">themes/&lt;name&gt;/theme.css 只改 CSS 变量</span></div>' +
      '<div class="grid-2">' + state.themes.map(function (t) {
        var cur = t.name === state.currentTheme;
        return '<div class="card">' +
          '<div class="head row"><h3 style="margin:0">' + esc(t.title || t.name) + '</h3>' +
          (cur ? '<span class="pill on">使用中</span>' : '<button class="btn sm primary" data-act="use-theme" data-name="' + esc(t.name) + '">启用</button>') + '</div>' +
          '<div class="desc">' + esc(t.description || '') + '</div>' +
          '<div class="row"><span class="chip">' + esc(t.name) + '</span>' +
            (t.color ? '<span class="chip" style="border-color:' + esc(t.color) + ';color:' + esc(t.color) + '">' + esc(t.color) + '</span>' : '') +
            '<span class="chip">layout.js ' + (t.hasLayout ? '有' : '无') + '</span></div>' +
        '</div>';
      }).join('') + '</div>';
  }

  /* ---------------- 设置 ---------------- */
  async function loadSettings() {
    var r = await api('/api/admin/settings');
    state.settings = r.site || {};
    state.rawSettings = r.settings || {};
    state.cfg = r.config || {};
  }

  function viewSettings() {
    var s = state.settings;
    var navLines = (s.nav || []).map(function (n) { return n.label + ' | ' + n.href; }).join('\n');
    return '<div class="admin-head"><h1>站点设置</h1><div class="spacer"></div><button class="btn primary" data-act="save-settings">保存设置</button></div>' +
      '<div class="grid-2">' +
        '<div class="card"><h2>基本信息</h2>' +
          '<label class="field"><span>站点名称</span><input type="text" data-set="site.title" value="' + esc(s.title) + '"></label>' +
          '<label class="field"><span>副标题</span><input type="text" data-set="site.subtitle" value="' + esc(s.subtitle) + '"></label>' +
          '<label class="field"><span>站点描述</span><textarea data-set="site.description" rows="3">' + esc(s.description) + '</textarea></label>' +
          '<label class="field"><span>作者</span><input type="text" data-set="site.author" value="' + esc(s.author) + '"></label>' +
          '<label class="field"><span>侧栏简介 <em>（留空则不显示）</em></span><textarea data-set="site.aboutShort" rows="2">' + esc(s.aboutShort || '') + '</textarea></label>' +
          '<label class="field"><span>头像 URL</span><input type="text" data-set="site.avatar" value="' + esc(s.avatar) + '"></label>' +
        '</div>' +
        '<div class="card"><h2>导航与页脚</h2>' +
          '<label class="field"><span>导航 <em>（每行：显示文字 | 链接）</em></span><textarea data-set="nav-lines" rows="5">' + esc(navLines) + '</textarea></label>' +
          '<label class="field"><span>页脚补充文字 <em>（纯文本）</em></span><input type="text" data-set="site.footer" value="' + esc(s.footer) + '"></label>' +
          '<label class="field"><span>页脚来源标注 <em>（支持 HTML，留空则不显示该行）</em></span><input type="text" data-set="site.poweredBy" value="' + esc(s.poweredBy || '') + '"></label>' +
          '<label class="field"><span>备案/其它信息</span><input type="text" data-set="site.icp" value="' + esc(s.icp) + '"></label>' +
        '</div>' +
        '<div class="card"><h2>修改管理密码</h2>' +
          '<label class="field"><span>当前密码</span><input type="password" id="pw-cur" autocomplete="current-password"></label>' +
          '<label class="field"><span>新密码 <em>（至少 8 位）</em></span><input type="password" id="pw-new" autocomplete="new-password"></label>' +
          '<button class="btn" data-act="change-pw">更新密码</button>' +
        '</div>' +
        '<div class="card"><h2>运行配置（config.json）</h2>' +
          '<table class="tbl"><tbody>' +
            '<tr><th>每页文章</th><td>' + esc(state.cfg.posts ? state.cfg.posts.perPage : '') + '</td></tr>' +
            '<tr><th>基础路径</th><td>' + esc(state.cfg.server ? state.cfg.server.basePath : '') + '</td></tr>' +
            '<tr><th>站点绝对地址</th><td>' + esc(state.cfg.siteUrl || '（未设置）') + '</td></tr>' +
            '<tr><th>代码高亮</th><td>' + (state.cfg.markdown && state.cfg.markdown.highlight ? '开' : '关') + '</td></tr>' +
          '</tbody></table>' +
          '<p class="muted" style="margin-top:10px">基础设施类配置请编辑服务器上的 config.json 后执行 <code>kill -HUP &lt;pid&gt;</code> 热重载。</p>' +
        '</div>' +
      '</div>';
  }

  async function saveSettings() {
    var out = {};
    document.querySelectorAll('[data-set]').forEach(function (el) {
      var key = el.dataset.set;
      if (key === 'nav-lines') {
        out['site.nav'] = el.value.split('\n').map(function (line) {
          var parts = line.split('|').map(function (x) { return x.trim(); });
          return parts[0] ? { label: parts[0], href: parts[1] || '/' } : null;
        }).filter(Boolean);
      } else {
        out[key] = el.value;
      }
    });
    var r = await api('/api/admin/settings', { method: 'POST', body: { settings: out, theme: state.currentTheme } });
    toast(r.ok ? '设置已保存' : (r.error || '保存失败'), r.ok ? 'ok' : 'err');
  }

  async function changePassword() {
    var cur = document.getElementById('pw-cur').value;
    var next = document.getElementById('pw-new').value;
    var r = await api('/api/admin/password', { method: 'POST', body: { current: cur, next: next } });
    if (r.ok && r.relogin) {
      toast('密码已更新，所有登录会话已失效，请重新登录', 'ok');
      state.user = null;
      render();
      return;
    }
    toast(r.ok ? '密码已更新' : (r.error || '更新失败'), r.ok ? 'ok' : 'err');
    if (r.ok) { document.getElementById('pw-cur').value = ''; document.getElementById('pw-new').value = ''; }
  }

  /* ---------------- 插件面板 ---------------- */
  function viewPanel(id) {
    return '<div class="admin-head"><h1>扩展面板</h1></div><div id="panel-host"></div>';
  }

  function mountPanel(id) {
    var host = document.getElementById('panel-host');
    var panel = (BOOT.panels || []).find(function (p) { return p.id === id; });
    if (!panel) { host.innerHTML = '<div class="card">面板不存在</div>'; return; }
    var box = h('<div class="plugin-panel" data-panel="' + esc(id) + '">' + (panel.html || '') + '</div>');
    host.appendChild(box);
    var init = function () {
      if (window.BlogAdminPanels && typeof window.BlogAdminPanels[id] === 'function') {
        window.BlogAdminPanels[id](box, { api: api, esc: esc, toast: toast, U: U, confirmBox: confirmBox, fmtDate: fmtDate });
      } else {
        box.insertAdjacentHTML('afterbegin', '<div class="card muted">面板脚本未提供初始化函数 window.BlogAdminPanels["' + esc(id) + '"]</div>');
      }
    };
    if (panel.script && !state.panelsMounted[id + ':script']) {
      state.panelsMounted[id + ':script'] = true;
      var s = document.createElement('script');
      s.src = U(panel.script);
      s.onload = init;
      s.onerror = function () { box.innerHTML = '<div class="card">面板脚本加载失败：' + esc(panel.script) + '</div>'; };
      document.head.appendChild(s);
    } else {
      init();
    }
  }

  /* ---------------- 事件 ---------------- */
  document.addEventListener('click', async function (ev) {
    var viewBtn = ev.target.closest('[data-view]');
    if (viewBtn) { go(viewBtn.dataset.view); return; }

    var el = ev.target.closest('[data-act]');
    if (!el) return;
    var act = el.dataset.act;
    try {
      if (act === 'logout') {
        await api('/api/admin/logout', { method: 'POST' });
        state.user = null;
        render();
      } else if (act === 'new-post' || act === 'new-page') {
        state.editing = {
          title: '', slug: '', date: fmtDate(new Date().toISOString()),
          tags: [], summary: '', draft: true, pinned: false, isPage: act === 'new-page', content: '',
        };
        state.view = 'editor';
        renderNav();
        await renderView();
      } else if (act === 'edit') {
        await editPost(el.dataset.slug, el.dataset.page === '1');
      } else if (act === 'delete') {
        await deletePost(el.dataset.slug);
      } else if (act === 'cancel-edit') {
        if (state.editorDirty && !confirmBox('放弃未保存的修改？')) return;
        state.editing = null;
        state.editorDirty = false;
        state.view = 'posts';
        renderNav();
        await renderView();
      } else if (act === 'save-post') {
        await savePost();
      } else if (act === 'reload-all') {
        var r = await api('/api/admin/plugins', { method: 'POST', body: { name: '__none__', action: 'noop' } });
        toast('内容已由服务端自动热加载；插件可在插件页单独重载');
      } else if (act === 'plugin-toggle') {
        var name = el.dataset.name, on = el.dataset.on === '1';
        var res = await api('/api/admin/plugins', { method: 'POST', body: { name: name, action: on ? 'enable' : 'disable' } });
        state.plugins = res.plugins || state.plugins;
        toast((on ? '已启用 ' : '已停用 ') + name + (res.result && res.result.error ? '（' + res.result.error + '）' : ''), res.result && res.result.error ? 'err' : 'ok');
        await renderView();
      } else if (act === 'plugin-reload') {
        var res2 = await api('/api/admin/plugins', { method: 'POST', body: { name: el.dataset.name, action: 'reload' } });
        state.plugins = res2.plugins || state.plugins;
        toast(res2.ok ? '重载成功' : ('重载失败：' + (res2.result && res2.result.error)), res2.ok ? 'ok' : 'err');
        await renderView();
      } else if (act === 'use-theme') {
        var res3 = await api('/api/admin/themes', { method: 'POST', body: { name: el.dataset.name } });
        toast(res3.ok ? '主题已切换' : '切换失败', res3.ok ? 'ok' : 'err');
        await renderView();
      } else if (act === 'save-settings') {
        await saveSettings();
      } else if (act === 'widget-new') {
        state.widgetEdit = { type: (state.widgetTypes[0] || {}).type, zone: el.dataset.zone, title: '', config: {} };
        await renderView();
      } else if (act === 'widget-edit') {
        var w = (state.widgetList || []).find(function (x) { return x.id === Number(el.dataset.id); });
        if (!w) return;
        state.widgetEdit = { id: w.id, type: w.type, zone: w.zone, title: w.title, config: w.config || {} };
        await renderView();
        var ed = document.getElementById('widget-editor');
        if (ed) ed.scrollIntoView({ block: 'center' });
      } else if (act === 'widget-cancel') {
        state.widgetEdit = null;
        await renderView();
      } else if (act === 'widget-save') {
        var payload = collectWidgetForm();
        var res = state.widgetEdit.id
          ? await api('/api/admin/widgets', { method: 'POST', body: { action: 'update', id: state.widgetEdit.id, patch: payload } })
          : await api('/api/admin/widgets', { method: 'POST', body: { action: 'create', widget: payload } });
        toast(res.ok ? '小工具已保存' : (res.error || '保存失败'), res.ok ? 'ok' : 'err');
        if (res.ok) { state.widgetEdit = null; await renderView(); }
      } else if (act === 'widget-preview') {
        var pv = collectWidgetForm();
        var r2 = await api('/api/admin/widgets', { method: 'POST', body: { action: 'preview', type: pv.type, config: pv.config } });
        var box = document.getElementById('widget-preview');
        if (box) {
          box.style.display = 'block';
          box.innerHTML = r2.ok ? (r2.html || '<div class="muted">该配置渲染结果为空</div>') : ('<div class="muted">' + esc(r2.error) + '</div>');
        }
      } else if (act === 'widget-toggle') {
        var won = el.dataset.on === '1';
        await api('/api/admin/widgets', { method: 'POST', body: { action: 'toggle', id: Number(el.dataset.id), enabled: won } });
        toast(won ? '已启用' : '已停用', 'ok');
        await renderView();
      } else if (act === 'widget-move') {
        await api('/api/admin/widgets', { method: 'POST', body: { action: 'move', id: Number(el.dataset.id), dir: el.dataset.dir } });
        await renderView();
      } else if (act === 'widget-delete') {
        if (!confirmBox('删除这个小工具？')) return;
        await api('/api/admin/widgets', { method: 'POST', body: { action: 'delete', id: Number(el.dataset.id) } });
        toast('已删除', 'ok');
        await renderView();
      } else if (act === 'change-pw') {
        await changePassword();
      }
    } catch (e) {
      toast(e.message, 'err');
    }
  });

  document.addEventListener('change', function (ev) {
    if (ev.target.id === 'wf-type') {
      state.widgetEdit.type = ev.target.value;
      state.widgetEdit.config = {};
      renderView();
    }
  });

  document.addEventListener('change', async function (ev) {
    var ps = ev.target.closest('[data-pset]');
    if (!ps) return;
    var parts = ps.dataset.pset.split(':');
    var val = ps.type === 'checkbox' ? ps.checked : ps.value;
    if (ps.type === 'number') val = Number(val);
    try {
      await api('/api/admin/plugins', { method: 'POST', body: { name: parts[0], action: 'setting', key: parts[1], value: val } });
      toast('插件设置已保存', 'ok');
    } catch (e) { toast(e.message, 'err'); }
  });

  document.addEventListener('keydown', function (ev) {
    if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === 's') {
      if (state.view === 'editor') { ev.preventDefault(); savePost(); }
    }
  });

  /* ---------------- 启动 ---------------- */
  (async function boot() {
    try {
      var r = await api('/api/admin/me');
      state.user = r.user;
    } catch (e) {
      state.user = null;
    }
    render();
  })();
})();
