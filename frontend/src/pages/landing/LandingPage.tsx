import {
  ArrowRight,
  BrainCircuit,
  CheckCircle2,
  Clock3,
  EyeOff,
  LineChart,
  ListChecks,
  MapPinned,
  Menu,
  MessageCircle,
  MousePointerClick,
  ScanSearch,
  ShieldCheck,
  Store,
  Tags,
  Truck,
  UserRound,
} from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../../auth/authContext';
import { Wordmark } from '../../components/shell/Wordmark';
import { Drawer } from '../../components/ui';
import type { FrontendProfile } from '../../config';
import { shopperDemoAvailable, useDemoConfig } from '../../lib/demoConfig';
import { usePageTitle } from '../../lib/pageTitle';
import { HeroVisual } from './HeroVisual';

const ANCHORS = [
  ['#how-it-works', 'How it works'],
  ['#for-brands', 'For brands'],
  ['#for-stores', 'For stores'],
  ['#for-shoppers', 'For shoppers'],
] as const;

function ShopperLink({ className = 'ui-button ui-button--secondary' }: { className?: string }) {
  return (
    <a className={className} href="/shop" target="_blank" rel="noopener noreferrer">
      See it as a shopper ↗
    </a>
  );
}

function Section({
  id,
  eyebrow,
  title,
  lead,
  children,
  tone,
}: {
  id?: string;
  eyebrow?: string;
  title: string;
  lead?: string;
  children: ReactNode;
  tone?: 'tint' | 'dark';
}) {
  const headingId = `${id ?? title.replace(/\W+/g, '-').toLowerCase()}-title`;
  return (
    <section id={id} className={`lp-section${tone ? ` lp-section--${tone}` : ''}`} aria-labelledby={headingId}>
      <div className="lp-container">
        {eyebrow && <p className="lp-eyebrow">{eyebrow}</p>}
        <h2 id={headingId}>{title}</h2>
        {lead && <p className="lp-lead">{lead}</p>}
        {children}
      </div>
    </section>
  );
}

function Checklist({ items }: { items: string[] }) {
  return (
    <ul className="lp-checklist">
      {items.map((item) => (
        <li key={item}>
          <CheckCircle2 size={18} aria-hidden="true" />
          <span>{item}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * Public landing page ("/", Interface Refresh UI-1, Part 1 §1.2): the problem, the flow,
 * what each party gets, and the two doors (Brand login / Store login). No sign-in needed;
 * the only API call is the public demo config, and the page works without it.
 * Illustrations are labelled "Example"; no statistics are invented.
 */
export function LandingPage({ profile = 'local' }: { profile?: FrontendProfile }) {
  usePageTitle('Qwikspot — get it today at a store near you');
  const { user } = useAuth();
  const demo = useDemoConfig();
  const shopper = shopperDemoAvailable(demo, profile);
  const [menu, setMenu] = useState(false);

  const logins = user ? (
    <Link className="ui-button ui-button--primary" to="/app">
      Go to your console <ArrowRight size={16} aria-hidden="true" />
    </Link>
  ) : (
    <>
      <Link className="ui-button ui-button--ghost" to="/login?as=brand">
        Brand login
      </Link>
      <Link className="ui-button ui-button--primary" to="/login?as=store">
        Store login
      </Link>
    </>
  );

  return (
    <div className="lp">
      <header className="lp-header">
        <div className="lp-container lp-header__inner">
          <Link to="/" aria-label="Qwikspot home" className="lp-header__home">
            <Wordmark />
          </Link>
          <nav className="lp-header__nav" aria-label="Sections">
            {ANCHORS.map(([href, text]) => (
              <a key={href} href={href}>
                {text}
              </a>
            ))}
          </nav>
          <div className="lp-header__actions">{logins}</div>
          <button
            type="button"
            className="lp-header__menu ui-button ui-button--secondary ui-button--sm"
            onClick={() => setMenu(true)}
          >
            <Menu size={16} aria-hidden="true" /> Menu
          </button>
        </div>
      </header>
      <Drawer open={menu} title="Qwikspot" onClose={() => setMenu(false)}>
        <nav className="lp-menu" aria-label="Menu">
          {ANCHORS.map(([href, text]) => (
            <a key={href} href={href} onClick={() => setMenu(false)}>
              {text}
            </a>
          ))}
          <div className="lp-menu__actions">{logins}</div>
        </nav>
      </Drawer>

      <main>
        {/* 2. Hero */}
        <section className="lp-hero" aria-labelledby="hero-title">
          <div className="lp-container lp-hero__inner">
            <div className="lp-hero__copy">
              <p className="lp-eyebrow">For D2C brands and their partner stores</p>
              <h1 id="hero-title">Your shopper wants it today. Your partner store has it.</h1>
              <p className="lp-hero__sub">
                Qwikspot catches buying intent on your website, continues the conversation on WhatsApp in your
                brand&apos;s name, and holds the product at the nearest partner store that actually has it. A 4–5 day
                delivery becomes a same-day pickup.
              </p>
              <div className="lp-hero__ctas">
                <Link className="ui-button ui-button--accent lp-cta" to="/login?as=brand">
                  <Tags size={18} aria-hidden="true" /> I&apos;m a brand{' '}
                  <span className="lp-cta__hint">Brand login</span>
                </Link>
                <Link className="ui-button ui-button--secondary lp-cta" to="/login?as=store">
                  <Store size={18} aria-hidden="true" /> I run a store <span className="lp-cta__hint">Store login</span>
                </Link>
                {shopper && <ShopperLink className="ui-button ui-button--ghost lp-cta" />}
              </div>
            </div>
            <HeroVisual />
          </div>
        </section>

        {/* 3. The problem */}
        <Section eyebrow="The problem" title="Three ways a ready-to-buy shopper slips away">
          <div className="lp-grid lp-grid--3">
            {[
              [EyeOff, 'Intent disappears', 'Shoppers search, add to cart and leave. You never hear from them again.'],
              [Truck, 'Delivery is slow', "A shopper who needs it today won't wait 4–5 days. They buy elsewhere."],
              [
                MapPinned,
                'Stores are invisible online',
                'A partner store 2 km away has the product. The shopper never finds out.',
              ],
            ].map(([Icon, title, text]) => {
              const I = Icon as typeof EyeOff;
              return (
                <article key={title as string} className="lp-card">
                  <span className="lp-icon lp-icon--warm" aria-hidden="true">
                    <I size={20} />
                  </span>
                  <h3>{title as string}</h3>
                  <p>{text as string}</p>
                </article>
              );
            })}
          </div>
        </Section>

        {/* 4. How it works */}
        <Section id="how-it-works" eyebrow="How it works" title="How Qwikspot works" tone="tint">
          <ol className="lp-steps">
            {[
              [
                MousePointerClick,
                'Catch intent',
                'On your website: searches, product views, carts and the "Need it today?" button.',
              ],
              [MessageCircle, 'Continue on WhatsApp', "In your brand's name. Answers come only from your catalogue."],
              [
                Store,
                'Hold at the right store',
                'Live store stock, distance and opening hours, a safety re-check before every hold, and a pickup code.',
              ],
              [
                LineChart,
                'Learn',
                'Every pickup, online order and missed request becomes an insight, like "Andheri runs out of Serum 30 ml on Saturdays."',
              ],
            ].map(([Icon, title, text], i) => {
              const I = Icon as typeof EyeOff;
              return (
                <li key={title as string} className="lp-step">
                  <span className="lp-step__num" aria-hidden="true">
                    {i + 1}
                  </span>
                  <span className="lp-icon" aria-hidden="true">
                    <I size={20} />
                  </span>
                  <h3>{title as string}</h3>
                  <p>{text as string}</p>
                </li>
              );
            })}
          </ol>
        </Section>

        {/* 5. One story, three winners */}
        <Section eyebrow="A day with Qwikspot" title="One story, three winners">
          <p className="lp-example-tag">
            <span className="ui-pill ui-pill--warning">Example</span> An illustrative journey with made-up people and
            times.
          </p>
          <div className="lp-story">
            <ol className="lp-timeline" aria-label="Example journey">
              {[
                ['6:40 pm', 'Priya views Vitamin C Glow Serum 30 ml and taps "Need it today?"'],
                ['6:41 pm', "The brand's WhatsApp offers Andheri Store; Powai is out of stock."],
                ['6:42 pm', 'She holds it and gets pickup code 48••••.'],
                ['7:30 pm', 'Andheri Store marks it ready.'],
                ['8:05 pm', 'She picks it up.'],
              ].map(([time, text]) => (
                <li key={time}>
                  <time>{time}</time>
                  <span>{text}</span>
                </li>
              ))}
            </ol>
            <div className="lp-winners">
              {[
                [
                  Tags,
                  'The brand got',
                  'A sale that would have been lost, a happier customer, and a data point about where stock ran out.',
                ],
                [Store, 'The store got', 'A walk-in who had already decided to buy.'],
                [UserRound, 'The shopper got', 'Her serum today, not in 5 days.'],
              ].map(([Icon, title, text]) => {
                const I = Icon as typeof EyeOff;
                return (
                  <article key={title as string} className="lp-card lp-card--compact">
                    <span className="lp-icon" aria-hidden="true">
                      <I size={18} />
                    </span>
                    <h3>{title as string}</h3>
                    <p>{text as string}</p>
                  </article>
                );
              })}
            </div>
          </div>
        </Section>

        {/* 6–8. For brands / stores / shoppers */}
        <Section
          id="for-brands"
          eyebrow="For brands"
          title="Turn buying intent into sales, online or in your partner stores."
          tone="tint"
        >
          <div className="lp-audience">
            <Checklist
              items={[
                'Recover abandoned intent with helpful, opt-in follow-ups.',
                'Turn "need it today" into same-day store sales.',
                'See which stores run out, and when.',
                'Every AI decision explained.',
                'Customers always hear from your brand, never from us.',
              ]}
            />
            <Link className="ui-button ui-button--accent" to="/login?as=brand">
              Brand login <ArrowRight size={16} aria-hidden="true" />
            </Link>
          </div>
        </Section>

        <Section id="for-stores" eyebrow="For stores" title="More customers who arrive ready to buy.">
          <div className="lp-audience">
            <Checklist
              items={[
                'Customers arrive already decided.',
                'A simple queue: confirm, mark ready, hand over with a code.',
                "Can't fulfil a hold? An honest refusal re-routes the customer instead of losing them.",
                'See what shoppers near you are asking for.',
              ]}
            />
            <Link className="ui-button ui-button--primary" to="/login?as=store">
              Store login <ArrowRight size={16} aria-hidden="true" />
            </Link>
          </div>
        </Section>

        <Section id="for-shoppers" eyebrow="For shoppers" title="Know before you go." tone="tint">
          <div className="lp-audience">
            <Checklist
              items={[
                'See which nearby store has it before you leave home.',
                'The product is held for you; pick it up today.',
                'One chat for questions, stores and ordering online.',
                'At most one follow-up, and only if you opted in. Reply STOP any time.',
              ]}
            />
            {shopper && <ShopperLink />}
          </div>
        </Section>

        {/* 9. Attract and retain */}
        <Section eyebrow="Attract and retain" title="Attract new buyers. Keep them coming back.">
          <div className="lp-grid lp-grid--2">
            <article className="lp-card">
              <span className="lp-icon lp-icon--warm" aria-hidden="true">
                <ScanSearch size={20} />
              </span>
              <h3>Attract</h3>
              <p>
                Capture shoppers who would have left: the &ldquo;Need it today?&rdquo; button, nearby stock and instant
                answers from your catalogue.
              </p>
            </article>
            <article className="lp-card">
              <span className="lp-icon" aria-hidden="true">
                <Clock3 size={20} />
              </span>
              <h3>Retain</h3>
              <p>
                Helpful follow-ups only to opted-in shoppers (at most one per intent and one per 24 hours), store visits
                that build the relationship, and demand data that keeps the right stock in the right store.
              </p>
            </article>
          </div>
        </Section>

        {/* 10. AI that proposes, rules that decide */}
        <Section eyebrow="How decisions are made" title="AI that proposes. Rules that decide." tone="dark">
          <div className="lp-grid lp-grid--3">
            {[
              [
                BrainCircuit,
                'The AI proposes',
                'It understands the shopper and suggests the next step: an answer, a store, a hold, an alternative or the online link.',
              ],
              [
                ListChecks,
                'The rules decide',
                'Qwikspot checks stock, opening hours, distance and consent before anything happens.',
              ],
              [ScanSearch, 'You can see why', 'Every decision has a "Why Qwikspot did this" trace your team can read.'],
            ].map(([Icon, title, text]) => {
              const I = Icon as typeof EyeOff;
              return (
                <article key={title as string} className="lp-card lp-card--dark">
                  <span className="lp-icon lp-icon--dark" aria-hidden="true">
                    <I size={20} />
                  </span>
                  <h3>{title as string}</h3>
                  <p>{text as string}</p>
                </article>
              );
            })}
          </div>
        </Section>

        {/* 11. Trust */}
        <Section eyebrow="Trust" title="Built on trust">
          <div className="lp-trust">
            <ShieldCheck size={40} aria-hidden="true" className="lp-trust__icon" />
            <Checklist
              items={[
                "Shoppers see your brand's name, not ours.",
                'Stores see a masked customer, never contact details.',
                'No personal data is collected from your website.',
                'Opt-in and STOP are always respected.',
              ]}
            />
          </div>
        </Section>

        {/* 12. Final CTA */}
        <section className="lp-final" aria-labelledby="final-title">
          <div className="lp-container">
            <h2 id="final-title">Ready to turn &ldquo;need it today&rdquo; into a sale?</h2>
            <div className="lp-hero__ctas">
              <Link className="ui-button ui-button--accent lp-cta" to="/login?as=brand">
                Brand login
              </Link>
              <Link className="ui-button ui-button--secondary lp-cta" to="/login?as=store">
                Store login
              </Link>
            </div>
          </div>
        </section>
      </main>

      <footer className="lp-footer">
        <div className="lp-container lp-footer__inner">
          <Wordmark />
          <Link to="/login?as=platform">Qwikspot team sign-in</Link>
          {demo.demoMode && <span>Demo data is synthetic.</span>}
          <span>© 2026 Qwikspot</span>
        </div>
      </footer>
    </div>
  );
}
