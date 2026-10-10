import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { validateVisualReview } from './check-visual-review.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DELIVERY_REVIEW_FILENAME = '成片验收.json';
export const DELIVERY_CRITERIA = [
  'fullPlayback', 'voiceover', 'captions', 'timing', 'titleAndSafeArea',
  'sceneTransitions', 'characterAndPropContinuity', 'logicAndClaims',
  'pacingAndEnding', 'publicationCopy',
];
const STATES = new Set(['pass', 'fail']);
const STATUSES = new Set(['pending', 'pass', 'fail']);

export function inspectDeliveryReview(pieceName, manifest, actualVideoHash = null) {
  const result = { errors: [], pending: [], failed: [], videoHash: actualVideoHash };
  if (!manifest) {
    result.pending.push('缺少 ' + DELIVERY_REVIEW_FILENAME + '：成片尚未完成全片视听验收');
    return result;
  }
  if (manifest.schemaVersion !== 1) result.errors.push('schemaVersion 必须为 1');
  if (manifest.piece !== pieceName) result.errors.push('验收记录 piece 必须与片目录一致');
  if (manifest.videoPath !== '成片.mp4') result.errors.push('videoPath 必须为成片.mp4，不能指向其他文件');
  if (!STATUSES.has(manifest.status)) {
    result.errors.push('status 必须为 pending / pass / fail');
    return result;
  }
  if (manifest.status === 'pending') {
    result.pending.push(String(manifest.note || '成片全片复核尚未完成'));
    return result;
  }
  if (manifest.status === 'fail') {
    result.failed.push(String(manifest.note || '成片验收未通过'));
    return result;
  }

  if (!manifest.checks || typeof manifest.checks !== 'object') {
    result.errors.push('pass 状态必须包含 checks');
    return result;
  }
  const missing = DELIVERY_CRITERIA.filter((key) => !STATES.has(manifest.checks[key]));
  if (missing.length) result.errors.push('成片检查项缺少有效 pass/fail 结论：' + missing.join(', '));
  const failedChecks = DELIVERY_CRITERIA.filter((key) => manifest.checks[key] === 'fail');
  if (failedChecks.length) result.errors.push('status=pass 却有失败项：' + failedChecks.join(', '));
  if (!/^[a-f0-9]{64}$/iu.test(String(manifest.sha256 || ''))) result.errors.push('缺有效 sha256：验收必须绑定到具体成片文件');
  if (actualVideoHash && String(manifest.sha256).toLowerCase() !== actualVideoHash) {
    result.errors.push('成片文件 SHA-256 与验收记录不一致；成片变更后必须重新完整验收');
  }
  if (!manifest.reviewer || !String(manifest.reviewer).trim()) result.errors.push('缺 reviewer');
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(String(manifest.reviewedAt || '')) ||
      Number.isNaN(Date.parse(manifest.reviewedAt))) result.errors.push('reviewedAt 必须是 YYYY-MM-DD');
  if (!manifest.evidence || !String(manifest.evidence).trim()) result.errors.push('缺 evidence（完整播放依据／核对记录路径）');
  if (!manifest.notes || !String(manifest.notes).trim()) result.errors.push('缺 notes');
  return result;
}

export function validateDeliveryReview(pieceDir) {
  const pieceName = path.basename(pieceDir);
  const reviewPath = path.join(pieceDir, DELIVERY_REVIEW_FILENAME);
  const videoPath = path.join(pieceDir, '成片.mp4');
  const errors = [];
  let manifest = null;
  let actualVideoHash = null;

  if (!fs.existsSync(videoPath) || !fs.statSync(videoPath).isFile()) {
    errors.push('缺少成片.mp4；无法执行成片验收');
  } else {
    actualVideoHash = createHash('sha256').update(fs.readFileSync(videoPath)).digest('hex');
  }

  try {
    manifest = JSON.parse(fs.readFileSync(reviewPath, 'utf8'));
  } catch (error) {
    if (error && error.code !== 'ENOENT') errors.push('无法读取 ' + DELIVERY_REVIEW_FILENAME + '：' + error.message);
  }

  const result = inspectDeliveryReview(pieceName, manifest, actualVideoHash);
  result.errors.unshift(...errors);
  return result;
}

function selfTest() {
  const goodChecks = Object.fromEntries(DELIVERY_CRITERIA.map((key) => [key, 'pass']));
  const good = {
    schemaVersion: 1,
    piece: 'sample-piece',
    videoPath: '成片.mp4',
    status: 'pass',
    sha256: 'a'.repeat(64),
    reviewer: '验收人角色',
    reviewedAt: '2026-10-10',
    evidence: '完整播放成片并逐项对照记录',
    notes: '口播、字幕、镜头与结尾全部核对',
    checks: goodChecks,
  };
  const tests = [];
  const accepted = inspectDeliveryReview('sample-piece', good, 'a'.repeat(64));
  tests.push(['完整且绑定当前视频哈希的记录可通过', !accepted.errors.length && !accepted.pending.length && !accepted.failed.length]);
  const pending = inspectDeliveryReview('sample-piece', {
    schemaVersion: 1, piece: 'sample-piece', videoPath: '成片.mp4', status: 'pending', note: '还没完整播放',
  }, 'a'.repeat(64));
  tests.push(['待复核成片不能被判为通过', pending.pending.length === 1]);
  const mismatchedHash = inspectDeliveryReview('sample-piece', good, 'b'.repeat(64));
  tests.push(['成片被更换后旧验收记录失效', mismatchedHash.errors.some((x) => x.includes('SHA-256 与验收记录不一致'))]);
  const hiddenFailure = inspectDeliveryReview('sample-piece', {
    ...good, checks: { ...goodChecks, captions: 'fail' },
  }, 'a'.repeat(64));
  tests.push(['存在失败检查项时不能标成 pass', hiddenFailure.errors.some((x) => x.includes('却有失败项'))]);
  const missingCheck = inspectDeliveryReview('sample-piece', {
    ...good, checks: { ...goodChecks, fullPlayback: undefined },
  }, 'a'.repeat(64));
  tests.push(['缺少任何一项全片验收都不能通过', missingCheck.errors.some((x) => x.includes('fullPlayback'))]);
  const wrongPiece = inspectDeliveryReview('another-piece', good, 'a'.repeat(64));
  tests.push(['验收记录必须绑定当前片目录', wrongPiece.errors.some((x) => x.includes('piece'))]);
  const testsFailed = tests.filter(([, ok]) => !ok);
  for (const [name, ok] of tests) console.log((ok ? 'PASS' : 'FAIL') + ' · ' + name);
  console.log('成片验收闸门自检：' + (tests.length - testsFailed.length) + '/' + tests.length);
  process.exit(testsFailed.length ? 1 : 0);
}

const argv = process.argv.slice(2);
if (argv.includes('--self-test')) selfTest();
else {
  const pieceArg = argv.includes('--piece') ? argv[argv.indexOf('--piece') + 1] : null;
  let piece = pieceArg;
  if (!piece) {
    try {
      const imagesRealPath = fs.realpathSync(path.join(ROOT, 'video', 'public', 'images'));
      piece = path.basename(path.dirname(imagesRealPath));
    } catch {
      console.error('找不到当前片。请指定 --piece <片目录名>，或先运行 use-piece.mjs。');
      process.exit(2);
    }
  }
  const pieceDir = path.join(ROOT, 'pieces', piece);
  const imageReview = validateVisualReview(pieceDir);
  const videoReview = validateDeliveryReview(pieceDir);
  console.log('成片发布前验收：' + piece);
  imageReview.errors.forEach((x) => console.error('  [视觉记录错误] ' + x));
  imageReview.failed.forEach((x) => console.error('  [图片未通过] ' + x));
  imageReview.pending.forEach((x) => console.error('  [图片待验收] ' + x));
  videoReview.errors.forEach((x) => console.error('  [成片记录错误] ' + x));
  videoReview.failed.forEach((x) => console.error('  [成片未通过] ' + x));
  videoReview.pending.forEach((x) => console.error('  [成片待验收] ' + x));
  if (imageReview.exceptions.length) {
    console.warn('  [图片例外] ' + imageReview.exceptions.length + ' 项，仅限当前片');
  }
  if (imageReview.errors.length || imageReview.failed.length || imageReview.pending.length ||
      videoReview.errors.length || videoReview.failed.length || videoReview.pending.length) {
    console.error('结论：发布前验收未通过。须完成逐图视觉验收、完整播放成片并绑定当前文件哈希；本脚本不会自动判断画面或声音质量。');
    process.exit(1);
  }
  console.log('结论：验收记录完整、文件哈希匹配，且没有待验或失败项。人工判断的真实性仍须以实际复核为准。');
}
