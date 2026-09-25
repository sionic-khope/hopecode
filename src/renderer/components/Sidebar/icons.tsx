import type { SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement>;

const strokeBase = {
  width: 14,
  height: 14,
  viewBox: '0 0 16 16',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.4,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const;

export function IconChevron(props: IconProps) {
  return (
    <svg {...strokeBase} {...props}>
      <path d="M6 4l4 4-4 4" />
    </svg>
  );
}

export function IconFolder(props: IconProps) {
  return (
    <svg {...strokeBase} {...props}>
      <path d="M2 4.5a1 1 0 0 1 1-1h3l1.2 1.5H13a1 1 0 0 1 1 1V11a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V4.5Z" />
    </svg>
  );
}

export function IconFolderPlus(props: IconProps) {
  return (
    <svg {...strokeBase} {...props}>
      <path d="M2 4.5a1 1 0 0 1 1-1h3l1.2 1.5H13a1 1 0 0 1 1 1V11a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V4.5Z" />
      <path d="M8 6.5v3.5M6.25 8.25h3.5" />
    </svg>
  );
}

export function IconThreadPlus(props: IconProps) {
  return (
    <svg {...strokeBase} {...props}>
      <path d="M2.5 3.5h11a1 1 0 0 1 1 1V10a1 1 0 0 1-1 1H6.5L3 13.5V11h-.5a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1Z" />
      <path d="M8 5.75v3M6.5 7.25h3" />
    </svg>
  );
}

export function IconPlusSmall(props: IconProps) {
  return (
    <svg {...strokeBase} {...props}>
      <path d="M8 3.5v9M3.5 8h9" />
    </svg>
  );
}

export function IconAccounts(props: IconProps) {
  return (
    <svg {...strokeBase} {...props}>
      <circle cx="8" cy="5.5" r="2.5" />
      <path d="M3 13c0-2.4 2.2-4 5-4s5 1.6 5 4" />
    </svg>
  );
}

export function IconPin(props: IconProps) {
  return (
    <svg width={10} height={10} viewBox="0 0 16 16" fill="currentColor" {...props}>
      <path d="M8 1.5c1.9 0 3.4 1.5 3.4 3.4 0 1.6-1 3.7-2.4 5.6l-.2.3v3.2a.8.8 0 0 1-1.6 0v-3.2l-.2-.3C5.6 8.6 4.6 6.5 4.6 4.9 4.6 3 6.1 1.5 8 1.5Z" />
    </svg>
  );
}

export function IconMore(props: IconProps) {
  return (
    <svg width={14} height={14} viewBox="0 0 16 16" fill="currentColor" {...props}>
      <circle cx="3.5" cy="8" r="1.2" />
      <circle cx="8" cy="8" r="1.2" />
      <circle cx="12.5" cy="8" r="1.2" />
    </svg>
  );
}

export function IconShieldAlert(props: IconProps) {
  return (
    <svg {...strokeBase} {...props}>
      <path d="M8 1.8 13 3.6v4c0 3-2.1 5.4-5 6.6-2.9-1.2-5-3.6-5-6.6v-4L8 1.8Z" />
      <path d="M8 5.2v3.3M8 10.6v.1" />
    </svg>
  );
}
