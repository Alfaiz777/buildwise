/**
 * The demo brand's settings (docs/04 §3), shared by seed:demo, seed:live and Reset demo.
 * Deployment-specific values already on the brand (storefront origins, messaging sender,
 * online store URL) are kept; everything else returns to the demo defaults.
 */
const LOCAL_STOREFRONT = 'http://localhost:5173';

export function demoBrandSettings(input: {
  current: Record<string, unknown>;
  brandName: string;
  holdMinutes: number;
  whatsappNumber?: string;
}): Record<string, unknown> {
  const keep = (key: string, fallback: unknown) =>
    input.current[key] !== undefined && input.current[key] !== null ? input.current[key] : fallback;
  return {
    allowed_storefront_origins: keep('allowed_storefront_origins', [LOCAL_STOREFRONT]),
    messaging: keep('messaging', {
      display_name: input.brandName,
      whatsapp_number: input.whatsappNumber ?? '910000000001', // placeholder number
      // Change 16: the chat header's logo (self-made) and the "Powered by Qwikspot" footer.
      logo_url: '/demo-products/demo-beauty-co-logo.png',
      powered_by_footer: true,
    }),
    // "Buy online" opens the product on the demo storefront (/shop since UI-2).
    online_store: keep('online_store', { product_url_template: `${LOCAL_STOREFRONT}/shop#product={product_id}` }),
    // Shared-demo safety (G5): short holds release stock quickly.
    reservation_policy: {
      reservations_enabled: true,
      hold_minutes: input.holdMinutes,
      max_quantity_per_reservation: 2,
    },
    human_handoff_rules: { enabled: true },
    // A short attribution window so a NONE outcome can be seen during a demo (default 7 days).
    outcome_policy: { attribution_window_minutes: 10 },
    follow_up_policy: {
      inactivity_minutes: 1,
      frequency_hours: 24,
      types: {
        SEARCH_EXPLORATION: { enabled: true, delay_minutes: 2, priority: 'NORMAL' },
        PRODUCT_CONSIDERATION: { enabled: true, delay_minutes: 2, priority: 'NORMAL' },
        CART_ABANDONMENT: { enabled: true, delay_minutes: 2, priority: 'NORMAL' },
        CHECKOUT_ABANDONMENT: { enabled: true, delay_minutes: 1, priority: 'HIGH' },
        STORE_ORIENTED: { enabled: true, delay_minutes: 1, priority: 'NORMAL' },
      },
    },
  };
}
