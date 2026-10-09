from pathlib import Path
import base64,json,os,re,urllib.request,urllib.error,uuid,wave,sys,hashlib
from voiceover_utils import captions_for, clean, normalize_word_times, split_golden_prefix
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
if not -50 <= rate <= 100:raise SystemExit(f'VOLC_TTS_SPEECH_RATE 超出 [-50, 100]：{rate}')
fast_raw=local_env.get('VOLC_TTS_GOLDEN3S_SPEECH_RATE')
fast_rate=int(re.match(r'-?\d+',fast_raw).group()) if fast_raw else min(rate+10,100)
if not -50 <= fast_rate <= 100:raise SystemExit(f'VOLC_TTS_GOLDEN3S_SPEECH_RATE 超出 [-50, 100]：{fast_rate}')
if fast_rate <= rate:raise SystemExit(f'黄金三秒语速必须高于正常语速：当前普通语速={rate}，黄金三秒语速={fast_rate}；请降低 VOLC_TTS_SPEECH_RATE 或提高 VOLC_TTS_GOLDEN3S_SPEECH_RATE（最高 100）')
if not -50 <= loudness <= 100:raise SystemExit(f'VOLC_TTS_LOUDNESS_RATE 超出 [-50, 100]：{loudness}')
print(f'TTS 配置来源={voice_source}｜音色={speaker}｜资源={resource}｜普通语速={rate}｜黄金三秒语速={fast_rate}｜响度={loudness}',flush=True)

SAMPLE_RATE=24000
BYTES_PER_SECOND=SAMPLE_RATE*2  # mono 16-bit PCM
def synthesize(text, speech_rate):
 payload={'user':{'uid':'quandao-video'},'req_params':{'text':text,'speaker':speaker,'audio_params':{'format':'pcm','sample_rate':SAMPLE_RATE,'speech_rate':speech_rate,'loudness_rate':loudness,'enable_subtitle':True}}}
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
 if not complete or not audio:raise RuntimeError(f'Incomplete TTS response for segment: {text[:24]}')
 pcm=b''.join(audio);duration=len(pcm)/BYTES_PER_SECOND
 words=[w for sentence in sentences for w in sentence.get('words',[])]
 return pcm,duration,sentences,normalize_word_times(words,duration)

for shot_index,shot in enumerate(project['shots']):
 out=PROJECT/'public'/shot['audio'];out.parent.mkdir(parents=True,exist_ok=True)
 is_first_shot=shot_index==0
 if is_first_shot:
  prefix,suffix=split_golden_prefix(shot['voice'],rate,fast_rate)
  segment_plan=[(prefix,fast_rate,'golden3s')]
  if suffix:segment_plan.append((suffix,rate,'normal'))
 else:
  segment_plan=[(shot['voice'],rate,'normal')]
 signature_input=[shot['voice'],speaker,rate,loudness,resource]
 if is_first_shot:
  signature_input.append({'strategy':'golden3s-piecewise-v1','segments':[{'text':t,'rate':r,'kind':k} for t,r,k in segment_plan]})
 signature=hashlib.sha256(json.dumps(signature_input,ensure_ascii=False).encode()).hexdigest()
 if out.exists() and meta['shots'].get(str(shot['id']),{}).get('signature')==signature:
  print('Reuse voice',shot['id'],flush=True);continue

 audio_parts=[];segments_for_meta=[];provider_sentences=[];all_words=[];offset=0.0
 for segment_no,(segment_text,segment_rate,kind) in enumerate(segment_plan,1):
  segment_pcm,segment_duration,sentences,segment_words=synthesize(segment_text,segment_rate)
  audio_parts.append(segment_pcm)
  for word in segment_words:
   shifted=dict(word)
   shifted['startTime']=float(shifted.get('startTime',0))+offset
   shifted['endTime']=float(shifted.get('endTime',shifted['startTime']))+offset
   all_words.append(shifted)
  segments_for_meta.append({
   'segment':segment_no,'kind':kind,'speech_rate':segment_rate,
   'start':offset,'end':offset+segment_duration,'text':segment_text
  })
  provider_sentences.append({'segment':segment_no,'data':sentences})
  print(f'  segment {segment_no}/{len(segment_plan)} · {kind} · rate={segment_rate} · {segment_duration:.2f}s',flush=True)
  offset+=segment_duration

 pcm=b''.join(audio_parts);duration=len(pcm)/BYTES_PER_SECOND
 with wave.open(str(out),'wb') as f:f.setnchannels(1);f.setsampwidth(2);f.setframerate(SAMPLE_RATE);f.writeframes(pcm)
 captions=captions_for(shot['voice'],all_words,duration,shot.get('captions'))
 (out.with_suffix('.timestamps.json')).write_text(json.dumps({
  'duration':duration,'wordTimelineUnit':'seconds','segments':segments_for_meta,
  'providerSentencesRaw':provider_sentences,'words':all_words
 },ensure_ascii=False,indent=2),encoding='utf-8')
 meta['shots'][str(shot['id'])]={'duration':duration,'captions':captions,'signature':signature,'speaker':speaker}
 meta['status']='ready' if all(str(s['id']) in meta['shots'] and (PROJECT/'public'/s['audio']).exists() for s in project['shots']) else 'in-progress'
 metaPath.write_text(json.dumps(meta,ensure_ascii=False,indent=2),encoding='utf-8')
 print(f'Voice {shot["id"]}: {duration:.2f}s, {len(captions)} captions',flush=True)

# 全量复用（未重新合成任何一段）时也要把 status 收敛，否则它会永远停在 in-progress
meta['status']='ready' if all(str(s['id']) in meta['shots'] and (PROJECT/'public'/s['audio']).exists() for s in project['shots']) else 'in-progress'
metaPath.write_text(json.dumps(meta,ensure_ascii=False,indent=2),encoding='utf-8')
print('All voice tracks ready',flush=True)

