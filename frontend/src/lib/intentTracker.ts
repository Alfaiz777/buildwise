/**
 * The storefront snippet's API (public/qwikspot-intent.js), as a theme sees it on
 * `window.QwikspotIntent`. The real Shopify store loads it through
 * integrations/shopify/qwikspot.liquid; the tests load it directly.
 */
export interface IntentTracker {
  init(options: {
    apiBaseUrl: string;
    brandId: string;
    openLink: (link: string | null, prefilled: string) => void;
  }): IntentTracker;
  ids(): { web_session_id: string; visitor_id: string };
  /** M6: the qs_ref this tab arrived with from a "Buy online" link, or null. */
  attributionRef?(): string | null;
  track(type: string, data?: { variantId?: string; searchTerm?: string; entry?: string }): Promise<TrackResult>;
  whatsapp(entry: 'STORE_NEED' | 'CHAT', variantId?: string): Promise<TrackResult>;
  newSession(): void;
  forgetVisitor(): void;
}

export interface TrackResult {
  intent_stage: string;
  intent_strength: string;
  intent_type: string;
  whatsapp: { prefilled_text: string; wa_link: string | null; expires_at: string } | null;
}

declare global {
  interface Window {
    QwikspotIntent?: IntentTracker;
  }
}
