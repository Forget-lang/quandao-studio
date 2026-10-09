import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * check-reuse.mjs —— 跨片口播查重（判据本体在 mac-director §6.6）
 *
 * 为什么要有：同系列每片的叙事结构（§6.1）与画风（第十章）本来就该同源，
 * 但口播的「句子」不该跨片复用。2026-10-08 实测：本系列第二条片七句里有六句的
 * 开头／收尾与第一条逐字或近似，观众连着看两条会觉得是同一条片换了行业。
 *
 * 扫什么：本片「全片固定标题 ＋ 每镜口播」，与所有往期片的同名内容比连续字片段重合。
 * 不扫什么：AI 画面提示词与共用骨架——那两样是规定同源的，扫了必假红。
 *           画面手法的跨片复用（同一套道具动作、同机位改状态）也管不着，靠 mac-director §十四 人判。
 *
 * 判法：只报清单，不判红。功能性过渡句（如「活动是这么跑的」）本身无害，由人判要不要改。
 *       「生成端不读往期口播」才是治本的那半条（mac-director §6.6），这条命令只是兜底。
 *
 * 用法：
 *   node scripts/check-reuse.mjs [--piece <片名>] [--min <字数>]
 *   node scripts/check-reuse.mjs --self-test
 * 不给 --piece 时按 video/public/images 的软链认当前片（同 check-piece.mjs）。
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// 连续重合的最小字数。低于这个数会把正常业务词也算进来。
// 阈值只此一处，技能正文（mac-director §6.6）不抄第二份。
const MIN_DEFAULT = 6;

const argv = process.argv.slice(2);
const argOf = (k) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : null);

const SPLIT = /[，。；！？：、,.!?;:\s]+/u;
const clausesOf = (t) => String(t || '').split(SPLIT).map((s) => s.trim()).filter((s) => s.length >= 2);

function listPieces() {
  const dir = path.join(ROOT, 'pieces');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => e.name).sort();
}

function currentPiece() {
  const l = path.join(ROOT, 'video', 'public', 'images');
  try {
    const m = path.resolve(path.dirname(l), fs.readlinkSync(l)).match(/pieces[/\\]([^/\\]+)[/\\]/);
    return m ? m[1] : null;
  } catch { return null; }
}

/** Read the explicit fixed-title field first; only legacy drafts fall back to the old first-shot heading. */
function extractDirectorTitle(markdown) {
  let legacyTitle = null;
  for (const line of String(markdown || '').split('\n')) {
    const fixed = line.match(/^\s*[-*]\s*本期固定标题(?:（[^）]*）)?[：:]\s*(.+?)\s*$/u);
    if (fixed) return fixed[1].trim();

    if (!legacyTitle) {
      const h = line.match(/^#{2,3}\s*镜1\s*·\s*([^·]+?)\s*·/u) || line.match(/^#{2,3}\s*分镜1[：:]\s*(.+?)\s*$/u);
      if (h) legacyTitle = h[1].trim();
    }
  }
  return legacyTitle;
}

/** One piece's visible / spoken text: prefer the final project.json, with Markdown fallback for archives. */
function readPiece(name) {
  const dir = path.join(ROOT, 'pieces', name);
  const clauses = [];
  let title = null;
  const sources = [];

  const pj = path.join(dir, 'project.json');
  if (fs.existsSync(pj)) {
    try {
      const j = JSON.parse(fs.readFileSync(pj, 'utf8'));
      if (j.pieceTitle) title = String(j.pieceTitle).trim();
      for (const s of j.shots || []) clauses.push(...clausesOf(s.voice));
      sources.push('project.json');
    } catch { /* 坏文件当没有，下面还有导演稿兜底 */ }
  }

  const md = path.join(dir, '导演稿.md');
  if (fs.existsSync(md)) {
    const markdown = fs.readFileSync(md, 'utf8');
    for (const line of markdown.split('\n')) {
      const m = line.match(/^口播[：:]\s*`([^`]+)`/u);
      if (m) clauses.push(...clausesOf(m[1]));
    }
    if (!title) title = extractDirectorTitle(markdown);
    sources.push('导演稿.md');
  }

  if (title) clauses.push(title);
  return { name, title, clauses: [...new Set(clauses)], sources };
}

/** 最长公共子串 */
function lcs(a, b) {
  let best = '', bestLen = 0;
  const dp = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    let prev = 0;
    for (let j = 1; j <= b.length; j++) {
      const cur = dp[j];
      dp[j] = a[i - 1] === b[j - 1] ? prev + 1 : 0;
      if (dp[j] > bestLen) { bestLen = dp[j]; best = a.slice(i - bestLen, i); }
      prev = cur;
    }
  }
  return best;
}

function collect(cur, others, min) {
  const hits = [];
  for (const c of cur.clauses) {
    for (const o of others) {
      for (const h of o.clauses) {
        const frag = lcs(c, h);
        if (frag.length >= min) hits.push({ frag, len: frag.length, cur: c, other: o.name, otherClause: h });
      }
    }
  }
  // 同一片段去重（可能来自多对子句），长的排前
  const seen = new Map();
  for (const x of hits) if (!seen.has(x.frag)) seen.set(x.frag, x);
  return [...seen.values()].sort((a, b) => b.len - a.len || a.frag.localeCompare(b.frag, 'zh'));
}

function selfTest() {
  const fails = [];
  const A = { name: 'P-新', clauses: ['先把这件事说清楚', '所以这件事不是降价，是把闲时变成理由'] };
  const B = { name: 'P-旧', clauses: ['先把这件事说清楚，这就是异业合作', '所以这件事不是打折，是把四十分钟变成理由'] };
  const hits = collect(A, [B], MIN_DEFAULT);
  if (!hits.some((x) => x.frag === '先把这件事说清楚')) fails.push('没抓到逐字同的句式');
  if (!hits.some((x) => x.frag === '所以这件事不是')) fails.push('没抓到同模子的句式');
  const short = collect({ name: 'x', clauses: ['工作日白天'] }, [{ name: 'y', clauses: ['工作日白天空着'] }], MIN_DEFAULT);
  if (short.length) fails.push(`阈值失效：4 字重合也被算进来了（${short[0].frag}）`);

  const fixedTitle = '朋友用了券，老客怎么拿奖励？';
  const newDraft = `- 本期固定标题（唯一上屏标题）：${fixedTitle}\n\n## 分镜1：内部信息标签（不上屏）`;
  if (extractDirectorTitle(newDraft) !== fixedTitle) fails.push('没有优先读取导演稿中的本期固定标题，或错误拿了分镜内部标签');
  if (extractDirectorTitle('## 分镜1：旧稿标题') !== '旧稿标题') fails.push('旧稿缺少固定标题字段时，兼容回退失败');

  console.log(fails.length ? '自检失败：\n  ' + fails.join('\n  ') : `自检通过：查重能抓到逐字同与同模子的句式，低于 ${MIN_DEFAULT} 字的正常业务词不会误报；导演稿的全片固定标题可正确读取，并兼容旧档。`);
  process.exit(fails.length ? 1 : 0);
}

if (argv.includes('--self-test')) selfTest();

const min = Number(argOf('--min')) || MIN_DEFAULT;
let piece = argOf('--piece') || currentPiece();
const all = listPieces();

if (!piece) {
  console.error('找不到当前片。用 --piece <片名> 指定，或先跑 node scripts/use-piece.mjs <片名>。');
  console.error(`现有片：${all.join('、') || '（pieces/ 为空）'}`);
  process.exit(2);
}
if (!all.includes(piece)) {
  console.error(`片目录不存在：pieces/${piece}`);
  console.error(`现有片：${all.join('、') || '（pieces/ 为空）'}`);
  process.exit(2);
}

const cur = readPiece(piece);
const others = all.filter((p) => p !== piece).map(readPiece).filter((p) => p.clauses.length);
const hits = collect(cur, others, min);

console.log(`跨片口播查重（mac-director §6.6）· 当前片：${piece}`);
console.log(`本片句子 ${cur.clauses.length} 条（含全片固定标题${cur.title ? `「${cur.title}」` : '：无'}）· 来源 ${cur.sources.join('＋') || '无'}`);
console.log(`比对面 ${others.length} 条往期片${others.length ? '：' + others.map((o) => o.name).join('、') : ''} · 连续重合阈值 ≥${min} 字\n`);

if (!others.length) {
  console.log('── 无往期片可比，跳过。');
  process.exit(0);
}

console.log(`── 命中（${hits.length}）＝与往期片重合的连续片段，逐条人判要不要改`);
for (const x of hits) {
  console.log(`   [${x.len} 字] 「${x.frag}」`);
  console.log(`        本片      ${x.cur}`);
  console.log(`        ← ${x.other}  ${x.otherClause}`);
}
if (!hits.length) console.log('   无');

console.log(`\n结论：命中 ${hits.length} 处。只报清单、不判红——功能性过渡句可留，句式模子要改（治本看 mac-director §6.6）。`);