// Small inline monochrome icon set for the chat lane. currentColor throughout so
// tone follows the surrounding text color (tool card header, buttons, status dots).
import type { ReactElement, ReactNode, SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement>;

function base(props: IconProps, children: ReactNode) {
  const { width = 14, height = 14, ...rest } = props;
  return (
    <svg
      width={width}
      height={height}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      {...rest}
    >
      {children}
    </svg>
  );
}

export function ChevronIcon(props: IconProps) {
  return base(props, <path d="M4 6l4 4 4-4" />);
}

export function ReadIcon(props: IconProps) {
  return base(
    props,
    <>
      <path d="M4 2h5l3 3v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1Z" />
      <path d="M9 2v3h3" />
    </>,
  );
}

export function EditIcon(props: IconProps) {
  return base(
    props,
    <>
      <path d="M10.5 2.5l3 3L5 14H2v-3l8.5-8.5Z" />
    </>,
  );
}

export function WriteIcon(props: IconProps) {
  return base(
    props,
    <>
      <path d="M4 2h5l3 3v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1Z" />
      <path d="M5.5 8.5h5M5.5 11h3.5" />
    </>,
  );
}

export function BashIcon(props: IconProps) {
  return base(
    props,
    <>
      <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" />
      <path d="M4 6.5l2.2 1.8L4 10" />
      <path d="M8 10.5h3.5" />
    </>,
  );
}

export function SearchIcon(props: IconProps) {
  return base(
    props,
    <>
      <circle cx="6.8" cy="6.8" r="4.3" />
      <path d="M10 10l3.5 3.5" />
    </>,
  );
}

export function GlobIcon(props: IconProps) {
  return base(
    props,
    <>
      <circle cx="8" cy="8" r="6" />
      <path d="M2 8h12M8 2c1.8 1.7 1.8 10.3 0 12M8 2c-1.8 1.7-1.8 10.3 0 12" />
    </>,
  );
}

export function WebIcon(props: IconProps) {
  return base(
    props,
    <>
      <circle cx="8" cy="8" r="6" />
      <path d="M2 8h12M8 2c1.8 1.7 1.8 10.3 0 12M4 4.5c1.2.7 2.6 1 4 1s2.8-.3 4-1M4 11.5c1.2-.7 2.6-1 4-1s2.8.3 4 1" />
    </>,
  );
}

export function TaskIcon(props: IconProps) {
  return base(
    props,
    <>
      <circle cx="8" cy="8" r="6" />
      <path d="M5.5 8l1.8 1.8L10.5 6" />
    </>,
  );
}

export function TodoIcon(props: IconProps) {
  return base(
    props,
    <>
      <rect x="2" y="2.5" width="12" height="11" rx="1.5" />
      <path d="M4.5 6h7M4.5 8.5h7M4.5 11h4" />
    </>,
  );
}

export function ToolGenericIcon(props: IconProps) {
  return base(
    props,
    <>
      <path d="M9.5 2.5a3 3 0 0 1 3.7 3.9l-.9-.2-1.4 1.4.2.9a3 3 0 0 1-3.9-3.7l.9.2 1.4-1.4-.2-.9Z" />
      <path d="M6.6 8.6L2.8 12.4a1.2 1.2 0 0 0 1.7 1.7l3.8-3.8" />
    </>,
  );
}

export function CheckCircleIcon(props: IconProps) {
  return base(
    props,
    <>
      <circle cx="8" cy="8" r="6" />
      <path d="M5.4 8.2l1.8 1.8 3.4-3.6" />
    </>,
  );
}

export function ErrorCircleIcon(props: IconProps) {
  return base(
    props,
    <>
      <circle cx="8" cy="8" r="6" />
      <path d="M6.2 6.2l3.6 3.6M9.8 6.2l-3.6 3.6" />
    </>,
  );
}

export function InfoCircleIcon(props: IconProps) {
  return base(
    props,
    <>
      <circle cx="8" cy="8" r="6" />
      <path d="M8 7.2v3.3" />
      <circle cx="8" cy="5.3" r="0.15" fill="currentColor" stroke="none" />
    </>,
  );
}

export function StopIcon(props: IconProps) {
  return base(
    props,
    <>
      <rect x="4" y="4" width="8" height="8" rx="1.5" fill="currentColor" stroke="none" />
    </>,
  );
}

export function SendIcon(props: IconProps) {
  return base(
    props,
    <>
      <path d="M2.5 8L13.5 3l-3.6 11-2.1-4.8L2.5 8Z" />
    </>,
  );
}

export function PinIcon(props: IconProps) {
  return base(
    props,
    <>
      <path d="M9.5 2.5l4 4-2 2 .5 3.5L9 9l-3 3-1-1 3-3-3.5-.5L7 5l2-2Z" />
    </>,
  );
}

export function SpinnerIcon(props: IconProps) {
  const { className, ...rest } = props;
  return base(
    { className: ['hc-spin', className].filter(Boolean).join(' '), ...rest },
    <path d="M8 2a6 6 0 1 1-6 6" />,
  );
}

const TOOL_ICONS: Record<string, (props: IconProps) => ReactElement> = {
  Read: ReadIcon,
  NotebookEdit: ReadIcon,
  Edit: EditIcon,
  MultiEdit: EditIcon,
  Write: WriteIcon,
  Bash: BashIcon,
  BashOutput: BashIcon,
  KillShell: BashIcon,
  Grep: SearchIcon,
  Glob: GlobIcon,
  WebFetch: WebIcon,
  WebSearch: WebIcon,
  Task: TaskIcon,
  TodoWrite: TodoIcon,
};

/** Resolve the best-fit icon for a tool_use name, falling back to a generic wrench. */
export function iconForTool(toolName: string): (props: IconProps) => ReactElement {
  return TOOL_ICONS[toolName] ?? ToolGenericIcon;
}
