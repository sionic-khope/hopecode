import type { SystemNoticeItem } from '../../../shared/types';
import { ErrorCircleIcon, InfoCircleIcon } from './icons';
import './Chat.css';

export interface SystemNoticeProps {
  item: SystemNoticeItem;
}

/** Inline banner for account-switch / resume / error notices (plan 7.2, 7.3). */
export function SystemNotice({ item }: SystemNoticeProps) {
  const Icon = item.level === 'info' ? InfoCircleIcon : ErrorCircleIcon;
  return (
    <div className={`hc-notice${item.level !== 'info' ? ` hc-notice--${item.level}` : ''}`} role="status">
      <span className="hc-notice__icon">
        <Icon width={13} height={13} />
      </span>
      <span>{item.text}</span>
    </div>
  );
}
