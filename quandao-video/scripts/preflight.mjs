import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 工程目录由脚本位置推出，不依赖当前工作目录：在仓库根跑和在 video/ 跑，结果必须一样。
const VIDEO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'video');
const pj = path.join(VIDEO, 'src', 'project.json');
if (!fs.existsSync(pj)) { console.error(`找不到 Remotion 工程：${pj}。确认这条工作区的 video/ 目录在位。`); process.exit(2); }

const p=JSON.parse(fs.readFileSync(pj,'utf8'));
const m=JSON.parse(fs.readFileSync(path.join(VIDEO,'src','voiceover-meta.json'),'utf8'));
if(!p.shots.length){console.error('工程当前没有片数据：src/project.json 的 shots 为空。先由 mac-director 出导演稿、quandao-video 写入后再跑。');process.exit(1);}
let missing=[];
for(const s of p.shots){for(const name of [...s.images,s.audio])if(!fs.existsSync(path.join(VIDEO,'public',name)))missing.push(name);if(!m.shots[s.id]?.duration||!m.shots[s.id]?.captions?.length)missing.push('timing:'+s.id);}
if(m.status!=='ready')missing.push('TTS status must be ready');
if(missing.length){console.error('尚缺：\n'+missing.join('\n'));process.exit(1);}
const img=p.shots.reduce((n,s)=>n+s.images.length,0);
console.log(`${img} 张图、${p.shots.length} 条音频与字幕时间轴已就绪。`);
