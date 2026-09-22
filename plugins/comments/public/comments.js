/* comments.js — 评论插件前台逻辑（零依赖） */
(function () {
  'use strict';
  var root = document.querySelector('[data-comments]');
  if (!root) return;

  var base = root.dataset.base || '';
  var slug = root.dataset.slug;
  var listEl = root.querySelector('[data-list]');
  var countEl = root.querySelector('[data-count]');
  var form = root.querySelector('[data-form]');
  var msg = root.querySelector('[data-msg]');
  var page = 1, total = 0, rendered = 0;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function linkify(text) {
    return esc(text).replace(/(https?:\/\/[^\s<]+[^\s<.,;:!?、。，；：！？])/g, function (url) {
      return '<a href="' + url + '" target="_blank" rel="noopener noreferrer nofollow">' + url + '</a>';
    });
  }
  function timeAgo(iso) {
    var d = new Date(iso), diff = (Date.now() - d.getTime()) / 1000;
    if (isNaN(d)) return '';
    if (diff < 60) return '刚刚';
    if (diff < 3600) return Math.floor(diff / 60) + ' 分钟前';
    if (diff < 86400) return Math.floor(diff / 3600) + ' 小时前';
    if (diff < 86400 * 30) return Math.floor(diff / 86400) + ' 天前';
    var p = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }

  function itemHtml(c) {
    return '<article class="comment-item">' +
      '<div class="comment-head">' +
        '<span class="comment-avatar">' + esc((c.author || '?').slice(0, 1)) + '</span>' +
        '<span class="comment-author">' + esc(c.author) + '</span>' +
        '<span class="comment-time" title="' + esc(c.createdAt) + '">' + esc(timeAgo(c.createdAt)) + '</span>' +
      '</div>' +
      '<div class="comment-body">' + linkify(c.content) + '</div>' +
    '</article>';
  }

  async function load(more) {
    try {
      var res = await fetch(base + '/api/comments/' + encodeURIComponent(slug) + '?page=' + page);
      var data = await res.json();
      if (!data.ok) throw new Error(data.error || '加载失败');
      total = data.total;
      countEl.textContent = total ? '(' + total + ')' : '(暂无)';
      if (!more) listEl.innerHTML = '';
      if (!data.comments.length && !more) {
        listEl.innerHTML = '<p class="comments-empty">还没有评论，来做第一个吧 ✨</p>';
      } else {
        listEl.insertAdjacentHTML('beforeend', data.comments.map(itemHtml).join(''));
      }
      rendered += data.comments.length;
      var old = listEl.querySelector('.comments-more');
      if (old) old.remove();
      if (rendered < total) {
        var btn = document.createElement('button');
        btn.className = 'comments-more';
        btn.type = 'button';
        btn.textContent = '加载更多（' + (total - rendered) + '）';
        btn.addEventListener('click', function () { page++; load(true); });
        listEl.appendChild(btn);
      }
    } catch (e) {
      listEl.innerHTML = '<p class="comments-empty">评论加载失败：' + esc(e.message) + '</p>';
    }
  }

  form.addEventListener('submit', async function (ev) {
    ev.preventDefault();
    var btn = form.querySelector('button[type=submit]');
    var payload = {
      author: form.author.value,
      email: form.email.value,
      content: form.content.value,
      website: form.website.value,
    };
    btn.disabled = true;
    msg.className = 'cf-msg';
    msg.textContent = '提交中…';
    try {
      var res = await fetch(base + '/api/comments/' + encodeURIComponent(slug), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      var data = await res.json();
      if (!data.ok) throw new Error(data.error || '提交失败');
      msg.className = 'cf-msg ok';
      msg.textContent = data.message || '已提交';
      form.content.value = '';
      if (!data.pending) { page = 1; rendered = 0; load(false); }
    } catch (e) {
      msg.className = 'cf-msg err';
      msg.textContent = e.message;
    } finally {
      btn.disabled = false;
    }
  });

  load(false);
})();
