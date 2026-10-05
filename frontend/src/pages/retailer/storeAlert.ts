import { useCallback, useEffect, useState } from 'react';

/**
 * New-hold alert for the Store Console (Change 16, UI-4): the browser tab title and an
 * optional short tone. Sound is OFF by default and remembered per browser; nothing plays
 * unless the store switched it on.
 */
const SOUND_KEY = 'qs_store_sound';

export function useStoreSound(): [boolean, (on: boolean) => void] {
  const [on, setOn] = useState(() => {
    try {
      return window.localStorage.getItem(SOUND_KEY) === 'on';
    } catch {
      return false;
    }
  });
  const update = useCallback((next: boolean) => {
    setOn(next);
    try {
      window.localStorage.setItem(SOUND_KEY, next ? 'on' : 'off');
    } catch {
      // storage blocked: the choice lasts for this page only
    }
  }, []);
  return [on, update];
}

/** One short, quiet tone (WebAudio; no audio file). Browsers may block it until a click. */
export function playNewHoldTone(): void {
  try {
    const Ctx =
      window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.15, ctx.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.35);
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.4);
    osc.onended = () => void ctx.close();
  } catch {
    // audio unavailable: the toast and badge still show
  }
}

/** "(2) New hold · Store Console" while there are unseen new holds; restored on unmount. */
export function useNewHoldTitle(unseen: number) {
  useEffect(() => {
    const original = document.title;
    if (unseen > 0) document.title = `(${unseen}) New hold${unseen === 1 ? '' : 's'} · Store Console`;
    return () => {
      document.title = original;
    };
  }, [unseen]);
}
