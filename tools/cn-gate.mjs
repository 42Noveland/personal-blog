#!/usr/bin/env node
/**
 * cn-gate.mjs — 中文文章「发布门禁」：发布前扫一遍中文 AI 腔、节奏与人称痕迹，给出分数与逐条证据。
 *
 * 用法：
 *   node tools/cn-gate.mjs content/posts/xxx.md              # 出报告（不拦）
 *   node tools/cn-gate.mjs content/posts/xxx.md --gate       # 门禁模式：不达标 → 退出码 1
 *   node tools/cn-gate.mjs content/posts/xxx.md --json       # 机器可读
 *   node tools/cn-gate.mjs content/posts/xxx.md --min 70     # 自定义分数线（默认 60）
 *
 * 设计取向：只做「确定性的、可复核的」检查——不调模型、不联网、零依赖；
 * 结论是「这段话踩了哪几条已知的机器腔」，不是「这是不是 AI 写的」。
 * 阈值按一篇人类手写的中文技术博客（同题材）实测校准过：那份人类样本不该被扣分，
 * 而条目化的 AI 笔记应当明显低分——校准前的版本恰好把两者判反了。
 * 规则来源：维基百科《Signs of AI writing》的中文适配 + 本仓库往期类人化经验。
 */
import fs from 'node:fs';

// ---------- 参数 ----------
const args = process.argv.slice(2);
const file = args.find(a => !a.startsWith('--'));
const GATE = args.includes('--gate');
const JSON_OUT = args.includes('--json');
const minIdx = args.indexOf('--min');
const MIN_SCORE = minIdx >= 0 ? Number(args[minIdx + 1]) : 75;
if (!file) {
  console.error('用法: node tools/cn-gate.mjs <文章.md> [--gate] [--json] [--min 60]');
  process.exit(2);
}

const raw = fs.readFileSync(file, 'utf8');

// ---------- 抽取正文（散文） ----------
const lines = raw.split(/\r?\n/);
let inFence = false, inFigure = false, inFrontmatter = false, fmDone = false;
const proseLines = [];       // {ln, text}
const stats = { headings: 0, tables: 0, fences: 0, figures: 0, listItems: 0 };

lines.forEach((line, i) => {
  const t = line.trim();
  if (i === 0 && t === '---') { inFrontmatter = true; return; }
  if (inFrontmatter) { if (t === '---') { inFrontmatter = false; fmDone = true; } return; }
  if (/^```/.test(t)) { inFence = !inFence; if (inFence) stats.fences++; return; }
  if (inFence) return;
  if (/^<figure/.test(t)) { inFigure = true; }
  if (inFigure) { if (/<\/figure>/.test(t)) inFigure = false; stats.figures++; return; }
  if (/^#{1,6}\s/.test(t)) { stats.headings++; return; }
  if (/^\|/.test(t)) { stats.tables++; return; }
  if (/^([-*+]|\d+[.)])\s+/.test(t)) { stats.listItems++; }
  if (!t) return;
  let s = t
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<\/?[a-zA-Z][^>]*>/g, '')
    .replace(/^([-*+]|\d+[.)])\s+/, '')
    .replace(/\*\*|__/g, '')
    .replace(/`/g, '')
    .replace(/&quot;/g, '"').replace(/&amp;/g, '&');
  if (s.trim()) proseLines.push({ ln: i + 1, text: s.trim() });
});

const prose = proseLines.map(p => p.text).join('\n');
const cjk = (prose.match(/[\u4e00-\u9fff]/g) || []).length;
const per1k = n => (n / Math.max(cjk, 1)) * 1000;

// ---------- 句子切分 ----------
const sentences = [];
for (const { ln, text } of proseLines) {
  const parts = text.split(/(?<=[。！？!?])/).map(s => s.trim()).filter(Boolean);
  for (const s of parts) sentences.push({ ln, text: s });
}
const lens = sentences.map(s => s.text.length).sort((a, b) => a - b);
const mean = lens.reduce((a, b) => a + b, 0) / Math.max(lens.length, 1);
const std = Math.sqrt(lens.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(lens.length, 1));
const cv = mean ? std / mean : 0;
const pct = f => lens[Math.min(lens.length - 1, Math.floor(f * lens.length))] ?? 0;

// ---------- 指标 ----------
const m = {
  汉字数: cjk,
  句数: sentences.length,
  句长均值: +mean.toFixed(1),
  句长中位: pct(0.5),
  句长CV: +cv.toFixed(2),
  短句占比: +(lens.filter(x => x < 15).length / Math.max(lens.length, 1)).toFixed(2),
  长句占比: +(lens.filter(x => x > 80).length / Math.max(lens.length, 1)).toFixed(2),
  单句段占比: +(proseLines.filter(p => p.text.split(/(?<=[。！？!?])/).filter(Boolean).length <= 1).length /
    Math.max(proseLines.length, 1)).toFixed(2),
  第一人称每万字: +per1k((prose.match(/我(?!们)/g) || []).length) * 10,
  第二人称每万字: +per1k((prose.match(/[你您]/g) || []).length) * 10,
  冒号每千字: +per1k((prose.match(/[：:]/g) || []).length).toFixed(2),
  破折号每千字: +per1k((prose.match(/——|—/g) || []).length).toFixed(2),
  粗体每千字: +per1k((raw.match(/\*\*/g) || []).length / 2).toFixed(2),
  列表项: stats.listItems,
  表格: stats.tables,
  代码块: stats.fences,
};

// ---------- 规则 ----------
const findings = []; // {sev, rule, ln, quote, hint}
const add = (sev, rule, hit, hint) => findings.push({ sev, rule, ...hit, hint });

// P0/P1 · 翻案句式（强式直接拦，弱式提醒）
const flipStrong = /(不是[^。！？]{0,30}而是|并非[^。！？]{0,30}而是|与其说[^。！？]{0,30}不如说)/g;
const flipWeak = /不是[^。！？]{0,20}，是[^。！？]{0,20}/g;
for (const s of sentences) {
  const strong = s.text.match(flipStrong);
  const weak = !strong && s.text.match(flipWeak);
  if (strong) add('P0', '翻案句（不是…而是…）', { ln: s.ln, quote: s.text.slice(0, 60) }, '直接陈述结论，删掉"先立误解再推翻"的姿势');
  else if (weak) add('P1', '翻案句（弱式：不是…，是…）', { ln: s.ln, quote: s.text.slice(0, 60) }, '把"不是 A，是 B"改成一个正面陈述');
}

// P0 · 套话黑话（出现 2 次以上才拦）
const cliches = ['值得注意', '不容忽视', '至关重要', '综上所述', '总而言之', '与此同时', '由此可见', '毋庸置疑',
  '旨在', '赋能', '助力', '彰显', '深刻体现', '生动写照', '在当今', '随着科技的发展', '随着技术的发展', '不可或缺', '举足轻重'];
let clicheCount = 0; const clicheHits = [];
for (const w of cliches) {
  const n = (prose.match(new RegExp(w, 'g')) || []).length;
  if (n) { clicheCount += n; clicheHits.push(`${w}×${n}`); }
}
if (clicheCount) {
  add(clicheCount >= 2 ? 'P0' : 'P1', '套话黑话', { ln: 0, quote: clicheHits.join('、') }, '换成具体动作、数字或直接删掉');
}

// P2 · 机械序号段首（中文技术文里很常见，单独出现不算病；≥3 处才提一句）
const seqRe = /^(首先|其次|再次|最后|第一|第二|第三|其一|其二|其三)[，,、：:]?/;
const seqHits = proseLines.filter(p => seqRe.test(p.text));
if (seqHits.length >= 3) {
  add('P2', '机械序号开头偏多', { ln: seqHits[0].ln, quote: `${seqHits.length} 处，如「${seqHits[0].text.slice(0, 26)}」` }, '段首序号偶尔用没事，成串出现就显得像模板');
}

// P1 · 冒号/破折号/粗体密度（阈值按人类参照样本校准：人类技术文冒号 ~13/千 属正常）
if (m.冒号每千字 > 20) add('P1', '冒号密度偏高', { ln: 0, quote: `每千字 ${m.冒号每千字} 个` }, '正文里的"标签：说明"结构改回句子');
if (m.破折号每千字 > 1.5) add('P1', '破折号密度偏高', { ln: 0, quote: `每千字 ${m.破折号每千字} 个` }, '用逗号、句号或括号代替');
if (m.粗体每千字 > 1.5) add('P1', '粗体当装饰', { ln: 0, quote: `每千字 ${m.粗体每千字} 组` }, '只保留真正需要强调的少数粗体');

// P1 · 节奏（句长均一 / 缺短句）
if (m.句长CV < 0.6) add('P1', '句长过于均一', { ln: 0, quote: `CV=${m.句长CV}` }, '刻意插入几个短句，或把长句拆开');
if (m.短句占比 < 0.08) add('P1', '几乎没有短句', { ln: 0, quote: `短句占比 ${(m.短句占比 * 100).toFixed(0)}%` }, '至少让十分之一的句子短下来');

// P1 · 清单体（人类参照也有单句段，故阈值放到 80%）
if (m.单句段占比 > 0.8) add('P1', '清单体（单句段过多）', { ln: 0, quote: `单句段 ${(m.单句段占比 * 100).toFixed(0)}%` }, '把并列的短段合成一段，或让段落有起承转合');

// P1/P2 · 人称痕迹
const persona = m.第一人称每万字 + m.第二人称每万字;
if (persona < 5) add('P1', '人称痕迹缺失', { ln: 0, quote: `我+你 合计 ${persona.toFixed(1)}/万字` }, '加一两句"我"的经历或"你"会遇到的场景');
else if (m.第二人称每万字 === 0) add('P2', '没有跟读者说话', { ln: 0, quote: `第二人称 0/万字` }, '顺手把一两处改成"你会看到/你手上的板子"，读者感立刻不一样');

// P1 · 结尾口号化
const lastParas = proseLines.slice(-3);
const sloganRe = /(让我们|希望大?家|愿每|共勉|记住这|一起加油|未来可期|值得期待)/;
for (const p of lastParas) {
  if (sloganRe.test(p.text)) add('P1', '结尾口号化', { ln: p.ln, quote: p.text.slice(0, 50) }, '用一件具体的事收尾，别升价值');
}

// P2 · 连续同头句
for (let i = 0; i + 2 < sentences.length; i++) {
  const a = sentences[i].text.slice(0, 3), b = sentences[i + 1].text.slice(0, 3), c = sentences[i + 2].text.slice(0, 3);
  if (a === b && b === c && a.length === 3) {
    add('P2', '连续同头句', { ln: sentences[i].ln, quote: `${a}… ×3 连用` }, '换掉其中一句的开头');
    break;
  }
}

// P2 · 对称三点式
const triad = prose.match(/[^，。；：]{2,8}、[^，。；：]{2,8}、[^，。；：]{2,8}(?=[和与]?[，。])/g) || [];
if (triad.length / Math.max(cjk / 1000, 1) > 1.2) {
  add('P2', '对称三点式偏多', { ln: 0, quote: `${triad.length} 处（每千字 ${(triad.length / Math.max(cjk / 1000, 1)).toFixed(1)}）` }, '按内容需要决定条目数，别一律凑三个');
}

// INFO · 4-gram 高频复读（技术文里专有名词天然复读，仅供参考、不扣分）
const grams = {};
for (let i = 0; i + 4 <= prose.length; i++) {
  const g = prose.slice(i, i + 4);
  if (/^[\u4e00-\u9fff]{4}$/.test(g)) grams[g] = (grams[g] || 0) + 1;
}
const topGrams = Object.entries(grams).sort((a, b) => b[1] - a[1]).filter(([, n]) => n >= 5).slice(0, 3);
if (topGrams.length) {
  add('INFO', '高频复读（参考）', { ln: 0, quote: topGrams.map(([g, n]) => `「${g}」×${n}`).join('、') }, '若是专有名词可忽略；若是口头禅，换掉一两处');
}

// ---------- 打分 ----------
const W = { P0: 12, P1: 6, P2: 3, INFO: 0 };
let score = 100;
for (const f of findings) score -= W[f.sev];
score = Math.max(0, score);
const p0 = findings.filter(f => f.sev === 'P0').length;
const pass = p0 === 0 && score >= MIN_SCORE;

// ---------- 输出 ----------
if (JSON_OUT) {
  console.log(JSON.stringify({ file, score, pass, min: MIN_SCORE, metrics: m, findings }, null, 1));
} else {
  console.log(`\n中文发布门禁 · ${file}`);
  console.log('─'.repeat(62));
  console.log(`汉字 ${m.汉字数} ｜ 句 ${m.句数} ｜ 句长 均 ${m.句长均值}/中位 ${m.句长中位} ｜ CV ${m.句长CV} ｜ 短句 ${(m.短句占比 * 100).toFixed(0)}%`);
  console.log(`单句段 ${(m.单句段占比 * 100).toFixed(0)}% ｜ 我 ${m.第一人称每万字.toFixed(1)}/万 ｜ 你 ${m.第二人称每万字.toFixed(1)}/万 ｜ 冒号 ${m.冒号每千字}/千 ｜ 破折号 ${m.破折号每千字}/千 ｜ 粗体 ${m.粗体每千字}/千`);
  console.log(`结构：表 ${m.表格} ｜ 列表项 ${m.列表项} ｜ 代码块 ${m.代码块}`);
  if (!findings.length) console.log('\n没有命中任何已知的机器腔规则。');
  for (const f of findings) {
    const at = f.ln ? `第 ${f.ln} 行` : '全文';
    console.log(`\n[${f.sev}] ${f.rule}（${at}）`);
    console.log(`   证据：${f.quote}`);
    console.log(`   改法：${f.hint}`);
  }
  console.log('\n' + '─'.repeat(62));
  console.log(`类人度评分：${score}/100（P0 ${p0} 处）→ ${pass ? '✅ 通过' : '❌ 不通过'}（线 ${MIN_SCORE}）`);
  if (!pass && !GATE) console.log('（提示：加 --gate 时本文件会让发布流程退出码非 0）');
}

if (GATE && !pass) process.exit(1);
