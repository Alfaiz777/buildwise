/*
 * Buildwise storefront intent snippet (docs/06_INTEGRATION_CONTRACTS.md §14.1).
 * Dependency-free; the same file goes into the real Shopify theme in L2.
 *
 *   <script src="https://<buildwise>/buildwise-intent.js"></script>
 *   <script>
 *     BuildwiseIntent.init({ apiBaseUrl: 'https://<buildwise>', brandId: 'brd_…' });
 *     BuildwiseIntent.track('PRODUCT_VIEW', { variantId: 'gid://shopify/ProductVariant/…' });
 *     button.onclick = () => BuildwiseIntent.whatsapp('STORE_NEED', variantId);
 *   </script>
 *
 * Privacy: only two opaque random IDs are kept — web_session_id (per tab, sessionStorage)
 * and visitor_id (per browser, localStorage). Neither contains personal data, and the
 * snippet never sends names, phone numbers, emails or locations.
 *
 * Attribution (M6): when a "Buy online" link from the conversation brings the shopper here
 * with `?bw_ref=…`, the opaque reference is kept for this tab's session (sessionStorage) and
 * returned by attributionRef(), so checkout can pass it on (locally: the demo order call; in
 * L2: a Shopify cart attribute). It only links the order to the conversation.
 */
(function () {
  'use strict';

  var SESSION_KEY = 'bw_web_session_id';
  var VISITOR_KEY = 'bw_visitor_id';
  var REF_KEY = 'bw_ref';
  var REF_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;

  /** Keeps a valid bw_ref from the landing URL for this tab's session. */
  function captureRef() {
    try {
      var ref = new URLSearchParams(window.location.search).get(REF_KEY);
      if (ref && REF_PATTERN.test(ref)) window.sessionStorage.setItem(REF_KEY, ref);
    } catch (e) {
      /* storage blocked: no attribution */
    }
  }

  function attributionRef() {
    try {
      return window.sessionStorage.getItem(REF_KEY);
    } catch (e) {
      return null;
    }
  }
  var config = null;

  function randomId(prefix) {
    var bytes = new Uint8Array(16);
    window.crypto.getRandomValues(bytes);
    var hex = '';
    for (var i = 0; i < bytes.length; i++) hex += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16);
    return prefix + hex;
  }

  function stored(storage, key, prefix) {
    try {
      var value = storage.getItem(key);
      if (!value) {
        value = randomId(prefix);
        storage.setItem(key, value);
      }
      return value;
    } catch (e) {
      return randomId(prefix); // storage blocked: behave as a fresh, anonymous session
    }
  }

  function ids() {
    return {
      web_session_id: stored(window.sessionStorage, SESSION_KEY, 'ws_'),
      visitor_id: stored(window.localStorage, VISITOR_KEY, 'vis_'),
    };
  }

  function requireInit() {
    if (!config) throw new Error('BuildwiseIntent.init() must be called first');
  }

  function track(eventType, data) {
    requireInit();
    data = data || {};
    var current = ids();
    var body = {
      brand_id: config.brandId,
      web_session_id: current.web_session_id,
      visitor_id: current.visitor_id,
      client_event_id: randomId('ce_'),
      event_type: eventType,
    };
    if (data.variantId) body.shopify_variant_id = data.variantId;
    if (data.searchTerm) body.search_term = String(data.searchTerm).slice(0, 80);
    if (data.entry) body.entry = data.entry;
    return fetch(config.apiBaseUrl + '/api/intents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'omit',
      body: JSON.stringify(body),
    }).then(function (res) {
      return res.json().then(function (json) {
        if (!res.ok) throw json;
        return json;
      });
    });
  }

  /** "Need it today?" (STORE_NEED) or "Chat with us" (CHAT): records the click, then opens WhatsApp. */
  function whatsapp(entry, variantId) {
    return track('WHATSAPP_CLICK', { entry: entry, variantId: variantId }).then(function (res) {
      if (res.whatsapp) config.openLink(res.whatsapp.wa_link, res.whatsapp.prefilled_text);
      return res;
    });
  }

  window.BuildwiseIntent = {
    init: function (options) {
      config = {
        apiBaseUrl: String(options.apiBaseUrl || '').replace(/\/$/, ''),
        brandId: options.brandId,
        openLink:
          options.openLink ||
          function (link) {
            if (link) window.open(link, '_blank', 'noopener');
          },
      };
      captureRef();
      return window.BuildwiseIntent;
    },
    ids: ids,
    attributionRef: attributionRef,
    track: track,
    whatsapp: whatsapp,
    /** Starts a new browsing session in this tab (the visitor is kept). */
    newSession: function () {
      try {
        window.sessionStorage.removeItem(SESSION_KEY);
      } catch (e) {
        /* ignore */
      }
    },
    /** Forgets the visitor too (e.g. "Continue as guest" on a shared demo machine). */
    forgetVisitor: function () {
      try {
        window.localStorage.removeItem(VISITOR_KEY);
        window.sessionStorage.removeItem(SESSION_KEY);
      } catch (e) {
        /* ignore */
      }
    },
  };
})();
