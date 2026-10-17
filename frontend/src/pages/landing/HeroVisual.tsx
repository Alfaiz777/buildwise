import { BadgeCheck, Check, CheckCheck, ChevronLeft, MapPin, Phone, Sparkles, Video } from 'lucide-react';
import { useRef, type PointerEvent } from 'react';
import { prefersReducedMotion, useBeats, useOnScreen } from './motion';

/** A self-made serum bottle (no third-party imagery). */
function SerumBottle({ size = 52 }: { size?: number }) {
  return (
    <svg viewBox="0 0 64 64" width={size} height={size} aria-hidden="true">
      <rect width="64" height="64" rx="12" fill="#fff4dc" />
      <rect x="27" y="8" width="10" height="9" rx="2" fill="#2b2f36" />
      <rect x="29" y="16" width="6" height="5" fill="#4a505a" />
      <rect x="21" y="21" width="22" height="35" rx="6" fill="#fbae2c" />
      <rect x="25" y="31" width="14" height="14" rx="2" fill="#fff" opacity="0.92" />
      <text x="32" y="41" textAnchor="middle" fontSize="7" fontWeight="700" fill="#b45c09">
        C
      </text>
    </svg>
  );
}

/**
 * The beats of the hero story (ms each): 0 the shopper asks · 1 the brand is typing · 2 the
 * product card with stores · 3 the shopper taps "Pick up" · 4 Qwikspot checks the store ·
 * 5 held, the store gets a new hold · 6 the store confirms.
 */
const BEATS = [1700, 1500, 2600, 1100, 1900, 2600, 3200] as const;

/**
 * Hero visual (UI-L2): an iPhone with the brand's WhatsApp chat playing out — the shopper asks,
 * the brand answers with the product and the nearest store with stock, the shopper holds it —
 * beside the AI's decision and the store's queue. Every chat element is something real WhatsApp
 * can render (buttons ≤ 20 characters, a footer). All messages stay in the DOM (assistive tech
 * reads the whole example); CSS reveals them beat by beat. Clearly labelled as an example.
 */
export function HeroVisual() {
  const fig = useRef<HTMLElement>(null);
  const onScreen = useOnScreen(fig);
  const beat = useBeats(BEATS, onScreen);
  const at = (n: number) => (beat >= n ? 'is-on' : 'is-off');
  const typing = beat === 1 || beat === 4;

  // A gentle 3D tilt that follows the pointer (mouse only; never with reduced motion).
  const tilt = (e: PointerEvent<HTMLElement>) => {
    if (e.pointerType !== 'mouse' || prefersReducedMotion() || !fig.current) return;
    const r = fig.current.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width - 0.5;
    const y = (e.clientY - r.top) / r.height - 0.5;
    fig.current.style.setProperty('--ry', `${(x * 10).toFixed(2)}deg`);
    fig.current.style.setProperty('--rx', `${(-y * 8).toFixed(2)}deg`);
  };
  const untilt = () => {
    fig.current?.style.setProperty('--ry', '0deg');
    fig.current?.style.setProperty('--rx', '0deg');
  };

  return (
    <figure
      ref={fig}
      className="hv"
      data-beat={beat}
      aria-label="Example: a shopper's chat and the store's queue"
      onPointerMove={tilt}
      onPointerLeave={untilt}
    >
      <div className="hv-stage">
        {/* ------------------------------------------------ the iPhone */}
        <div className="iph">
          <span className="iph__btn iph__btn--action" aria-hidden="true" />
          <span className="iph__btn iph__btn--up" aria-hidden="true" />
          <span className="iph__btn iph__btn--down" aria-hidden="true" />
          <span className="iph__btn iph__btn--power" aria-hidden="true" />
          <div className="iph__screen">
            <div className="iph__status" aria-hidden="true">
              <span className="iph__time">9:41</span>
              <span className="iph__island" />
              <span className="iph__icons">
                <svg viewBox="0 0 18 12" width="17" height="11">
                  <rect x="0" y="8" width="3" height="4" rx="1" />
                  <rect x="5" y="5.5" width="3" height="6.5" rx="1" />
                  <rect x="10" y="3" width="3" height="9" rx="1" />
                  <rect x="15" y="0" width="3" height="12" rx="1" />
                </svg>
                <svg viewBox="0 0 16 12" width="15" height="11">
                  <path d="M8 2.2c2.4 0 4.6.9 6.2 2.5l1.3-1.4A10.6 10.6 0 0 0 8 .3 10.6 10.6 0 0 0 .5 3.3l1.3 1.4A8.7 8.7 0 0 1 8 2.2Zm0 3.7c1.4 0 2.7.5 3.6 1.4l1.4-1.4A7 7 0 0 0 8 4a7 7 0 0 0-5 1.9l1.4 1.4c1-.9 2.2-1.4 3.6-1.4Zm0 3.6c-.6 0-1.1.2-1.5.6L8 11.7l1.5-1.6c-.4-.4-.9-.6-1.5-.6Z" />
                </svg>
                <span className="iph__battery">
                  <span />
                </span>
              </span>
            </div>

            {/* WhatsApp: the brand's chat */}
            <div className="hw-head">
              <ChevronLeft size={22} aria-hidden="true" />
              <span className="hw-head__avatar" aria-hidden="true">
                AS
              </span>
              <span className="hw-head__who">
                <strong>
                  AquaSkin <BadgeCheck size={13} aria-label="Verified business" />
                </strong>
                <span className={typing ? 'is-typing' : undefined}>{typing ? 'typing…' : 'online'}</span>
              </span>
              <Video size={19} aria-hidden="true" />
              <Phone size={17} aria-hidden="true" />
            </div>

            <div className="hw-chat">
              <div className="hw-scroll">
                <span className="hw-day">Today</span>
                <div className="hw-row hw-row--out is-on">
                  <p className="hw-bubble hw-bubble--out">
                    Need the vitamin C serum today. I&apos;m near Satellite.
                    <span className="hw-meta">
                      6:40 pm{' '}
                      <CheckCheck
                        size={14}
                        className={beat >= 1 ? 'hw-ticks is-read' : 'hw-ticks'}
                        aria-hidden="true"
                      />
                    </span>
                  </p>
                </div>

                <div className={`hw-row hw-row--in ${at(2)}`}>
                  <div className="hw-bubble hw-bubble--in hw-bubble--card">
                    <div className="hw-product">
                      <SerumBottle />
                      <div>
                        <strong>Vitamin C Glow Serum 30 ml</strong>
                        <span>₹795</span>
                      </div>
                    </div>
                    <p>
                      🏬 Pick up today at <strong>Wellness Mart</strong>, Satellite Road, 0.3 km · open till 10 pm
                      <br />
                      🚚 Home delivery in 4–5 days
                    </p>
                    <span className="hw-footer">Powered by Qwikspot</span>
                    <span className="hw-meta">6:41 pm</span>
                  </div>
                  <div className="hw-buttons" aria-label="Reply buttons">
                    <span className={beat === 3 ? 'is-tapped' : undefined}>Pick up: Wellness</span>
                    <span>Home delivery</span>
                    <span>Other stores</span>
                  </div>
                </div>

                <div className={`hw-row hw-row--out ${at(4)}`}>
                  <p className="hw-bubble hw-bubble--out">
                    Pick up: Wellness
                    <span className="hw-meta">
                      6:41 pm <CheckCheck size={14} className="hw-ticks is-read" aria-hidden="true" />
                    </span>
                  </p>
                </div>

                <div className={`hw-row hw-row--in ${at(5)}`}>
                  <div className="hw-bubble hw-bubble--in">
                    <div className="hw-map" aria-hidden="true">
                      <span className="hw-map__pin">
                        <MapPin size={18} />
                      </span>
                    </div>
                    <p>
                      ✅ Held for you at <strong>Wellness Mart</strong>.<br />
                      Pickup code <strong className="hw-code">4821</strong> · held until 8:40 pm
                    </p>
                    <span className="hw-meta">6:42 pm</span>
                  </div>
                </div>

                <div className={`hw-row hw-row--in ${at(6)}`}>
                  <p className="hw-bubble hw-bubble--in">
                    Wellness Mart confirmed your hold. See you soon! 👋
                    <span className="hw-meta">6:43 pm</span>
                  </p>
                </div>

                <div className={`hw-row hw-row--in hw-typing ${typing ? 'is-on' : 'is-off'}`} aria-hidden="true">
                  <span className="hw-bubble hw-bubble--in">
                    <i />
                    <i />
                    <i />
                  </span>
                </div>
              </div>
            </div>

            <div className="hw-input" aria-hidden="true">
              <span className="hw-input__field">Message</span>
              <span className="hw-input__mic">
                <svg viewBox="0 0 24 24" width="16" height="16">
                  <path d="M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3Zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.9V21h2v-3.1A7 7 0 0 0 19 11h-2Z" />
                </svg>
              </span>
            </div>
            <span className="iph__home" aria-hidden="true" />
            <span className="iph__glare" aria-hidden="true" />
          </div>
        </div>

        {/* ------------------------------------------------ around the phone */}
        <div className={`hv-chip hv-chip--intent ${beat === 0 ? 'is-live' : ''}`} aria-hidden="true">
          <span className="hv-chip__dot" />
          Intent caught · “Need it today?”
        </div>

        <div className={`hv-card hv-card--ai ${at(3)}`} role="group" aria-label="Example AI decision">
          <span className="hv-card__title">
            <Sparkles size={14} aria-hidden="true" /> Why Qwikspot did this
          </span>
          <ul>
            <li className={beat >= 4 ? 'is-ok' : undefined}>
              <Check size={13} aria-hidden="true" /> Wellness Mart · 0.3 km · 6 in stock
            </li>
            <li className={beat >= 4 ? 'is-ok' : undefined}>
              <Check size={13} aria-hidden="true" /> Open till 10 pm
            </li>
            <li className={beat >= 4 ? 'is-ok' : undefined}>
              <Check size={13} aria-hidden="true" /> Safety re-check passed
            </li>
          </ul>
        </div>

        <div className={`hv-card hv-card--queue ${at(5)}`} role="group" aria-label="Example store queue card">
          <div className="hv-queue__top">
            <span className="ui-pill ui-pill--primary">{beat >= 6 ? 'Confirmed' : 'New hold'}</span>
            <span className="hv-queue__store">
              <MapPin size={13} aria-hidden="true" /> Wellness Mart
            </span>
          </div>
          <strong>1 × Vitamin C Glow Serum 30 ml</strong>
          <span className="hv-queue__meta">Customer •••• 4821 · held until 8:40 pm</span>
          <span className={`hv-queue__confirm ${beat >= 6 ? 'is-done' : ''}`}>
            {beat >= 6 ? (
              <>
                <Check size={14} aria-hidden="true" /> Customer notified
              </>
            ) : (
              'Confirm'
            )}
          </span>
        </div>
      </div>
      <figcaption>Example · synthetic data</figcaption>
    </figure>
  );
}
