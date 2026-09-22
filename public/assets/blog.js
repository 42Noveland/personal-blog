/* blog.js — 前端交互（零依赖） */
(function () {
  'use strict';

  var root = document.documentElement;

  /* ---------- 明暗切换 ---------- */
  function applyMode(mode) {
    root.dataset.mode = mode;
    try { localStorage.setItem('blog-mode', mode); } catch (e) {}
    var btn = document.querySelector('[data-theme-toggle]');
    if (btn) btn.setAttribute('aria-label', mode === 'dark' ? '切换到浅色' : '切换到深色');
  }

  function initMode() {
    var saved = null;
    try { saved = localStorage.getItem('blog-mode'); } catch (e) {}
    if (!saved) saved = root.dataset.defaultMode || 'dark';
    applyMode(saved);
  }
  initMode();

  document.addEventListener('click', function (ev) {
    var t = ev.target.closest('[data-theme-toggle]');
    if (t) {
      applyMode(root.dataset.mode === 'dark' ? 'light' : 'dark');
      return;
    }
    var nav = ev.target.closest('[data-nav-toggle]');
    if (nav) {
      var menu = document.querySelector('[data-site-nav]');
      if (menu) menu.classList.toggle('open');
      return;
    }
    var st = ev.target.closest('[data-search-toggle]');
    if (st) {
      var panel = document.querySelector('[data-search-panel]');
      if (panel) {
        panel.hidden = !panel.hidden;
        if (!panel.hidden) {
          var input = panel.querySelector('input');
          if (input) input.focus();
        }
      }
    }
  });

  /* 快捷键：/ 聚焦搜索，Esc 关闭面板 */
  document.addEventListener('keydown', function (ev) {
    if (ev.key === '/' && !/input|textarea/i.test(document.activeElement.tagName)) {
      var panel = document.querySelector('[data-search-panel]');
      var input = panel && panel.querySelector('input');
      if (input) { ev.preventDefault(); panel.hidden = false; input.focus(); }
    }
    if (ev.key === 'Escape') {
      var p = document.querySelector('[data-search-panel]');
      if (p) p.hidden = true;
    }
  });

  /* ---------- 代码块：复制按钮 + 语法高亮 ---------- */
  function decorateCode() {
    document.querySelectorAll('pre.code-block > code').forEach(function (code) {
      var lang = (code.className.match(/language-([\w+-]+)/) || [])[1] || '';
      if (window.BlogHighlight) window.BlogHighlight.apply(code, lang);
      var pre = code.parentNode;
      if (pre.querySelector('.copy-btn')) return;
      var btn = document.createElement('button');
      btn.className = 'copy-btn';
      btn.type = 'button';
      btn.textContent = '复制';
      btn.addEventListener('click', function () {
        var text = code.innerText;
        var done = function () {
          btn.textContent = '已复制 ✓';
          setTimeout(function () { btn.textContent = '复制'; }, 1600);
        };
        if (navigator.clipboard && window.isSecureContext) {
          navigator.clipboard.writeText(text).then(done, function () { fallback(text, done); });
        } else {
          fallback(text, done);
        }
      });
      pre.appendChild(btn);
    });
  }
  function fallback(text, done) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); done(); } catch (e) {}
    document.body.removeChild(ta);
  }

  // 注意：defer 脚本执行时 readyState 已是 'interactive'，
  // 若在此刻立即执行，后面的 defer 脚本（highlight.js）还没跑，高亮会静默失效。
  // 正确做法：等 DOMContentLoaded（所有 defer 脚本执行完之后触发）。
  if (document.readyState === 'complete') {
    decorateCode();
  } else {
    document.addEventListener('DOMContentLoaded', decorateCode);
  }
})();
