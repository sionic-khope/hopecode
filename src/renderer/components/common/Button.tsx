import { forwardRef, type ButtonHTMLAttributes } from 'react';
import './common.css';

export type ButtonVariant = 'primary' | 'secondary' | 'plain' | 'destructive';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Square icon-only button (pass aria-label). */
  icon?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', icon = false, className, type = 'button', ...rest },
  ref,
) {
  const cls = [
    'hc-btn',
    `hc-btn--${variant}`,
    size !== 'md' ? `hc-btn--${size}` : '',
    icon ? 'hc-btn--icon' : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');
  return <button ref={ref} type={type} className={cls} {...rest} />;
});
