import { Loader2 } from 'lucide-react';
import type { ButtonHTMLAttributes, ReactNode, Ref } from 'react';

/** `brand`: the Ask Qwikspot teal gradient, for a page's main actions (UI-P1). */
export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'accent' | 'brand';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: 'sm' | 'md';
  /** Shows a spinner, keeps the label for screen readers and disables the button. */
  loading?: boolean;
  icon?: ReactNode;
  /** React 19: a ref is an ordinary prop (e.g. to focus Sign in after a demo login is chosen). */
  ref?: Ref<HTMLButtonElement>;
}

/** The one button. `type` defaults to "button" so it never submits a form by accident. */
export function Button({
  variant = 'primary',
  size = 'md',
  loading = false,
  icon,
  disabled,
  className,
  children,
  type = 'button',
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      className={['ui-button', `ui-button--${variant}`, `ui-button--${size}`, className].filter(Boolean).join(' ')}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <Loader2 className="ui-spin" size={16} aria-hidden="true" /> : icon}
      {children}
    </button>
  );
}
