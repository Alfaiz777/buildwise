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
import { useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../../auth/authContext';
import { Wordmark } from '../../components/shell/Wordmark';
import { Drawer } from '../../components/ui';
import type { FrontendProfile } from '../../config';
import { useDemoConfig } from '../../lib/demoConfig';
import { LEGAL_LINKS } from '../../lib/legal';
import { usePageTitle } from '../../lib/pageTitle';
import { HeroVisual } from './HeroVisual';
import { useActiveSection, useReveal, useScrolled } from './motion';
import { BrandShowcase, DecisionFlow, ShopperShowcase, StoreShowcase } from './Showcases';

const ANCHORS = [
  ['#how-it-works', 'How it works'],
  ['#for-brands', 'For brands'],
  ['#for-stores', 'For stores'],
  ['#for-shoppers', 'For shoppers'],
] as const;
const ANCHOR_IDS = ANCHORS.map(([href]) => href.slice(1));

/** What Qwikspot does, as a moving band under the hero. */
const CAPABILITIES = [
  'WhatsApp in your brand’s name',
  'Live store stock',
  'Safety re-check before every hold',
  'Pickup codes',
  'Walk-in sales keep stock true',
  'Every decision explained',
  'Opt-in follow-ups, STOP respected',
  'Demand insights per store',
];

/** A stagger index for reveal animations. */
const delay = (i: number) => ({ '--d': `${i * 90}ms` }) as CSSProperties;

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
        <div className="lp-section__head rv">
          {eyebrow && <p className="lp-eyebrow">{eyebrow}</p>}
          <h2 id={headingId}>{title}</h2>
          {lead && <p className="lp-lead">{lead}</p>}
        </div>
        {children}
      </div>
    </section>
  );
}

function Checklist({ items }: { items: string[] }) {
  return (
    <ul className="lp-checklist">
      {items.map((item, i) => (
        <li key={item} className="rv" style={delay(i)}>
          <CheckCircle2 size={18} aria-hidden="true" />
          <span>{item}</span>
        </li>
      ))}
    </ul>
  );
}

/** A "For …" section: the promise and its checklist beside a live preview of that screen. */
function Audience({
  id,
  eyebrow,
  title,
  items,
  action,
  preview,
  tone,
  flip = false,
}: {
  id: string;
  eyebrow: string;
  title: string;
  items: string[];
  action?: ReactNode;
  preview: ReactNode;
  tone?: 'tint';
  flip?: boolean;
}) {
  return (
    <section id={id} className={`lp-section${tone ? ` lp-section--${tone}` : ''}`} aria-labelledby={`${id}-title`}>
      <div className={`lp-container lp-audience${flip ? ' lp-audience--flip' : ''}`}>
        <div className="lp-audience__copy">
          <div className="rv">
            <p className="lp-eyebrow">{eyebrow}</p>
            <h2 id={`${id}-title`}>{title}</h2>
          </div>
          <Checklist items={items} />
          {action && <div className="rv">{action}</div>}
        </div>
        <div className="lp-audience__preview rv rv--zoom">{preview}</div>
      </div>
    </section>
  );
}

/**
 * Public landing page ("/", UI-1; UI-L2 redesign): the problem, the flow, what each party gets,
 * and the two doors (Brand login / Store login). No sign-in needed; the only API call is the
 * public demo config, and the page works without it. Illustrations are labelled as examples;
 * no statistics are invented. Motion: a live hero phone, scroll reveals, a moving capability
 * band — all of it still with reduced motion, and fully visible without JavaScript observers.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function LandingPage({ profile: _profile = 'local' }: { profile?: FrontendProfile }) {
  usePageTitle('Qwikspot — get it today at a store near you');
  const { user } = useAuth();
  const demo = useDemoConfig();
  const [menu, setMenu] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useReveal(root);
  const scrolled = useScrolled();
  const active = useActiveSection(ANCHOR_IDS);

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
    <div className="lp" ref={root}>
      <header className={`lp-header${scrolled ? ' is-scrolled' : ''}`}>
        <div className="lp-container lp-header__inner">
          <Link to="/" aria-label="Qwikspot home" className="lp-header__home">
            <Wordmark />
          </Link>
          <nav className="lp-header__nav" aria-label="Sections">
            {ANCHORS.map(([href, text]) => (
              <a key={href} href={href} className={active === href.slice(1) ? 'is-active' : undefined}>
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
        {/* Hero */}
        <section className="lp-hero" aria-labelledby="hero-title">
          <div className="lp-hero__bg" aria-hidden="true">
            <span className="lp-blob lp-blob--a" />
            <span className="lp-blob lp-blob--b" />
            <span className="lp-blob lp-blob--c" />
            <span className="lp-grid-dots" />
            {[
              [58, 10],
              [94, 34],
              [62, 90],
              [97, 78],
              [52, 52],
              [40, 96],
            ].map(([x, y], i) => (
              <span
                key={i}
                className="lp-ping"
                style={{ left: `${x}%`, top: `${y}%`, '--d': `${i * 0.9}s` } as CSSProperties}
              />
            ))}
          </div>
          <div className="lp-container lp-hero__inner">
            <div className="lp-hero__copy">
              <p className="lp-badge lp-in" style={delay(0)}>
                <span className="lp-badge__dot" aria-hidden="true" />
                For D2C brands and their partner stores
              </p>
              <h1 id="hero-title" className="lp-in" style={delay(1)}>
                Your shopper wants it <span className="lp-hl">today</span>. Your partner store{' '}
                <span className="lp-hl lp-hl--amber">has it</span>.
              </h1>
              <p className="lp-hero__sub lp-in" style={delay(2)}>
                Qwikspot catches buying intent on your website, continues the conversation on WhatsApp in your
                brand&apos;s name, and holds the product at the nearest partner store that actually has it. A 4–5 day
                delivery becomes a same-day pickup.
              </p>
              <div className="lp-hero__ctas lp-in" style={delay(3)}>
                <Link className="ui-button ui-button--accent lp-cta lp-cta--glow" to="/login?as=brand">
                  <Tags size={18} aria-hidden="true" /> I&apos;m a brand{' '}
                  <span className="lp-cta__hint">Brand login</span>
                </Link>
                <Link className="ui-button ui-button--secondary lp-cta" to="/login?as=store">
                  <Store size={18} aria-hidden="true" /> I run a store <span className="lp-cta__hint">Store login</span>
                </Link>
              </div>
              <ul className="lp-hero__proof lp-in" style={delay(4)}>
                <li>
                  <MessageCircle size={15} aria-hidden="true" /> WhatsApp in your name
                </li>
                <li>
                  <MapPinned size={15} aria-hidden="true" /> Live store stock
                </li>
                <li>
                  <ScanSearch size={15} aria-hidden="true" /> Every decision explained
                </li>
              </ul>
            </div>
            <div className="lp-hero__visual lp-in" style={delay(2)}>
              <HeroVisual />
            </div>
          </div>
        </section>

        {/* What it does, moving */}
        <div className="lp-marquee">
          <ul className="lp-marquee__track" aria-label="What Qwikspot does">
            {[...CAPABILITIES, ...CAPABILITIES].map((c, i) => (
              <li key={i} aria-hidden={i >= CAPABILITIES.length || undefined}>
                <span className="lp-marquee__pin" aria-hidden="true" />
                {c}
              </li>
            ))}
          </ul>
        </div>

        {/* The problem */}
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
            ].map(([Icon, title, text], i) => {
              const I = Icon as typeof EyeOff;
              return (
                <article key={title as string} className="lp-card lp-card--problem rv" style={delay(i)}>
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

        {/* How it works: the agent's pipeline */}
        <Section id="how-it-works" eyebrow="How it works" title="How Qwikspot works" tone="tint">
          <div className="lp-steps-wrap rv">
            <span className="lp-steps__beam" aria-hidden="true">
              <i />
            </span>
            <ol className="lp-steps">
              {[
                [
                  MousePointerClick,
                  'Catch intent',
                  'On your website: searches, product views, carts and the "Need it today?" button.',
                  'Website snippet',
                ],
                [
                  MessageCircle,
                  'Continue on WhatsApp',
                  "In your brand's name. Answers come only from your catalogue.",
                  'AI agent',
                ],
                [
                  Store,
                  'Hold at the right store',
                  'Live store stock, distance and opening hours, a safety re-check before every hold, and a pickup code.',
                  'Rules + live stock',
                ],
                [
                  LineChart,
                  'Learn',
                  'Every pickup, online order and missed request becomes an insight, like "Navrangpura runs out of Serum 30 ml on Saturdays."',
                  'Insights',
                ],
              ].map(([Icon, title, text, tag], i) => {
                const I = Icon as typeof EyeOff;
                return (
                  <li key={title as string} className="lp-step" style={delay(i + 1)}>
                    <span className="lp-step__node" aria-hidden="true">
                      <I size={20} />
                      <span className="lp-step__num">{i + 1}</span>
                    </span>
                    <span className="lp-step__tag">{tag as string}</span>
                    <h3>{title as string}</h3>
                    <p>{text as string}</p>
                  </li>
                );
              })}
            </ol>
          </div>
        </Section>

        {/* One story, three winners */}
        <Section eyebrow="A day with Qwikspot" title="One story, three winners">
          <p className="lp-example-tag rv">
            <span className="ui-pill ui-pill--warning">Example</span> An illustrative journey with made-up people and
            times.
          </p>
          <div className="lp-story">
            <ol className="lp-timeline rv" aria-label="Example journey">
              {[
                ['6:40 pm', 'Priya views Vitamin C Glow Serum 30 ml and taps "Need it today?"'],
                ['6:41 pm', "The brand's WhatsApp lists three Satellite stores with stock, nearest first."],
                ['6:42 pm', 'She holds it and gets pickup code 48••••.'],
                ['7:30 pm', 'Wellness Mart marks it ready.'],
                ['8:05 pm', 'She picks it up.'],
              ].map(([time, text], i) => (
                <li key={time} style={delay(i)}>
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
              ].map(([Icon, title, text], i) => {
                const I = Icon as typeof EyeOff;
                return (
                  <article key={title as string} className="lp-card lp-card--compact rv" style={delay(i + 2)}>
                    <span className="lp-icon" aria-hidden="true">
                      <I size={18} />
                    </span>
                    <div>
                      <h3>{title as string}</h3>
                      <p>{text as string}</p>
                    </div>
                  </article>
                );
              })}
            </div>
          </div>
        </Section>

        {/* For brands / stores / shoppers */}
        <Audience
          id="for-brands"
          eyebrow="For brands"
          title="Turn buying intent into sales, online or in your partner stores."
          tone="tint"
          items={[
            'Recover abandoned intent with helpful, opt-in follow-ups.',
            'Turn "need it today" into same-day store sales.',
            'See which stores run out, and when.',
            'Every AI decision explained.',
            'Customers always hear from your brand, never from us.',
          ]}
          action={
            <Link className="ui-button ui-button--accent" to="/login?as=brand">
              Brand login <ArrowRight size={16} aria-hidden="true" />
            </Link>
          }
          preview={<BrandShowcase />}
        />
        <Audience
          id="for-stores"
          eyebrow="For stores"
          title="More customers who arrive ready to buy."
          flip
          items={[
            'Customers arrive already decided.',
            'A simple queue: confirm, mark ready, hand over with a code.',
            "Can't fulfil a hold? An honest refusal re-routes the customer instead of losing them.",
            'Record walk-in sales; the stock Qwikspot offers updates at once.',
            'See what shoppers near you are asking for.',
          ]}
          action={
            <Link className="ui-button ui-button--primary" to="/login?as=store">
              Store login <ArrowRight size={16} aria-hidden="true" />
            </Link>
          }
          preview={<StoreShowcase />}
        />
        <Audience
          id="for-shoppers"
          eyebrow="For shoppers"
          title="Know before you go."
          tone="tint"
          items={[
            'See which nearby store has it before you leave home.',
            'The product is held for you; pick it up today.',
            'One chat for questions, stores and ordering online.',
            'At most one follow-up, and only if you opted in. Reply STOP any time.',
          ]}
          preview={<ShopperShowcase />}
        />

        {/* Attract and retain */}
        <Section eyebrow="Attract and retain" title="Attract new buyers. Keep them coming back.">
          <div className="lp-grid lp-grid--2">
            <article className="lp-card lp-card--feature rv">
              <span className="lp-icon lp-icon--warm" aria-hidden="true">
                <ScanSearch size={20} />
              </span>
              <h3>Attract</h3>
              <p>
                Capture shoppers who would have left: the &ldquo;Need it today?&rdquo; button, nearby stock and instant
                answers from your catalogue.
              </p>
            </article>
            <article className="lp-card lp-card--feature rv" style={delay(1)}>
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

        {/* AI that proposes, rules that decide */}
        <Section eyebrow="How decisions are made" title="AI that proposes. Rules that decide." tone="dark">
          <div className="lp-decide rv">
            <DecisionFlow />
          </div>
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
            ].map(([Icon, title, text], i) => {
              const I = Icon as typeof EyeOff;
              return (
                <article key={title as string} className="lp-card lp-card--dark rv" style={delay(i)}>
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

        {/* Trust */}
        <Section eyebrow="Trust" title="Built on trust">
          <div className="lp-trust rv">
            <span className="lp-trust__shield" aria-hidden="true">
              <ShieldCheck size={44} />
            </span>
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

        {/* Final CTA */}
        <section className="lp-final" aria-labelledby="final-title">
          <div className="lp-final__bg" aria-hidden="true">
            {[18, 42, 66, 84].map((x, i) => (
              <span key={x} className="lp-final__pin" style={{ left: `${x}%`, '--d': `${i * 0.7}s` } as CSSProperties}>
                <svg viewBox="0 0 24 24">
                  <path d="M12 2.5c-4 0-7.2 3.1-7.2 7 0 5.2 6.1 11.3 6.6 11.8a.85.85 0 0 0 1.2 0c.5-.5 6.6-6.6 6.6-11.8 0-3.9-3.2-7-7.2-7Z" />
                  <path className="lp-final__check" d="m8.9 9.6 2.2 2.2 4-4.1" />
                </svg>
              </span>
            ))}
          </div>
          <div className="lp-container rv">
            <h2 id="final-title">Ready to turn &ldquo;need it today&rdquo; into a sale?</h2>
            <p className="lp-final__sub">Brands and partner stores sign in to their own console.</p>
            <div className="lp-hero__ctas">
              <Link className="ui-button ui-button--accent lp-cta lp-cta--glow" to="/login?as=brand">
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
          {LEGAL_LINKS.map((l) => (
            <a key={l.href} href={l.href} target="_blank" rel="noopener noreferrer">
              {l.label}
            </a>
          ))}
          <span>© 2026 Qwikspot</span>
        </div>
      </footer>
    </div>
  );
}
