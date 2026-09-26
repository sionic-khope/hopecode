// App-chrome glyphs (profile menu, settings, header toolbar, right panel, message actions). Same drawing grid as
// the sidebar nav icons: 20-unit viewBox, 1.5 stroke, round caps. Decorative (aria-hidden); label the control.
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

export function GlyphSettings(props: GlyphProps) {
  return (
    <svg {...base} {...props}>
      <circle cx="10" cy="10" r="2.6" />
      <path d="M10 2.75v1.9M10 15.35v1.9M17.25 10h-1.9M4.65 10h-1.9M15.13 4.87l-1.35 1.35M6.22 13.78l-1.35 1.35M15.13 15.13l-1.35-1.35M6.22 6.22 4.87 4.87" />
    </svg>
  );
}

export function GlyphKeyboard(props: GlyphProps) {
  return (
    <svg {...base} {...props}>
      <rect x="2.5" y="5" width="15" height="10" rx="2.2" />
      <path d="M5.5 8h.01M8.5 8h.01M11.5 8h.01M14.5 8h.01M6.5 12h7" />
    </svg>
  );
}

export function GlyphInfo(props: GlyphProps) {
  return (
    <svg {...base} {...props}>
      <circle cx="10" cy="10" r="7.25" />
      <path d="M10 9v4.5M10 6.5h.01" />
    </svg>
  );
}

export function GlyphFolderOpen(props: GlyphProps) {
  return (
    <svg {...base} {...props}>
      <path d="M2.75 6.25a1.5 1.5 0 0 1 1.5-1.5h3.1l1.6 1.75h5.8a1.5 1.5 0 0 1 1.5 1.5v6.75a1.5 1.5 0 0 1-1.5 1.5H4.25a1.5 1.5 0 0 1-1.5-1.5Z" />
      <path d="M2.9 9h14.2" />
    </svg>
  );
}

export function GlyphPower(props: GlyphProps) {
  return (
    <svg {...base} {...props}>
      <path d="M10 2.75v6" />
      <path d="M6.1 5.1a6 6 0 1 0 7.8 0" />
    </svg>
  );
}

export function GlyphChart(props: GlyphProps) {
  return (
    <svg {...base} {...props}>
      <path d="M3.25 16.25h13.5" />
      <path d="M5.5 13.5V9.75M9 13.5V5.75M12.5 13.5v-5M16 13.5V7.5" />
    </svg>
  );
}

export function GlyphPeople(props: GlyphProps) {
  return (
    <svg {...base} {...props}>
      <circle cx="7.75" cy="7" r="2.75" />
      <path d="M2.75 16c.4-2.6 2.4-4.25 5-4.25s4.6 1.65 5 4.25" />
      <path d="M12.75 4.6a2.6 2.6 0 0 1 0 4.8M14.6 11.9c1.4.55 2.4 1.85 2.65 4.1" />
    </svg>
  );
}

/** Neutral agent glyph (a prompt caret in a tile): Hopecode's own, used when no official agent logo is bundled. */
export function GlyphAgent(props: GlyphProps) {
  return (
    <svg {...base} {...props}>
      <rect x="2.75" y="3.75" width="14.5" height="12.5" rx="3.25" />
      <path d="m6.25 8 2.25 2-2.25 2M10.5 12.5h3.25" />
    </svg>
  );
}

export function GlyphBranch(props: GlyphProps) {
  return (
    <svg {...base} {...props}>
      <circle cx="6" cy="4.75" r="1.75" />
      <circle cx="6" cy="15.25" r="1.75" />
      <circle cx="14" cy="7.25" r="1.75" />
      <path d="M6 6.5v7M14 9c0 3-3.2 3.1-6.9 5.1" />
    </svg>
  );
}

/** Changes panel: a document with +/- lines. */
export function GlyphChanges(props: GlyphProps) {
  return (
    <svg {...base} {...props}>
      <path d="M5.25 2.75h6.5l3.5 3.5v10a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1v-12.5a1 1 0 0 1 1-1Z" />
      <path d="M8 8.25h4M10 6.25v4M8 13.25h4" />
    </svg>
  );
}

export function GlyphTerminal(props: GlyphProps) {
  return (
    <svg {...base} {...props}>
      <rect x="2.75" y="3.75" width="14.5" height="12.5" rx="2.5" />
      <path d="m6 8 2.25 2L6 12M10.5 12.25h3.5" />
    </svg>
  );
}

/** "에디터에서 열기": angle brackets. */
export function GlyphCode(props: GlyphProps) {
  return (
    <svg {...base} {...props}>
      <path d="m7 6-4 4 4 4M13 6l4 4-4 4M11.25 4.5l-2.5 11" />
    </svg>
  );
}

export function GlyphCommit(props: GlyphProps) {
  return (
    <svg {...base} {...props}>
      <circle cx="10" cy="10" r="3" />
      <path d="M2.75 10H7M13 10h4.25" />
    </svg>
  );
}

export function GlyphRefresh(props: GlyphProps) {
  return (
    <svg {...base} {...props}>
      <path d="M16.25 9.5A6.25 6.25 0 1 0 14.4 14" />
      <path d="M16.5 4.75v4.5H12" />
    </svg>
  );
}

export function GlyphCopy(props: GlyphProps) {
  return (
    <svg {...base} {...props}>
      <rect x="6.75" y="6.75" width="10" height="10" rx="2" />
      <path d="M13.25 6.75V5a1.75 1.75 0 0 0-1.75-1.75H5A1.75 1.75 0 0 0 3.25 5v6.5A1.75 1.75 0 0 0 5 13.25h1.75" />
    </svg>
  );
}

export function GlyphCheck(props: GlyphProps) {
  return (
    <svg {...base} {...props}>
      <path d="m4.5 10.5 3.5 3.5 7.5-8" />
    </svg>
  );
}

/** "편집해서 다시 보내기". */
export function GlyphEditResend(props: GlyphProps) {
  return (
    <svg {...base} {...props}>
      <path d="M11.9 3.6a1.6 1.6 0 0 1 2.26 2.26L7.4 12.6l-3.03.77.77-3.03 6.76-6.74Z" />
      <path d="M11 16.25h5.75" />
    </svg>
  );
}

export function GlyphChevronDown(props: GlyphProps) {
  return (
    <svg {...base} width={11} height={11} strokeWidth={1.8} {...props}>
      <path d="m5.5 8 4.5 4.5L14.5 8" />
    </svg>
  );
}

export function GlyphClose(props: GlyphProps) {
  return (
    <svg {...base} {...props}>
      <path d="m5.5 5.5 9 9M14.5 5.5l-9 9" />
    </svg>
  );
}
