import { ExternalLink, QrCode as QrIcon, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { QrCode } from '../../components/ui/QrCode';
import type { ShopifyStore } from './shopifyStore';
import './tour.css';

/**
 * The Brand Console header's way into the real store: "Open AquaSkin store" (a new tab) and a
 * QR button whose popover a judge scans with their phone to open the same store there.
 */
export function StoreButton({ store, brandName }: { store: ShopifyStore; brandName: string }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const name = store.name ?? brandName;
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    const onClick = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onClick);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onClick);
    };
  }, [open]);
  return (
    <div className="store-btn" ref={root}>
      <a
        className="ui-button ui-button--accent ui-button--sm store-btn__open"
        href={store.url}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={`Open the ${name} Shopify store (new tab)`}
      >
        <span className="store-btn__open-word">Open</span> {name} store <ExternalLink size={14} aria-hidden="true" />
      </a>
      <button
        type="button"
        className="ui-icon-button store-btn__qr"
        aria-label={`Scan to open the ${name} store on a phone`}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <QrIcon size={18} aria-hidden="true" />
      </button>
      {open && (
        <div className="store-btn__pop" role="dialog" aria-label={`Open the ${name} store on your phone`}>
          <div className="store-btn__pop-head">
            <strong>Open it on your phone</strong>
            <button type="button" className="ui-icon-button" aria-label="Close" onClick={() => setOpen(false)}>
              <X size={16} aria-hidden="true" />
            </button>
          </div>
          <QrCode value={store.url} size={176} label={`QR code for ${store.url}`} />
          <p className="small">Point your phone camera at the code to open the store, then tap “Need it today?”.</p>
          <a className="small store-btn__url" href={store.url} target="_blank" rel="noopener noreferrer">
            {store.domain}
          </a>
        </div>
      )}
    </div>
  );
}
