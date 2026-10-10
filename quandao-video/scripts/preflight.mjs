import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const VIDEO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'video');
const PUBLIC = path.join(VIDEO, 'public');
const projectPath = path.join(VIDEO, 'src', 'project.json');
const metaPath = path.join(VIDEO, 'src', 'voiceover-meta.json');

function dimensionsFromBuffer(buf) {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buf.length >= 24 && buf.subarray(0, 8).equals(png)) {
    const width = buf.readUInt32BE(16), height = buf.readUInt32BE(20);
    if (width > 0 && height > 0) return { width, height, format: 'png' };
  }
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let offset = 2;
    while (offset + 4 < buf.length) {
      if (buf[offset] !== 0xff) { offset++; continue; }
      while (offset < buf.length && buf[offset] === 0xff) offset++;
      if (offset >= buf.length) break;
      const marker = buf[offset++];
      if (marker === 0xd9 || marker === 0xda) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (offset + 1 >= buf.length) break;
      const segmentLength = buf.readUInt16BE(offset);
      if (segmentLength < 2 || offset + segmentLength > buf.length) break;
      const sof = [0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker);
      if (sof && segmentLength >= 7) {
        const height = buf.readUInt16BE(offset + 3), width = buf.readUInt16BE(offset + 5);
        if (width > 0 && height > 0) return { width, height, format: 'jpeg' };
      }
      offset += segmentLength;
    }
  }
  throw new Error('不支持或无法读取图片尺寸（仅支持 PNG/JPEG）');
}
const is4x3 = ({ width, height }) => width > 0 && height > 0 && width * 3 === height * 4;

function shotConfigProblems(shot) {
  const problems = [];
  if (!Array.isArray(shot.images) || shot.images.length === 0) problems.push('images 必须是至少含一张图片的数组');
  if (Array.isArray(shot.images) && (!Array.isArray(shot.imageCrop) ||
      shot.imageCrop.length !== shot.images.length || shot.imageCrop.some((v) => typeof v !== 'boolean'))) {
    problems.push('imageCrop 必须是与 images 一一对应的布尔数组（false=不裁角，true=按配置放大裁切）');
  }
  if (typeof shot.audio !== 'string' || !shot.audio) problems.push('audio 必须指定音频文件');
  if (typeof shot.voice !== 'string' || !Array.isArray(shot.captions) ||
      shot.captions.some((c) => typeof c !== 'string') || shot.captions.join('') !== shot.voice) {
    problems.push('project.json 的 captions 必须逐字拼回该镜 voice');
  }
  return problems;
}
function publicPath(name) {
  if (typeof name !== 'string' || !name) return null;
  const target = path.resolve(PUBLIC, name), rel = path.relative(PUBLIC, target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return target;
}
function selfTest() {
  const header = (w,h) => {
    const b=Buffer.alloc(24);
    Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]).copy(b,0);
    b.writeUInt32BE(w,16); b.writeUInt32BE(h,20); return b;
  };
  const checks=[];
  const good=dimensionsFromBuffer(header(2364,1773)), bad=dimensionsFromBuffer(header(1536,1024));
  checks.push(['PNG 像素尺寸解析与 4:3 判断',good.width===2364&&good.height===1773&&is4x3(good)]);
  checks.push(['非 4:3 图片会被识别',!is4x3(bad)]);
  checks.push(['空图片数组会被拒绝',shotConfigProblems({images:[],imageCrop:[],audio:'audio/s1.wav',voice:'x',captions:['x']}).some(x=>x.startsWith('images'))]);
  checks.push(['裁切标记必须与图片一一对应',shotConfigProblems({images:['images/a.png'],imageCrop:[],audio:'audio/s1.wav',voice:'x',captions:['x']}).some(x=>x.startsWith('imageCrop'))]);
  checks.push(['字幕计划必须与口播逐字一致',shotConfigProblems({images:['images/a.png'],imageCrop:[false],audio:'audio/s1.wav',voice:'你好',captions:['你好啊']}).some(x=>x.includes('逐字拼回'))]);
  const failed=checks.filter(([,ok])=>!ok);
  for (const [name,ok] of checks) console.log(`${ok?'PASS':'FAIL'} · ${name}`);
  console.log(`自检结果：${checks.length-failed.length}/${checks.length}`);
  process.exit(failed.length?1:0);
}
if (process.argv.includes('--self-test')) selfTest();

if (!fs.existsSync(projectPath)) { console.error(`找不到 Remotion 工程：${projectPath}。先运行 node scripts/use-piece.mjs <片名>。`); process.exit(2); }
if (!fs.existsSync(metaPath)) { console.error(`找不到 TTS 元数据：${metaPath}。先运行 TTS 流程。`); process.exit(2); }
const p=JSON.parse(fs.readFileSync(projectPath,'utf8')), m=JSON.parse(fs.readFileSync(metaPath,'utf8'));
if (!Array.isArray(p.shots)||!p.shots.length) { console.error('工程当前没有片数据：src/project.json 的 shots 为空。先完成导演稿与工程数据。'); process.exit(1); }

const issues=[];
for (const s of p.shots) {
  for (const problem of shotConfigProblems(s)) issues.push(`镜${s.id}: ${problem}`);
  const assets=[];
  if (Array.isArray(s.images)) for (const name of s.images) assets.push({name,kind:'图片'});
  if (typeof s.audio==='string'&&s.audio) assets.push({name:s.audio,kind:'音频'});
  for (const asset of assets) {
    const file=publicPath(asset.name);
    if (!file) { issues.push(`镜${s.id}: ${asset.kind}路径非法：${asset.name}`); continue; }
    if (!fs.existsSync(file)) { issues.push(`镜${s.id}: 缺少${asset.kind}：${asset.name}`); continue; }
    if (asset.kind==='图片') {
      try {
        const d=dimensionsFromBuffer(fs.readFileSync(file));
        if (!is4x3(d)) issues.push(`镜${s.id}: 图片比例不合格：${asset.name} = ${d.width}×${d.height}（要求严格 4:3）`);
      } catch(e) { issues.push(`镜${s.id}: 无法验收图片尺寸：${asset.name}（${e.message}）`); }
    }
  }
  const ms=m.shots?.[String(s.id)];
  if (!ms||!Number.isFinite(ms.duration)||ms.duration<=0||!Array.isArray(ms.captions)||!ms.captions.length) {
    issues.push(`镜${s.id}: voiceover-meta.json 缺有效 duration/captions`);
  } else if (ms.captions.map(c=>String(c.text??'')).join('')!==s.voice) {
    issues.push(`镜${s.id}: voiceover-meta.json 字幕与当前口播不一致`);
  }
  if (typeof s.audio==='string'&&s.audio) {
    const timestampName=s.audio.replace(/\.(?:wav|mp3|m4a)$/iu,'.timestamps.json'), timestampFile=publicPath(timestampName);
    if (!timestampFile||!fs.existsSync(timestampFile)) issues.push(`镜${s.id}: 缺语音词级时间戳文件：${timestampName}`);
    else {
      try {
        const t=JSON.parse(fs.readFileSync(timestampFile,'utf8'));
        if (!Number.isFinite(t.duration)||t.duration<=0||!Array.isArray(t.words)||!t.words.length) issues.push(`镜${s.id}: 时间戳文件缺 duration 或 words：${timestampName}`);
      } catch { issues.push(`镜${s.id}: 时间戳文件不是有效 JSON：${timestampName}`); }
    }
  }
}
if (m.status!=='ready') issues.push('TTS status 必须为 ready');
const expected=new Set(p.shots.map(s=>String(s.id)));
for (const id of Object.keys(m.shots||{})) if (!expected.has(id)) issues.push(`voiceover-meta.json 存在多余镜头记录：${id}`);
if (issues.length) { console.error('素材预检不通过：\n'+[...new Set(issues)].map(x=>' - '+x).join('\n')); process.exit(1); }
const imageCount=p.shots.reduce((n,s)=>n+s.images.length,0);
console.log(`素材预检通过：${imageCount} 张严格 4:3 图片、${p.shots.length} 条音频、逐字对齐的字幕计划及词级时间戳均已就绪。`);
