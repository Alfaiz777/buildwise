/**
 * Change 16 (UI-2): every automated message fits what real WhatsApp can render, and the
 * "Powered by Qwikspot" footer appears only where it belongs.
 */
import { describe, expect, it } from 'vitest';
import { decorateParts, POWERED_BY_FOOTER } from '../src/domain/messageParts.js';
import {
  fit,
  isInteractive,
  layoutOf,
  MessagePartsError,
  validateMessage,
  WHATSAPP_LIMITS,
} from '../src/domain/whatsappLimits.js';
import type { OutboundOption } from '../src/ports/messaging.js';

const opt = (id: string, label: string, extra: Partial<OutboundOption> = {}): OutboundOption => ({
  optionId: id,
  label,
  ...extra,
});
const rejects = (m: Parameters<typeof validateMessage>[0], code: string) => {
  expect(() => validateMessage(m)).toThrow(MessagePartsError);
  expect(() => validateMessage(m)).toThrow(code);
};

describe('WhatsApp limits', () => {
  it('fit() shortens on a word boundary with an ellipsis and never exceeds the limit', () => {
    expect(fit('short', 20)).toBe('short');
    const out = fit('Vitamin C Glow Serum is available today', 20);
    expect(out.length).toBeLessThanOrEqual(20);
    expect(out.endsWith('…')).toBe(true);
    expect(out).toBe('Vitamin C Glow…');
  });

  it('layout: ≤ 3 short choices are buttons; more, longer labels, descriptions or sections make a list', () => {
    expect(layoutOf([opt('a', 'Hold at Andheri'), opt('b', 'Other stores'), opt('c', 'Buy online')], undefined)).toBe(
      'BUTTONS',
    );
    expect(
      layoutOf(
        [1, 2, 3, 4].map((i) => opt(`o${i}`, `Store ${i}`)),
        undefined,
      ),
    ).toBe('LIST');
    expect(layoutOf([opt('a', 'Hold 1 at Andheri (2.1 km, open)')], undefined)).toBe('LIST');
    expect(layoutOf([opt('a', 'Andheri', { description: '2.1 km' })], undefined)).toBe('LIST');
    expect(layoutOf(undefined, { ctaUrl: { label: 'Buy online', url: 'https://x.test' } })).toBe('CTA');
    expect(layoutOf(undefined, undefined)).toBe('TEXT');
  });

  it('body: 4,096 characters for plain text, 1,024 for interactive messages', () => {
    const long = 'word '.repeat(1500);
    expect(validateMessage({ text: long }).text.length).toBeLessThanOrEqual(WHATSAPP_LIMITS.body);
    const interactive = validateMessage({ text: long, options: [opt('a', 'OK')] });
    expect(interactive.text.length).toBeLessThanOrEqual(WHATSAPP_LIMITS.interactiveBody);
  });

  it('list rows: title ≤ 24, description ≤ 72, section ≤ 24, list button ≤ 20; at most 10 rows', () => {
    const v = validateMessage({
      text: 'Choose',
      options: [
        opt('hold:a', 'A very long store name that does not fit', {
          description: 'x '.repeat(60),
          section: 'Stores near you and further away',
        }),
      ],
      parts: { listButton: 'Choose a store near you please' },
    });
    const row = v.options![0]!;
    expect(row.label.length).toBeLessThanOrEqual(24);
    expect(row.description!.length).toBeLessThanOrEqual(72);
    expect(row.section!.length).toBeLessThanOrEqual(24);
    expect(v.parts!.listButton!.length).toBeLessThanOrEqual(20);
    rejects(
      { text: 'x', options: Array.from({ length: 11 }, (_, i) => opt(`o${i}`, `S${i}`, { section: 's' })) },
      'TOO_MANY_ROWS',
    );
  });

  it('a list always has an open button', () => {
    const v = validateMessage({ text: 'x', options: [1, 2, 3, 4].map((i) => opt(`o${i}`, `S${i}`)) });
    expect(v.parts?.listButton).toBe('Choose an option');
  });

  it('rejects what WhatsApp would refuse: duplicate ids, a CTA with options, bad URLs, SVG images, bad coordinates', () => {
    rejects({ text: 'x', options: [opt('a', 'A'), opt('a', 'B')] }, 'OPTION_ID_DUPLICATE');
    rejects(
      { text: 'x', options: [opt('a', 'A')], parts: { ctaUrl: { label: 'Go', url: 'https://x.test' } } },
      'CTA_WITH_OPTIONS',
    );
    rejects(
      { text: 'x', parts: { header: { type: 'IMAGE', url: 'http://example.com/a.png', alt: 'a' } } },
      'IMAGE_URL_NOT_HTTPS',
    );
    rejects(
      { text: 'x', parts: { header: { type: 'IMAGE', url: '/demo-products/a.png', alt: 'a' } } },
      'IMAGE_URL_INVALID',
    );
    rejects(
      { text: 'x', parts: { header: { type: 'IMAGE', url: 'https://x.test/a.svg', alt: 'a' } } },
      'IMAGE_TYPE_UNSUPPORTED',
    );
    rejects(
      { text: 'x', parts: { location: { name: 'S', address: 'A', latitude: 120, longitude: 0 } } },
      'LOCATION_INVALID',
    );
    rejects({ text: 'x', parts: { ctaUrl: { label: 'Go', url: 'ftp://x.test' } } }, 'CTA_URL_NOT_HTTPS');
  });

  it('allows http only for localhost (the local profile), https everywhere', () => {
    for (const url of ['http://localhost:5173/demo-products/a.png', 'https://demo.example/a.jpg']) {
      expect(
        validateMessage({ text: 'x', parts: { header: { type: 'IMAGE', url, alt: 'a' } } }).parts?.header,
      ).toMatchObject({ url });
    }
  });

  it('header text ≤ 60, footer ≤ 60, CTA label ≤ 20', () => {
    const v = validateMessage({
      text: 'x',
      parts: {
        header: { type: 'TEXT', text: 'h'.repeat(80) },
        footer: 'f'.repeat(80),
        ctaUrl: { label: 'c'.repeat(30), url: 'https://x.test' },
      },
    });
    expect(v.parts!.header).toMatchObject({ type: 'TEXT' });
    expect((v.parts!.header as { text: string }).text.length).toBeLessThanOrEqual(60);
    expect(v.parts!.footer!.length).toBeLessThanOrEqual(60);
    expect(v.parts!.ctaUrl!.label.length).toBeLessThanOrEqual(20);
  });
});

describe('"Powered by Qwikspot" footer', () => {
  const buttons = [opt('hold:a', 'Hold at Andheri')];
  const decorate = (author: Parameters<typeof decorateParts>[0]['author'], options = buttons, poweredByFooter = true) =>
    decorateParts({ options, parts: undefined, author, poweredByFooter, publicOrigin: 'https://demo.example' });

  it('on interactive automated messages: AI replies, follow-ups and store updates', () => {
    for (const author of ['AUTOMATED_REPLY', 'PROACTIVE_FOLLOW_UP', 'RESERVATION_UPDATE'] as const) {
      expect(decorate(author)?.footer).toBe(POWERED_BY_FOOTER);
    }
  });

  it('never on a team member’s reply, never on plain text, never when the brand turned it off', () => {
    expect(decorate('HUMAN_AGENT')?.footer).toBeUndefined();
    expect(decorate('AUTOMATED_REPLY', [])?.footer).toBeUndefined();
    expect(decorate('AUTOMATED_REPLY', buttons, false)?.footer).toBeUndefined();
    expect(POWERED_BY_FOOTER.length).toBeLessThanOrEqual(WHATSAPP_LIMITS.footer);
  });

  it('an image header makes a message interactive and resolves against the public origin', () => {
    const parts = decorateParts({
      options: undefined,
      parts: { header: { type: 'IMAGE', url: '/demo-products/vitamin-c-glow-serum.png', alt: 'Serum' } },
      author: 'AUTOMATED_REPLY',
      poweredByFooter: true,
      publicOrigin: 'https://demo.example/',
    });
    expect(parts).toEqual({
      header: { type: 'IMAGE', url: 'https://demo.example/demo-products/vitamin-c-glow-serum.png', alt: 'Serum' },
      footer: POWERED_BY_FOOTER,
    });
    expect(isInteractive(undefined, parts)).toBe(true);
  });
});
