'use strict';
/**
 * 目录插件 — 演示 contentFilter（读取渲染后的标题结构）+ postHeader（正文前插入 UI）
 *   · 每次请求的数据必须挂在 ctx.state 上，否则并发请求会互相污染
 *   · 需要的样式经 head 钩子注入，脚本随组件内联，插件自成一体
 */
const { escapeHtml } = require('../../lib/utils');

module.exports = {
  head() {
    return `<style>
      .toc { margin: 0 0 30px; padding: 16px 18px; border: 1px solid var(--border);
             border-radius: 14px; background: color-mix(in srgb, var(--card) 70%, transparent); }
      .toc-title { display: flex; align-items: center; gap: 8px; cursor: pointer; user-select: none;
                   font-size: 13px; letter-spacing: .08em; text-transform: uppercase; color: var(--text-mute); }
      .toc-list { list-style: none; margin: 12px 0 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
      .toc-list a { display: block; padding: 5px 10px; border-radius: 8px; color: var(--text-dim);
                    font-size: 14px; border-left: 2px solid transparent; }
      .toc-list a:hover { background: var(--accent-soft); color: var(--text); }
      .toc-list a.lv3 { padding-left: 30px; font-size: 13.5px; }
      .toc-list a.lv4 { padding-left: 46px; font-size: 13px; }
      .toc-list a.active { color: var(--accent); border-left-color: var(--accent); background: var(--accent-soft); }
      .toc.collapsed .toc-list { display: none; }
    </style>`;
  },

  contentFilter(ctx) {
    const maxLevel = Number(this.settings.get('maxLevel', 3)) || 3;
    ctx.state.tocHeadings = (ctx.headings || []).filter((h) => h.level >= 2 && h.level <= maxLevel);
    return null; // 不修改正文
  },

  postHeader(ctx) {
    const headings = ctx.state.tocHeadings || [];
    const min = Number(this.settings.get('minHeadings', 3)) || 3;
    if (headings.length < min) return '';
    const items = headings.map((h) =>
      `<li><a class="lv${h.level}" href="#${encodeURIComponent(h.id)}">${escapeHtml(h.text)}</a></li>`).join('');
    return `<nav class="toc" id="post-toc">
      <div class="toc-title" data-toc-toggle>📑 目录 <span style="margin-left:auto">▾</span></div>
      <ul class="toc-list">${items}</ul>
    </nav>
    <script nonce="${ctx.nonce || ''}">
    (function(){
      var toc = document.getElementById('post-toc');
      if (!toc) return;
      toc.querySelector('[data-toc-toggle]').addEventListener('click', function(){
        toc.classList.toggle('collapsed');
      });
      var links = [].slice.call(toc.querySelectorAll('a'));
      var targets = links.map(function(a){
        try { return document.getElementById(decodeURIComponent(a.hash.slice(1))); } catch (e) { return null; }
      });
      if ('IntersectionObserver' in window) {
        var io = new IntersectionObserver(function(entries){
          entries.forEach(function(e){
            if (!e.isIntersecting) return;
            var i = targets.indexOf(e.target);
            links.forEach(function(l){ l.classList.remove('active'); });
            if (links[i]) links[i].classList.add('active');
          });
        }, { rootMargin: '-80px 0px -70% 0px', threshold: 0 });
        targets.forEach(function(t){ if (t) io.observe(t); });
      }
    })();
    </script>`;
  },
};
