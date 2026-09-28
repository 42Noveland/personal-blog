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
    syncThemeColor();
  }

  /* 手机浏览器地址栏配色跟随主题（读取主题的 --bg） */
  function syncThemeColor() {
    var meta = document.querySelector('meta[name="theme-color"]');
    if (!meta) return;
    var bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
    if (bg) meta.setAttribute('content', bg);
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
      closeViewer();
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

  /* ---------- 图片 / 示意图：点击放大（手机上看不清的图） ---------- */

  var zoomView = null;

  function buildViewer() {
    var v = document.createElement('div');
    v.className = 'zoom-view';
    v.hidden = true;
    v.innerHTML = '<div class="zoom-bar"><span class="zoom-label"></span>' +
      '<button class="zoom-close" type="button" aria-label="关闭">✕</button></div>' +
      '<div class="zoom-stage"></div>' +
      '<p class="zoom-tip">双指缩放 · 拖动查看 · 点击空白或按 Esc 关闭</p>';
    document.body.appendChild(v);
    v.addEventListener('click', function (ev) {
      if (ev.target.closest('.zoom-close') ||
          ev.target === v || ev.target.classList.contains('zoom-stage') || ev.target.classList.contains('zoom-tip')) {
        closeViewer();
      }
    });
    return v;
  }

  function openViewer(item) {
    if (!zoomView) zoomView = buildViewer();
    var stage = zoomView.querySelector('.zoom-stage');
    var label = zoomView.querySelector('.zoom-label');
    stage.innerHTML = '';
    var node;
    if (item.kind === 'svg') {
      node = item.el.cloneNode(true);
      node.removeAttribute('style');
      node.style.width = item.w + 'px';
      node.style.height = 'auto';
      node.style.maxWidth = 'none';
    } else {
      node = document.createElement('img');
      node.src = item.el.currentSrc || item.el.src;
      node.alt = item.el.alt || '';
      node.style.width = item.w + 'px';
      node.style.height = 'auto';
      node.style.maxWidth = 'none';
      node.style.borderRadius = '6px';
    }
    stage.appendChild(node);
    label.textContent = item.label || '';
    zoomView.hidden = false;
    document.body.classList.add('zoom-open');
    stage.scrollTop = 0;
    stage.scrollLeft = item.kind === 'img' ? Math.max(0, (stage.scrollWidth - stage.clientWidth) / 2) : 0;
  }

  function closeViewer() {
    if (!zoomView || zoomView.hidden) return;
    zoomView.hidden = true;
    zoomView.querySelector('.zoom-stage').innerHTML = '';
    document.body.classList.remove('zoom-open');
  }

  function registerZoom(el, item) {
    if (!el || el.dataset.zoomReady) return;
    el.dataset.zoomReady = '1';
    el.style.cursor = 'zoom-in';
    el.addEventListener('click', function (ev) { ev.preventDefault(); openViewer(item); });
    var hint = document.createElement('span');
    hint.className = 'zoom-hint';
    hint.textContent = '点击放大 🔍';
    hint.addEventListener('click', function (ev) { ev.preventDefault(); ev.stopPropagation(); openViewer(item); });
    var fig = el.closest('figure');
    var cap = fig ? fig.querySelector('figcaption') : null;
    if (cap) {
      cap.appendChild(document.createTextNode(' '));
      cap.appendChild(hint);
    } else {
      var holder = document.createElement('span');
      holder.appendChild(hint);
      el.parentNode.insertBefore(holder, el.nextSibling);
    }
  }

  function wrapCaption(el) {
    var fig = el.closest('figure');
    var cap = fig ? fig.querySelector('figcaption') : null;
    if (cap) return cap.textContent.trim();
    return el.getAttribute('alt') || '';
  }

  /* 正文位图：只给“被缩小的图”加放大入口
     注意：loading=lazy 的图在进入视口前 complete 就是 true 但 naturalWidth 为 0，
     所以要同时挂 load 监听 + 在滚动时补扫，不能只看一次。 */
  function tryRegisterImage(img) {
    if (img.dataset.zoomReady) return;
    var rendered = img.getBoundingClientRect().width;
    var nat = img.naturalWidth || 0;
    if (!rendered || !nat) return;
    if (nat > rendered * 1.25) {
      registerZoom(img, { el: img, kind: 'img', w: nat, label: wrapCaption(img) });
    }
  }

  function scanImages() {
    document.querySelectorAll('.prose img').forEach(function (img) {
      if (!img.dataset.zoomWatch) {
        img.dataset.zoomWatch = '1';
        img.addEventListener('load', function () { tryRegisterImage(img); });
      }
      tryRegisterImage(img);
    });
  }

  function rescanImages() {
    document.querySelectorAll('.prose img[data-zoom-watch]').forEach(tryRegisterImage);
  }

  /* 内联 SVG 示意图（mermaid 等）：缩得太小就加放大入口 */
  function scanDiagrams() {
    document.querySelectorAll('.prose .diagram-box > svg').forEach(function (svg) {
      if (svg.dataset.zoomReady) return;
      var vb = (svg.getAttribute('viewBox') || '').split(/[\s,]+/).map(Number);
      var vbW = vb[2] || 0;
      var rendered = svg.getBoundingClientRect().width;
      if (!vbW || !rendered) return;
      if (vbW > rendered * 1.25) {
        registerZoom(svg, { el: svg, kind: 'svg', w: Math.round(vbW), label: wrapCaption(svg) });
      }
    });
  }

  /* 窄屏下给过宽的示意图一个最低可读宽度（配合容器横滑） */
  function fitDiagrams() {
    var narrow = window.innerWidth <= 900;
    document.querySelectorAll('.prose .diagram-box > svg').forEach(function (svg) {
      var vb = (svg.getAttribute('viewBox') || '').split(/[\s,]+/).map(Number);
      var vbW = vb[2] || 0;
      var box = svg.parentNode;
      var avail = (box.clientWidth || 0) - 24;
      if (!narrow || !vbW || !avail) { svg.style.minWidth = ''; return; }
      svg.style.minWidth = avail / vbW < 0.62 ? Math.round(vbW * 0.62) + 'px' : '';
    });
  }

  /* ---------- 回到顶部（手机端长文） ---------- */
  function initToTop() {
    if (document.querySelector('.to-top')) return;
    var btn = document.createElement('button');
    btn.className = 'to-top';
    btn.type = 'button';
    btn.setAttribute('aria-label', '回到顶部');
    btn.textContent = '↑';
    btn.addEventListener('click', function () { window.scrollTo({ top: 0, behavior: 'smooth' }); });
    document.body.appendChild(btn);
    var upd = function () { btn.classList.toggle('show', window.scrollY > 800); };
    window.addEventListener('scroll', upd, { passive: true });
    upd();
  }

  function decorateContent() {
    scanImages();
    scanDiagrams();
    fitDiagrams();
  }

  var fitTimer = null;
  window.addEventListener('resize', function () {
    clearTimeout(fitTimer);
    fitTimer = setTimeout(decorateContent, 200);
  });

  var rescanTimer = null;
  window.addEventListener('scroll', function () {
    if (rescanTimer) return;
    rescanTimer = setTimeout(function () { rescanTimer = null; rescanImages(); }, 400);
  }, { passive: true });

  // 注意：defer 脚本执行时 readyState 已是 'interactive'，
  // 若在此刻立即执行，后面的 defer 脚本（highlight.js）还没跑，高亮会静默失效。
  // 正确做法：等 DOMContentLoaded（所有 defer 脚本执行完之后触发）。
  if (document.readyState === 'complete') {
    decorateCode();
    decorateContent();
    initToTop();
  } else {
    document.addEventListener('DOMContentLoaded', function () {
      decorateCode();
      decorateContent();
      initToTop();
    });
  }
})();
