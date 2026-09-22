/* comments/admin.js — 评论管理面板（由后台 SPA 在打开页签时调用 window.BlogAdminPanels.comments） */
window.BlogAdminPanels = window.BlogAdminPanels || {};
window.BlogAdminPanels.comments = function (root, api) {
  var esc = api.esc;
  var rowsEl = root.querySelector('[data-cmt-rows]');
  var filterEl = root.querySelector('[data-cmt-filter]');
  var totalEl = root.querySelector('[data-cmt-total]');

  function statusPill(s) {
    var map = { approved: ['on', '已通过'], pending: ['warn', '待审核'], spam: ['off', '垃圾'] };
    var m = map[s] || ['off', s];
    return '<span class="pill ' + m[0] + '">' + m[1] + '</span>';
  }

  async function load() {
    rowsEl.innerHTML = '<tr><td class="muted">加载中…</td></tr>';
    var r = await api.api('/api/admin/comments?status=' + encodeURIComponent(filterEl.value));
    if (!r.ok) { rowsEl.innerHTML = '<tr><td>' + esc(r.error || '加载失败') + '</td></tr>'; return; }
    var counts = r.counts || {};
    totalEl.textContent = '全部 ' + (counts.approved || 0) + ' 通过 / ' + (counts.pending || 0) + ' 待审 / ' + (counts.spam || 0) + ' 垃圾';
    if (!r.comments.length) { rowsEl.innerHTML = '<tr><td class="muted">没有评论</td></tr>'; return; }
    rowsEl.innerHTML = r.comments.map(function (c) {
      return '<tr>' +
        '<td style="width:130px"><strong>' + esc(c.author) + '</strong><div class="muted" style="font-size:12px">' + esc(c.created_at.slice(0, 16).replace('T', ' ')) + '</div>' +
          '<div class="muted" style="font-size:11px">' + esc(c.ip || '') + '</div></td>' +
        '<td style="width:120px" class="muted">' + esc(c.slug) + '</td>' +
        '<td>' + esc(c.content) + (c.email ? '<div class="muted" style="font-size:12px">✉ ' + esc(c.email) + '</div>' : '') + '</td>' +
        '<td style="width:80px">' + statusPill(c.status) + '</td>' +
        '<td class="actions">' +
          (c.status !== 'approved' ? '<button class="btn sm" data-cmt-act="approve" data-id="' + c.id + '">通过</button> ' : '') +
          (c.status === 'approved' ? '<button class="btn sm" data-cmt-act="pending" data-id="' + c.id + '">转待审</button> ' : '') +
          '<button class="btn sm danger" data-cmt-act="spam" data-id="' + c.id + '">垃圾</button> ' +
          '<button class="btn sm danger" data-cmt-act="delete" data-id="' + c.id + '">删除</button>' +
        '</td></tr>';
    }).join('');
  }

  root.addEventListener('click', async function (ev) {
    var btn = ev.target.closest('[data-cmt-act]');
    if (btn) {
      var act = btn.dataset.cmtAct, id = btn.dataset.id;
      try {
        if (act === 'delete') {
          if (!api.confirmBox('删除这条评论？')) return;
          await api.api('/api/admin/comments/' + id, { method: 'DELETE' });
        } else {
          await api.api('/api/admin/comments/' + id, { method: 'POST', body: { action: act } });
        }
        api.toast('已更新', 'ok');
        load();
      } catch (e) { api.toast(e.message, 'err'); }
      return;
    }
    if (ev.target.closest('[data-cmt-refresh]')) load();
  });

  filterEl.addEventListener('change', load);
  load();
};
