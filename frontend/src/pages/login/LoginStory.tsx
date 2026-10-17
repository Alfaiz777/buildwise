import { useEffect, useState } from 'react';

/**
 * The login page's story panel (UI-L): Qwikspot's loop in four beats, drawn with the logo's own
 * motif — a pin with a check. A shopper browsing online asks on WhatsApp; Qwikspot checks the
 * live stock of the stores nearby; the nearest store with stock holds it; it is picked up today.
 * Decorative: the scene is aria-hidden and the beats are plain text for screen readers. With
 * reduced motion the scene stays on the last beat.
 */

export const STORY_STEPS = [
  { title: 'Browsing online', text: 'A shopper looks at a product on the brand’s website.' },
  { title: 'Asks on WhatsApp', text: '“Need it today?” opens a chat in the brand’s name.' },
  { title: 'Checks live stock', text: 'Qwikspot checks the stores nearby, stock as it is right now.' },
  { title: 'Picked up today', text: 'The nearest store with stock holds it. The shopper walks in.' },
] as const;

const BEAT_MS = 3200;

function prefersReducedMotion() {
  return typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

export function LoginStory() {
  const [reduced] = useState(prefersReducedMotion);
  const [step, setStep] = useState(reduced ? STORY_STEPS.length - 1 : 0);
  useEffect(() => {
    if (reduced) return;
    const id = window.setInterval(() => setStep((s) => (s + 1) % STORY_STEPS.length), BEAT_MS);
    return () => window.clearInterval(id);
  }, [reduced]);

  return (
    <div className="ls" data-step={step}>
      <div className="ls-scene" aria-hidden="true">
        {/* The map: streets, three stores and the route to the one that holds it. */}
        <div className="ls-map">
          <svg className="ls-streets" viewBox="0 0 400 300" preserveAspectRatio="none">
            <path d="M0 210 C 90 190, 150 240, 230 200 S 360 150, 400 170" />
            <path d="M60 0 C 80 90, 40 170, 90 300" />
            <path d="M270 0 C 250 80, 310 150, 280 300" />
            <path d="M0 90 C 120 110, 260 60, 400 80" />
          </svg>
          <svg className="ls-route" viewBox="0 0 400 300" preserveAspectRatio="none">
            <path d="M118 236 C 160 220, 190 180, 236 150" pathLength={1} />
          </svg>
          <span className="ls-ping" />
          <span className="ls-store ls-store--a">
            <Pin />
            <span className="ls-store__tag">Out of stock</span>
          </span>
          <span className="ls-store ls-store--b">
            <Pin check />
            <span className="ls-store__tag ls-store__tag--ok">1.2 km · in stock</span>
          </span>
          <span className="ls-store ls-store--c">
            <Pin />
            <span className="ls-store__tag">4.8 km</span>
          </span>
          <span className="ls-you">
            <span className="ls-you__dot" />
          </span>
        </div>

        {/* The shopper's phone: the product, then the chat. */}
        <div className="ls-phone">
          <div className="ls-phone__notch" />
          <div className="ls-product">
            <span className="ls-product__img" />
            <span className="ls-product__lines">
              <span />
              <span />
            </span>
            <span className="ls-product__cta">Need it today?</span>
          </div>
          <div className="ls-chat">
            <span className="ls-bubble ls-bubble--out">Is it in stock near me?</span>
            <span className="ls-typing">
              <i />
              <i />
              <i />
            </span>
            <span className="ls-bubble ls-bubble--in">
              Held at Wellness Mart, 1.2 km. Pickup code <b>4821</b>
            </span>
            <span className="ls-pass">
              <span className="ls-pass__qr" />
              <span className="ls-pass__text">
                <b>Pickup pass</b>
                <span>Wellness Mart · today</span>
              </span>
            </span>
          </div>
        </div>
      </div>

      <ol className="ls-steps" aria-label="How Qwikspot works">
        {STORY_STEPS.map((s, i) => (
          <li key={s.title} className={i === step ? 'is-on' : i < step ? 'is-done' : undefined}>
            <span className="ls-steps__n" aria-hidden="true">
              {i + 1}
            </span>
            <span>
              <strong>{s.title}</strong>
              <span className="ls-steps__text">{s.text}</span>
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

/** The Qwikspot pin (the wordmark's shape); with a check for the store that has it. */
function Pin({ check = false }: { check?: boolean }) {
  return (
    <svg viewBox="0 0 24 24" className="ls-pin">
      <path d="M12 2.5c-4 0-7.2 3.1-7.2 7 0 5.2 6.1 11.3 6.6 11.8a.85.85 0 0 0 1.2 0c.5-.5 6.6-6.6 6.6-11.8 0-3.9-3.2-7-7.2-7Z" />
      {check && <path className="ls-pin__check" d="m8.9 9.6 2.2 2.2 4-4.1" pathLength={1} />}
    </svg>
  );
}
