import { useId, type ReactNode } from 'react';

/**
 * A small tooltip (UI-P1): shown on hover and on keyboard focus, described to screen readers
 * (aria-describedby), so a pill or a short value can explain itself without extra text.
 */
export function Tip({ text, children, className }: { text: ReactNode; children: ReactNode; className?: string }) {
  const id = useId();
  return (
    <span className={['ui-tip', className].filter(Boolean).join(' ')} tabIndex={0} aria-describedby={id}>
      {children}
      <span id={id} role="tooltip" className="ui-tip__bubble">
        {text}
      </span>
    </span>
  );
}
