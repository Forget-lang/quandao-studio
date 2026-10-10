import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const VISUAL_REVIEW_FILENAME = '视觉验收.json';
export const VISUAL_CRITERIA = [
  'singleScene', 'aspectRatio', 'style', 'characters',
  'action', 'props', 'text', 'composition',
];
const CHECK_STATES = new Set(['pass', 'fail']);
const REVIEW_STATUSES = new Set(['pending', 'pass', 'fail', 'approved_exception']);

export function inspectVisualReview(pieceName, project, manifest) {
  const result = { errors: [], pending: [], failed: [], exceptions: [], hashes: {} };
  if (!manifest) {
    result.pending.push('缺少 ' + VISUAL_REVIEW_FILENAME + '：逐图视觉验收未完成，禁止渲染');
    return result;
  }
  if (manifest.schemaVersion !== 1) result.errors.push('schemaVersion 必须为 1');
  if (manifest.piece !== pieceName) result.errors.push('验收记录 piece 必须与片目录一致：期望「' + pieceName + '」');
  if (!project || !Array.isArray(project.shots) || !project.shots.length) {
    result.errors.push('project.json 缺少 shots，无法对账验收资产');
    return result;
  }

  const expected = project.shots.flatMap((shot) =>
    (Array.isArray(shot.images) ? shot.images : []).map((image) => String(image))
  );
  if (expected.some((name) => !name)) result.errors.push('project.json 中存在空图片路径');
  if (!Array.isArray(manifest.images)) {
    result.errors.push('视觉验收记录 images 必须是数组');
    return result;
  }
  const actual = manifest.images.map((item) => item && item.path);
  if (actual.length !== expected.length || actual.some((name, i) => name !== expected[i])) {
    result.errors.push('视觉验收记录的图片路径与 project.json 的 images 顺序必须完全一致，不能缺项、多项或错序');
  }
  if (new Set(actual.filter((x) => typeof x === 'string')).size !== actual.length) {
    result.errors.push('视觉验收记录存在重复图片路径');
  }

  for (const item of manifest.images) {
    const name = typeof (item && item.path) === 'string' ? item.path : '(未知图片)';
    const status = item && item.status;
    if (!REVIEW_STATUSES.has(status)) {
      result.errors.push(name + ': status 必须是 pending / pass / fail / approved_exception');
      continue;
    }
    if (status === 'pending') {
      result.pending.push(name + ': ' + ((item && item.note) || '尚未完成逐图视觉验收'));
      continue;
    }
    if (status === 'fail') {
      result.failed.push(name + ': ' + ((item && item.note) || '视觉验收失败'));
      continue;
    }

    if (!/^[a-f0-9]{64}$/iu.test(String(item.sha256 || ''))) result.errors.push(name + ': 缺有效 sha256；验收记录必须绑定到具体图片文件内容');
    if (!item.checks || typeof item.checks !== 'object') {
      result.errors.push(name + ': 通过或例外放行必须填写 checks');
      continue;
    }
    const missing = VISUAL_CRITERIA.filter((key) => !CHECK_STATES.has(item.checks[key]));
    if (missing.length) result.errors.push(name + ': checks 缺少有效结论：' + missing.join(', '));
    const failedChecks = VISUAL_CRITERIA.filter((key) => item.checks[key] === 'fail');
    if (status === 'pass' && failedChecks.length) {
      result.errors.push(name + ': status=pass 却有失败项：' + failedChecks.join(', '));
    }
    if (!item.reviewer || !String(item.reviewer).trim()) result.errors.push(name + ': 缺 reviewer');
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(String(item.reviewedAt || '')) ||
        Number.isNaN(Date.parse(item.reviewedAt))) {
      result.errors.push(name + ': reviewedAt 必须是 YYYY-MM-DD');
    }
    if (!item.evidence || !String(item.evidence).trim()) result.errors.push(name + ': 缺 evidence（验收依据或复核路径）');
    if (!item.notes || !String(item.notes).trim()) result.errors.push(name + ': 缺 notes');

    if (status === 'approved_exception') {
      const ex = item.exception;
      if (failedChecks.length === 0) result.errors.push(name + ': approved_exception 至少要对应一项明确失败的 checks');
      if (!ex || !String(ex.acceptedDeviation || '').trim() ||
          !String(ex.approvalEvidence || '').trim() || ex.scope !== 'current-piece-only') {
        result.errors.push(name + ': 例外放行必须记录 acceptedDeviation、approvalEvidence，并将 scope 限定为 current-piece-only');
      } else {
        result.exceptions.push({ path: name, deviation: ex.acceptedDeviation });
      }
    }
  }
  return result;
}

export function validateVisualReview(pieceDir, providedProject = null) {
  let project = providedProject;
  let manifest = null;
  const pieceName = path.basename(pieceDir);
  const projectPath = path.join(pieceDir, 'project.json');
  const reviewPath = path.join(pieceDir, VISUAL_REVIEW_FILENAME);
  const errors = [];
  if (!project) {
    try { project = JSON.parse(fs.readFileSync(projectPath, 'utf8')); }
    catch (error) {
      errors.push('无法读取 project.json：' + error.message);
      return { errors: errors, pending: [], failed: [], exceptions: [], hashes: {} };
    }
  }
  try { manifest = JSON.parse(fs.readFileSync(reviewPath, 'utf8')); }
  catch (error) {
    if (error && error.code !== 'ENOENT') errors.push('无法读取 ' + VISUAL_REVIEW_FILENAME + '：' + error.message);
    else manifest = null;
  }
  const result = inspectVisualReview(pieceName, project, manifest);
  result.errors.unshift(...errors);
  if (manifest && Array.isArray(manifest.images)) {
    const root = path.resolve(pieceDir);
    for (const item of manifest.images) {
      if (!item || typeof item.path !== 'string') continue;
      const file = path.resolve(root, item.path);
      const relative = path.relative(root, file);
      if (relative.startsWith('..') || path.isAbsolute(relative)) {
        result.errors.push(item.path + ': 验收图片路径越出本片目录');
        continue;
      }
      if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
        result.errors.push(item.path + ': 验收图片文件不存在');
        continue;
      }
      const actualHash = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
      result.hashes[item.path] = actualHash;
      if (item.status === 'pass' || item.status === 'approved_exception') {
        if (!/^[a-f0-9]{64}$/iu.test(String(item.sha256 || '')) || actualHash !== String(item.sha256).toLowerCase()) {
          result.errors.push(item.path + ': 图片文件 SHA-256 与验收记录不一致；图片更改后必须重新验收');
        }
      }
    }
  }
  return result;
}

function selfTest() {
  const project = { shots: [{ id: 1, images: ['images/a.jpg'] }] };
  const goodChecks = Object.fromEntries(VISUAL_CRITERIA.map((key) => [key, 'pass']));
  const baseRecord = {
    path: 'images/a.jpg', status: 'pass', sha256: 'a'.repeat(64), reviewer: '验收人角色', reviewedAt: '2026-10-10',
    evidence: '原图全尺寸逐项复核', notes: '画面与当前提示词一致', checks: { ...goodChecks },
  };
  const manifest = (images) => ({ schemaVersion: 1, piece: 'sample-piece', images: images });
  const tests = [];
  const clean = inspectVisualReview('sample-piece', project, manifest([{ ...baseRecord }]));
  tests.push(['完整逐图记录可通过', !clean.errors.length && !clean.pending.length && !clean.failed.length]);
  const pending = inspectVisualReview('sample-piece', project, manifest([{ path: 'images/a.jpg', status: 'pending', note: '待验' }]));
  tests.push(['待验图片会阻止放行', pending.pending.length === 1]);
  const failed = inspectVisualReview('sample-piece', project, manifest([{ path: 'images/a.jpg', status: 'fail', note: '缺少指定道具' }]));
  tests.push(['失败图片会阻止放行', failed.failed.length === 1]);
  const exceptionItem = {
    ...baseRecord, status: 'approved_exception',
    checks: { ...goodChecks, props: 'fail' },
    exception: {
      acceptedDeviation: '道具状态与原提示词不同',
      approvalEvidence: '当前片导演稿的明确用户接受记录',
      scope: 'current-piece-only',
    },
  };
  const exception = inspectVisualReview('sample-piece', project, manifest([exceptionItem]));
  tests.push(['有证据且限定本片的例外可识别', !exception.errors.length && exception.exceptions.length === 1]);
  const unsafeException = inspectVisualReview('sample-piece', project, manifest([{
    ...exceptionItem, exception: { acceptedDeviation: '偏差', approvalEvidence: '', scope: 'global' },
  }]));
  tests.push(['缺少批准依据或扩大例外范围会被拦截', unsafeException.errors.length > 0]);
  const missingCheck = inspectVisualReview('sample-piece', project, manifest([{
    ...baseRecord, checks: { ...goodChecks, text: undefined },
  }]));
  tests.push(['缺少任一检查项会被拦截', missingCheck.errors.length > 0]);
  const mismatchedPath = inspectVisualReview('sample-piece', project, manifest([{ ...baseRecord, path: 'images/other.jpg' }]));
  tests.push(['验收路径必须和工程图片顺序一致', mismatchedPath.errors.some((x) => x.includes('顺序必须完全一致'))]);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'quandao-visual-review-'));
  try {
    fs.mkdirSync(path.join(tmp, 'images'), { recursive: true });
    const img = path.join(tmp, 'images', 'a.jpg');
    fs.writeFileSync(img, Buffer.from('sample-image-bytes'));
    fs.writeFileSync(path.join(tmp, 'project.json'), JSON.stringify(project));
    const hash = createHash('sha256').update(fs.readFileSync(img)).digest('hex');
    const boundManifest = {
      schemaVersion: 1, piece: path.basename(tmp),
      images: [{ ...baseRecord, sha256: hash }],
    };
    fs.writeFileSync(path.join(tmp, VISUAL_REVIEW_FILENAME), JSON.stringify(boundManifest));
    const matched = validateVisualReview(tmp);
    tests.push(['验收记录能与实际图片哈希匹配', !matched.errors.length && matched.hashes['images/a.jpg'] === hash]);
    fs.writeFileSync(img, Buffer.from('changed-image-bytes'));
    const drifted = validateVisualReview(tmp);
    tests.push(['图片更换后旧验收记录会失效', drifted.errors.some((x) => x.includes('SHA-256 与验收记录不一致'))]);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  const pass = tests.every(([, ok]) => ok);
  for (const [name, ok] of tests) console.log((ok ? 'PASS' : 'FAIL') + ' · ' + name);
  console.log('视觉验收闸门自检：' + tests.filter(([, ok]) => ok).length + '/' + tests.length);
  process.exit(pass ? 0 : 1);
}

const argv = process.argv.slice(2);
const isDirectExecution = path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url);
if (isDirectExecution && argv.includes('--self-test')) selfTest();
else if (isDirectExecution) {
  const pieceArg = argv.includes('--piece') ? argv[argv.indexOf('--piece') + 1] : null;
  let piece = pieceArg;
  if (!piece) {
    try {
      const imagesPath = fs.realpathSync(path.join(ROOT, 'video', 'public', 'images'));
      piece = path.basename(path.dirname(imagesPath));
    } catch {
      console.error('找不到当前片。请指定 --piece <片目录名>，或先运行 use-piece.mjs。');
      process.exit(2);
    }
  }
  const pieceDir = path.join(ROOT, 'pieces', piece);
  const result = validateVisualReview(pieceDir);
  console.log('逐图视觉验收：' + piece);
  result.errors.forEach((x) => console.error('  [记录结构错误] ' + x));
  result.failed.forEach((x) => console.error('  [未通过] ' + x));
  result.pending.forEach((x) => console.error('  [待验收] ' + x));
  result.exceptions.forEach((x) => console.warn('  [本片例外放行] ' + x.path + ': ' + x.deviation));
  Object.entries(result.hashes).forEach(([name, hash]) => console.log('  [当前图片 SHA-256] ' + name + ': ' + hash));
  if (result.errors.length || result.failed.length || result.pending.length) {
    console.error('结论：逐图视觉验收未通过，禁止渲染。');
    process.exit(1);
  }
  console.log(result.exceptions.length
    ? '结论：验收记录完整，含 ' + result.exceptions.length + ' 项本片例外。'
    : '结论：验收记录完整，无例外。');
  console.log('注意：脚本只验证验收记录结构与状态，不会自动理解图片内容。');
}
