#!/usr/bin/env node
'use strict';
/** 设置管理密码：node tools/set-password.js '新密码'  （写入 config.json 的 scrypt 散列） */
const configLib = require('../lib/config');
const { hashPassword } = require('../lib/auth');

const pw = process.argv[2];
if (!pw || pw.length < 8) {
  console.error('用法：node tools/set-password.js <至少8位的密码>');
  process.exit(1);
}
const cfg = configLib.load();
cfg.admin.passwordHash = hashPassword(pw);
configLib.save(cfg);
console.log('已更新管理密码散列 → config.json');
