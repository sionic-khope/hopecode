import type { ButtonHTMLAttributes } from 'react';
import './common.css';

export interface SwitchProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onChange' | 'role'> {
  checked: boolean;
  onChange: (checked: boolean) => void;
  size?: 'sm' | 'md';
}

/** macOS-style toggle switch (role="switch"). */
export function Switch({ checked, onChange, size = 'sm', className, disabled, ...rest }: SwitchProps) {
  const cls = ['hc-switch', size === 'md' ? 'hc-switch--md' : '', className ?? ''].filter(Boolean).join(' ');
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      className={cls}
      onClick={() => onChange(!checked)}
      {...rest}
    >
      <span className="hc-switch__thumb" aria-hidden />
    </button>
  );
}
