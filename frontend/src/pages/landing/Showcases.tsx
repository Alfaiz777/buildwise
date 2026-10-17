import { Check, MapPin, Navigation, Receipt, Sparkles, Store as StoreIcon } from 'lucide-react';

/**
 * Small, decorative previews beside the "For brands / stores / shoppers" sections and in the
 * "AI that proposes" section (UI-L2). They show the real product's screens in miniature, with
 * synthetic data, and animate once they scroll into view (the parent `.rv.is-in`). Labelled
 * "Illustrative example".
 */

function Label() {
  return <span className="sc-label">Illustrative example</span>;
}

/** Brand Console: Ask Qwikspot answers from the brand's own data. */
export function BrandShowcase() {
  const bars = [38, 52, 46, 61, 58, 84, 30];
  return (
    <div className="sc sc--brand" aria-hidden="true">
      <Label />
      <div className="sc-window">
        <div className="sc-window__bar">
          <i />
          <i />
          <i />
          <span>Brand Console · Insights</span>
        </div>
        <div className="sc-ask">
          <p className="sc-ask__q">Which store runs out first?</p>
          <div className="sc-ask__a">
            <span className="sc-ask__mark">
              <Sparkles size={13} />
            </span>
            <p>
              <strong>Navrangpura</strong> runs out of Serum 30 ml on <strong>Saturdays</strong>. Move 6 units there by
              Friday.
            </p>
          </div>
        </div>
        <div className="sc-chart">
          {bars.map((h, i) => (
            <span key={i} className={i === 5 ? 'is-peak' : undefined} style={{ '--h': `${h}%`, '--i': i } as never}>
              <i>{'MTWTFSS'[i]}</i>
            </span>
          ))}
        </div>
        <div className="sc-trace">
          <Check size={13} /> Why Qwikspot did this · 3 checks passed
        </div>
      </div>
    </div>
  );
}

/** Store Console: a hold moving through its steps, and a walk-in sale keeping stock true. */
export function StoreShowcase() {
  return (
    <div className="sc sc--store" aria-hidden="true">
      <Label />
      <div className="sc-window">
        <div className="sc-window__bar">
          <i />
          <i />
          <i />
          <span>Store Console · Today</span>
        </div>
        <div className="sc-hold">
          <div className="sc-hold__top">
            <span className="sc-pill">Next up</span>
            <span className="sc-muted">expires in 18 min</span>
          </div>
          <strong>1 × Vitamin C Glow Serum 30 ml</strong>
          <span className="sc-muted">Customer •••• 4821 · nearest store with stock</span>
          <ol className="sc-progress">
            {['Confirmed', 'Ready', 'Arrived', 'Picked up'].map((s, i) => (
              <li key={s} style={{ '--i': i } as never}>
                <span>
                  <Check size={11} />
                </span>
                {s}
              </li>
            ))}
          </ol>
        </div>
        <div className="sc-sale">
          <Receipt size={15} />
          <span>
            <strong>INV-000124</strong> walk-in sale · 2 units
            <span className="sc-muted"> · stock updated for Qwikspot</span>
          </span>
        </div>
      </div>
    </div>
  );
}

/** The shopper's pickup pass in the brand's chat. */
export function ShopperShowcase() {
  return (
    <div className="sc sc--shopper" aria-hidden="true">
      <Label />
      <div className="sc-pass">
        <div className="sc-pass__head">
          <span className="sc-pass__store">
            <StoreIcon size={16} />
          </span>
          <span>
            <strong>Wellness Mart</strong>
            <span className="sc-muted">Satellite Road · 0.3 km · open till 10 pm</span>
          </span>
        </div>
        <div className="sc-pass__code">
          <span className="sc-muted">Pickup code</span>
          <strong>
            {'4821'.split('').map((d, i) => (
              <span key={i} style={{ '--i': i } as never}>
                {d}
              </span>
            ))}
          </strong>
        </div>
        <div className="sc-pass__item">
          <span>1 × Vitamin C Glow Serum 30 ml</span>
          <span className="sc-muted">held until 8:40 pm</span>
        </div>
        <div className="sc-pass__actions">
          <span>
            <Navigation size={13} /> Directions
          </span>
          <span>
            <MapPin size={13} /> Other stores
          </span>
        </div>
      </div>
    </div>
  );
}

/** "AI that proposes. Rules that decide.": the proposal, the checks ticking, the action. */
export function DecisionFlow() {
  const checks = ['In stock now', 'Open when you arrive', 'Nearest with stock', 'Shopper opted in'];
  return (
    <div className="df" aria-hidden="true">
      <div className="df-node df-node--ai">
        <span className="df-node__tag">AI proposes</span>
        <p>“Hold Serum 30 ml at Wellness Mart, 0.3 km.”</p>
      </div>
      <span className="df-wire">
        <i />
      </span>
      <div className="df-node df-node--rules">
        <span className="df-node__tag">Rules decide</span>
        <ul>
          {checks.map((c, i) => (
            <li key={c} style={{ '--i': i } as never}>
              <span>
                <Check size={11} />
              </span>
              {c}
            </li>
          ))}
        </ul>
      </div>
      <span className="df-wire df-wire--2">
        <i />
      </span>
      <div className="df-node df-node--act">
        <span className="df-node__tag">Then it happens</span>
        <p>Held · pickup code sent · the store is told</p>
      </div>
    </div>
  );
}
