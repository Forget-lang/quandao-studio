import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 一条片一个目录。video/src 里的两个 JSON 和 video/public 下的 images|audio
// 都是**生成物**——要改就改 pieces/ 里的原件再重跑本脚本。
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PIECES = path.join(ROOT, 'pieces');
const VIDEO = path.join(ROOT, 'video');
const SRC = path.join(VIDEO, 'src');
const PUB = path.join(VIDEO, 'public');
const FONT_SRC = path.join(ROOT, 'quandao-video', 'font', 'LXGWWenKai-Medium.ttf');
const FONT_DST = path.join(PUB, 'fonts', 'LXGWWenKai-Medium.ttf');

const list = () =>
  fs.existsSync(PIECES)
    ? fs.readdirSync(PIECES, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort()
    : [];

const current = () => {
  const l = path.join(PUB, 'images');
  try {
    const t = fs.readlinkSync(l);
    const m = path.resolve(path.dirname(l), t).match(/pieces[/\\]([^/\\]+)[/\\]/);
    return m ? m[1] : null;
  } catch { return null; }
};

const arg = process.argv[2];
if (!arg) {
  const c = current();
  console.log(c ? `当前片：${c}` : '当前片：（无，video/public/images 不是符号链接）');
  const all = list();
  console.log(`可选片 ${all.length} 条：`);
  all.forEach((n) => console.log('  ' + n + (n === c ? '   ← 当前' : '')));
  process.exit(0);
}

const dir = path.join(PIECES, arg);
for (const need of ['project.json', 'voiceover-meta.json', 'images', 'audio']) {
  if (!fs.existsSync(path.join(dir, need))) {
    console.error(`片「${arg}」缺 ${need}，不切换。`);
    process.exit(1);
  }
}

fs.mkdirSync(PUB, { recursive: true });
fs.mkdirSync(path.join(PUB, 'fonts'), { recursive: true });
if (!fs.existsSync(FONT_DST)) {
  if (!fs.existsSync(FONT_SRC)) { console.error(`缺字体 ${FONT_SRC}，技能 §4.7 是硬门槛，停。`); process.exit(1); }
  fs.copyFileSync(FONT_SRC, FONT_DST);
  console.log('字体已按 §4.7 第 3 步拷入工程 public/fonts/');
}

for (const [sub, dst] of [
  ['project.json', path.join(SRC, 'project.json')],
  ['voiceover-meta.json', path.join(SRC, 'voiceover-meta.json')],
]) {
  fs.copyFileSync(path.join(dir, sub), dst);
}

for (const sub of ['images', 'audio']) {
  const link = path.join(PUB, sub);
  let st = null;
  try { st = fs.lstatSync(link); } catch {}
  if (st && !st.isSymbolicLink()) {
    const n = st.isDirectory() ? fs.readdirSync(link).length : 1;
    if (n > 0) {
      console.error(`video/public/${sub} 是一个有 ${n} 项的真实目录，不是生成物。`);
      console.error('先把它移进 pieces/<片名>/${sub} 再切，避免覆盖唯一副本。');
      process.exit(1);
    }
    fs.rmSync(link, { recursive: true });
  } else if (st) {
    fs.unlinkSync(link);
  }
  // 相对链接：目录改名、或仓库 clone 到别的机器/路径都不会断（绝对链接一改名就变悬空）。
  fs.symlinkSync(path.relative(path.dirname(link), path.join(dir, sub)), link, 'dir');
}

const p = JSON.parse(fs.readFileSync(path.join(dir, 'project.json'), 'utf8'));
const img = p.shots.reduce((n, s) => n + s.images.length, 0);
console.log(`已切到：${arg}`);
console.log(`  ${p.piece}`);
console.log(`  ${p.shots.length} 镜 · ${img} 张图 · 音频 ${p.shots.length} 条`);
