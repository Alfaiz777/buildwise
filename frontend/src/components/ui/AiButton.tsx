import type { ButtonHTMLAttributes, ReactNode } from 'react';

/**
 * The Qwikspot pin with a sparkle — the mark of everything Ask Qwikspot (UI-P1). The pin is the
 * logo's own shape and colours; the sparkle says "AI". Decorative (the text names the action).
 */
export function AiMark({ size = 20, onDark = false }: { size?: number; onDark?: boolean }) {
  return (
    <span
      className={`ui-ai-mark${onDark ? ' ui-ai-mark--on-dark' : ''}`}
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      <svg viewBox="0 0 24 24" width={size} height={size}>
        <path
          className="ui-ai-mark__pin"
          d="M12 2.5c-4 0-7.2 3.1-7.2 7 0 5.2 6.1 11.3 6.6 11.8a.85.85 0 0 0 1.2 0c.5-.5 6.6-6.6 6.6-11.8 0-3.9-3.2-7-7.2-7Z"
        />
        <path
          className="ui-ai-mark__check"
          d="m8.9 9.6 2.2 2.2 4-4.1"
          fill="none"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      <svg className="ui-ai-mark__spark" viewBox="0 0 12 12" width={size * 0.5} height={size * 0.5}>
        <path d="M6 0c.4 2.9 1.7 4.4 6 6-4.3 1.6-5.6 3.1-6 6-.4-2.9-1.7-4.4-6-6 4.3-1.6 5.6-3.1 6-6Z" />
      </svg>
    </span>
  );
}

/**
 * The Ask Qwikspot button style, for every AI action (header, page actions, "Ask a follow-up",
 * "Ask about this"): the logo with a sparkle, a teal gradient and a soft glow. `quiet` is the
 * small outlined form for inline actions.
 */
export function AiButton({
  children,
  size = 'md',
  quiet = false,
  className,
  type = 'button',
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { children: ReactNode; size?: 'sm' | 'md'; quiet?: boolean }) {
  return (
    <button
      type={type}
      className={['ui-ai-button', `ui-ai-button--${size}`, quiet ? 'ui-ai-button--quiet' : '', className]
        .filter(Boolean)
        .join(' ')}
      {...rest}
    >
      <AiMark size={size === 'sm' ? 16 : 20} onDark={!quiet} />
      <span>{children}</span>
    </button>
  );
}
