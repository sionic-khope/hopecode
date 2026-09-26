import { memo, useMemo } from 'react';
import { SPRITE_GRID, spriteForType, spriteRects, type SpriteDef } from './sprites';
import './Subagents.css';

export interface PixelSpriteProps {
  /** `subagent_type`; picks the character deterministically. */
  type: string;
  /** Rendered edge in CSS px (a multiple of 12 keeps pixels square and crisp). */
  size?: number;
  /** Running: two-frame bob (off under reduced motion). */
  running?: boolean;
  /** Settled: small badge in the corner. */
  state?: 'done' | 'failed';
  /** Explicit character (sprite sheet); overrides `type`. */
  sprite?: SpriteDef;
}

/** Decorative pixel character of a subagent (SVG `<rect>` runs, crisp edges). */
export const PixelSprite = memo(function PixelSprite({ type, size = 24, running = false, state, sprite }: PixelSpriteProps) {
  const def = sprite ?? spriteForType(type);
  const rects = useMemo(() => spriteRects(def), [def]);
  const classes = ['hc-sprite', running ? 'hc-sprite--running' : '', state ? `hc-sprite--${state}` : ''].filter(Boolean).join(' ');
  return (
    <span
      className={classes}
      style={{ width: size, height: size, ['--hc-sprite-px' as string]: `${size / SPRITE_GRID}px` }}
      data-sprite={def.id}
      role="img"
      aria-label={`${def.name} 캐릭터`}
      title={type}
    >
      <svg
        className="hc-sprite__svg"
        width={size}
        height={size}
        viewBox={`0 0 ${SPRITE_GRID} ${SPRITE_GRID}`}
        shapeRendering="crispEdges"
        aria-hidden
      >
        {rects.map((r) => (
          <rect key={`${r.x}-${r.y}`} x={r.x} y={r.y} width={r.w} height={1} fill={r.fill} />
        ))}
      </svg>
      {state === 'done' ? (
        <span className="hc-sprite__badge hc-sprite__badge--done" aria-hidden>
          <svg viewBox="0 0 8 8" width={8} height={8}>
            <path d="M1.6 4.2l1.6 1.6 3.2-3.4" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
      ) : state === 'failed' ? (
        <span className="hc-sprite__badge hc-sprite__badge--failed" aria-hidden>
          <svg viewBox="0 0 8 8" width={8} height={8}>
            <path d="M2.4 2.4l3.2 3.2M5.6 2.4l-3.2 3.2" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" />
          </svg>
        </span>
      ) : null}
    </span>
  );
});
