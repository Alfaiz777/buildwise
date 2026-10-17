/** UI-P3: an integration's state at a glance — a coloured dot and one word. */
export type DotState = 'connected' | 'simulator' | 'attention' | 'off';
const DOT_WORDS: Record<DotState, string> = {
  connected: 'Connected',
  simulator: 'Simulator',
  attention: 'Needs attention',
  off: 'Not set up',
};
export function StatusDot({ state, text }: { state: DotState; text?: string }) {
  return (
    <span className={`status-dot status-dot--${state}`}>
      <span className="status-dot__dot" aria-hidden="true" />
      {text ?? DOT_WORDS[state]}
    </span>
  );
}
