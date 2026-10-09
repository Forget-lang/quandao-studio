from pathlib import Path
import base64,json,os,re,urllib.request,urllib.error,uuid,wave,sys,hashlib
# 技能目录（放 .env）与 Remotion 工程目录（放 src/ 与 public/）是两个地方，此前混成一个 ROOT，
# 结果音频落在 quandao-video/public/，而 staticFile() 只读 video/public/。
SKILL_DIR=Path(__file__).resolve().parents[1]
PROJECT=SKILL_DIR.parent/'video'
PROMOTION_ENV_PATH=SKILL_DIR.parent.parent/'promotion/.env'
if not PROJECT.is_dir():raise SystemExit(f'找不到 Remotion 工程目录 {PROJECT}；本脚本假定布局为 <工作区>/quandao-video/scripts/ 与 <工作区>/video/')
def load_env(p):
 d={}
 if p.exists():
  for line in p.read_text(encoding='utf-8-sig').splitlines():
   if '=' in line and not line.lstrip().startswith('#'):
    k,v=line.split('=',1);d[k.strip()]=v.strip().strip('"').strip("'")
 return d
local_env=load_env(SKILL_DIR/'.env')
# 语音合成配置以 promotion 为准（用户 2026-09-28 指定：密钥＋品牌音色单一来源）；
# promotion/.env 缺项时才回落技能本地 .env，两处都缺则显式报错，不静默用默认音色出片。
promo_env=load_env(PROMOTION_ENV_PATH)
key=promo_env.get('VOLC_TTS_API_KEY') or local_env.get('VOLC_TTS_API_KEY','')
speaker=promo_env.get('SPEAKER_ID') or local_env.get('VOLC_TTS_SPEAKER','')
resource=promo_env.get('RESOURCE_ID') or local_env.get('VOLC_TTS_RESOURCE_ID','seed-tts-2.0')
voice_source='promotion/.env' if promo_env.get('VOLC_TTS_API_KEY') else 'skill .env'
if not key:raise SystemExit(f'缺 VOLC_TTS_API_KEY：查过 {PROMOTION_ENV_PATH} 与 {SKILL_DIR/".env"}，两处都没有')
if not speaker:raise SystemExit(f'缺音色配置：promotion/.env 的 SPEAKER_ID 与技能 .env 的 VOLC_TTS_SPEAKER 都为空')
project=json.loads((PROJECT/'src/project.json').read_text(encoding='utf-8'))
# 空工程直接退出：否则下面的收敛逻辑会因 0==0 把 status 写成 ready，造出一个没有素材的假就绪声明。
if not project['shots']:raise SystemExit(f'{PROJECT/"src/project.json"} 的 shots 为空，没有可合成的口播')
metaPath=PROJECT/'src/voiceover-meta.json'
meta=json.loads(metaPath.read_text(encoding='utf-8'))
rate=int(re.match(r'-?\d+',local_env.get('VOLC_TTS_SPEECH_RATE','0')).group())
loudness=int(re.match(r'-?\d+',local_env.get('VOLC_TTS_LOUDNESS_RATE','50')).group())
print(f'TTS 配置来源={voice_source}｜音色={speaker}｜资源={resource}｜语速={rate}｜响度={loudness}',flush=True)
clean=lambda t:re.sub(r'[^\w\u4e00-\u9fff]','',t)
def captions_for(text,words,duration,plan=None):
 if plan is not None:
  # 手写切分必须逐字覆盖原文：时间轴是按字符数对位的，少一个字就会整体错位。
  if ''.join(plan)!=text:raise RuntimeError(f'字幕切分计划与口播原文不一致，无法对位时间轴：计划拼回「{"".join(plan)}」')
  pieces=list(plan)
 else:
  pieces=[]
  for clause in re.findall(r'[^，。！？：；、]+[，。！？：；、]?',text):
   # 等分而不是从开头硬切 14 字：后者会留下「来，」这种一两字的零头，
   # 把词从中间剁断，违反 §9.3「避免一句话说到一半突然换字」。
   if len(clause)<=15:
    pieces.append(clause)
   else:
    parts=-(-len(clause)//15);size=-(-len(clause)//parts)
    pieces.extend(clause[i:i+size] for i in range(0,len(clause),size))
 timeline=[]
 for w in words:
  token=clean(w.get('word',''));a=float(w.get('startTime',0));b=float(w.get('endTime',a))
  for i,ch in enumerate(token):timeline.append((ch,a+(b-a)*i/max(1,len(token)),a+(b-a)*(i+1)/max(1,len(token))))
 if ''.join(x[0] for x in timeline)!=clean(text):raise RuntimeError('Subtitle text mismatch; inspect saved raw word timestamps before proceeding')
 cursor=0;result=[]
 for piece in pieces:
  n=len(clean(piece))
  if n:
   result.append({'text':piece,'start':timeline[cursor][1],'end':timeline[cursor+n-1][2]});cursor+=n
 for i,c in enumerate(result):c['end']=result[i+1]['start'] if i+1<len(result) else duration
 if result:result[0]['start']=0
 return result
for shot in project['shots']:
 out=PROJECT/'public'/shot['audio'];out.parent.mkdir(parents=True,exist_ok=True)
 signature=hashlib.sha256(json.dumps([shot['voice'],speaker,rate,loudness,resource],ensure_ascii=False).encode()).hexdigest()
 if out.exists() and meta['shots'].get(str(shot['id']),{}).get('signature')==signature:
  print('Reuse voice',shot['id'],flush=True);continue
 payload={'user':{'uid':'quandao-video'},'req_params':{'text':shot['voice'],'speaker':speaker,'audio_params':{'format':'pcm','sample_rate':24000,'speech_rate':rate,'loudness_rate':loudness,'enable_subtitle':True}}}
 request=urllib.request.Request('https://openspeech.bytedance.com/api/v3/tts/unidirectional/sse',data=json.dumps(payload).encode(),headers={'Content-Type':'application/json','X-Api-Key':key,'X-Api-Resource-Id':resource,'X-Api-Request-Id':str(uuid.uuid4())})
 audio=[];sentences=[];complete=False
 try:
  with urllib.request.urlopen(request,timeout=150) as response:
   for line in response:
    line=line.decode('utf-8').strip()
    if not line.startswith('data:'):continue
    event=json.loads(line[5:].strip());code=event.get('code',0)
    if code not in (0,20000000):raise RuntimeError(f'TTS service error {code}: {event.get("message","")}')
    if event.get('data'):audio.append(base64.b64decode(event['data']))
    if event.get('sentence'):sentences.append(event['sentence'])
    if code==20000000:complete=True
 except urllib.error.HTTPError as e:
  raise SystemExit(f'TTS HTTP {e.code}; verify local API configuration')
 if not complete or not audio:raise RuntimeError('Incomplete TTS response')
 pcm=b''.join(audio);duration=len(pcm)/48000
 with wave.open(str(out),'wb') as f:f.setnchannels(1);f.setsampwidth(2);f.setframerate(24000);f.writeframes(pcm)
 words=[w for s in sentences for w in s.get('words',[])]
 (out.with_suffix('.timestamps.json')).write_text(json.dumps(sentences,ensure_ascii=False,indent=2),encoding='utf-8')
 captions=captions_for(shot['voice'],words,duration,shot.get('captions'))
 meta['shots'][str(shot['id'])]={'duration':duration,'captions':captions,'signature':signature,'speaker':speaker}
 meta['status']='ready' if len(meta['shots'])==len(project['shots']) else 'in-progress'
 metaPath.write_text(json.dumps(meta,ensure_ascii=False,indent=2),encoding='utf-8')
 print(f'Voice {shot["id"]}: {duration:.2f}s, {len(captions)} captions',flush=True)
# 全量复用（未重新合成任何一段）时也要把 status 收敛，否则它会永远停在 in-progress
meta['status']='ready' if len(meta['shots'])==len(project['shots']) else 'in-progress'
metaPath.write_text(json.dumps(meta,ensure_ascii=False,indent=2),encoding='utf-8')
print('All voice tracks ready',flush=True)

