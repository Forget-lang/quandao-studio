import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * check-piece.mjs —— 本线（quandao-studio）的词面机检 + 画面人判派单
 *
 * 两个真源都在本线目录里（2026-09-30 起与 promotion 完全隔离，运行时不再读它）：
 *   平台红线词表 ＝ spec/红线词表.json（抄自 promotion 后独立维护；想比对就跑 scripts/sync-redlines.mjs）
 *   功能能不能讲 ＝ spec/功能真值.json
 *
 * 分层依据（spec/红线词表.json，2026-09-30 核读）：
 *   codeBanned       = 画面层（渲染进视频的可见文本）→ 本片 = 标题 + 字幕
 *   voiceBanned.scanAs = 「本层实际扫描 token = codeBanned ∪ voiceBanned」→ 口播与对外文案按合并表扫
 *   graphicPolicy.internalTermsNotOnScreen = 内部文档与取证记录**允许**写违禁词 → 导演稿不按对外内容判，只作提示
 *   graphicPolicy.enforcement = 「不可辨识」只能人判，须逐帧看并留验收记录
 *   brandDisplay     = 品牌口径（2026-10-08 用户拍板）：全片零提及——口播／顶部固定标题／字幕任一处出现品牌名即硬红
 *
 * 用法：node scripts/check-piece.mjs [--piece <片名>]
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SPEC = path.join(ROOT, 'spec');

const red = JSON.parse(fs.readFileSync(path.join(SPEC, '红线词表.json'), 'utf8'));
const truth = JSON.parse(fs.readFileSync(path.join(SPEC, '功能真值.json'), 'utf8'));

const argv = process.argv.slice(2);
let piece = argv.includes('--piece') ? argv[argv.indexOf('--piece') + 1] : null;
if (!piece) {
  try {
    piece = path.basename(path.dirname(fs.readlinkSync(path.join(ROOT, 'video', 'public', 'images'))));
  } catch {
    console.error('找不到当前片。先跑 node scripts/use-piece.mjs <片名>，或用 --piece 指定。');
    process.exit(2);
  }
}
const DIR = path.join(ROOT, 'pieces', piece);
if (!fs.existsSync(DIR)) { console.error(`片目录不存在：${DIR}`); process.exit(2); }

const CODE = red.codeBanned?.tokens || [];
const VOICE = red.voiceBanned?.tokens || [];
const REVIEW = red.outputsReview?.tokens || [];
const MERGED = [...new Set([...CODE, ...VOICE])];   // voiceBanned.note 规定的合并口径

// ---- 上屏与对外内容：硬禁对象 ----
const onScreen = [];   // 会进画面/口播的文本
const external = [];   // 对外发布的文案
const pj = JSON.parse(fs.readFileSync(path.join(DIR, 'project.json'), 'utf8'));
// 顶部标题区全片只展示 pieceTitle（2026-09-30 用户反馈定）；分镜的 title 只是内部信息标签，不上屏，所以不扫。
if (pj.pieceTitle) onScreen.push({ where: '全片固定标题', text: pj.pieceTitle });
for (const s of pj.shots || []) {
  onScreen.push({ where: `镜${s.id} 口播`, text: s.voice || '' });
  (s.captions || []).forEach((c, i) => onScreen.push({ where: `镜${s.id} 字幕${i + 1}`, text: c }));
}
if (pj.piece) onScreen.push({ where: '片名', text: pj.piece });

/**
 * 按 promotion 的豁免规则切小节：含「自查」的标题行开启豁免区，直到下一个标题为止。
 * （knownBlindSpot／note 原文：自查清单必然逐条复述禁词，不计命中）
 */
function loadMarkdown(file, bucket) {
  const p = path.join(DIR, file);
  if (!fs.existsSync(p)) return;
  let exempt = false;
  fs.readFileSync(p, 'utf8').split('\n').forEach((line, i) => {
    const heading = /^#{1,6}\s/.test(line) || /^【[^】]*】\s*$/u.test(line) || /^\*\*[^*]+\*\*\s*[:：]/u.test(line);
    if (heading) exempt = /自查/u.test(line);
    if (!line.trim()) return;
    bucket.push({ where: `${file}:${i + 1}`, text: line.trim(), exempt });
  });
}
const pub = [];
loadMarkdown('发布文案.md', pub);
for (const x of pub) if (!x.exempt) external.push({ where: x.where, text: x.text });

// ---- 扫词 ----
const hits = [];
const scan = (tokens, verdict, items) => {
  for (const t of items) for (const tok of tokens) {
    if (tok && t.text.includes(tok)) hits.push({ verdict, tok, where: t.where, line: t.text.slice(0, 130) });
  }
};
scan(MERGED, 'HIT', onScreen);
scan(MERGED, 'HIT', external);
scan(REVIEW, 'REVIEW', onScreen.concat(external));

// ---- 画面人判派单：机检抓不到的，至少告诉人去看哪几张图 ----
// 只盯「动作」词，不盯机制词——「核销」进口播完全正常，不是画面禁项。
// 只看描述图的行（导演稿里的 `| f1-1 |` 表格行与【画面内容】段），不扫口播行。
const VISUAL_TRIGGERS = ['对准', '扫码', '扫一扫', '二维码', '立牌', '码图'];
const IMAGE_LINE = /^\|\s*f\d+-\d+\s*\|/u;
const guide = [];
const gp = path.join(DIR, '导演稿.md');
if (fs.existsSync(gp)) {
  fs.readFileSync(gp, 'utf8').split('\n').forEach((line, i) => {
    if (!IMAGE_LINE.test(line)) return;
    const hit = VISUAL_TRIGGERS.filter((w) => line.includes(w));
    if (hit.length) guide.push({ line: i + 1, words: hit, text: line.trim().slice(0, 120) });
  });
}

// ---- 功能越界提示：从本线 spec/功能真值.json 的 mustNotClaim 抽触发词 ----
const claims = [];
const trig = [];
for (const c of truth.mustNotClaim || []) {
  const key = c.claim || '';
  for (const w of String(key).replace(/[·／/、，,。]/g, ' ').split(/\s+/).filter((x) => x.length >= 2))
    trig.push({ w, key, why: c.why });
}
for (const t of onScreen.concat(external)) for (const g of trig) {
  if (t.text.includes(g.w)) claims.push({ word: g.w, ban: g.key, why: g.why, where: t.where });
}

const uniq = (a, k) => [...new Map(a.map((x) => [k(x), x])).values()];
const H = uniq(hits.filter((x) => x.verdict === 'HIT'), (x) => x.tok + x.where);

// 品牌口径门槛（判据本体＝spec/红线词表.json 的 brandDisplay，2026-10-08 用户拍板）：
//   全片零提及：全片固定标题、任一镜口播、任一条字幕，任一处出现品牌名即硬红。
//   品牌名本体也取自词表，脚本里不另写一份，改口径只改 spec。
const brandName = red.brandDisplay?.name || null;
const brandProblems = [];
if (brandName) {
  const screenText = [pj.pieceTitle || '', ...(pj.shots || []).flatMap((s) => s.captions || [])].join('\n');
  if (screenText.includes(brandName)) brandProblems.push(`画面层（顶部固定标题／字幕）出现品牌名「${brandName}」——全片零提及`);
  const voices = (pj.shots || []).map((s) => s.voice || '').join('\n');
  const n = voices.split(brandName).length - 1;
  if (n > 0) brandProblems.push(`口播出现品牌名「${brandName}」${n} 次——全片零提及，一处都不许有`);
}

// 标题硬门槛（2026-10-08 放宽，口径本体在 mac-director §八）：必须有全片固定标题，且不超过 16 字。
const titleProblems = [];
if (!pj.pieceTitle) titleProblems.push('project.json 缺 pieceTitle（全片固定标题）');
else if (pj.pieceTitle.length > 16) titleProblems.push(`pieceTitle「${pj.pieceTitle}」共 ${pj.pieceTitle.length} 字，超过 16 字硬上限`);
const R = uniq(hits.filter((x) => x.verdict === 'REVIEW'), (x) => x.tok + x.where);
const C = uniq(claims, (x) => x.word + x.where);

console.log(`词表版本 ${red._meta.version}（画面 ${red.codeBanned.tokens.length}／口播 ${red.voiceBanned.tokens.length}／合并 ${MERGED.length}）· 本线自己的一份，比对用 sync-redlines.mjs`);
console.log(`扫描对象：${piece}`);
console.log(`  上屏与对外文本 ${onScreen.length + external.length} 条 · 合并词表 ${MERGED.length} 个 · 提示层 ${REVIEW.length} 个 · 品牌口径 ${brandName ? `「${brandName}」全片零提及` : '未登记'}\n`);

console.log(`── ① 词面硬禁与标题门槛（${H.length + titleProblems.length + brandProblems.length}）＝必须改`);
H.forEach((x) => console.log(`   [${x.tok}] ${x.where}\n        ${x.line}`));
titleProblems.forEach((x) => console.log(`   [标题门槛] ${x}`));
brandProblems.forEach((x) => console.log(`   [品牌口径] ${x}`));
if (!H.length && !titleProblems.length && !brandProblems.length) console.log('   无');
console.log();

console.log(`── ② 需人工确认（${R.length}）`);
R.forEach((x) => console.log(`   [${x.tok}] ${x.where}`));
if (!R.length) console.log('   无');
console.log();

console.log(`── ③ 功能越界提示（${C.length}）＝不是判定，要人看一眼是否讲了不存在的功能`);
C.forEach((x) => console.log(`   [${x.word}] ${x.where}  ← 禁令：${x.ban}`));
if (!C.length) console.log('   无');
console.log();

console.log(`── ④ 画面人判派单（${guide.length} 处）＝机检抓不到，必须逐帧看`);
console.log('   判据：不得演示「扫码动作」（手机对准码／点扫码按钮／扫码成功动效），与码是否可辨识无关；');
console.log('        码图形只能不可辨识地当场景物料，且要在验收记录写明为何不可扫。');
guide.forEach((g) => console.log(`   导演稿.md:${g.line}  触发词[${g.words.join('、')}]  ${g.text}`));
if (!guide.length) console.log('   无');
console.log();

if (H.length || titleProblems.length || brandProblems.length) {
  console.error(`结论：不通过。词面硬禁 ${H.length} 处、标题门槛 ${titleProblems.length} 处、品牌口径 ${brandProblems.length} 处。`);
  process.exit(1);
}
if (guide.length) console.log(`结论：词面无硬禁。但 ④ 的 ${guide.length} 处必须逐帧人判并补验收记录，未判完不算过。`);
else console.log('结论：词面无硬禁，无画面待判项。');
