import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * sync-redlines.mjs —— 按需对比本线词表与 promotion 那份的差集。**只读，一个字都不写。**
 *
 * 为什么存在：本线的 `spec/红线词表.json` 是自己的一份副本（完全隔离，运行时不读 promotion）。
 * 副本的风险是"忘记同步"，所以给一条想起来就能跑的命令：它列出对方多了哪些词、少了哪些词，
 * 要不要合过来由人决定；合完记得把 `_meta.version` 改成对方那次的日期。
 *
 * 用法：node scripts/sync-redlines.mjs
 * 退出码：0＝两份机器层完全一致；1＝有差异（附清单）；2＝找不到对方文件（不报错，只是没得比）
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MINE = path.join(ROOT, 'spec', '红线词表.json');
const THEIRS = path.resolve(ROOT, '..', 'promotion', 'spec', 'redlines.json');

const LAYERS = [
  ['codeBanned', '画面层'],
  ['voiceBanned', '口播层'],
  ['outputsReview', '提示层'],
];

const local = JSON.parse(fs.readFileSync(MINE, 'utf8'));
if (!fs.existsSync(THEIRS)) {
  console.log(`本线词表版本：${local._meta.version}（画面 ${local.codeBanned.tokens.length}／口播 ${local.voiceBanned.tokens.length}／提示 ${local.outputsReview.tokens.length}）`);
  console.log(`找不到对照对象：${THEIRS}\n这不是故障——本线运行时不读它，只是现在没得比。`);
  process.exit(2);
}
const theirs = JSON.parse(fs.readFileSync(THEIRS, 'utf8'));

let diffs = 0;
console.log(`本线版本 ${local._meta.version}  ←→  promotion 那份 updated=${theirs._meta.updated || theirs._meta.lastVerified || '未标'}`);
for (const [key, label] of LAYERS) {
  const a = new Set(local[key]?.tokens || []);
  const b = new Set(theirs[key]?.tokens || []);
  const onlyTheirs = [...b].filter((x) => !a.has(x));
  const onlyMine = [...a].filter((x) => !b.has(x));
  if (!onlyTheirs.length && !onlyMine.length) { console.log(`  ${label}：一致（${b.size} 个）`); continue; }
  diffs += onlyTheirs.length + onlyMine.length;
  console.log(`  ${label}：对方 ${b.size}／本线 ${a.size}`);
  if (onlyTheirs.length) console.log(`     对方有、本线没有 → 建议合入：${onlyTheirs.join('、')}`);
  if (onlyMine.length) console.log(`     本线自己收紧的：${onlyMine.join('、')}`);
}
if (!diffs) console.log('\n结论：机器层完全一致，无需动作。');
else console.log('\n结论：有差异。要不要合进本线词表由人定——本线可以比对方严，但不该比对方松。');
process.exit(diffs ? 1 : 0);
