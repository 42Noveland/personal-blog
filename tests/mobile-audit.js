#!/usr/bin/env node
'use strict';
/**
 * mobile-audit.js — 手机端体检（零依赖，走 CDP）
 *
 * 用法：
 *   node tests/mobile-audit.js <url> [--port 9333] [--w 390] [--h 844] [--json out.json] [--scroll]
 *
 * 需要先有开了 --remote-debugging-port 的浏览器（tools/cdp-shot.js 用的是同一套）。
 * 自签证书站点请用 --ignore-certificate-errors 启动浏览器。
 *
 * 检查项：
 *   1. 页面是否横向溢出（排除被 overflow 容器裁剪的元素）
 *   2. 顶栏高度 / 点击区尺寸 / theme-color
 *   3. 需要手指点的元素是否 < 40px 高
 *   4. 目录是否在窄屏收起
 *   5. 代码块是否还需要横向滚动、字体、复制按钮是否可见
 *   6. 表格是否溢出、图/示意图的放大入口与白色底板
 *   7. 打开并关闭一次放大浮层（验证交互真的能用）
 *   8. 评论是否成功取数
 */
const http = require('http');

const args = process.argv.slice(2);
const url = args[0];
if (!url) { console.error('用法: node tests/mobile-audit.js <url> [--port 9333] [--w 390] [--h 844] [--json out.json] [--scroll]'); process.exit(1); }
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const has = (n) => args.includes('--' + n);
const PORT = Number(opt('port', 9333));
const W = Number(opt('w', 390));
const H = Number(opt('h', 844));
const JSON_OUT = opt('json', '');
const SCROLL = has('scroll');

function getJson(path) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: PORT, path }, (res) => {
      let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.events = []; }
  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('WS 连接失败')); });
    const c = new Cdp(ws);
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && c.pending.has(msg.id)) {
        const { resolve, reject } = c.pending.get(msg.id); c.pending.delete(msg.id);
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      } else if (msg.method) c.events.push(msg);
    };
    return c;
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`${method} 超时`)); } }, 60000);
    });
  }
  async waitEvent(method, timeout = 30000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      const i = this.events.findIndex((e) => e.method === method);
      if (i >= 0) return this.events.splice(i, 1)[0];
      await new Promise((r) => setTimeout(r, 100));
    }
    return null;
  }
}

/* 体检探针：在被审计页面里跑，返回 JSON 字符串 */
const PROBE = `(() => {
  const vw = window.innerWidth;
  const clipped = (el) => { let p = el.parentElement, n = 0; while (p && n++ < 8) { const o = getComputedStyle(p).overflowX; if (o === 'auto' || o === 'scroll' || o === 'hidden') return true; p = p.parentElement; } return false; };
  const path = (el) => { let p = []; while (el && el.nodeType === 1 && p.length < 4) { let s = el.tagName.toLowerCase(); if (el.id) s += '#' + el.id; else if (typeof el.className === 'string' && el.className) s += '.' + el.className.trim().split(/\\s+/).slice(0, 2).join('.'); p.unshift(s); el = el.parentElement; } return p.join(' > '); };
  const out = { url: location.pathname, vw, pageScrollW: document.scrollingElement.scrollWidth, pageOverflow: document.scrollingElement.scrollWidth > vw + 1, issues: [] };
  document.querySelectorAll('*').forEach((el) => {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return;
    if ((r.right > vw + 1 || r.left < -1) && !clipped(el) && !el.classList.contains('skip-link') && !el.classList.contains('cf-hp'))
      out.issues.push({ kind: 'page-overflow', sel: path(el), left: Math.round(r.left), right: Math.round(r.right) });
  });
  const head = document.querySelector('.site-header');
  out.header = head ? {
    h: Math.round(head.getBoundingClientRect().height),
    iconH: Math.round(document.querySelector('.icon-btn').getBoundingClientRect().height),
    themeColor: (document.querySelector('meta[name=theme-color]') || {}).content || null,
    toTopExists: !!document.querySelector('.to-top')
  } : null;
  const small = [];
  document.querySelectorAll('a, button').forEach((el) => {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0 || r.height >= 40 || el.classList.contains('skip-link') || el.closest('.zoom-view') || el.classList.contains('heading-anchor')) return;
    // 整卡可点的“铺满式链接”（::after 绝对定位铺满父级）按父卡片算，不按文字盒子算
    const after = getComputedStyle(el, '::after');
    if (after.content !== 'none' && after.position === 'absolute' && el.offsetParent && el.offsetParent.getBoundingClientRect().height >= 40) return;
    // 正文里的行内链接不适用点击区要求（WCAG 2.5.8 明确豁免 inline）
    if (el.closest('.prose') && getComputedStyle(el).display === 'inline' && /^(P|LI|TD|BLOCKQUOTE|FIGCAPTION|SPAN|EM|STRONG)$/.test(el.parentElement.tagName)) return;
    small.push({ sel: path(el), w: Math.round(r.width), h: Math.round(r.height), t: (el.textContent || el.getAttribute('aria-label') || '').trim().slice(0, 14) });
  });
  out.smallTapCount = small.length;
  // <32px 视为不合格（WCAG 2.5.8 要 24px，iOS 建议 44px）；32–39px 记为偏小
  out.tinyTapCount = small.filter((s) => s.h < 32).length;
  out.smallTaps = small.filter((s) => s.h < 32).slice(0, 8);
  out.compactTaps = small.filter((s) => s.h >= 32).slice(0, 6);
  const toc = document.querySelector('.toc');
  out.toc = toc ? { cls: toc.className, listVisible: getComputedStyle(toc.querySelector('.toc-list')).display !== 'none', titleH: Math.round(toc.querySelector('.toc-title').getBoundingClientRect().height) } : null;
  const cbs = [].slice.call(document.querySelectorAll('.code-block'));
  out.code = {
    n: cbs.length,
    needScroll: cbs.filter((el) => el.scrollWidth > el.clientWidth + 2).length,
    fs: cbs.length ? getComputedStyle(cbs[0]).fontSize : null,
    ws: cbs.length ? getComputedStyle(cbs[0]).whiteSpace : null,
    copyH: cbs.length ? Math.round((cbs[0].querySelector('.copy-btn') || { getBoundingClientRect: () => ({ height: 0 }) }).getBoundingClientRect().height) : null,
    copyOpacity: cbs.length ? getComputedStyle(cbs[0].querySelector('.copy-btn') || document.body).opacity : null
  };
  const tbs = [].slice.call(document.querySelectorAll('.prose table'));
  out.tables = { n: tbs.length, wide: tbs.filter((el) => el.parentNode.scrollWidth > el.parentNode.clientWidth + 2).length };
  const z = [].slice.call(document.querySelectorAll('[data-zoom-ready]'));
  out.images = {
    total: document.querySelectorAll('.prose img').length,
    zoomable: z.filter((el) => el.tagName === 'IMG').length,
    svgZoomable: z.filter((el) => el.tagName === 'svg').length,
    hints: document.querySelectorAll('.zoom-hint').length,
    diagramBoxes: [].slice.call(document.querySelectorAll('.prose .diagram-box')).map((b) => {
      const s = b.querySelector('svg');
      const vb = (s.getAttribute('viewBox') || '').split(/[\\s,]+/).map(Number);
      return { svgW: Math.round(s.getBoundingClientRect().width), natW: Math.round(vb[2] || 0), minW: s.style.minWidth || '', bg: getComputedStyle(b).backgroundColor, canScroll: b.scrollWidth > b.clientWidth + 2 };
    })
  };
  const first = document.querySelector('.prose img[data-zoom-ready], .prose .diagram-box > svg[data-zoom-ready]');
  if (first) {
    first.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    const view = document.querySelector('.zoom-view');
    const node = view && view.querySelector('.zoom-stage > *');
    out.viewer = view ? {
      hidden: view.hidden, nodeTag: node ? node.tagName : null, nodeW: node ? Math.round(node.getBoundingClientRect().width) : 0,
      stageScrollable: view.querySelector('.zoom-stage').scrollWidth > view.querySelector('.zoom-stage').clientWidth + 2,
      bodyLocked: document.body.classList.contains('zoom-open')
    } : null;
    const c = view && view.querySelector('.zoom-close');
    if (c) c.click();
    if (out.viewer) out.viewer.closedAfter = document.querySelector('.zoom-view').hidden;
  }
  const cl = document.querySelector('[data-comments] [data-list]');
  if (cl) out.comments = { base: document.querySelector('[data-comments]').dataset.base, text: cl.textContent.trim().slice(0, 40), items: cl.querySelectorAll('.comment-item').length };
  return JSON.stringify(out);
})()`;

const SCROLL_PROBE = `(async () => {
  const H = document.scrollingElement.scrollHeight;
  for (let y = 0; y < H; y += 500) { window.scrollTo(0, y); await new Promise((r) => setTimeout(r, 260)); }
  window.scrollTo(0, 0);
  await new Promise((r) => setTimeout(r, 1200));
  return ${PROBE};
})()`;

function report(d) {
  const lines = [];
  const ok = (c) => (c ? '✓' : '✗');
  lines.push(`[${d.url}] vw=${d.vw} 页面宽=${d.pageScrollW}`);
  lines.push(`  ${ok(!d.pageOverflow)} 无横向溢出${d.issues.length ? '（' + d.issues.length + ' 处溢出：' + d.issues.slice(0, 3).map((i) => i.sel).join(' / ') + '）' : ''}`);
  if (d.header) {
    lines.push(`  ${ok(d.header.iconH >= 40)} 顶栏 ${d.header.h}px / 图标点击区 ${d.header.iconH}px / theme-color ${d.header.themeColor || '缺失'}`);
  }
  lines.push(`  ${ok(d.tinyTapCount === 0)} 点击区 <32px 的元素：${d.tinyTapCount} 个${d.tinyTapCount ? '（如 ' + d.smallTaps.slice(0, 3).map((t) => t.t + ' ' + t.h + 'px').join('、') + '）' : ''}；32–39px 的 ${d.smallTapCount - d.tinyTapCount} 个${d.compactTaps.length ? '（如 ' + d.compactTaps.slice(0, 3).map((t) => t.t + ' ' + t.h + 'px').join('、') + '）' : ''}`);
  if (d.toc) lines.push(`  ${ok(!d.toc.listVisible)} 目录：${d.toc.listVisible ? '展开' : '收起'}（标题行 ${d.toc.titleH}px）`);
  if (d.code.n) lines.push(`  ${ok(d.code.needScroll === 0)} 代码块 ${d.code.n} 个：需横滑 ${d.code.needScroll} 个 / ${d.code.fs} / white-space:${d.code.ws} / 复制按钮 ${d.code.copyH}px 透明度 ${d.code.copyOpacity}`);
  if (d.tables.n) lines.push(`  ${ok(d.tables.wide === 0)} 表格 ${d.tables.n} 个：横滑 ${d.tables.wide} 个`);
  if (d.images.total || d.images.svgZoomable) {
    lines.push(`  图：位图 ${d.images.total}（可放大 ${d.images.zoomable}）/ 示意图 ${d.images.diagramBoxes.length}（可放大 ${d.images.svgZoomable}）/ 提示 ${d.images.hints}`);
    d.images.diagramBoxes.forEach((b, i) => lines.push(`     示意图 ${i + 1}: ${b.svgW}px/原生 ${b.natW}px 底板 ${b.bg}${b.minW ? ' 最小宽度 ' + b.minW : ''}`));
  }
  if (d.viewer) lines.push(`  ${ok(!d.viewer.hidden && d.viewer.closedAfter)} 放大浮层：打开 ${d.viewer.nodeTag} ${d.viewer.nodeW}px → 关闭正常${d.viewer.stageScrollable ? '（可拖动）' : ''}`);
  if (d.comments) lines.push(`  ${ok(!/失败/.test(d.comments.text))} 评论：base=${d.comments.base} 列表「${d.comments.text}」`);
  return lines.join('\n');
}

(async function main() {
  const ver = await getJson('/json/version');
  const browser = await Cdp.connect(ver.webSocketDebuggerUrl);
  const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true });
  const send = (method, params = {}) => {
    const id = ++browser.id;
    browser.ws.send(JSON.stringify({ id, method, params, sessionId }));
    return new Promise((resolve, reject) => {
      browser.pending.set(id, { resolve, reject });
      setTimeout(() => { if (browser.pending.has(id)) { browser.pending.delete(id); reject(new Error(`${method} 超时`)); } }, 60000);
    });
  };
  await send('Security.setIgnoreCertificateErrors', { ignore: true });
  await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 2, mobile: true });
  await send('Page.enable');
  await send('Page.navigate', { url });
  await new Promise((r) => setTimeout(r, 1500));
  const r = await send('Runtime.evaluate', { expression: SCROLL ? SCROLL_PROBE : PROBE, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) { console.error('探针异常:', r.exceptionDetails.exception && r.exceptionDetails.exception.description); process.exit(2); }
  const data = JSON.parse(r.result.value);
  console.log(report(data));
  if (JSON_OUT) { require('fs').writeFileSync(JSON_OUT, JSON.stringify(data, null, 2)); console.log('  原始结果 →', JSON_OUT); }
  await browser.send('Target.closeTarget', { targetId });
  process.exit(0);
})().catch((e) => { console.error('审计失败:', e.message); process.exit(3); });