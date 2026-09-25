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

const navBase = {
  width: 17,
  height: 17,
  viewBox: '0 0 20 20',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.5,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true,
} as const;

/** Sidebar show / hide (window chrome, next to the traffic lights). */
export function IconSidebar(props: IconProps) {
  return (
    <svg {...navBase} {...props}>
      <rect x="2.75" y="3.75" width="14.5" height="12.5" rx="2.75" />
      <path d="M7.75 3.75v12.5" />
      <path d="M4.9 7.1h1M4.9 9.6h1" strokeWidth={1.3} />
    </svg>
  );
}

/** "새 채팅": pencil on a square. */
export function IconCompose(props: IconProps) {
  return (
    <svg {...navBase} {...props}>
      <path d="M9.25 3.75H5.5a2 2 0 0 0-2 2v8.75a2 2 0 0 0 2 2h8.75a2 2 0 0 0 2-2v-3.75" />
      <path d="M14.6 2.9a1.5 1.5 0 0 1 2.12 2.12L10.4 11.35l-2.85.72.72-2.85 6.32-6.32Z" />
    </svg>
  );
}

export function IconSearch(props: IconProps) {
  return (
    <svg {...navBase} {...props}>
      <circle cx="8.75" cy="8.75" r="5.25" />
      <path d="m12.75 12.75 3.75 3.75" />
    </svg>
  );
}

/** "계정": two stacked people (the account pool). */
export function IconPeople(props: IconProps) {
  return (
    <svg {...navBase} {...props}>
      <circle cx="7.75" cy="7" r="2.75" />
      <path d="M2.75 16c.45-2.6 2.55-4.25 5-4.25s4.55 1.65 5 4.25" />
      <path d="M12.6 4.6a2.6 2.6 0 0 1 0 4.9M14.4 11.95c1.45.55 2.5 1.9 2.85 4.05" />
    </svg>
  );
}

/** Thread pin (outline; filled when pinned). */
export function IconPinThread({ filled, ...props }: IconProps & { filled?: boolean }) {
  return (
    <svg {...strokeBase} {...props}>
      <path
        d="M9.8 2.2 13.8 6.2l-1.6.6-2.3 2.3.3 2.9-1.1 1.1L6.6 10.6 3.4 13.8M6.6 10.6 4.1 8.1 5.2 7l2.9.3 2.3-2.3.6-1.6"
        fill={filled ? 'currentColor' : 'none'}
      />
    </svg>
  );
}

export function IconArchive(props: IconProps) {
  return (
    <svg {...strokeBase} {...props}>
      <rect x="2" y="3" width="12" height="3" rx="0.8" />
      <path d="M3 6v6.2a.8.8 0 0 0 .8.8h8.4a.8.8 0 0 0 .8-.8V6M6.5 8.5h3" />
    </svg>
  );
}

export function IconUnarchive(props: IconProps) {
  return (
    <svg {...strokeBase} {...props}>
      <rect x="2" y="3" width="12" height="3" rx="0.8" />
      <path d="M3 6v6.2a.8.8 0 0 0 .8.8h8.4a.8.8 0 0 0 .8-.8V6M8 11.5V8M6.4 9.4 8 7.8l1.6 1.6" />
    </svg>
  );
}

/** Small running indicator for a thread row. */
export function IconSpinner(props: IconProps) {
  const { className, ...rest } = props;
  return (
    <svg
      width={12}
      height={12}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      aria-hidden
      className={['hc-sb-spin', className].filter(Boolean).join(' ')}
      {...rest}
    >
      <circle cx="8" cy="8" r="6" strokeOpacity={0.2} />
      <path d="M8 2a6 6 0 0 1 6 6" />
    </svg>
  );
}

export function IconClose(props: IconProps) {
  return (
    <svg {...strokeBase} {...props}>
      <path d="m4.5 4.5 7 7M11.5 4.5l-7 7" />
    </svg>
  );
}
