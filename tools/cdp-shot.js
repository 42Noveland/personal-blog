#!/usr/bin/env node
'use strict';
/**
 * cdp-shot.js — 用 CDP 给页面截图（Node 内置 WebSocket，零依赖）
 *
 * 用法：
 *   node tools/cdp-shot.js <url> <out.png> [--port 9444] [--w 1280] [--h 900]
 *                          [--scale 2] [--full] [--cookie "name=value; name2=value2"]
 *                          [--click "selector"] [--wait 800] [--eval "js"]
 *
 * 需要事先启动一个开启了 --remote-debugging-port 的浏览器；
 * 自签证书站点请用 --ignore-certificate-errors 启动浏览器。
 */
const fs = require('fs');
const http = require('http');

const args = process.argv.slice(2);
const url = args[0];
const out = args[1];
const opt = (name, def) => {
  const i = args.indexOf('--' + name);
  return i >= 0 ? args[i + 1] : def;
};
const has = (name) => args.includes('--' + name);

if (!url || !out) {
  console.error('用法: node tools/cdp-shot.js <url> <out.png> [--port 9444] [--w 1280] [--h 900] [--scale 2] [--full] [--cookie "..."] [--click sel] [--wait ms] [--eval "js"]');
  process.exit(1);
}
const PORT = Number(opt('port', 9444));
const W = Number(opt('w', 1280));
const H = Number(opt('h', 900));
const SCALE = Number(opt('scale', 2));
const WAIT = Number(opt('wait', 900));
const WAIT2 = Number(opt('wait2', 0));
const FULL = has('full');
const COOKIE = opt('cookie', '');
const COOKIE_FILE = opt('cookie-file', '');
const UA = opt('ua', '');
const CLIP = opt('clip', '');   // --clip "y,height" 截取页面某区域（配合 captureBeyondViewport）
const CLICK = opt('click', '');
const EVAL = opt('eval', '');

/** 读取 curl cookie jar（Netscape 格式），返回 "k=v; k2=v2" */
function readCookieJar(file) {
  const out = [];
  try {
    for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const line = raw.replace(/^#HttpOnly_/, '');
      if (!line.trim() || line.startsWith('#')) continue;
      const parts = line.split('\t');
      if (parts.length >= 7) out.push(`${parts[5]}=${parts[6]}`);
    }
  } catch (e) {
    console.error('cookie 文件读取失败:', e.message);
  }
  return out.join('; ');
}

function getJson(path) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: PORT, path }, (res) => {
      let b = '';
      res.on('data', (d) => (b += d));
      res.on('end', () => {
        try { resolve(JSON.parse(b)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.events = []; }
  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = (e) => rej(new Error('WS 连接失败')); });
    const c = new Cdp(ws);
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && c.pending.has(msg.id)) {
        const { resolve, reject } = c.pending.get(msg.id);
        c.pending.delete(msg.id);
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      } else if (msg.method) {
        c.events.push(msg);
      }
    };
    return c;
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`${method} 超时`)); }
      }, 45000);
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

(async function main() {
  const ver = await getJson('/json/version');
  const browser = await Cdp.connect(ver.webSocketDebuggerUrl);
  const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true });

  // 用扁平会话：所有命令带上 sessionId
  const page = {
    send: (method, params = {}) => {
      const id = ++browser.id;
      browser.ws.send(JSON.stringify({ id, method, params, sessionId }));
      return new Promise((resolve, reject) => {
        browser.pending.set(id, { resolve, reject });
        setTimeout(() => {
          if (browser.pending.has(id)) { browser.pending.delete(id); reject(new Error(method + ' 超时')); }
        }, 45000);
      });
    },
  };

  await page.send('Page.enable');
  await page.send('Network.enable');
  await page.send('Log.enable');
  if (UA) await page.send('Emulation.setUserAgentOverride', { userAgent: UA });
  await page.send('Emulation.setDeviceMetricsOverride', {
    width: W, height: H, deviceScaleFactor: SCALE, mobile: /iPhone|Android/i.test(UA),
  });
  const cookieStr = COOKIE || (COOKIE_FILE ? readCookieJar(COOKIE_FILE) : '');
  if (cookieStr) {
    const host = new URL(url).hostname;
    for (const pair of cookieStr.split(';')) {
      const [name, ...rest] = pair.trim().split('=');
      if (!name) continue;
      await page.send('Network.setCookie', {
        name: name.trim(), value: rest.join('=').trim(), domain: host, path: '/', secure: true,
      });
    }
    console.log('已注入 cookie:', cookieStr.split(';').map((s) => s.split('=')[0].trim()).join(','));
  }
  await page.send('Page.navigate', { url });
  await browser.waitEvent('Page.loadEventFired', 30000).catch(() => {});
  await new Promise((r) => setTimeout(r, WAIT));
  if (CLICK) {
    await page.send('Runtime.evaluate', { expression: `document.querySelector(${JSON.stringify(CLICK)})?.click()`, awaitPromise: false });
    await new Promise((r) => setTimeout(r, 700));
  }
  if (EVAL) {
    const r = await page.send('Runtime.evaluate', { expression: EVAL, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) console.log('EVAL 异常:', JSON.stringify(r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text));
    else console.log('EVAL:', JSON.stringify(r.result && r.result.value));
  }
  if (WAIT2) await new Promise((r) => setTimeout(r, WAIT2));

  // CSP / 安全类控制台条目（用于验证策略没有误伤）
  const secEntries = browser.events
    .filter((e) => e.method === 'Log.entryAdded' && e.params && e.params.entry)
    .map((e) => e.params.entry)
    .filter((en) => en.source === 'security' || /Content Security Policy|Refused to/i.test(en.text || ''));
  if (secEntries.length) {
    console.log('CSP/安全告警 ' + secEntries.length + ' 条：');
    secEntries.slice(0, 12).forEach((en) => console.log('   ! ' + String(en.text).slice(0, 220)));
  } else {
    console.log('CSP/安全告警：无');
  }
  const errs = browser.events
    .filter((e) => e.method === 'Log.entryAdded' && e.params && e.params.entry && e.params.entry.level === 'error')
    .map((e) => e.params.entry.text);
  if (errs.length) console.log('页面 JS 错误 ' + errs.length + ' 条：', errs.slice(0, 5).map((t) => String(t).slice(0, 160)));

  const title = await page.send('Runtime.evaluate', { expression: 'document.title', returnByValue: true });
  const info = await page.send('Runtime.evaluate', {
    expression: 'JSON.stringify({url:location.href,h:document.documentElement.scrollHeight,cards:document.querySelectorAll(".post-card").length,text:document.body.innerText.slice(0,120)})',
    returnByValue: true,
  });
  console.log('TITLE:', title.result.value);
  console.log('INFO :', info.result.value);

  const shotParams = { format: 'png', captureBeyondViewport: !!FULL, fromSurface: true };
  if (CLIP) {
    const [cy, ch] = CLIP.split(',').map(Number);
    shotParams.captureBeyondViewport = true;
    shotParams.clip = { x: 0, y: cy, width: W, height: ch, scale: SCALE };
  }
  const shot = await page.send('Page.captureScreenshot', shotParams);
  fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
  console.log('SAVED:', out, fs.statSync(out).size + ' bytes');

  await browser.send('Target.closeTarget', { targetId });
  process.exit(0);
})().catch((e) => {
  console.error('失败:', e.message);
  process.exit(1);
});
