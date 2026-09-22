'use strict';
/**
 * auth.js — 管理员认证：scrypt 口令散列 + SQLite 会话 + HttpOnly Cookie
 */
const crypto = require('crypto');
const { safeEqual, randomToken, clientIp } = require('./utils');

const COOKIE_NAME = 'blog_sid';
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(String(password), salt, SCRYPT.keylen, {
    N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: 64 * 1024 * 1024,
  });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

function verifyPassword(password, stored) {
  try {
    const [algo, N, r, p, saltB64, keyB64] = String(stored).split('$');
    if (algo !== 'scrypt') return false;
    const salt = Buffer.from(saltB64, 'base64');
    const expected = Buffer.from(keyB64, 'base64');
    const key = crypto.scryptSync(String(password), salt, expected.length, {
      N: Number(N), r: Number(r), p: Number(p), maxmem: 64 * 1024 * 1024,
    });
    return crypto.timingSafeEqual(key, expected);
  } catch (_) {
    return false;
  }
}

/** 登录防爆破：只统计失败；成功即清零；超限锁定一段时间 */
class LoginGuard {
  constructor({ maxFails = 5, windowMs = 600000, lockMs = 600000 } = {}) {
    this.maxFails = maxFails;
    this.windowMs = windowMs;
    this.lockMs = lockMs;
    this.records = new Map();
  }
  /** 返回剩余锁定秒数，0 表示未锁定 */
  lockedFor(ip) {
    const r = this.records.get(ip);
    if (!r || !r.lockedUntil) return 0;
    const left = r.lockedUntil - Date.now();
    return left > 0 ? Math.ceil(left / 1000) : 0;
  }
  fail(ip) {
    const now = Date.now();
    const r = this.records.get(ip) || { fails: [], lockedUntil: 0 };
    r.fails = (r.fails || []).filter((t) => now - t < this.windowMs);
    r.fails.push(now);
    if (r.fails.length >= this.maxFails) {
      r.lockedUntil = now + this.lockMs;
      r.fails = [];
    }
    this.records.set(ip, r);
    if (this.records.size > 5000) this.records.clear();
    return this.lockedFor(ip);
  }
  succeed(ip) {
    this.records.delete(ip);
  }
}

class Auth {
  constructor(store, config) {
    this.store = store;
    this.config = config;
    this.guard = new LoginGuard({
      maxFails: config.admin.loginMaxFails,
      windowMs: config.admin.loginLockMinutes * 60000,
      lockMs: config.admin.loginLockMinutes * 60000,
    });
  }

  /** 登录失败节流：超过阈值锁定 */
  checkLoginAllowed(ip) {
    return this.guard.lockedFor(ip) === 0;
  }

  login(password, { ip, ua }) {
    const cfg = this.config;
    const lockedFor = this.guard.lockedFor(ip);
    if (lockedFor) {
      const err = new Error(`尝试次数过多，请 ${Math.max(1, Math.ceil(lockedFor / 60))} 分钟后再试`);
      err.status = 429;
      throw err;
    }
    if (!cfg.admin.passwordHash || !verifyPassword(password, cfg.admin.passwordHash)) {
      this.guard.fail(ip);
      const err = new Error('密码不正确');
      err.status = 401;
      throw err;
    }
    this.guard.succeed(ip);
    const token = randomToken(32);
    const exp = this.store.createSession(token, cfg.admin.user, ip, ua, cfg.admin.sessionDays);
    return { token, expires: exp };
  }

  logout(req, res) {
    const token = readCookie(req, COOKIE_NAME);
    if (token) this.store.deleteSession(token);
    clearCookie(res, this.config);
  }

  /** 返回会话对象或 null */
  session(req) {
    const token = readCookie(req, COOKIE_NAME);
    if (!token) return null;
    return this.store.getSession(token);
  }

  isAdmin(req) {
    return !!this.session(req);
  }

  /** 生成 Set-Cookie 头 */
  setSessionCookie(res, token) {
    const parts = [
      `${COOKIE_NAME}=${token}`,
      'Path=' + (this.config.server.basePath || '/'),
      'HttpOnly',
      'SameSite=Lax',
      `Max-Age=${this.config.admin.sessionDays * 86400}`,
    ];
    if (this.config.server.secureCookies) parts.push('Secure');
    res.setHeader('Set-Cookie', parts.join('; '));
  }
}

function readCookie(req, name) {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const part of String(raw).split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

function clearCookie(res, config) {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Path=${config.server.basePath || '/'}; HttpOnly; SameSite=Lax; Max-Age=0`);
}

/** 写操作的同源校验（CSRF 防护）：Origin/Referer 的 host 必须与 Host 一致 */
function sameOrigin(req) {
  const host = req.headers.host;
  if (!host) return false;
  const check = (val, base) => {
    if (!val) return true; // 无头请求（curl）时交由调用方决定
    try {
      const u = new URL(val, base);
      return u.host === host;
    } catch (_) { return false; }
  };
  const origin = req.headers.origin;
  const referer = req.headers.referer;
  if (origin && !check(origin, `http://${host}`)) return false;
  if (referer && !check(referer, `http://${host}`)) return false;
  return true;
}

module.exports = { Auth, LoginGuard, hashPassword, verifyPassword, readCookie, sameOrigin, COOKIE_NAME };
