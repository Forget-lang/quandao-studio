import React from 'react';
import { AbsoluteFill, Composition, Sequence } from 'remotion';
import { FontGate, ShotScene } from './ThreeBarScene';
import { FPS, framesOf, shotDurationSec, shotStartFrames, shots, totalFrames } from './project-data';

const Piece: React.FC = () => (
  <AbsoluteFill style={{ backgroundColor: '#000000' }}>
    <FontGate>
      {shots.map((shot, i) => (
        <Sequence
          key={shot.id}
          from={shotStartFrames(i)}
          durationInFrames={framesOf(shotDurationSec(shot))}
          name={`分镜${shot.id} ${shot.title}`}
        >
          <ShotScene shot={shot} />
        </Sequence>
      ))}
    </FontGate>
  </AbsoluteFill>
);

// 合成 ID 的唯一定义处：scripts/render-piece.mjs 从这里解析，别在别处再写一遍字面量。
export const COMPOSITION_ID = 'QuandaoPiece';

export const RemotionRoot: React.FC = () => (
  <Composition
    id={COMPOSITION_ID}
    component={Piece}
    durationInFrames={Math.max(1, totalFrames)}
    fps={FPS}
    width={1080}
    height={1920}
  />
);
