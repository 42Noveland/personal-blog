'use strict';
/**
 * utils.js — 通用工具（零依赖）
 */

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** HTML 转义。顺带剔除控制字符（含 markdown 解析器内部使用的 \u0000/\u0001 占位符），
 *  防止外部输入伪造内部 token。 */
function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

/** 属性值转义（在 escapeHtml 基础上再多挡一层） */
function escapeAttr(s) {
  return escapeHtml(s).replace(/`/g, '&#96;');
}

/** 生成 URL slug：保留中日韩字符与字母数字，其余转 '-' */
function slugify(s) {
  return String(s == null ? '' : s)
    .trim()
    .toLowerCase()
    .replace(/[\s\u3000]+/g, '-')
    .replace(/[^\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{L}\p{N}._~-]+/gu, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 80) || 'untitled';
}

/** 生成不与 taken 冲突的 slug */
function uniqSlug(base, taken) {
  const set = taken instanceof Set ? taken : new Set(taken || []);
  let s = base, i = 2;
  while (set.has(s)) s = `${base}-${i++}`;
  return s;
}

/** 日期格式化：YYYY-MM-DD / YYYY-MM-DD HH:mm 等简易模板 */
function formatDate(input, fmt = 'YYYY-MM-DD') {
  const d = input instanceof Date ? input : new Date(input);
  if (isNaN(d.getTime())) return '';
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return fmt
    .replace(/YYYY/g, d.getFullYear())
    .replace(/MM/g, p(d.getMonth() + 1))
    .replace(/DD/g, p(d.getDate()))
    .replace(/HH/g, p(d.getHours()))
    .replace(/mm/g, p(d.getMinutes()))
    .replace(/ss/g, p(d.getSeconds()));
}

/** 宽松日期解析：'2026-09-22' / '2026/9/22 10:30' / ISO / 时间戳 */
function parseDate(v) {
  if (!v) return null;
  if (v instanceof Date) return v;
  const s = String(v).trim();
  if (/^\d{10,13}$/.test(s)) return new Date(Number(s.length === 10 ? s * 1000 : s));
  const m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (m) {
    return new Date(
      Number(m[1]), Number(m[2]) - 1, Number(m[3]),
      Number(m[4] || 0), Number(m[5] || 0), Number(m[6] || 0)
    );
  }
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

/** 极简 YAML frontmatter 解析（仅支持 key: value 与 key: [a, b] / - 列表） */
function parseFrontmatter(raw) {
  const text = String(raw).replace(/^\uFEFF/, '');
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { data: {}, content: text };
  const data = {};
  let key = null;
  for (const line of m[1].split(/\r?\n/)) {
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const kv = line.match(/^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/);
    if (kv) {
      key = kv[1];
      let val = kv[2].trim();
      if (/^\[.*\]$/.test(val)) {
        val = val.slice(1, -1).split(',').map((x) => unquote(x.trim())).filter(Boolean);
      } else if (val === '') {
        val = [];
      } else {
        val = unquote(val);
      }
      data[key] = val;
    } else {
      const li = line.match(/^\s*-\s+(.*)$/);
      if (li && key) {
        if (!Array.isArray(data[key])) data[key] = data[key] ? [data[key]] : [];
        data[key].push(unquote(li[1].trim()));
      }
    }
  }
  return { data, content: text.slice(m[0].length) };
}

function unquote(s) {
  let v = String(s);
  if (/^"(?:[^"\\]|\\.)*"$/.test(v)) {
    try { return JSON.parse(v); } catch (_) { return v.slice(1, -1); }
  }
  if (/^'(?:[^']|'')*'$/.test(v)) return v.slice(1, -1).replace(/''/g, "'");
  if (/^(true|yes|on)$/i.test(v)) return true;
  if (/^(false|no|off)$/i.test(v)) return false;
  if (/^(null|~)$/i.test(v)) return null;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  return v;
}

function toYamlString(v) {
  if (Array.isArray(v)) return `[${v.map((x) => toYamlString(x)).join(', ')}]`;
  if (typeof v === 'boolean' || typeof v === 'number') return String(v);
  const s = String(v == null ? '' : v);
  return /[:#\[\]{}",'\n]|^\s|\s$/.test(s) ? JSON.stringify(s) : s;
}

function buildFrontmatter(data, content) {
  const lines = ['---'];
  for (const [k, v] of Object.entries(data)) {
    if (v === undefined || v === null || v === '') continue;
    if (Array.isArray(v) && v.length === 0) continue;
    lines.push(`${k}: ${toYamlString(v)}`);
  }
  lines.push('---', '');
  return lines.join('\n') + String(content || '').replace(/^\s*\n/, '');
}

/** 中英混排字数/阅读时长估算（中文 400 字/分，英文 220 词/分） */
function countWords(text) {
  const s = String(text || '');
  const cjk = (s.match(/[\u3400-\u9FFF\uF900-\uFAFF\u3040-\u30FF]/g) || []).length;
  const words = (s.replace(/[\u3400-\u9FFF\uF900-\uFAFF\u3040-\u30FF]/g, ' ').match(/[A-Za-z0-9_'-]+/g) || []).length;
  return { cjk, words, total: cjk + words };
}

function readingMinutes(text) {
  const { cjk, words } = countWords(text);
  return Math.max(1, Math.round(cjk / 400 + words / 220));
}

/** 从 markdown 提取纯文本摘要 */
function plainText(md, limit = 160) {
  let s = String(md || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/[*_`~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const { total } = countWords(s);
  if (total <= limit) return s;
  // 按字符粗切，保证中文也大致齐整
  return s.slice(0, Math.max(limit, Math.round(limit * 1.2))) + '…';
}

function truncate(s, n) {
  const str = String(s || '');
  return str.length <= n ? str : str.slice(0, n) + '…';
}

/** 常量时间字符串比较 */
function safeEqual(a, b) {
  const crypto = require('crypto');
  const ba = Buffer.from(String(a || ''), 'utf8');
  const bb = Buffer.from(String(b || ''), 'utf8');
  if (ba.length !== bb.length) {
    crypto.timingSafeEqual(ba, ba);
    return false;
  }
  return crypto.timingSafeEqual(ba, bb);
}

function randomToken(bytes = 32) {
  return require('crypto').randomBytes(bytes).toString('base64url');
}

/** 内网/代理场景下取真实 IP */
function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return String(fwd).split(',')[0].trim();
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

function deepMerge(base, over) {
  if (Array.isArray(base) || Array.isArray(over)) return over === undefined ? base : over;
  if (typeof base !== 'object' || base === null) return over === undefined ? base : over;
  if (typeof over !== 'object' || over === null) return base;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = deepMerge(base[k], v);
  return out;
}

/** 简单内存限流器：key -> 时间戳数组 */
class RateLimiter {
  constructor(limit, windowMs) { this.limit = limit; this.windowMs = windowMs; this.hits = new Map(); }
  check(key) {
    const now = Date.now();
    const arr = (this.hits.get(key) || []).filter((t) => now - t < this.windowMs);
    if (arr.length >= this.limit) { this.hits.set(key, arr); return false; }
    arr.push(now);
    this.hits.set(key, arr);
    if (this.hits.size > 5000) this.hits.clear();
    return true;
  }
}

module.exports = {
  escapeHtml, escapeAttr, slugify, uniqSlug, formatDate, parseDate,
  parseFrontmatter, buildFrontmatter, countWords, readingMinutes, plainText,
  truncate, safeEqual, randomToken, clientIp, deepMerge, RateLimiter,
};
