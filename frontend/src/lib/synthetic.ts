import { useCallback, useState } from 'react';

/**
 * "Hide synthetic history" on Brand lists (Change 16, UI-3; audit P1-4). On by default so
 * live demo activity comes first; remembered per browser. Storage may be blocked — then it
 * is simply not remembered.
 */
const KEY = 'qs_hide_synthetic';

function read(): boolean {
  try {
    return window.localStorage.getItem(KEY) !== 'false';
  } catch {
    return true;
  }
}

export function useHideSynthetic(): [boolean, (hide: boolean) => void] {
  const [hide, setHide] = useState(read);
  const update = useCallback((next: boolean) => {
    setHide(next);
    try {
      window.localStorage.setItem(KEY, String(next));
    } catch {
      // storage blocked: the choice lasts for this page only
    }
  }, []);
  return [hide, update];
}

/** Splits rows into what is shown and how many synthetic rows were hidden. */
export function withoutSynthetic<T extends { demo_history?: boolean }>(rows: T[], hide: boolean) {
  const shown = hide ? rows.filter((r) => !r.demo_history) : rows;
  return { shown, hidden: rows.length - shown.length };
}
