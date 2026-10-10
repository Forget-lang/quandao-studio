import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * render-piece.mjs —— 渲染并**直接归档进本片目录**，省掉"渲完还得手动搬"那一步（它必然被忘）。
 *
 * 用法：
 *   node scripts/render-piece.mjs                 渲染当前片 → pieces/<片>/成片.mp4
 *   node scripts/render-piece.mjs --piece <片名>  指定片
 *   node scripts/render-piece.mjs --force         覆盖已有成片（默认拒绝，防止盖掉已发布的那条）
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VIDEO = path.join(ROOT, 'video');
const argv = process.argv.slice(2);
const argOf = (k) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : null);

let piece = argOf('--piece');
if (!piece) {
  const l = path.join(VIDEO, 'public', 'images');
  try {
    const m = path.resolve(path.dirname(l), fs.readlinkSync(l)).match(/pieces[/\\]([^/\\]+)[/\\]/);
    piece = m && m[1];
  } catch { /* 下面统一报错 */ }
}
if (!piece) { console.error('不知道要渲哪条片：先跑 node scripts/use-piece.mjs <片名>，或用 --piece 指定。'); process.exit(2); }

const DIR = path.join(ROOT, 'pieces', piece);
if (!fs.existsSync(DIR)) { console.error(`片目录不存在：${DIR}`); process.exit(2); }
const OUT = path.join(DIR, '成片.mp4');
if (fs.existsSync(OUT) && !argv.includes('--force')) {
  console.error(`已存在 ${OUT}\n要重渲请加 --force（先确认这条片没有已发布的版本被你盖掉）。`);
  process.exit(2);
}

// 目标片必须就是当前加载到 Remotion 的片，避免 --piece 与运行时工程错配。
for (const sub of ['images', 'audio']) {
  let activeReal;
  try {
    activeReal = fs.realpathSync(path.join(VIDEO, 'public', sub));
  } catch {
    console.error('运行时 public/' + sub + ' 目录尚未连接。先运行 node scripts/use-piece.mjs ' + piece + '。');
    process.exit(2);
  }
  if (path.resolve(activeReal) !== path.resolve(DIR, sub)) {
    console.error('当前 Remotion 的 public/' + sub + ' 与目标片不一致。先运行 node scripts/use-piece.mjs ' + piece + '，再渲染。');
    process.exit(2);
  }
}
for (const name of ['project.json']) {
  try {
    const source = fs.readFileSync(path.join(DIR, name), 'utf8');
    const runtime = fs.readFileSync(path.join(VIDEO, 'src', name), 'utf8');
    if (source !== runtime) {
      console.error('运行时 video/src/' + name + ' 与 pieces/' + piece + '/' + name + ' 不一致。请先运行 node scripts/use-piece.mjs ' + piece + '。');
      process.exit(2);
    }
  } catch (error) {
    console.error('无法核对所选片与运行时 ' + name + '：' + error.message);
    process.exit(2);
  }
}

// 正式渲染入口必须重跑素材技术预检，不能依赖操作者记得提前运行。
const preflightGate = spawnSync(process.execPath, [path.join(ROOT, 'quandao-video', 'scripts', 'preflight.mjs')], {
  cwd: ROOT, stdio: 'inherit',
});
if (preflightGate.status !== 0) {
  console.error('素材技术预检未通过，停止渲染。');
  process.exit(preflightGate.status || 1);
}

// 逐图视觉验收必须先通过；--confirm-manual-review 不能替代这道闸门。
const visualGate = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'check-visual-review.mjs'), '--piece', piece], {
  cwd: ROOT, stdio: 'inherit',
});
if (visualGate.status !== 0) {
  console.error('逐图视觉验收未通过，停止渲染；请先修复图片或补齐有依据的本片例外记录。');
  process.exit(visualGate.status || 1);
}

// 合成 ID 只在 Root.tsx 里定义一次，这里解析出来用，避免第二处字面量各改各的。
const root = fs.readFileSync(path.join(VIDEO, 'src', 'Root.tsx'), 'utf8');
const id = (root.match(/COMPOSITION_ID\s*=\s*'([^']+)'/) || [])[1];
if (!id) { console.error('video/src/Root.tsx 里找不到 COMPOSITION_ID 定义，渲染入口与注册已脱节。'); process.exit(2); }

const r = spawnSync('npx', ['remotion', 'render', 'src/index.ts', id, path.relative(VIDEO, OUT)], {
  cwd: VIDEO, stdio: 'inherit',
});
if (r.status !== 0) { console.error(`渲染失败（退出码 ${r.status}），成片未归档。`); process.exit(r.status || 1); }

const size = fs.statSync(OUT).size;
if (size < 1024 * 100) console.warn(`警告：成片只有 ${(size / 1024).toFixed(0)} KB，几乎肯定是空工程或渲染中断。`);
console.log(`\n已归档：${path.relative(ROOT, OUT)}（${(size / 1024 / 1024).toFixed(1)} MB）`);
console.log('下一步：node scripts/check-piece.mjs 过词面机检。');
