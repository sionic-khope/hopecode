import type { SVGProps } from 'react';

/** A note page (optionally with a plus: "새 노트"). Same grid as the sidebar icons. */
export function IconNotePage({ plus, ...props }: SVGProps<SVGSVGElement> & { plus?: boolean }) {
  return (
    <svg width={15} height={15} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden {...props}>
      <path d="M11.5 3H5.75a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h8.5a1 1 0 0 0 1-1V6.75L11.5 3Z" />
      <path d="M11.5 3v3.75h3.75" />
      {plus ? <path d="M10 10v4M8 12h4" /> : <path d="M7.75 10.5h4.5M7.75 13.5h3" />}
    </svg>
  );
}

/** "← 돌아가기": a pixel arrow pointing left. */
export function IconBack(props: SVGProps<SVGSVGElement>) {
  return (
    <svg width={14} height={14} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="square" aria-hidden {...props}>
      <path d="M14 8H3M7 3.5 2.5 8 7 12.5" />
    </svg>
  );
}

/** A sparkle (an AI request). Square strokes to sit with the pixel type. */
export function IconSpark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg width={14} height={14} viewBox="0 0 16 16" fill="currentColor" aria-hidden {...props}>
      <path d="M7 1h2v4h4v2H9v4H7V7H3V5h4z" transform="translate(0 2)" />
      <rect x="12" y="1" width="2" height="2" />
      <rect x="2" y="12" width="2" height="2" />
    </svg>
  );
}
