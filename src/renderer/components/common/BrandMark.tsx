import { useId, type SVGProps } from 'react';

type BrandMarkProps = Omit<SVGProps<SVGSVGElement>, 'viewBox'> & { size?: number };

/**
 * The Hopecode mark (build/icon.svg, redrawn on a 24-unit grid): a lowercase "h" whose right leg is a
 * system-blue block caret, on a light squircle tile. Decorative by default; pass aria-label to expose it.
 */
export function BrandMark({ size = 18, ...props }: BrandMarkProps) {
  const id = useId();
  const tile = `${id}-tile`;
  const ink = `${id}-ink`;
  const caret = `${id}-caret`;
  const labelled = props['aria-label'] !== undefined;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      role={labelled ? 'img' : undefined}
      aria-hidden={labelled ? undefined : true}
      focusable="false"
      {...props}
    >
      <defs>
        <linearGradient id={tile} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#FFFFFF" />
          <stop offset="1" stopColor="#DDE5F1" />
        </linearGradient>
        <linearGradient id={ink} gradientUnits="userSpaceOnUse" x1="0" y1="5" x2="0" y2="19">
          <stop offset="0" stopColor="#26324D" />
          <stop offset="1" stopColor="#0B1428" />
        </linearGradient>
        <linearGradient id={caret} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#4AA5FF" />
          <stop offset="1" stopColor="#0A60E6" />
        </linearGradient>
      </defs>
      <rect x="1.25" y="1.25" width="21.5" height="21.5" rx="5.4" fill={`url(#${tile})`} />
      <rect x="1.25" y="1.25" width="21.5" height="21.5" rx="5.4" fill="none" stroke="#0B1428" strokeOpacity="0.14" strokeWidth="0.5" />
      <path d="M8.1 6.2V17.8" fill="none" stroke={`url(#${ink})`} strokeWidth="2.3" strokeLinecap="round" />
      <path d="M8.1 13.5c0-2.3 1.6-3.55 3.8-3.55 2.35 0 3.85 1.4 3.85 3.4" fill="none" stroke={`url(#${ink})`} strokeWidth="2.3" />
      <rect x="14.3" y="14" width="2.9" height="5" rx="0.45" fill={`url(#${caret})`} />
    </svg>
  );
}
