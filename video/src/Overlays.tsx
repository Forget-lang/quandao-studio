import React from 'react';
import type { Overlay } from './project-data';

const FONT_FAMILY = '"LXGW WenKai Medium"';

/** 券卡图标：一律矢量画，不交给生图模型（模型画小图标会糊成不可辨认的形状） */
const GrapeIcon: React.FC<{ size: number; color: string }> = ({ size, color }) => (
  <svg width={size} height={size} viewBox="0 0 64 64" fill="none">
    <path d="M32 10c0 6-4 9-9 9" stroke={color} strokeWidth="3.4" strokeLinecap="round" />
    <path d="M32 10c2 5 6 8 11 8" stroke={color} strokeWidth="3.4" strokeLinecap="round" />
    <circle cx="24" cy="26" r="6.4" fill={color} />
    <circle cx="38" cy="26" r="6.4" fill={color} />
    <circle cx="17" cy="38" r="6.4" fill={color} />
    <circle cx="31" cy="38" r="6.4" fill={color} />
    <circle cx="45" cy="38" r="6.4" fill={color} />
    <circle cx="24" cy="50" r="6.4" fill={color} />
    <circle cx="38" cy="50" r="6.4" fill={color} />
  </svg>
);

const ClockIcon: React.FC<{ size: number; color: string }> = ({ size, color }) => (
  <svg width={size} height={size} viewBox="0 0 64 64" fill="none">
    <circle cx="32" cy="32" r="24" stroke={color} strokeWidth="4" />
    <path d="M32 18v14l11 7" stroke={color} strokeWidth="4" strokeLinecap="round" />
  </svg>
);

const LimitIcon: React.FC<{ size: number; color: string }> = ({ size, color }) => (
  <svg width={size} height={size} viewBox="0 0 64 64" fill="none">
    <rect x="10" y="16" width="44" height="34" rx="6" stroke={color} strokeWidth="4" />
    <path d="M22 33h20" stroke={color} strokeWidth="4" strokeLinecap="round" />
    <path d="M32 23v20" stroke={color} strokeWidth="4" strokeLinecap="round" />
  </svg>
);

const ICONS: Record<string, React.FC<{ size: number; color: string }>> = {
  grape: GrapeIcon,
  clock: ClockIcon,
  limit: LimitIcon,
};

export const OverlayLayer: React.FC<{ overlays: Overlay[] }> = ({ overlays }) => (
  <>
    {overlays.map((o, i) => {
      const Icon = o.icon ? ICONS[o.icon] : undefined;
      return (
        <div key={i}>
          {Icon ? (
            <div
              style={{
                position: 'absolute',
                left: o.iconX ?? o.x + o.w / 2 - (o.iconSize ?? 54) / 2,
                top: o.iconY ?? o.y - (o.iconSize ?? 54) - 6,
                width: o.iconSize ?? 54,
                height: o.iconSize ?? 54,
              }}
            >
              <Icon size={o.iconSize ?? 54} color={o.color ?? '#1F3A5F'} />
            </div>
          ) : null}

          <div
            style={{
              position: 'absolute',
              left: o.x,
              top: o.y,
              width: o.w,
              height: o.h,
              transform: `rotate(${o.rotate ?? 0}deg)`,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 10,
              fontFamily: FONT_FAMILY,
              fontWeight: 500,
              color: o.color ?? '#1F3A5F',
              textAlign: 'center',
            }}
          >
            {o.text ? (
              <div style={{ fontSize: o.fontSize ?? 44, lineHeight: 1.25, letterSpacing: 1 }}>
                {o.text}
              </div>
            ) : null}
            {o.chips?.length ? (
              <div style={{ display: 'flex', gap: 10, justifyContent: 'center', flexWrap: 'wrap' }}>
                {o.chips.map((c, j) => (
                  <div
                    key={j}
                    style={{
                      fontFamily: FONT_FAMILY,
                      fontSize: c.fontSize ?? 30,
                      color: c.color ?? '#FFFFFF',
                      backgroundColor: c.bg ?? '#C0392B',
                      borderRadius: 8,
                      padding: '6px 14px',
                      letterSpacing: 1,
                      lineHeight: 1.2,
                    }}
                  >
                    {c.text}
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        </div>
      );
    })}
  </>
);
