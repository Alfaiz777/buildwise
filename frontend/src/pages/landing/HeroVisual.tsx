import { CheckCheck, Clock, MapPin } from 'lucide-react';

/** A simple self-made illustration of a serum bottle (no third-party imagery). */
function SerumBottle() {
  return (
    <svg viewBox="0 0 64 64" width="56" height="56" aria-hidden="true">
      <rect width="64" height="64" rx="12" fill="var(--amber-50)" />
      <rect x="27" y="8" width="10" height="9" rx="2" fill="var(--grey-800)" />
      <rect x="29" y="16" width="6" height="5" fill="var(--grey-700)" />
      <rect x="21" y="21" width="22" height="35" rx="6" fill="var(--amber-400)" />
      <rect x="25" y="31" width="14" height="14" rx="2" fill="#fff" opacity="0.92" />
      <text x="32" y="41" textAnchor="middle" fontSize="7" fontWeight="700" fill="var(--amber-700)">
        C
      </text>
    </svg>
  );
}

/**
 * Hero visual (UI-1): a static, clearly labelled example of what the shopper sees in the
 * brand's WhatsApp chat and what the store sees in its queue. Every part of the chat is
 * something real WhatsApp can render (short buttons, a footer). UI-2 replaces it with the
 * real chat components.
 */
export function HeroVisual() {
  return (
    <figure className="hero-visual" aria-label="Example: a shopper's chat and the store's queue">
      <div className="hero-phone">
        <div className="hero-phone__bar">
          <span className="hero-phone__avatar" aria-hidden="true">
            DB
          </span>
          <div>
            <strong>Demo Beauty Co</strong>
            <span>usually replies instantly</span>
          </div>
        </div>
        <div className="hero-phone__chat">
          <p className="hero-bubble hero-bubble--in">
            Need the vitamin C serum today. I&apos;m near Powai.
            <CheckCheck size={14} aria-hidden="true" />
          </p>
          <div className="hero-bubble hero-bubble--out">
            <div className="hero-card">
              <SerumBottle />
              <div>
                <strong>Vitamin C Glow Serum 30 ml</strong>
                <span>₹795</span>
              </div>
            </div>
            <p>
              🏬 Pick up today at <strong>Andheri Store</strong>, 2.1 km · open till 9 pm
              <br />
              🚚 Home delivery in 4–5 days
            </p>
            <span className="hero-bubble__footer">Powered by Qwikspot</span>
          </div>
          <div className="hero-buttons" aria-label="Reply buttons">
            <span>Pick up today</span>
            <span>Home delivery</span>
            <span>Other stores</span>
          </div>
        </div>
      </div>
      <div className="hero-queue" aria-label="Example store queue card">
        <div className="hero-queue__top">
          <span className="ui-pill ui-pill--primary">New hold</span>
          <span className="hero-queue__store">
            <MapPin size={14} aria-hidden="true" /> Andheri Store
          </span>
        </div>
        <strong>1 × Vitamin C Glow Serum 30 ml</strong>
        <span className="hero-queue__meta">
          <Clock size={14} aria-hidden="true" /> Customer •••• 4821 · held until 8:40 pm
        </span>
        <span className="hero-queue__confirm">Confirm</span>
      </div>
      <figcaption>Example · synthetic data</figcaption>
    </figure>
  );
}
