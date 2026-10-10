import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

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
function extensionMatchesFormat(filename, format) {
  const ext = path.extname(filename).toLowerCase();
  if (format === 'png') return ext === '.png';
  if (format === 'jpeg') return ext === '.jpg' || ext === '.jpeg';
  return false;
}

const TIMING_TOLERANCE_SECONDS = 0.15;
const WORD_START_ORDER_TOLERANCE_SECONDS = 0.03;

function comparableText(value) {
  return String(value ?? '').replace(/[^\w一-鿿]/gu, '');
}

function wavDurationFromBuffer(buf) {
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF' ||
      buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('音频不是有效的 RIFF/WAVE 文件');
  }
  let offset = 12, byteRate = 0, dataBytes = null;
  while (offset + 8 <= buf.length) {
    const chunkId = buf.toString('ascii', offset, offset + 4);
    const chunkSize = buf.readUInt32LE(offset + 4);
    const chunkStart = offset + 8;
    if (chunkSize > buf.length - chunkStart) throw new Error('WAV 分块长度超出文件边界');
    if (chunkId === 'fmt ') {
      if (chunkSize < 16) throw new Error('WAV fmt 分块长度不足');
      byteRate = buf.readUInt32LE(chunkStart + 8);
    } else if (chunkId === 'data') {
      dataBytes = chunkSize;
    }
    offset = chunkStart + chunkSize + (chunkSize % 2);
  }
  if (!byteRate || dataBytes === null) throw new Error('WAV 缺少有效 fmt/data 分块');
  const duration = dataBytes / byteRate;
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('WAV 计算出的真实时长无效');
  return duration;
}

function audioDurationFromFile(file, filename) {
  const ext = path.extname(filename).toLowerCase();
  const buf = fs.readFileSync(file);
  const isWave = buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' &&
    buf.toString('ascii', 8, 12) === 'WAVE';
  if (ext === '.wav' || isWave) return wavDurationFromBuffer(buf);

  const result = spawnSync('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1', file
  ], { encoding: 'utf8', timeout: 10000 });
  if (result.error?.code === 'ENOENT') {
    throw new Error('非 WAV 音频需要 ffprobe 才能核验真实时长；请安装 ffmpeg/ffprobe');
  }
  if (result.error) throw new Error(`ffprobe 无法读取音频：${result.error.message}`);
  const duration = Number(String(result.stdout || '').trim());
  if (result.status !== 0 || !Number.isFinite(duration) || duration <= 0) {
    throw new Error(`ffprobe 未返回有效音频时长：${String(result.stderr || '').trim()}`);
  }
  return duration;
}

function timestampProblems(t, voice, audioDuration = null) {
  const problems = [];
  if (!t || !Number.isFinite(t.duration) || t.duration <= 0 ||
      !Array.isArray(t.words) || !t.words.length) {
    return ['时间戳文件缺有效 duration 或 words'];
  }
  if (t.wordTimelineUnit !== 'seconds') problems.push('wordTimelineUnit 必须明确标记为 seconds');

  const expected = comparableText(voice);
  const actual = comparableText(t.words.map((w) => typeof w?.word === 'string' ? w.word : '').join(''));
  if (!expected) problems.push('当前口播不含可用于词级对齐的文字或数字');
  else if (actual !== expected) {
    problems.push(`词级时间戳文本与当前口播不一致（时间戳 ${actual.length} 字符，口播 ${expected.length} 字符）`);
  }

  let previousStart = null;
  t.words.forEach((word, index) => {
    const label = `词级时间戳第${index + 1}项`;
    if (!word || typeof word.word !== 'string' || !word.word.trim()) {
      problems.push(`${label}缺少有效 word 文本`);
    }
    const start = word?.startTime, end = word?.endTime;
    if (!Number.isFinite(start) || !Number.isFinite(end)) {
      problems.push(`${label}缺少有效 startTime/endTime`);
      return;
    }
    if (start < -WORD_START_ORDER_TOLERANCE_SECONDS || end <= start) {
      problems.push(`${label}时间范围无效（${start}–${end} 秒）`);
    }
    if (previousStart !== null && start + WORD_START_ORDER_TOLERANCE_SECONDS < previousStart) {
      problems.push(`${label}的 startTime 倒退，词级时间轴顺序不正确`);
    }
    previousStart = start;
    if (end > t.duration + TIMING_TOLERANCE_SECONDS) {
      problems.push(`${label}结束时间超出时间戳 duration`);
    }
    if (Number.isFinite(audioDuration) && end > audioDuration + TIMING_TOLERANCE_SECONDS) {
      problems.push(`${label}结束时间超出真实音频时长`);
    }
  });

  if (Number.isFinite(audioDuration) &&
      Math.abs(t.duration - audioDuration) > TIMING_TOLERANCE_SECONDS) {
    problems.push(
      `时间戳 duration ${t.duration.toFixed(3)}s 与真实音频时长 ${audioDuration.toFixed(3)}s 相差超过 ${TIMING_TOLERANCE_SECONDS.toFixed(2)}s`
    );
  }
  return problems;
}

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
  checks.push(['PNG 内容必须使用 .png 扩展名',extensionMatchesFormat('images/a.png','png')]);
  checks.push(['JPEG 内容不能伪装成 .png',!extensionMatchesFormat('images/a.png','jpeg')]);
  checks.push(['JPEG 内容允许 .jpg 与 .jpeg',extensionMatchesFormat('images/a.jpg','jpeg')&&extensionMatchesFormat('images/a.jpeg','jpeg')]);
  checks.push(['空图片数组会被拒绝',shotConfigProblems({images:[],imageCrop:[],audio:'audio/s1.wav',voice:'x',captions:['x']}).some(x=>x.startsWith('images'))]);
  checks.push(['裁切标记必须与图片一一对应',shotConfigProblems({images:['images/a.png'],imageCrop:[],audio:'audio/s1.wav',voice:'x',captions:['x']}).some(x=>x.startsWith('imageCrop'))]);
  checks.push(['字幕计划必须与口播逐字一致',shotConfigProblems({images:['images/a.png'],imageCrop:[false],audio:'audio/s1.wav',voice:'你好',captions:['你好啊']}).some(x=>x.includes('逐字拼回'))]);
  const alignedTiming={duration:1,wordTimelineUnit:'seconds',words:[
    {word:'宠物',startTime:0.1,endTime:0.3},{word:'店。',startTime:0.3,endTime:0.5}
  ]};
  checks.push(['词级时间戳文本必须拼回当前口播',timestampProblems(alignedTiming,'宠物店。',1).length===0]);
  checks.push(['词级时间戳不匹配口播时会被拒绝',timestampProblems({...alignedTiming,words:[{word:'宠物狗',startTime:0.1,endTime:0.3}]},'宠物店。',1).some(x=>x.includes('文本与当前口播不一致'))]);
  checks.push(['词级时间戳倒序时会被拒绝',timestampProblems({...alignedTiming,words:[
    {word:'宠物',startTime:0.4,endTime:0.6},{word:'店。',startTime:0.1,endTime:0.3}
  ]},'宠物店。',1).some(x=>x.includes('startTime 倒退'))]);
  checks.push(['时间戳与真实音频时长偏差过大时会被拒绝',timestampProblems(alignedTiming,'宠物店。',1.4).some(x=>x.includes('真实音频时长'))]);
  const wavFixture=()=>{
    const sampleRate=8000, dataBytes=sampleRate;
    const b=Buffer.alloc(44+dataBytes);
    b.write('RIFF',0,'ascii'); b.writeUInt32LE(36+dataBytes,4); b.write('WAVE',8,'ascii');
    b.write('fmt ',12,'ascii'); b.writeUInt32LE(16,16); b.writeUInt16LE(1,20);
    b.writeUInt16LE(1,22); b.writeUInt32LE(sampleRate,24); b.writeUInt32LE(sampleRate*2,28);
    b.writeUInt16LE(2,32); b.writeUInt16LE(16,34); b.write('data',36,'ascii'); b.writeUInt32LE(dataBytes,40);
    return b;
  };
  checks.push(['WAV 真实时长从 PCM 数据长度计算',Math.abs(wavDurationFromBuffer(wavFixture())-0.5)<1e-9]);
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
  let actualAudioDuration = null;
  if (Array.isArray(s.images)) for (const name of s.images) assets.push({name,kind:'图片'});
  if (typeof s.audio==='string'&&s.audio) assets.push({name:s.audio,kind:'音频'});
  for (const asset of assets) {
    const file=publicPath(asset.name);
    if (!file) { issues.push(`镜${s.id}: ${asset.kind}路径非法：${asset.name}`); continue; }
    if (!fs.existsSync(file)) { issues.push(`镜${s.id}: 缺少${asset.kind}：${asset.name}`); continue; }
    if (asset.kind==='音频') {
      try { actualAudioDuration = audioDurationFromFile(file, asset.name); }
      catch(e) { issues.push(`镜${s.id}: 无法核验音频真实时长：${asset.name}（${e.message}）`); }
    }
    if (asset.kind==='图片') {
      try {
        const d=dimensionsFromBuffer(fs.readFileSync(file));
        if (!extensionMatchesFormat(asset.name, d.format)) issues.push(`镜${s.id}: 图片实际格式为 ${d.format}，但文件扩展名与格式不一致：${asset.name}`);
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
  if (ms && Number.isFinite(ms.duration) && Number.isFinite(actualAudioDuration) &&
      Math.abs(ms.duration - actualAudioDuration) > TIMING_TOLERANCE_SECONDS) {
    issues.push(`镜${s.id}: voiceover-meta.json 时长 ${ms.duration.toFixed(3)}s 与真实音频时长 ${actualAudioDuration.toFixed(3)}s 不一致`);
  }
  if (typeof s.audio==='string'&&s.audio) {
    const timestampName=s.audio.replace(/\.(?:wav|mp3|m4a)$/iu,'.timestamps.json'), timestampFile=publicPath(timestampName);
    if (!timestampFile||!fs.existsSync(timestampFile)) issues.push(`镜${s.id}: 缺语音词级时间戳文件：${timestampName}`);
    else {
      try {
        const t=JSON.parse(fs.readFileSync(timestampFile,'utf8'));
        for (const problem of timestampProblems(t, s.voice, actualAudioDuration)) {
          issues.push(`镜${s.id}: ${problem}：${timestampName}`);
        }
      } catch { issues.push(`镜${s.id}: 时间戳文件不是有效 JSON：${timestampName}`); }
    }
  }
}
if (m.status!=='ready') issues.push('TTS status 必须为 ready');
const expected=new Set(p.shots.map(s=>String(s.id)));
for (const id of Object.keys(m.shots||{})) if (!expected.has(id)) issues.push(`voiceover-meta.json 存在多余镜头记录：${id}`);
if (issues.length) { console.error('素材预检不通过：\n'+[...new Set(issues)].map(x=>' - '+x).join('\n')); process.exit(1); }
const imageCount=p.shots.reduce((n,s)=>n+s.images.length,0);
console.log(`素材预检通过：${imageCount} 张严格 4:3 图片、${p.shots.length} 条音频；字幕与口播逐字一致，词级时间戳文本／顺序及时间戳、TTS 元数据与真实音频时长均已核对。`);
