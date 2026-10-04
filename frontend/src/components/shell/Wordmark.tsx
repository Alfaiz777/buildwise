/** The Qwikspot wordmark: a location pin with a check, and the name. */
export function Wordmark({ size = 'md' }: { size?: 'md' | 'lg' }) {
  return (
    <span className={`wordmark wordmark--${size}`}>
      <svg viewBox="0 0 24 24" width="1.4em" height="1.4em" aria-hidden="true">
        <path
          d="M12 2.5c-4 0-7.2 3.1-7.2 7 0 5.2 6.1 11.3 6.6 11.8a.85.85 0 0 0 1.2 0c.5-.5 6.6-6.6 6.6-11.8 0-3.9-3.2-7-7.2-7Z"
          fill="var(--color-primary)"
        />
        <path
          d="m8.9 9.6 2.2 2.2 4-4.1"
          fill="none"
          stroke="var(--color-accent)"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      <span>Qwikspot</span>
    </span>
  );
}
