import projectJson from './project.json';
import metaJson from './voiceover-meta.json';

export type Caption = { text: string; start: number; end: number };
export type MetaShot = { duration?: number; captions?: Caption[]; signature?: string; speaker?: string };
export type Shot = {
  id: number;
  title: string;
  voice: string;
  audio: string;
  images: string[];
  imageWeights?: number[];
};

export const FPS: number = (projectJson as any).fps ?? 30;
export const shots: Shot[] = (projectJson as any).shots;

/**
 * 全片固定标题（≤10 字的一句痛点），顶部标题区从头到尾只显示它，不随分镜变。
 * 2026-09-30 用户反馈定：「标题就是一直展示此视频要说的痛点」「10 个字要抓痛点」。
 * 缺失即报错——它是硬门槛，不允许静默渲染出一条没有痛点标题的片子。
 */
export const pieceTitle: string = String((projectJson as any).pieceTitle ?? '');
if (!pieceTitle) {
  throw new Error('project.json 缺 pieceTitle（全片固定标题，≤10 字）。先在片数据里补上这一句再渲染。');
}
const metaShots: Record<string, MetaShot> = ((metaJson as any).shots ?? {}) as Record<string, MetaShot>;

/** 项目口径：口播语速 ≤6 字/秒。无真实语音时长时按此估算，仅用于 TTS 前的预览。 */
export const cleanLen = (t: string) => t.replace(/[^\w一-鿿]/g, '').length;
const estimatedSec = (s: Shot) => cleanLen(s.voice) / 6;

export const hasRealVoice = (s: Shot) => Boolean(metaShots[String(s.id)]?.duration);
export const shotDurationSec = (s: Shot) => metaShots[String(s.id)]?.duration ?? estimatedSec(s);
export const framesOf = (sec: number) => Math.max(1, Math.round(sec * FPS));
export const totalFrames = shots.reduce((n, s) => n + framesOf(shotDurationSec(s)), 0);
export const shotStartFrames = (index: number) =>
  shots.slice(0, index).reduce((n, s) => n + framesOf(shotDurationSec(s)), 0);

/**
 * 字幕时间戳单位对齐：generate_voiceover.py 写入的 captions 与 duration 必须同一单位；
 * 历史上该脚本混用过毫秒与秒，这里按「最大值是否远大于时长」兜底判定。
 */
export const captionsOf = (s: Shot): Caption[] => {
  const raw = metaShots[String(s.id)]?.captions ?? [];
  if (!raw.length) return [];
  const dur = shotDurationSec(s);
  const maxEnd = Math.max(...raw.map((c) => c.end));
  const factor = maxEnd > dur * 10 ? 1000 : 1;
  return raw.map((c) => ({ text: c.text, start: c.start / factor, end: c.end / factor }));
};

/** 每张图的显示区间（权重前置，服务「黄金 3 秒画面要跟声」） */
export const imageSegments = (s: Shot) => {
  const total = framesOf(shotDurationSec(s));
  if (!s.images.length) return [];
  const weights =
    s.imageWeights && s.imageWeights.length === s.images.length
      ? s.imageWeights
      : s.images.map(() => 1 / s.images.length);
  const sum = weights.reduce((a, b) => a + b, 0);
  let acc = 0;
  return s.images.map((img, i) => {
    const from = acc;
    acc += i === weights.length - 1 ? total - acc : Math.round((weights[i] / sum) * total);
    return { img, from, durationInFrames: Math.max(1, acc - from) };
  });
};

/**
 * 叠加层：券名、字段名、图标等"必须逐字准确"的内容不交给生图模型，
 * 由这里按坐标叠在空白卡面上（依据 mac-director §10.9/§7.5 与 SKILL.md:104）。
 */
export type Overlay = {
  kind: string;
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
  rotate?: number;
  fontSize?: number;
  color?: string;
  icon?: 'grape' | 'clock' | 'limit';
  iconSize?: number;
  iconX?: number;
  iconY?: number;
  chips?: { text: string; fontSize?: number; color?: string; bg?: string }[];
};
const overlayMap: Record<string, Overlay[]> = ((projectJson as any).overlayMap ?? {}) as Record<string, Overlay[]>;
export const overlaysOf = (img: string): Overlay[] => overlayMap[img] ?? [];

/** §9.1：单条字幕句末不显示标点 */
export const stripCuePunctuation = (text: string) =>
  text.replace(/[\s]*[，。！？；、…,.!?;:]+$/u, '').trimEnd();
