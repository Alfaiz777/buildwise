import { useEffect, useState, type RefObject } from 'react';

/**
 * Motion helpers for the landing page (UI-L2). Everything degrades to a still, fully visible
 * page: without IntersectionObserver (old browsers, tests) nothing is hidden, and with
 * prefers-reduced-motion nothing moves.
 */

export function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

/**
 * Scroll reveal: every `.rv` inside the root gets `is-in` when it enters the viewport. The root
 * gets `lp-anim` only when this can work, so the hidden starting state never strands content.
 */
export function useReveal(root: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const el = root.current;
    if (!el || typeof IntersectionObserver === 'undefined' || prefersReducedMotion()) return;
    el.classList.add('lp-anim');
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            e.target.classList.add('is-in');
            io.unobserve(e.target);
          }
        }
      },
      { rootMargin: '0px 0px -8% 0px', threshold: 0.12 },
    );
    el.querySelectorAll('.rv').forEach((n) => io.observe(n));
    return () => io.disconnect();
  }, [root]);
}

/** True once the page has scrolled past `offset` px (the header tightens). */
export function useScrolled(offset = 12): boolean {
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const on = () => setScrolled(window.scrollY > offset);
    on();
    window.addEventListener('scroll', on, { passive: true });
    return () => window.removeEventListener('scroll', on);
  }, [offset]);
  return scrolled;
}

/** The id of the section in the middle of the screen (the header highlights its link). */
export function useActiveSection(ids: readonly string[]): string | null {
  const [active, setActive] = useState<string | null>(null);
  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) if (e.isIntersecting) setActive(e.target.id);
      },
      { rootMargin: '-45% 0px -50% 0px' },
    );
    for (const id of ids) {
      const n = document.getElementById(id);
      if (n) io.observe(n);
    }
    return () => io.disconnect();
  }, [ids]);
  return active;
}

/** True while the element is on screen (animations pause off screen). Defaults to true. */
export function useOnScreen(ref: RefObject<HTMLElement | null>): boolean {
  const [on, setOn] = useState(true);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(([e]) => setOn(!!e?.isIntersecting), { threshold: 0.05 });
    io.observe(el);
    return () => io.disconnect();
  }, [ref]);
  return on;
}

/**
 * A looping story: advances through `durations` (ms per beat) while `running`. With reduced
 * motion it rests on the last beat.
 */
export function useBeats(durations: readonly number[], running: boolean): number {
  const [reduced] = useState(prefersReducedMotion);
  const last = durations.length - 1;
  const [beat, setBeat] = useState(reduced ? last : 0);
  useEffect(() => {
    if (reduced || !running) return;
    const id = window.setTimeout(() => setBeat((b) => (b + 1) % durations.length), durations[beat]);
    return () => window.clearTimeout(id);
  }, [beat, durations, reduced, running]);
  return beat;
}
