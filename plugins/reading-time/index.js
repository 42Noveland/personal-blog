'use strict';
/**
 * 阅读时长插件 — 最小可用示例（约 20 行）
 * 演示：postMeta 钩子（注入文章元信息）+ 插件设置项 + head 钩子注入样式。
 * 钩子内通过 this.settings.get(...) 读取本插件设置（后台「插件」页可在线修改）。
 */
module.exports = {
  head() {
    return `<style>
      .plugin-meta { color: var(--text-mute); white-space: nowrap; }
      .plugin-meta.warn { color: #ffc46b; }
    </style>`;
  },

  postMeta(ctx) {
    const post = ctx.post;
    if (!post) return '';
    const minutes = post.readingMinutes || 1;
    const showWords = !!this.settings.get('showWords', false);
    const words = post.words || 0;
    return `<span class="dot">·</span><span class="plugin-meta" title="预计阅读时长">📖 约 ${minutes} 分钟</span>` +
      (showWords ? `<span class="plugin-meta">· ${words} 字</span>` : '');
  },
};
