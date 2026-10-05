import { useMemo } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { useDemoConfig } from '../../lib/demoConfig';
import { ShopperChat } from '../../lib/shopperApi';
import { ShopperPhone } from './ShopperPhone';
import { ShopperUnavailable } from './ShopperUnavailable';

/**
 * /chat — the brand's WhatsApp chat, full screen, as the shopper sees it (Change 16).
 * Opened from the demo store with the prefilled "Need it today?" text in the fragment
 * (`#text=…`, never the query string, so it stays out of server logs).
 */
export function ChatPage() {
  const demo = useDemoConfig();
  const [params] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const brandId = params.get('brand') ?? demo.shopperDemoBrand;
  const prefill = useMemo(
    () => new URLSearchParams(location.hash.replace(/^#/, '')).get('text') ?? '',
    [location.hash],
  );
  const chat = useMemo(() => (brandId ? new ShopperChat(brandId) : null), [brandId]);

  if (!demo.loaded) return <p className="status page">Loading…</p>;
  if (!chat) return <ShopperUnavailable />;
  return (
    <div className="chat-page">
      <p className="demo-ribbon">
        Demo · synthetic data · <Link to="/shop">Back to the store</Link>
      </p>
      <ShopperPhone chat={chat} initialDraft={prefill} onClose={() => navigate('/shop')} className="wa-phone--full" />
    </div>
  );
}
