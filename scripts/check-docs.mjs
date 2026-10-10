import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * check-docs.mjs —— 本线（quandao-studio）的文档漂移机检（文档架构约束与统一画风单源的兜底，见 AGENTS.md §〇）
 *
 * 判红的五件事＋一件只报清单：
 *   ① 同一个「口径型读数」出现在两个以上的文档 —— 一条事实只能有一个家
 *   ② 文档点名的路径或节号在盘上不存在 —— 删过的东西不许继续被引用
 *   ③ 缺陷账标题的条数与表格实际行数不符
 *   ④ 退役话头回流（spec/退役.json）—— 新方案顶掉旧方案后，旧描述不许留在现行文档里
 *      ④ 分两个面：规则文档命中＝硬红；当前片产物命中＝提示（已发布片按档案处理，不挡门）
 *   ⑤ 同一份文件里重复的实质行 —— 只报清单（多是技能原文自带的老账，逐条收敛时再判红）
 *   ⑥ 统一画风单一来源 —— 制作技能引用 mac-director §10.12，不得另抄近似风格正文
 *
 * 用法：
 *   node scripts/check-docs.mjs                  正式扫
 *   node scripts/check-docs.mjs --self-test      拿假文档验证所有判红检测器真的会红，且⑤能列出重复项（防假绿灯）
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// 扫描面由目录派生，不手写清单：新增一份 md 就自动进检查，避免出现"第二处登记"。
// 排除 node_modules 与 pieces/（片产物按档案处理，④ 单独软扫）。
const SKIP_DIR = new Set(['node_modules', '.remotion', '.git', 'out', 'pieces']);
function discoverDocs(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) { if (!SKIP_DIR.has(e.name)) discoverDocs(path.join(dir, e.name), acc); }
    else if (e.name.endsWith('.md') && !e.name.startsWith('.')) acc.push(path.relative(ROOT, path.join(dir, e.name)));
  }
  return acc.sort();
}
const DOCS = discoverDocs(ROOT);
const PIECE_FILES = ['导演稿.md', 'project.json', '发布文案.md'];
const NEGATIVE = /已废|不得再用|不要拿它当标准|禁止它|反面/;   // 行内出现＝这是在禁止它，不算回流

// 有意保留的重复读数（理由必填；没有理由就从这里删掉，回到"只有一个家"）
const DUP_OK = [
  { tok: '1080×810', why: '母版主画面区几何值。AGENTS §二 用它讲通道要求、SKILL 用它讲实现，两处都得看得见数字' },
];

// 只认"口径型读数"：会被引用、会漂移的那种。裸量词（3 张、2 个）不是口径，抓了只剩噪音。
const PATTERNS = [
  /[0-9]+(?:\.[0-9]+)?\s*%/g,                               // 6.5%
  /[0-9]+(?:\.[0-9]+)?\s*(?:px|rpx)/g,                      // 920px
  /[0-9]+(?:\.[0-9]+)?\s*字\/秒/g,                            // 4.8 字/秒
  /scale\([0-9.]+\)/g,                                       // scale(1.07)
  /(?:最多|≤|不超过|以内|约)\s*[0-9]+(?:\.[0-9]+)?\s*字/g,           // 最多 18 字
  /[0-9]+\s*×\s*[0-9]+/g,                                    // 1080×810
];

const readLines = (docs, f) => docs[f].split('\n');

function collectDups(docs, names) {
  const map = new Map();
  const where = new Map();
  for (const f of names) {
    let inCode = false;
    readLines(docs, f).forEach((line, i) => {
      if (/^\s*```/.test(line)) { inCode = !inCode; return; }
      if (inCode) return;                       // 命令块里的数字是命令，不是口径
      for (const P of PATTERNS) for (const m of line.match(P) || []) {
        const tok = m.replace(/\s+/g, '');
        if (!map.has(tok)) { map.set(tok, new Set()); where.set(tok, []); }
        map.get(tok).add(f);
        where.get(tok).push(`${f}:${i + 1}`);
      }
    });
  }
  return [...map.entries()]
    .filter(([tok, set]) => set.size > 1 && !DUP_OK.some((d) => d.tok === tok))
    .map(([tok, set]) => ({ tok, files: [...set], spots: where.get(tok) }));
}

// These paths are deliberately absent from a clean clone: .gitignore excludes
// per-piece assets, the local secret env file, and use-piece.mjs-generated runtime files.
const MAY_BE_ABSENT_PATHS = new Set([
  'pieces',
  '../applet',
  'quandao-video/.env',
  'video/src/project.json',
  'video/src/voiceover-meta.json',
  'video/public/images',
  'video/public/audio',
  'video/public/fonts',
  'video/out',
]);

function collectBroken(docs, names, realRoot) {
  const heads = {};
  const sectionHeading = /^#{1,6}\s+([0-9]+(?:\.[0-9]+)*[A-Z]?|[〇一二三四五六七八九十]+)(?=[、. ]|$)/gm;
  for (const f of names) heads[f] = new Set([...docs[f].matchAll(sectionHeading)].map((m) => m[1]));
  const paths = [];
  const secs = [];
  const PATHISH = /^(\.\.?\/|video\/|scripts\/|pieces\/|mac-director\/|quandao-video\/|spec\/|components\/|pages_)/;
  for (const f of names) {
    readLines(docs, f).forEach((line, i) => {
      for (const m of line.matchAll(/`([^`\s]+)`/g)) {
        const raw = m[1].replace(/[，。、）)"'：;]+$/, '');
        if (/[{<]*\*|https?:/.test(raw) || raw.includes('{') || raw.includes('<') || raw.includes('…')) continue;
        if (!PATHISH.test(raw)) continue;
        const normalizedPath = raw.replace(/\/+$/, '');
        const inDocs = names.some((g) => g === raw || g.endsWith(raw.replace(/^\.\.\//, '')));
        const existsOnDisk = realRoot
          ? fs.existsSync(path.resolve(path.dirname(path.join(realRoot, f)), raw)) || fs.existsSync(path.join(realRoot, raw))
          : false;
        if (MAY_BE_ABSENT_PATHS.has(normalizedPath) && !existsOnDisk) continue;
        const hit = inDocs || !realRoot ? inDocs : existsOnDisk;
        if (!hit) paths.push(`${f}:${i + 1}  \`${raw}\``);
      }
      for (const m of line.matchAll(/§\s*([0-9]+(?:\.[0-9]+)*[A-Z]?|[〇一二三四五六七八九十]+)/g)) {
        if (!names.some((g) => heads[g].has(m[1]))) secs.push(`${f}:${i + 1}  §${m[1]}`);
      }
    });
  }
  return { paths, secs };
}

function ledgerMismatch(text) {
  const declared = text.match(/##\s*待办（(\d+)\s*条）/);
  if (!declared) return null;
  const rows = ((text.split(/##\s*待办/)[1] || '').match(/^\|\s*\d+\s*\|/gm) || []).length;
  return Number(declared[1]) === rows ? null : `标题写「${declared[1]} 条」，表里实际 ${rows} 行`;
}

function loadRetired() {
  const p = path.join(ROOT, 'spec', '退役.json');
  if (!fs.existsSync(p)) return [];
  return JSON.parse(fs.readFileSync(p, 'utf8')).retired || [];
}

function currentPiece() {
  const l = path.join(ROOT, 'video', 'public', 'images');
  try {
    const m = path.resolve(path.dirname(l), fs.readlinkSync(l)).match(/pieces[/\\]([^/\\]+)[/\\]/);
    return m ? m[1] : null;
  } catch { return null; }
}

/** targets: [{name, text, kind:'hard'|'soft'}]。hard＝现行规则文档，soft＝某条片的产物（按档案处理） */
function scanRetired(retired, targets) {
  const out = [];
  for (const t of targets) {
    if (!t.text) continue;
    t.text.split('\n').forEach((line, i) => {
      for (const r of retired) {
        if (r.term && line.includes(r.term) && !NEGATIVE.test(line)) {
          out.push({ term: r.term, why: r.why, instead: r.instead, spot: `${t.name}:${i + 1}`, kind: t.kind });
        }
      }
    });
  }
  return out;
}

/** 制作层不得复制导演层的视觉风格正文；统一前缀只有一个出处。 */
function collectVisualStyleSourceIssues(docs) {
  const issues = [];
  const director = docs['mac-director/SKILL.md'] || '';
  const video = docs['quandao-video/SKILL.md'] || '';

  if (!director.includes('## 10.12 默认生图风格前缀')) {
    issues.push('缺少统一风格真源：mac-director/SKILL.md §10.12');
  }

  const frontMatter = video.match(/^---\n([\s\S]*?)\n---/u);
  const description = frontMatter?.[1] || '';
  if (description.includes('画面风格继承已确认参考图')) {
    issues.push('quandao-video frontmatter 仍将参考图写成必需风格来源');
  }
  if (!description.includes('默认继承 mac-director 第十章的统一文字前缀')) {
    issues.push('quandao-video frontmatter 未说明统一文字前缀是默认风格来源');
  }
  if (video.includes('- 画风是否符合参考图？')) {
    issues.push('quandao-video 最终图片检查仍只要求对照参考图，未覆盖无图像输入时的文字回退');
  }

  const rule = video.match(/## 5\.1 固定视觉参考图[\s\S]*?(?=\n## 5\.1A 主画面比例锁定)/u);
  if (!rule || !rule[0].includes('mac-director/SKILL.md') || !rule[0].includes('§10.12')) {
    issues.push('quandao-video §5.1 未指向 mac-director §10.12 的统一风格真源');
  }

  const template = video.match(/【视觉风格】([\s\S]*?)【禁止】/u);
  if (!template) {
    issues.push('quandao-video §5.6 缺少【视觉风格】模板段');
  } else {
    const duplicateMarkers = [
      '现代中国生活题材数字二维动画截帧',
      '中国本土现代数字二维动画截帧风',
      '清晰粗细适中的深色闭合轮廓线，干净数字平涂'
    ];
    if (duplicateMarkers.some((marker) => template[1].includes(marker))) {
      issues.push('quandao-video §5.6 再次复制视觉风格正文；应改为引用 mac-director §10.12');
    }
    if (!template[1].includes('mac-director/SKILL.md') || !template[1].includes('§10.12')) {
      issues.push('quandao-video §5.6 未引用 mac-director §10.12 的统一文字前缀');
    }
  }
  return issues;
}

/** 文件内重复。两类分开算，否则会把"合法的同名"当成账：
 *  · 正文行逐字相同 —— 同一句话说了两遍
 *  · 代码块之间共享 ≥4 行 —— 同一套参数抄了两份（改一处漏一处的那种真事故）
 *  注：同一个代码块里 title/subtitle 各写一遍 fontFamily 是代码结构，不算重复。 */
function collectSelfRepeats(docs, names) {
  const prose = [];
  const blocks = [];
  for (const f of names) {
    const cnt = new Map();
    const chunks = [];
    let inCode = false;
    let cur = null;
    docs[f].split('\n').forEach((line, i) => {
      if (/^\s*```/.test(line)) {
        if (inCode && cur && cur.lines.length >= 4) chunks.push(cur);
        inCode = !inCode;
        if (inCode) cur = { start: i + 1, lines: [] };
        return;
      }
      if (inCode) { if (cur && line.trim()) cur.lines.push(line.trim().replace(/\/\/.*$/, '').replace(/\s+/g, ' ').trim()); return; }
      const l = line.trim();
      if (l.length < 14 || l.startsWith('|') || /^---$/.test(l)) return;
      if (!cnt.has(l)) cnt.set(l, []);
      cnt.get(l).push(i + 1);
    });
    for (const [l, rows] of cnt) if (rows.length > 1) prose.push({ file: f, text: l, rows });
    for (let a = 0; a < chunks.length; a++) for (let b = a + 1; b < chunks.length; b++) {
      const setB = new Set(chunks[b].lines);
      const shared = chunks[a].lines.filter((x) => setB.has(x));
      if (shared.length >= 4) blocks.push({ file: f, at: `${chunks[a].start}、${chunks[b].start}`, lines: shared });
    }
  }
  return { prose, blocks };
}

// ---- 自检：所有判红检测器都必须真的会红；⑤ 也必须能列出重复项，否则就是假绿灯 ----
function selfTest() {
  const docs = {
    'A.md': '甲文件里写 6.5%\n\n## 3.1 标题\n',
    'B.md': '乙文件里也写 6.5%\n\n见 §99.9、§五 和 `scripts/不存在.mjs`\n',
    '缺陷账.md': '## 待办（3 条）\n\n| # | 问题 |\n|---|---|\n| 1 | x |\n',
  };
  const fails = [];
  const d = collectDups(docs, ['A.md', 'B.md']);
  if (!d.some((x) => x.tok === '6.5%')) fails.push('① 没抓到跨文件重复读数');
  const b = collectBroken(docs, ['A.md', 'B.md'], null);
  if (!b.secs.includes('B.md:3  §99.9')) fails.push('② 没抓到断节号');
  if (!b.secs.includes('B.md:3  §五')) fails.push('② 没抓到不存在的中文编号节号');
  if (!b.paths.some((x) => x.includes('不存在.mjs'))) fails.push('② 没抓到断路径');
  const generatedPaths = collectBroken({
    'A.md': '`pieces/` `../applet/` `quandao-video/.env` `video/src/project.json` `video/src/voiceover-meta.json` `video/public/images` `video/public/audio` `video/public/fonts/` `video/out/` `scripts/不存在.mjs`'
  }, ['A.md'], null);
  if (generatedPaths.paths.length !== 1 || !generatedPaths.paths[0].includes('不存在.mjs')) {
    fails.push('② 生成物/本地密钥路径缺席时误报，或真实断路径漏报');
  }
  if (!ledgerMismatch(docs['缺陷账.md'])) fails.push('③ 没抓到条数不符');
  const styleGood = {
    'mac-director/SKILL.md': ['## 10.12 默认生图风格前缀', '统一风格正文'].join('\n'),
    'quandao-video/SKILL.md': [
      '---',
      'description: 默认继承 mac-director 第十章的统一文字前缀',
      '---',
      '## 5.1 固定视觉参考图',
      '引用 mac-director/SKILL.md §10.12',
      '## 5.1A 主画面比例锁定',
      '【视觉风格】统一继承 mac-director/SKILL.md §10.12 的视觉前缀【禁止】'
    ].join('\n')
  };
  if (collectVisualStyleSourceIssues(styleGood).length) fails.push('⑥ 合规的统一画风引用被误判');

  const styleBad = {
    'mac-director/SKILL.md': styleGood['mac-director/SKILL.md'],
    'quandao-video/SKILL.md': [
      '---',
      'description: 默认继承 mac-director 第十章的统一文字前缀',
      '---',
      '## 5.1 固定视觉参考图',
      '引用 mac-director/SKILL.md §10.12',
      '## 5.1A 主画面比例锁定',
      '【视觉风格】现代中国生活题材数字二维动画截帧，清晰轮廓线【禁止】'
    ].join('\n')
  };
  if (!collectVisualStyleSourceIssues(styleBad).some((x) => x.includes('再次复制视觉风格正文'))) {
    fails.push('⑥ 没抓到制作层复制统一风格正文');
  }
  const styleFallbackBad = {
    ...styleGood,
    'quandao-video/SKILL.md': styleGood['quandao-video/SKILL.md'] + '\\n- 画风是否符合参考图？'
  };
  if (!collectVisualStyleSourceIssues(styleFallbackBad).some((x) => x.includes('未覆盖无图像输入时的文字回退'))) {
    fails.push('⑥ 没抓到最终图片验收清单遗漏文字风格回退');
  }

  const retired = [{ term: '旧口径话头', why: '测试', instead: '新口径' }];
  const s = scanRetired(retired, [{ name: 'C.md', text: '这里还留着旧口径话头的写法\n这句也提旧口径话头，但已废\n', kind: 'hard' }]);
  if (s.length !== 1) fails.push(`④ 回流检测不对（应抓到 1 处、反面引用不计，实际 ${s.length}）`);
  const dupCode = '```ts\nconst A = 1;\nconst B = 2;\nconst C = 3;\nconst D = 4;\n```\n\n正文一句\n\n```ts\nconst A = 1;\nconst B = 2;\nconst C = 3;\nconst D = 4;\nconst E = 5;\n```\n';
  const rep = collectSelfRepeats({ 'D.md': dupCode }, ['D.md']);
  if (!rep.blocks.length) fails.push('⑤ 没抓到"同一套参数抄了两份"');
  console.log(fails.length ? '自检失败：\n  ' + fails.join('\n  ') : '自检通过：所有判红检测器都能识别对应问题，⑤ 也能列出重复参数段。');
  process.exit(fails.length ? 1 : 0);
}

if (process.argv.includes('--self-test')) selfTest();

const docs = {};
for (const f of DOCS) if (fs.existsSync(path.join(ROOT, f))) docs[f] = fs.readFileSync(path.join(ROOT, f), 'utf8');
const names = Object.keys(docs);

const dups = collectDups(docs, names);
const broken = collectBroken(docs, names, ROOT);
const ledger = ledgerMismatch(docs['缺陷账.md'] || '');
const retired = loadRetired();
const piece = currentPiece();
const targets = names.map((f) => ({ name: f, text: docs[f], kind: 'hard' }));
if (piece) for (const pf of PIECE_FILES) {
  const p = path.join(ROOT, 'pieces', piece, pf);
  if (fs.existsSync(p)) targets.push({ name: `pieces/${piece}/${pf}`, text: fs.readFileSync(p, 'utf8'), kind: 'soft' });
}
const flow = scanRetired(retired, targets);
const hardFlow = flow.filter((x) => x.kind === 'hard');
const softFlow = flow.filter((x) => x.kind === 'soft');

console.log(`扫描 ${names.length} 份文档`);
console.log(`\n── ① 重复读数（${dups.length}）＝一条事实写了两个家，留一个、其余改成「见 §x.y」`);
dups.forEach((x) => console.log(`   ${x.tok}  ←  ${x.files.join(' / ')}\n        ${x.spots.join('  ')}`));
if (!dups.length) console.log('   无');
console.log(`\n── ② 断链（${broken.paths.length + broken.secs.length}）＝点名的路径或节号在盘上不存在`);
broken.paths.forEach((x) => console.log(`   路径 ${x}`));
broken.secs.forEach((x) => console.log(`   节号 ${x}`));
if (!broken.paths.length && !broken.secs.length) console.log('   无');
console.log(`\n── ③ 缺陷账条数：${ledger || '对得上'}`);
console.log(`\n── ④ 退役话头回流（黑名单 ${retired.length} 条${piece ? ` · 另扫当前片 ${piece}` : ''}）`);
hardFlow.forEach((x) => console.log(`   硬红 ${x.spot}  「${x.term}」\n        为什么作废：${x.why}\n        改用：${x.instead}`));
softFlow.forEach((x) => console.log(`   片内 ${x.spot}  「${x.term}」＝档案，已发布片不回改，新片不得再写`));
if (!flow.length) console.log('   无');

const selfRep = collectSelfRepeats(docs, names);
const selfN = selfRep.prose.length + selfRep.blocks.length;
console.log(`\n── ⑤ 文件内重复（${selfN}）＝同一份文件自己说两遍。只报清单不判红，逐条人工判是不是真该收`);
selfRep.blocks.forEach((x) => console.log(`   参数抄了两份  ${x.file} 代码块 @${x.at}（共享 ${x.lines.length} 行，如 ${x.lines.slice(0, 2).join(' / ').slice(0, 72)}）`));
selfRep.prose.forEach((x) => console.log(`   同一句说两遍  ${x.file}:${x.rows.join('、')}  ${x.text.slice(0, 52)}`));
if (!selfN) console.log('   无');

const styleIssues = collectVisualStyleSourceIssues(docs);
console.log(`\n── ⑥ 统一画风单一来源（${styleIssues.length}）＝制作层不得复制导演层的统一风格正文`);
styleIssues.forEach((x) => console.log(`   ${x}`));
if (!styleIssues.length) console.log('   无');

const red = dups.length || broken.paths.length + broken.secs.length || ledger || hardFlow.length || styleIssues.length;
console.log(red ? '\n结论：不通过——以上都是"改一处、到处口径不一"的种子。' : '\n结论：零漂移。');
process.exit(red ? 1 : 0);
