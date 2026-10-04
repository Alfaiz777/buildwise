import { MapPin, Send } from 'lucide-react';
import { useState, type FormEvent } from 'react';

/** Named demo places in Mumbai (synthetic). Near Powai: Powai has no stock, so Andheri is offered. */
export const LOCATION_PRESETS = [
  { name: 'Near Powai', latitude: 19.12, longitude: 72.9 },
  { name: 'Near Bandra', latitude: 19.06, longitude: 72.83 },
] as const;

export type ComposerSend = { type: 'TEXT'; text: string } | { type: 'LOCATION'; latitude: number; longitude: number };

/** Type a message or share a location (a named place, or custom coordinates). */
export function ChatComposer({
  draft,
  onDraftChange,
  onSend,
  disabled = false,
}: {
  draft: string;
  onDraftChange: (text: string) => void;
  onSend: (content: ComposerSend) => void;
  disabled?: boolean;
}) {
  const [menu, setMenu] = useState<'closed' | 'places' | 'custom'>('closed');
  const [lat, setLat] = useState('19.12');
  const [lng, setLng] = useState('72.90');

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const text = draft.trim();
    if (text) onSend({ type: 'TEXT', text });
  };
  const share = (latitude: number, longitude: number) => {
    setMenu('closed');
    onSend({ type: 'LOCATION', latitude, longitude });
  };

  return (
    <div className="wa-composer">
      {menu !== 'closed' && (
        <div className="wa-places" role="menu" aria-label="Share location">
          {menu === 'places' ? (
            <>
              {LOCATION_PRESETS.map((p) => (
                <button
                  key={p.name}
                  type="button"
                  role="menuitem"
                  disabled={disabled}
                  onClick={() => share(p.latitude, p.longitude)}
                >
                  📍 {p.name}
                </button>
              ))}
              <button type="button" role="menuitem" onClick={() => setMenu('custom')}>
                Custom…
              </button>
            </>
          ) : (
            <form
              className="wa-custom"
              onSubmit={(e) => {
                e.preventDefault();
                const la = Number(lat);
                const lo = Number(lng);
                if (Number.isFinite(la) && Number.isFinite(lo)) share(la, lo);
              }}
            >
              <label>
                Latitude
                <input value={lat} onChange={(e) => setLat(e.target.value)} inputMode="decimal" />
              </label>
              <label>
                Longitude
                <input value={lng} onChange={(e) => setLng(e.target.value)} inputMode="decimal" />
              </label>
              <button type="submit" disabled={disabled}>
                Send location
              </button>
            </form>
          )}
        </div>
      )}
      <form className="wa-input" onSubmit={submit}>
        <button
          type="button"
          className="wa-icon"
          aria-label="Share location"
          aria-expanded={menu !== 'closed'}
          onClick={() => setMenu(menu === 'closed' ? 'places' : 'closed')}
        >
          <MapPin size={20} aria-hidden="true" />
        </button>
        <input
          aria-label="Message"
          placeholder="Message"
          value={draft}
          onChange={(e) => onDraftChange(e.target.value)}
          maxLength={1000}
        />
        <button type="submit" className="wa-send" aria-label="Send" disabled={disabled || !draft.trim()}>
          <Send size={18} aria-hidden="true" />
        </button>
      </form>
    </div>
  );
}
