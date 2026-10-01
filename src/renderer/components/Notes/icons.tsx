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

/** Collapse / expand a side pane. */
export function IconPane({ side, ...props }: SVGProps<SVGSVGElement> & { side: 'left' | 'right' }) {
  return (
    <svg width={16} height={16} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden {...props}>
      <rect x="2.75" y="3.75" width="14.5" height="12.5" rx="1" />
      {side === 'left' ? <path d="M7.5 3.75v12.5" /> : <path d="M12.5 3.75v12.5" />}
    </svg>
  );
}
