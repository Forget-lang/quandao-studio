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
 *   brandDisplay     = 品牌口径（spec 唯一真源）：画内相关功能场景可轻度露出；口播／固定标题／字幕／发布文案中出现即硬红
 *
 * 用法：node scripts/check-piece.mjs [--piece <片名>]
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SPEC = path.join(ROOT, 'spec');

const red = JSON.parse(fs.readFileSync(path.join(SPEC, '红线词表.json'), 'utf8'));
const truth = JSON.parse(fs.readFileSync(path.join(SPEC, '功能真值.json'), 'utf8'));

const argv = process.argv.slice(2);
const CODE = red.codeBanned?.tokens || [];
const VOICE = red.voiceBanned?.tokens || [];
const REVIEW = red.outputsReview?.tokens || [];
const MERGED = [...new Set([...CODE, ...VOICE])];   // voiceBanned.note 规定的合并口径

function scanImagePromptRows(markdown, tokens) {
  const lines = String(markdown || '').split(/\r?\n/u);
  const out = [];
  const heading = /^###\s+【AI画面提示词(\d+)】/u;
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(heading);
    if (!match) continue;
    let end = i + 1;
    while (end < lines.length && !/^#{1,6}\s/u.test(lines[end])) end++;
    const body = lines.slice(i + 1, end).join('\n');
    const found = [...new Set(tokens.filter((token) => token && body.includes(token)))];
    if (found.length) out.push({line:i+1,image:Number(match[1]),tokens:found,text:(lines[i]+'\n'+body).trim().slice(0,180)});
    i = end - 1;
  }
  return out;
}

if (argv.includes('--self-test')) {
  const sample = [
    '### 【AI画面提示词1】',
    '画面限制：不要出现微信、小程序码；仅作负面约束提醒',
    '### 【AI画面提示词2】',
    '顾客在柜台与店员交谈，手里拿着普通优惠券',
    '## 普通说明',
    '普通说明文字含微信，但不是图片提示词正文。',
  ].join('\n');
  const hits = scanImagePromptRows(sample, MERGED);
  const actionHits = scanImagePromptRows(sample, ['小程序码']);
  const pass = hits.length === 1 && hits[0].image === 1 &&
    hits[0].tokens.includes('微信') && hits[0].tokens.includes('小程序码') &&
    actionHits.length === 1 &&
    scanImagePromptRows(sample.replace('不要出现微信、小程序码；', ''), ['小程序码']).length === 0;
  console.log(pass ? '自检通过：正式 AI 画面提示词章节会进入提示层；普通说明文字不误扫。' : '自检失败：正式 AI 画面提示词章节扫描不符合预期。');
  process.exit(pass ? 0 : 1);
}

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
if (!fs.existsSync(DIR)) { console.error('片目录不存在：' + DIR); process.exit(2); }

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
const gp = path.join(DIR, '导演稿.md');
let directorDraft = '';
if (fs.existsSync(gp)) directorDraft = fs.readFileSync(gp, 'utf8');
// 正式输出格式是「【AI画面提示词N】」标题与其正文；这里只派人工复核，不以词面命中直接定违规。
const guide = scanImagePromptRows(directorDraft, VISUAL_TRIGGERS)
  .map((x) => ({ line:x.line, image:x.image, words:x.tokens, text:x.text }));
const promptGuide = scanImagePromptRows(directorDraft, MERGED);

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

// 品牌口径门槛（判据本体＝spec/红线词表.json 的 brandDisplay）：
//   固定标题、口播、底部字幕与发布文案不得出现品牌名；相关功能画面内的低调露出由最终图片人判。
//   画面像素无法靠本机词面脚本可靠验字与判断视觉层级，品牌名本体从词表读取，不另写一份。
const brandName = red.brandDisplay?.name || null;
const brandProblems = [];
if (brandName) {
  const screenText = [pj.pieceTitle || '', ...(pj.shots || []).flatMap((s) => s.captions || [])].join('\n');
  if (screenText.includes(brandName)) brandProblems.push(`画面层（顶部固定标题／底部字幕）出现品牌名「${brandName}」——品牌仅可按规范在相关功能画面内轻度露出`);
  const voices = (pj.shots || []).map((s) => s.voice || '').join('\n');
  const n = voices.split(brandName).length - 1;
  if (n > 0) brandProblems.push(`口播出现品牌名「${brandName}」${n} 次——口播不得出现品牌`);
  const publishedText = external.map((x) => x.text).join('\n');
  if (publishedText.includes(brandName)) brandProblems.push(`发布文案或话题标签出现品牌名「${brandName}」——对外发布文本不得出现品牌`);
}

// 标题硬门槛（口径本体在 mac-director §八）：必须有全片固定标题、不超过 16 字，且显式换行最多两行。
const titleProblems = [];
if (!pj.pieceTitle) titleProblems.push('project.json 缺 pieceTitle（全片固定标题）');
else {
  if (pj.pieceTitle.length > 16) titleProblems.push(`pieceTitle「${pj.pieceTitle}」共 ${pj.pieceTitle.length} 字，超过 16 字硬上限`);
  if (pj.pieceTitle.split(/\r?\n/u).length > 2) titleProblems.push('pieceTitle 显式换行超过 2 行；全片固定标题最多两行');
}
const R = uniq(hits.filter((x) => x.verdict === 'REVIEW'), (x) => x.tok + x.where);
const C = uniq(claims, (x) => x.word + x.where);

console.log(`词表版本 ${red._meta.version}（画面 ${red.codeBanned.tokens.length}／口播 ${red.voiceBanned.tokens.length}／合并 ${MERGED.length}）· 本线自己的一份，比对用 sync-redlines.mjs`);
console.log(`扫描对象：${piece}`);
console.log(`  上屏与对外文本 ${onScreen.length + external.length} 条 · 合并词表 ${MERGED.length} 个 · 画面描述提示层 ${promptGuide.length} 行 · 品牌口径 ${brandName ? '相关功能画面可轻度露出；口播/固定标题/字幕/发布文案禁用，画内像素需人判' : '未登记'}\n`);

console.log(`── ① 词面硬禁与标题门槛（${H.length + titleProblems.length + brandProblems.length}）＝必须改`);
H.forEach((x) => console.log(`   [${x.tok}] ${x.where}\n        ${x.line}`));
titleProblems.forEach((x) => console.log(`   [标题门槛] ${x}`));
brandProblems.forEach((x) => console.log(`   [品牌口径] ${x}`));
if (!H.length && !titleProblems.length && !brandProblems.length) console.log('   无');
console.log();

console.log(`── ② 图片提示词／文案需人工确认（${R.length + promptGuide.length}）＝只提示，不进硬红`);
R.forEach((x) => console.log(`   [文案复核：${x.tok}] ${x.where}`));
promptGuide.forEach((x) => console.log(`   [提示层：${x.tokens.join('、')}] 导演稿.md:${x.line}  ${x.text}`));
if (!R.length && !promptGuide.length) console.log('   无');
console.log();

console.log(`── ③ 功能越界提示（${C.length}）＝不是判定，要人看一眼是否讲了不存在的功能`);
C.forEach((x) => console.log(`   [${x.word}] ${x.where}  ← 禁令：${x.ban}`));
if (!C.length) console.log('   无');
console.log();

console.log(`── ④ 图片提示词中的视觉风险派单（${guide.length} 处）＝需结合实际画面判断`);
console.log('   判据：不得演示「扫码动作」（手机对准码／点扫码按钮／扫码成功动效），与码是否可辨识无关；');
console.log('        码图形只能不可辨识地当场景物料，且要在验收记录写明为何不可扫。');
guide.forEach((g) => console.log(`   导演稿.md:${g.line}  触发词[${g.words.join('、')}]  ${g.text}`));
if (!guide.length) console.log('   无');
console.log();

if (H.length || titleProblems.length || brandProblems.length) {
  console.error(`结论：不通过。词面硬禁 ${H.length} 处、标题门槛 ${titleProblems.length} 处、品牌口径 ${brandProblems.length} 处。`);
  process.exit(1);
}
const manualTasks = R.length + promptGuide.length + guide.length;
const manualReviewConfirmed = argv.includes('--confirm-manual-review');
if (manualTasks && !manualReviewConfirmed) {
  console.log(`结论：硬性机检未发现拦截项，但仍有 ${manualTasks} 项人工复核任务；退出码 2 表示待人工确认，不可直接发布。`);
  console.log('逐图完成人工检查并将结论写入本片导演稿验收记录后，才可带 --confirm-manual-review 重新运行。');
  process.exit(2);
}
if (manualTasks && manualReviewConfirmed) {
  console.log(`人工复核由操作者显式确认（${manualTasks} 项）；请确认逐图结论已写入本片导演稿验收记录。`);
}
console.log(manualTasks ? '结论：硬性机检通过，人工复核已由操作者确认。' : '结论：词面无硬禁，无提示层待审项，无画面待判项。');
