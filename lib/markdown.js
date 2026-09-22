'use strict';
/**
 * markdown.js — 零依赖 Markdown → HTML 渲染器
 *
 * 设计要点：
 *  - 默认先转义再套用行内语法，外部内容不会注入 HTML（rawHtml:true 时例外，仅用于可信的自身文章）
 *  - 标题自动生成 anchor id（供 TOC 插件使用），并可通过 onHeading 回调收集
 *  - 支持：围栏代码块、标题、引用、有序/无序列表（含嵌套与任务列表）、表格、分隔线、
 *          行内代码、粗体、斜体、删除线、高亮、链接、图片、自动链接
 */

const { escapeHtml, escapeAttr, slugify } = require('./utils');

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const INLINE_TOKEN_OPEN = '\u0000';
const INLINE_TOKEN_CLOSE = '\u0001';

/** 链接/图片 URL 白名单，拦截 javascript: / data: 等 */
function sanitizeUrl(url) {
  const u = String(url == null ? '' : url).trim();
  if (!u) return '';
  if (/^[a-z][a-z0-9+.-]*:/i.test(u)) {
    return /^(https?|mailto|tel):/i.test(u) ? u : '';
  }
  if (/^\/\//.test(u)) return 'https:' + u;
  return u; // 相对路径 / 锚点
}

function inline(text, opts) {
  const tokens = [];
  const stash = (html) => {
    tokens.push(html);
    return INLINE_TOKEN_OPEN + (tokens.length - 1) + INLINE_TOKEN_CLOSE;
  };
  const unescapeForUrl = (s) => String(s)
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  // 转义但保留内部占位符（\u0000/\u0001）；用户输入的控制字符已在第 0 步剥掉
  const escapePreservingTokens = (s) => s.replace(/[&<>"']|[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, (c) => {
    if (c === INLINE_TOKEN_OPEN || c === INLINE_TOKEN_CLOSE) return c;
    return HTML_ESCAPES[c] || '';
  });

  // 0) 剥掉用户输入中的控制字符，之后出现的占位符必定来自本函数
  text = text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');

  // 1) 行内代码（先摘出，内部不再做任何格式化）
  text = text.replace(/(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g, (m, ticks, code) =>
    stash('<code class="inline-code">' + escapeHtml(code.trim()) + '</code>'));

  // 2) 图片、链接 —— 必须在整体转义之前处理，否则 URL 里的 & 会被二次转义
  const URL_RE = '((?:[^()\\s]|\\([^()]*\\))+)';
  text = text.replace(new RegExp('!\\[([^\\]]*)\\]\\(\\s*' + URL_RE + '(?:\\s+["\\\']([^"\\\']*)["\\\'])?\\s*\\)', 'g'), (m, alt, url, title) => {
    const href = sanitizeUrl(url);
    if (!href) return stash(escapeHtml(alt));
    return stash(`<img src="${escapeAttr(href)}" alt="${escapeAttr(alt)}"${title ? ` title="${escapeAttr(title)}"` : ''} loading="lazy">`);
  });
  text = text.replace(new RegExp('\\[([^\\]]*)\\]\\(\\s*' + URL_RE + '(?:\\s+["\\\']([^"\\\']*)["\\\'])?\\s*\\)', 'g'), (m, label, url, title) => {
    const href = sanitizeUrl(unescapeForUrl(url));
    if (!href) return stash(escapeHtml(label));
    const ext = /^https?:\/\//i.test(href) && !href.startsWith(opts.siteOrigin || INLINE_TOKEN_OPEN);
    return stash(`<a href="${escapeAttr(href)}"${title ? ` title="${escapeAttr(title)}"` : ''}${ext ? ' target="_blank" rel="noopener noreferrer"' : ''}>${escapeHtml(label)}</a>`);
  });

  // 3) 其余文本整体转义（XSS 防线：此处之后不再存在未转义的原始 HTML）
  text = escapePreservingTokens(text);

  // 4) 自动链接：<https://...> 与裸 URL
  text = text.replace(/&lt;(https?:\/\/[^\s&]+)&gt;/g, (m, url) =>
    stash(`<a href="${escapeAttr(unescapeForUrl(url))}" target="_blank" rel="noopener noreferrer">${url}</a>`));
  text = text.replace(/(^|[\s(（])(https?:\/\/[^\s<)（]+[^\s<)（.,;:!?、。，；：！？])/g, (m, pre, url) =>
    pre + stash(`<a href="${escapeAttr(unescapeForUrl(url))}" target="_blank" rel="noopener noreferrer">${url}</a>`));

  // 5) 强调类（在已转义文本上操作）
  text = text
    .replace(/\*\*\*(?=\S)([\s\S]+?)(?<=\S)\*\*\*/g, '<strong><em>$1</em></strong>')
    .replace(/\*\*(?=\S)([\s\S]+?)(?<=\S)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^\w*])\*(?=\S)([^*\n]+?)(?<=\S)\*(?!\w)/g, '$1<em>$2</em>')
    .replace(/(^|[^\w_])_(?=\S)([^_\n]+?)(?<=\S)_(?!\w)/g, '$1<em>$2</em>')
    .replace(/~~(?=\S)([\s\S]+?)(?<=\S)~~/g, '<del>$1</del>')
    .replace(/==(?=\S)([\s\S]+?)(?<=\S)==/g, '<mark>$1</mark>');

  // 6) 硬换行
  text = text.replace(/(?: {2,}|\\)\n/g, '<br>\n');

  // 7) 还原占位符
  let out = text.replace(new RegExp(INLINE_TOKEN_OPEN + '(\\d+)' + INLINE_TOKEN_CLOSE, 'g'), (m, i) =>
    tokens[Number(i)] === undefined ? '' : tokens[Number(i)]);
  if (opts.breaks) out = out.replace(/\n/g, '<br>\n');
  return out;
}

function parseTable(lines, start, opts) {
  const header = lines[start];
  if (!/^\s*\|.*\|\s*$/.test(header)) return null;
  if (start + 1 >= lines.length) return null;
  const sep = lines[start + 1];
  if (!/^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(sep) || !sep.includes('-')) return null;

  const splitRow = (row) => row.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
  const heads = splitRow(header);
  const aligns = splitRow(sep).map((c) => {
    const l = c.startsWith(':'), r = c.endsWith(':');
    return l && r ? 'center' : r ? 'right' : l ? 'left' : '';
  });
  let end = start + 2;
  const rows = [];
  while (end < lines.length && /\|/.test(lines[end]) && lines[end].trim() !== '') {
    rows.push(splitRow(lines[end]));
    end++;
  }
  const th = heads.map((h, i) => `<th${aligns[i] ? ` style="text-align:${aligns[i]}"` : ''}>${inline(h, opts)}</th>`).join('');
  const tb = rows.map((r) => '<tr>' + heads.map((_, i) =>
    `<td${aligns[i] ? ` style="text-align:${aligns[i]}"` : ''}>${inline(r[i] || '', opts)}</td>`).join('') + '</tr>').join('\n');
  return {
    html: `<div class="table-wrap"><table>\n<thead><tr>${th}</tr></thead>\n<tbody>\n${tb}\n</tbody></table></div>`,
    next: end,
  };
}

/** 列表块解析（支持嵌套、任务列表） */
function parseList(lines, start, opts) {
  const items = [];
  let i = start;
  const baseIndent = lines[start].match(/^\s*/)[0].length;
  const ordered = /^\s*\d+[.)]\s+/.test(lines[start]);

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      // 空行后若仍是同级列表项则继续，否则结束
      const nxt = lines[i + 1];
      if (nxt && new RegExp(`^\\s{${baseIndent},}(?:[-*+]|\\d+[.)])\\s+`).test(nxt) && nxt.match(/^\s*/)[0].length <= baseIndent + 1) {
        i++;
        continue;
      }
      break;
    }
    const m = line.match(/^(\s*)([-*+]|\d+[.)])\s+([\s\S]*)$/);
    if (!m) {
      // 续行：并入上一个 item
      if (items.length && line.match(/^\s*/)[0].length > baseIndent) {
        items[items.length - 1].lines.push(line.trim());
        i++;
        continue;
      }
      break;
    }
    const indent = m[1].length;
    const isOrdered = /^\d/.test(m[2]);
    if (indent < baseIndent) break;
    if (indent > baseIndent + 1) {
      if (items.length) {
        items[items.length - 1].lines.push(line);
        i++;
        continue;
      }
      break;
    }
    if (isOrdered !== ordered) break; // 同级标记类型变化 => 新列表
    items.push({ lines: [m[3]], ordered: isOrdered });
    i++;
  }

  const render = (item) => {
    const ctx = item.lines.join('\n');
    // 任务列表
    const task = ctx.match(/^\[([ xX])\]\s*([\s\S]*)$/);
    if (task) {
      const checked = task[1].toLowerCase() === 'x';
      return `<li class="task-item"><input type="checkbox" disabled${checked ? ' checked' : ''}><span>${inline(task[2], opts)}</span></li>`;
    }
    // 含缩进的行：交给块解析器处理子内容
    if (/\n\s+/.test(ctx)) {
      const sub = ctx.split('\n');
      const head = sub.shift();
      const rest = sub.map((l) => l.replace(new RegExp(`^ {1,${baseIndent + 3}}`), '')).join('\n');
      const subHtml = blocks(rest, opts);
      const loose = /\n\s*\n/.test(''); // 保持简单：子块存在即包裹
      return `<li>${loose ? inline(head, opts) : inline(head, opts)}${subHtml ? '\n' + subHtml : ''}</li>`;
    }
    return `<li>${inline(ctx, opts)}</li>`;
  };

  const body = items.map(render).join('\n');
  return {
    html: ordered ? `<ol>\n${body}\n</ol>` : `<ul>\n${body}\n</ul>`,
    next: i,
  };
}

/**
 * 块级解析
 * @param {string} src
 * @param {object} opts { allowRawHtml, breaks, headings: [], siteOrigin }
 * @returns {string} html
 */
function blocks(src, opts = {}) {
  const lines = String(src == null ? '' : src).replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // 空行
    if (!line.trim()) { i++; continue; }

    // 围栏代码块
    const fence = line.match(/^\s*(```+|~~~+)\s*([\w#+.-]*)\s*$/);
    if (fence) {
      const marker = fence[1][0];
      const lang = (fence[2] || '').toLowerCase();
      const buf = [];
      i++;
      while (i < lines.length && !new RegExp('^\\s*' + marker + '{' + fence[1].length + ',}\\s*$').test(lines[i])) {
        buf.push(lines[i]); i++;
      }
      i++; // 跳过闭合行
      const code = escapeHtml(buf.join('\n'));
      out.push(`<pre class="code-block" data-lang="${escapeAttr(lang || 'text')}"><code class="language-${escapeAttr(lang || 'text')}">${code}</code></pre>`);
      continue;
    }

    // 分隔线
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { out.push('<hr>'); i++; continue; }

    // 标题
    const h = line.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (h) {
      const level = h[1].length;
      const raw = h[2];
      const text = inline(raw, opts);
      const plain = raw.replace(/[*_`~\[\]]|\([^)]*\)/g, '').trim();
      let id = slugify(plain) || `h${i}`;
      if (opts.headings) {
        const used = opts.headings.filter((x) => x.id).map((x) => x.id);
        let cand = id, n = 2;
        while (used.includes(cand)) cand = `${id}-${n++}`;
        id = cand;
        opts.headings.push({ level, text: plain, id });
      }
      out.push(`<h${level} id="${escapeAttr(id)}">${text}<a class="heading-anchor" href="#${escapeAttr(id)}" aria-label="链接到此标题">#</a></h${level}>`);
      i++;
      continue;
    }

    // 引用块（递归解析内部）
    if (/^\s*>/.test(line)) {
      const buf = [];
      while (i < lines.length && (/^\s*>/.test(lines[i]) || (buf.length && lines[i].trim() && !/^\s*(```|#{1,6}\s)/.test(lines[i])))) {
        buf.push(lines[i].replace(/^\s*>\s?/, ''));
        i++;
        if (i < lines.length && !lines[i].trim() && !/^\s*>/.test(lines[i + 1] || '')) break;
      }
      out.push(`<blockquote>\n${blocks(buf.join('\n'), opts)}\n</blockquote>`);
      continue;
    }

    // 表格
    if (line.includes('|')) {
      const t = parseTable(lines, i, opts);
      if (t) { out.push(t.html); i = t.next; continue; }
    }

    // 列表
    if (/^\s*(?:[-*+]|\d+[.)])\s+/.test(line)) {
      const l = parseList(lines, i, opts);
      out.push(l.html);
      i = l.next;
      continue;
    }

    // 原始 HTML 块
    if (opts.allowRawHtml && /^\s*<(\/?)(div|section|figure|details|summary|iframe|video|audio|table|script|style|br|img|hr|p|ul|ol|li|span|a|h[1-6])\b/i.test(line)) {
      const buf = [line];
      i++;
      while (i < lines.length && lines[i].trim() && !/^\s*$/.test(lines[i])) { buf.push(lines[i]); i++; }
      out.push(buf.join('\n'));
      continue;
    }

    // 段落
    const para = [];
    while (i < lines.length && lines[i].trim() &&
      !/^\s*(```|~~~|#{1,6}\s|>|[-*+]\s|\d+[.)]\s)/.test(lines[i]) &&
      !/^\s*([-*_])(\s*\1){2,}\s*$/.test(lines[i]) &&
      !(lines[i].includes('|') && parseTable(lines, i, opts) && i > 0 && false)) {
      para.push(lines[i]);
      i++;
      if (i < lines.length && lines[i].includes('|') && lines[i + 1] && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1])) break;
    }
    if (para.length) out.push(`<p>${inline(para.join('\n'), opts)}</p>`);
    else i++;
  }
  return out.join('\n');
}

/**
 * 渲染入口
 * @param {string} md markdown 源码
 * @param {object} options { allowRawHtml=true, breaks=false, headings=[], siteOrigin }
 */
function render(md, options = {}) {
  const opts = {
    allowRawHtml: options.allowRawHtml !== false,
    breaks: !!options.breaks,
    headings: options.headings || [],
    siteOrigin: options.siteOrigin || '',
  };
  return blocks(md, opts);
}

module.exports = { render, inline, sanitizeUrl };
