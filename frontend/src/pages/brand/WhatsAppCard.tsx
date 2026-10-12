import { useCallback, useEffect, useRef, useState } from 'react';
import { useApi } from '../../api/apiContext';
import { errorMessage, useLoad } from '../../components/ConsoleShell';
import { Badge, Button, Card, ConfirmDialog, useToast } from '../../components/ui';

export interface WhatsAppStatus {
  enabled: boolean;
  status: 'CONNECTED' | 'RESTRICTED' | 'NOT_CONNECTED';
  display_phone_number: string | null;
  verified_name: string | null;
  quality_rating?: string | null;
  dev_number?: boolean;
}

interface MetaConfig {
  available: boolean;
  app_id: string | null;
  config_id: string | null;
  graph_version: string | null;
}

interface FacebookSdk {
  init(options: { appId: string; autoLogAppEvents?: boolean; xfbml?: boolean; version: string }): void;
  login(
    callback: (response: { authResponse?: { code?: string } | null; status?: string }) => void,
    options: Record<string, unknown>,
  ): void;
}

declare global {
  interface Window {
    FB?: FacebookSdk;
    fbAsyncInit?: () => void;
  }
}

const SDK_URL = 'https://connect.facebook.net/en_US/sdk.js';

/** Loads the Facebook JS SDK once (Embedded Signup); resolves with window.FB. */
export function loadFacebookSdk(): Promise<FacebookSdk> {
  if (window.FB) return Promise.resolve(window.FB);
  return new Promise((resolve, reject) => {
    window.fbAsyncInit = () => (window.FB ? resolve(window.FB) : reject(new Error('Facebook SDK missing')));
    const script = document.createElement('script');
    script.src = SDK_URL;
    script.async = true;
    script.defer = true;
    script.crossOrigin = 'anonymous';
    script.onerror = () => reject(new Error('The Facebook SDK could not load (blocked by the browser?).'));
    document.body.appendChild(script);
  });
}

/** Embedded Signup's session info, posted by facebook.com to this window. */
interface SignupEvent {
  type?: string;
  event?: string;
  data?: { phone_number_id?: string; waba_id?: string; error_message?: string; current_step?: string };
}

/**
 * Brand Console → Settings → Channels: WhatsApp (L2-WhatsApp). "Connect WhatsApp" runs Meta's
 * Embedded Signup (the Facebook JS SDK, the brand's own Meta login): the popup returns a
 * 30-second code, and facebook.com posts the WhatsApp Business Account and number ids; with
 * both, the backend finishes the connection. The ids come from /api/public/meta-config —
 * never hard-coded. Without a connection the brand stays on the simulator.
 */
export function WhatsAppCard({ loadSdk = loadFacebookSdk }: { loadSdk?: () => Promise<FacebookSdk> }) {
  const api = useApi();
  const toast = useToast();
  const status = useLoad(useCallback(() => api.get<WhatsAppStatus>('/api/integrations/whatsapp'), [api]));
  const meta = useLoad(useCallback(() => api.get<MetaConfig>('/api/public/meta-config'), [api]));
  const [busy, setBusy] = useState<'connect' | 'disconnect' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const pending = useRef<{ code?: string; wabaId?: string; phoneNumberId?: string | null; finished?: boolean }>({});

  const finish = useCallback(async () => {
    const p = pending.current;
    if (!p.code || !p.wabaId || p.finished) return;
    p.finished = true;
    try {
      await api.post('/api/integrations/whatsapp/connect', {
        code: p.code,
        waba_id: p.wabaId,
        ...(p.phoneNumberId ? { phone_number_id: p.phoneNumberId } : {}),
      });
      toast.show('WhatsApp connected');
      status.reload();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }, [api, status, toast]);

  // facebook.com posts the signup's outcome to this window (origin checked).
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      let host = '';
      try {
        host = new URL(event.origin).hostname;
      } catch {
        return;
      }
      if (host !== 'facebook.com' && !host.endsWith('.facebook.com')) return;
      let data: SignupEvent;
      try {
        data = typeof event.data === 'string' ? (JSON.parse(event.data) as SignupEvent) : (event.data as SignupEvent);
      } catch {
        return;
      }
      if (data?.type !== 'WA_EMBEDDED_SIGNUP') return;
      if (data.event === 'CANCEL') {
        setBusy(null);
        setError('WhatsApp signup was closed before it finished. Nothing was connected.');
      } else if (data.event === 'ERROR') {
        setBusy(null);
        setError('Meta reported a problem during the WhatsApp signup. Try again.');
      } else if (data.event?.startsWith('FINISH') && data.data?.waba_id) {
        pending.current.wabaId = data.data.waba_id;
        pending.current.phoneNumberId = data.data.phone_number_id ?? null;
        void finish();
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [finish]);

  const connect = async () => {
    const m = meta.data;
    if (!m?.available || !m.app_id || !m.config_id || !m.graph_version) return;
    setBusy('connect');
    setError(null);
    pending.current = {};
    try {
      const FB = await loadSdk();
      FB.init({ appId: m.app_id, autoLogAppEvents: true, xfbml: true, version: m.graph_version });
      FB.login(
        (response) => {
          const code = response.authResponse?.code;
          if (!code) {
            setBusy(null);
            setError('WhatsApp signup was closed before it finished. Nothing was connected.');
            return;
          }
          pending.current.code = code;
          void finish();
        },
        {
          config_id: m.config_id,
          response_type: 'code',
          override_default_response_type: true,
          // Embedded Signup v4: the configuration selects the flow; the extras object stays empty.
          extras: {},
        },
      );
    } catch (err) {
      setBusy(null);
      setError(err instanceof Error ? err.message : 'The Facebook SDK could not load.');
    }
  };

  const disconnect = async () => {
    setBusy('disconnect');
    try {
      await api.post('/api/integrations/whatsapp/disconnect', {});
      toast.show('WhatsApp disconnected — the simulator answers again');
      status.reload();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
      setConfirming(false);
    }
  };

  const s = status.data;
  if (!s || !s.enabled) return null;
  const connected = s && s.status !== 'NOT_CONNECTED';
  return (
    <Card
      title="Channels: WhatsApp"
      description="Customers chat with your own WhatsApp Business number. Without one, the web simulator answers."
    >
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {connected ? (
        <>
          <dl className="settings-list">
            <dt>Number</dt>
            <dd>
              <strong>{s.display_phone_number}</strong> {s.verified_name && <span>({s.verified_name})</span>}{' '}
              {s.status === 'RESTRICTED' ? (
                <Badge tone="warning">Restricted by Meta</Badge>
              ) : (
                <Badge tone="success">Connected</Badge>
              )}
            </dd>
            <dt>Quality</dt>
            <dd>{s.quality_rating ?? 'Unknown'}</dd>
          </dl>
          <div className="inline-actions">
            <Button variant="secondary" onClick={() => setConfirming(true)} disabled={busy !== null}>
              Disconnect
            </Button>
          </div>
        </>
      ) : (
        <>
          <p className="small muted">
            {s?.dev_number
              ? 'This server answers with its development number until you connect your own.'
              : 'Not connected — customers use the web simulator.'}
          </p>
          <div className="inline-actions">
            <Button onClick={() => void connect()} disabled={busy !== null || !meta.data?.available}>
              {busy === 'connect' ? 'Waiting for WhatsApp signup…' : 'Connect WhatsApp'}
            </Button>
          </div>
          {meta.data && !meta.data.available && (
            <p className="small muted">
              WhatsApp signup is not configured on this server (Meta app id and configuration id).
            </p>
          )}
        </>
      )}
      <ConfirmDialog
        open={confirming}
        title="Disconnect WhatsApp?"
        confirmLabel="Disconnect"
        tone="danger"
        busy={busy === 'disconnect'}
        onConfirm={() => void disconnect()}
        onCancel={() => setConfirming(false)}
      >
        Customers can no longer reach the assistant on {s?.display_phone_number ?? 'this number'}. You can connect again
        at any time.
      </ConfirmDialog>
    </Card>
  );
}
