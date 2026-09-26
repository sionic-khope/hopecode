// Top-right window toolbar glyphs (더보기, 공유, 환경, panel toggles, env popover rows). Same grid as
// common/glyphs.tsx: 20-unit viewBox, 1.5 stroke, round caps. Decorative (aria-hidden); label the control.
import type { SVGProps } from 'react';

type GlyphProps = SVGProps<SVGSVGElement>;

const base = {
  width: 16,
  height: 16,
  viewBox: '0 0 20 20',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.5,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true,
} as const;

export function GlyphMore(props: GlyphProps) {
  return (
    <svg {...base} {...props}>
      <circle cx="4.75" cy="10" r="0.9" fill="currentColor" />
      <circle cx="10" cy="10" r="0.9" fill="currentColor" />
      <circle cx="15.25" cy="10" r="0.9" fill="currentColor" />
    </svg>
  );
}

/** 공유: arrow leaving a tray. */
export function GlyphShare(props: GlyphProps) {
  return (
    <svg {...base} {...props}>
      <path d="M10 12.25V3.25M6.75 6.25 10 3l3.25 3.25" />
      <path d="M5.75 9.25h-1a1 1 0 0 0-1 1v5.5a1 1 0 0 0 1 1h10.5a1 1 0 0 0 1-1v-5.5a1 1 0 0 0-1-1h-1" />
    </svg>
  );
}

/** 환경: a short list. */
export function GlyphList(props: GlyphProps) {
  return (
    <svg {...base} {...props}>
      <path d="M7.75 5.5h8.5M7.75 10h8.5M7.75 14.5h8.5" />
      <circle cx="4.25" cy="5.5" r="0.75" fill="currentColor" />
      <circle cx="4.25" cy="10" r="0.75" fill="currentColor" />
      <circle cx="4.25" cy="14.5" r="0.75" fill="currentColor" />
    </svg>
  );
}

/** 하단 터미널 toggle: window with a bottom strip. */
export function GlyphPanelBottom(props: GlyphProps) {
  return (
    <svg {...base} {...props}>
      <rect x="2.75" y="3.75" width="14.5" height="12.5" rx="2.5" />
      <path d="M2.75 12h14.5M5.5 14.1l1.1-.95-1.1-.95" />
    </svg>
  );
}

/** 오른쪽 패널 toggle: window with a right column. */
export function GlyphPanelRight(props: GlyphProps) {
  return (
    <svg {...base} {...props}>
      <rect x="2.75" y="3.75" width="14.5" height="12.5" rx="2.5" />
      <path d="M12 3.75v12.5" />
    </svg>
  );
}

export function GlyphPullRequest(props: GlyphProps) {
  return (
    <svg {...base} {...props}>
      <circle cx="5.75" cy="4.75" r="1.75" />
      <circle cx="5.75" cy="15.25" r="1.75" />
      <circle cx="14.25" cy="15.25" r="1.75" />
      <path d="M5.75 6.5v7M14.25 13.5V8.25a2 2 0 0 0-2-2H9.5M11 4.5 9.25 6.25 11 8" />
    </svg>
  );
}

export function GlyphBranchPlus(props: GlyphProps) {
  return (
    <svg {...base} {...props}>
      <circle cx="6" cy="4.75" r="1.75" />
      <circle cx="6" cy="15.25" r="1.75" />
      <path d="M6 6.5v7M14.5 4.5v6M11.5 7.5h6M14.5 12.75c0 1.6-2.6 2.2-6.7 2.4" />
    </svg>
  );
}

export function GlyphFolder(props: GlyphProps) {
  return (
    <svg {...base} {...props}>
      <path d="M2.75 6.25a1.5 1.5 0 0 1 1.5-1.5h3.5l1.75 1.75h6.25a1.5 1.5 0 0 1 1.5 1.5v6.75a1.5 1.5 0 0 1-1.5 1.5H4.25a1.5 1.5 0 0 1-1.5-1.5Z" />
    </svg>
  );
}

export function GlyphFile(props: GlyphProps) {
  return (
    <svg {...base} {...props}>
      <path d="M5.75 2.75h5.5l3.5 3.5v10a1 1 0 0 1-1 1h-8a1 1 0 0 1-1-1v-12.5a1 1 0 0 1 1-1Z" />
      <path d="M11.25 2.75v3.5h3.5" />
    </svg>
  );
}

export function GlyphMarkdown(props: GlyphProps) {
  return (
    <svg {...base} {...props}>
      <rect x="2.25" y="4.75" width="15.5" height="10.5" rx="2" />
      <path d="M5 12.5v-5l2 2.25 2-2.25v5M13.25 7.5v5M11.5 10.75l1.75 1.75 1.75-1.75" />
    </svg>
  );
}

export function GlyphChevronRight(props: GlyphProps) {
  return (
    <svg {...base} {...props}>
      <path d="m8 5.5 4.5 4.5L8 14.5" />
    </svg>
  );
}
