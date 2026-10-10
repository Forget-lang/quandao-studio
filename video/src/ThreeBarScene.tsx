import React from 'react';
import {
  AbsoluteFill,
  Audio,
  Img,
  Sequence,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
  delayRender,
  continueRender,
} from 'remotion';
import {
  captionsOf,
  framesOf,
  imageSegments,
  pieceTitle,
  shotDurationSec,
  stripCuePunctuation,
  type Shot,
} from './project-data';

/** §6.0 排版锁定：主画面整屏垂直居中后再上移 48px */
const STAGE_H = 810;
const STAGE_NUDGE_UP = 48;
const STAGE_TOP = Math.round((1920 - STAGE_H) / 2) - STAGE_NUDGE_UP; // 507
const STAGE_BOTTOM = STAGE_TOP + STAGE_H; // 1317

const FONT_FAMILY = '"LXGW WenKai Medium"';

// 标题＝黑体＋抖音黄，全片固定（2026-09-30 用户反馈定：标题就是一直展示此视频要说的痛点）。
// 字幕仍是文楷近白，见 subtitleStyle；两者字体不同是有意为之，不是遗漏。
const TITLE_FONT = '"PingFang SC", "Noto Sans SC", "Source Han Sans SC", "Microsoft YaHei", sans-serif';
const TITLE_YELLOW = '#FFE100'; // 抖音黄。改色只改这一处，文档出处在 quandao-video §7.2。

const titleStyle: React.CSSProperties = {
  fontFamily: TITLE_FONT,
  fontWeight: 700,
  fontSize: 96,
  lineHeight: 1.3,
  letterSpacing: 1,
  color: TITLE_YELLOW,
  textAlign: 'center',
  maxWidth: 1000,
  whiteSpace: 'pre-line',
  paddingBottom: 42,
  margin: '0 auto',
};

const subtitleStyle: React.CSSProperties = {
  fontFamily: FONT_FAMILY,
  fontWeight: 500,
  fontSize: 60,
  lineHeight: 1.27,
  letterSpacing: 1,
  color: '#F8F8F8',
  textAlign: 'center',
  maxWidth: 920,
  paddingTop: 38,
  margin: '0 auto',
};

/**
 * §4.7 字体硬门槛：加载失败时故意不 continueRender，
 * 让渲染超时报错，而不是静默回退到系统黑体出片。
 */
export const FontGate: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [handle] = React.useState(() => delayRender('等待 LXGWWenKai-Medium 字体加载'));
  React.useEffect(() => {
    let cancelled = false;
    const url = staticFile('fonts/LXGWWenKai-Medium.ttf');
    const face = new FontFace('LXGW WenKai Medium', `url(${url}) format('truetype')`, {
      weight: '500',
    });
    face
      .load()
      .then((loaded) => {
        if (cancelled) return;
        (document.fonts as unknown as { add(f: FontFace): void }).add(loaded);
        continueRender(handle);
      })
      .catch((err) => {
        console.error('LXGWWenKai-Medium 加载失败，禁止静默回退黑体：', err);
      });
    return () => {
      cancelled = true;
    };
  }, [handle]);
  return <>{children}</>;
};

const Cue: React.FC<{ shot: Shot }> = ({ shot }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const sec = frame / fps;
  const cues = captionsOf(shot);
  const active = cues.find((c) => sec >= c.start && sec < c.end);
  return (
    <div style={{ ...subtitleStyle, visibility: active ? 'visible' : 'hidden' }}>
      {active ? stripCuePunctuation(active.text) : ''}
    </div>
  );
};

export const ShotScene: React.FC<{ shot: Shot }> = ({ shot }) => {
  const durationInFrames = framesOf(shotDurationSec(shot));
  const segments = imageSegments(shot);

  // 仅对 project.json 中 imageCrop 为 true 的素材裁角；false 时保留完整主画面。
  // 放大倍率、裁掉的比例与构图安全边距：唯一数字口径见 quandao-video/SKILL.md §5.1B。
  return (
    <AbsoluteFill style={{ backgroundColor: '#000000' }}>
      <Audio src={staticFile(shot.audio)} startFrom={0} endAt={durationInFrames} />

      <div
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          width: 1080,
          height: STAGE_TOP,
          display: 'flex',
          alignItems: 'flex-end',
          justifyContent: 'center',
          backgroundColor: '#000000',
        }}
      >
        <div style={titleStyle}>{pieceTitle}</div>
      </div>

      <div
        style={{
          position: 'absolute',
          top: STAGE_TOP,
          left: 0,
          width: 1080,
          height: STAGE_H,
          backgroundColor: '#000000',
          overflow: 'hidden',
        }}
      >
        {segments.map((seg, i) => (
          <Sequence key={i} from={seg.from} durationInFrames={seg.durationInFrames}>
            <Img
              src={staticFile(seg.img)}
              style={{
                width: 1080,
                height: STAGE_H,
                objectFit: 'cover',
                transform: seg.crop ? 'scale(1.07)' : 'none',
                transformOrigin: 'top center',
              }}
            />
          </Sequence>
        ))}
      </div>

      <div
        style={{
          position: 'absolute',
          top: STAGE_BOTTOM,
          left: 0,
          width: 1080,
          height: 1920 - STAGE_BOTTOM,
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'center',
          backgroundColor: '#000000',
        }}
      >
        <Cue shot={shot} />
      </div>
    </AbsoluteFill>
  );
};
