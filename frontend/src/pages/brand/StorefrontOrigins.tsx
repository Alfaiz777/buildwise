import { useState, type FormEvent } from 'react';
import { useApi } from '../../api/apiContext';
import { errorMessage } from '../../components/ConsoleShell';
import { Button, useToast } from '../../components/ui';

/** "https://Shop.example.com/" → "https://shop.example.com"; null when it is not a web address. */
export function originOf(value: string): string | null {
  try {
    const url = new URL(value.trim());
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.origin : null;
  } catch {
    return null;
  }
}

/**
 * Brand Console → Settings → "Storefronts allowed to send shopper events" (L4): the brand's
 * storefronts (e.g. https://m6ccxz-wk.myshopify.com) whose Qwikspot snippet may send shopper
 * events. Saved with PATCH /api/brand/settings/storefront-origins (Brand Admin, audited); the
 * backend has the final say (https only, exact origins, at most 10).
 */
export function StorefrontOrigins({ origins, onSaved }: { origins: string[]; onSaved: () => void }) {
  const api = useApi();
  const toast = useToast();
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async (next: string[], done: string) => {
    setBusy(true);
    setError(null);
    try {
      await api.patch('/api/brand/settings/storefront-origins', { origins: next });
      toast.show(done);
      setDraft('');
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const add = (e: FormEvent) => {
    e.preventDefault();
    const origin = originOf(draft);
    if (!origin) {
      setError('Enter the store address, like https://your-store.myshopify.com');
      return;
    }
    if (origins.includes(origin)) {
      setError('That storefront is already on the list.');
      return;
    }
    void save([...origins, origin], 'Storefront added');
  };

  return (
    <div className="storefront-origins">
      {origins.length ? (
        <ul className="plain">
          {origins.map((o) => (
            <li key={o} className="inline-actions">
              <span className="mono small">{o}</span>
              <Button
                variant="secondary"
                onClick={() =>
                  void save(
                    origins.filter((x) => x !== o),
                    'Storefront removed',
                  )
                }
                disabled={busy}
                aria-label={`Remove ${o}`}
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="small muted">None yet</p>
      )}
      <form className="inline" onSubmit={add}>
        <label htmlFor="storefront-origin">Add a storefront</label>
        <input
          id="storefront-origin"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="https://your-store.myshopify.com"
          autoComplete="off"
          spellCheck={false}
          inputMode="url"
        />
        <Button type="submit" disabled={busy || !draft.trim()}>
          {busy ? 'Saving…' : 'Add'}
        </Button>
      </form>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </div>
  );
}
