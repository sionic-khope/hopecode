import type { SVGProps } from 'react';
import { useThemeOverlay } from '../../theme/themeOverlay';

type BrandMarkProps = Omit<SVGProps<SVGSVGElement>, 'viewBox'> & { size?: number };

// The Hopecode mark (build/icon.svg uses the same grid): a red pixel heart and a yellow block cursor inside a white
// pixel dialogue frame with notched corners. 16x16 cells, so it is pixel-exact at 16 / 32 / 48 px.
// F frame, R heart, r heart shade, H heart highlight, Y cursor; '.' is the black box (or nothing outside it).
const MARK: readonly string[] = [
  '.FFFFFFFFFFFFFF.',
  'F..............F',
  'F..............F',
  'F..............F',
  'F..............F',
  'F...RR.RR......F',
  'F..RHRRRRRR....F',
  'F..RRRRRRRr....F',
  'F...RRRRRr.....F',
  'F....RRRr......F',
  'F.....Rr...YYY.F',
  'F..........YYY.F',
  'F..............F',
  'F..............F',
  'F..............F',
  '.FFFFFFFFFFFFFF.',
];

const PALETTE: Readonly<Record<string, string>> = {
  F: '#FFFFFF',
  R: '#FF2B45',
  r: '#B3122B',
  H: '#FFFFFF',
  Y: '#FFE14D',
};

interface Run {
  x: number;
  y: number;
  w: number;
  fill: string;
}

/** Horizontal runs of one color per row (fewer <rect>s than one per cell). */
const RUNS: readonly Run[] = MARK.flatMap((row, y) => {
  const runs: Run[] = [];
  for (let x = 0; x < row.length; ) {
    const key = row[x]!;
    let end = x + 1;
    while (end < row.length && row[end] === key) end++;
    const fill = PALETTE[key];
    if (fill) runs.push({ x, y, w: end - x, fill });
    x = end;
  }
  return runs;
});

/**
 * The Hopecode mark. Decorative by default; pass aria-label to expose it. A local overlay sprite
 * (~/.hopecode/theme/sprites/logo.png) takes its place when present. Sizes snap to multiples of 16 so the pixels stay
 * square (a 20 asks for 16, a 52 for 48).
 */
export function BrandMark({ size = 16, ...props }: BrandMarkProps) {
  const overlay = useThemeOverlay();
  const px = Math.max(16, Math.round(size / 16) * 16);
  const label = props['aria-label'];
  const labelled = label !== undefined;
  if (overlay.sprites.logo) {
    return (
      <img
        className="hc-brand-mark hc-pixelated"
        src={overlay.sprites.logo}
        width={px}
        height={px}
        alt={labelled ? String(label) : ''}
        aria-hidden={labelled ? undefined : true}
        draggable={false}
        data-overlay="logo"
      />
    );
  }
  return (
    <svg
      className="hc-brand-mark"
      width={px}
      height={px}
      viewBox="0 0 16 16"
      shapeRendering="crispEdges"
      role={labelled ? 'img' : undefined}
      aria-hidden={labelled ? undefined : true}
      focusable="false"
      {...props}
    >
      <rect x="1" y="1" width="14" height="14" fill="#000000" />
      {RUNS.map((r) => (
        <rect key={`${r.x}-${r.y}`} x={r.x} y={r.y} width={r.w} height={1} fill={r.fill} />
      ))}
    </svg>
  );
}
