import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ApiContext } from '../api/apiContext';
import type { ApiClient } from '../api/client';
import { ToastProvider } from '../components/ui';
import { WhatsAppCard, type WhatsAppStatus } from '../pages/brand/WhatsAppCard';
import { LEGAL_LINKS } from '../lib/legal';

const META = { available: true, app_id: '1234567890123', config_id: '9876543210987', graph_version: 'v26.0' };
const NOT_CONNECTED: WhatsAppStatus = {
  enabled: true,
  status: 'NOT_CONNECTED',
  display_phone_number: null,
  verified_name: null,
  dev_number: false,
};

function client(
  status: WhatsAppStatus,
  meta: { available: boolean; app_id: string | null; config_id: string | null; graph_version: string | null } = META,
  post = vi.fn(async () => ({})),
) {
  return {
    get: vi.fn(async (path: string) => (path === '/api/public/meta-config' ? meta : status)) as ApiClient['get'],
    post: post as ApiClient['post'],
    patch: vi.fn() as ApiClient['patch'],
    upload: vi.fn() as ApiClient['upload'],
  } satisfies ApiClient;
}

function renderCard(api: ApiClient, loadSdk?: () => Promise<never>) {
  return render(
    <ApiContext.Provider value={api}>
      <ToastProvider>
        <WhatsAppCard loadSdk={loadSdk} />
      </ToastProvider>
    </ApiContext.Provider>,
  );
}

/** A Facebook SDK stand-in: login hands back a code, like the Embedded Signup popup. */
function fakeSdk(code: string | null) {
  const FB = {
    init: vi.fn(),
    login: vi.fn((cb: (r: { authResponse?: { code?: string } | null }) => void, _options?: object) =>
      cb({ authResponse: code ? { code } : null }),
    ),
  };
  return { FB, load: vi.fn(async () => FB) as unknown as () => Promise<never> };
}

const postSignup = (event: string, data: object, origin = 'https://www.facebook.com') =>
  act(() => {
    window.dispatchEvent(
      new MessageEvent('message', { origin, data: JSON.stringify({ type: 'WA_EMBEDDED_SIGNUP', event, data }) }),
    );
  });

describe('Settings → Channels: WhatsApp (L2-WhatsApp)', () => {
  it('Connect runs Embedded Signup with the server’s ids and sends the code + WABA + number to the backend', async () => {
    const post = vi.fn(async () => ({}));
    const sdk = fakeSdk('signup-code-123');
    renderCard(client(NOT_CONNECTED, META, post), sdk.load);
    expect(await screen.findByText(/Not connected — customers use the web simulator/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Connect WhatsApp' }));
    await waitFor(() => expect(sdk.FB.login).toHaveBeenCalled());
    expect(sdk.FB.init).toHaveBeenCalledWith(expect.objectContaining({ appId: META.app_id, version: 'v26.0' }));
    expect(sdk.FB.login.mock.calls[0]![1]).toEqual({
      config_id: META.config_id,
      response_type: 'code',
      override_default_response_type: true,
      extras: {},
    });
    expect(post).not.toHaveBeenCalled(); // waits for the WABA / number ids
    postSignup('FINISH', { phone_number_id: '200000000000001', waba_id: '100000000000001' }, 'https://evil.example');
    expect(post).not.toHaveBeenCalled(); // not from facebook.com
    postSignup('FINISH', { phone_number_id: '200000000000001', waba_id: '100000000000001' });
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith('/api/integrations/whatsapp/connect', {
        code: 'signup-code-123',
        waba_id: '100000000000001',
        phone_number_id: '200000000000001',
      }),
    );
    expect(await screen.findByText('WhatsApp connected')).toBeInTheDocument();
  });

  it('a cancelled signup says so in plain words; nothing is sent', async () => {
    const post = vi.fn(async () => ({}));
    renderCard(client(NOT_CONNECTED, META, post), fakeSdk('code-x').load);
    fireEvent.click(await screen.findByRole('button', { name: 'Connect WhatsApp' }));
    postSignup('CANCEL', { current_step: 'PHONE_NUMBER_SETUP' });
    expect(await screen.findByRole('alert')).toHaveTextContent('WhatsApp signup was closed before it finished');
    expect(post).not.toHaveBeenCalled();
  });

  it('connected: the masked number, display name, quality and Disconnect (asks first)', async () => {
    const post = vi.fn(async () => ({}));
    renderCard(
      client(
        {
          enabled: true,
          status: 'CONNECTED',
          display_phone_number: '+91 •••• 4821',
          verified_name: 'AquaSkin',
          quality_rating: 'GREEN',
        },
        META,
        post,
      ),
    );
    expect(await screen.findByText('+91 •••• 4821')).toBeInTheDocument();
    expect(screen.getByText('(AquaSkin)')).toBeInTheDocument();
    expect(screen.getByText('GREEN')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Disconnect' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/api/integrations/whatsapp/disconnect', {}));
  });

  it('without the WhatsApp channel the card is hidden; without Meta ids Connect is disabled', async () => {
    const hidden = renderCard(client({ ...NOT_CONNECTED, enabled: false }));
    await waitFor(() => expect(screen.queryByText('Channels: WhatsApp')).not.toBeInTheDocument());
    hidden.unmount();
    renderCard(client(NOT_CONNECTED, { available: false, app_id: null, config_id: null, graph_version: 'v26.0' }));
    expect(await screen.findByRole('button', { name: 'Connect WhatsApp' })).toBeDisabled();
    expect(screen.getByText(/WhatsApp signup is not configured on this server/)).toBeInTheDocument();
  });

  it('the legal pages are the three Qwikspot URLs', () => {
    expect(LEGAL_LINKS.map((l) => l.href)).toEqual([
      'https://qwikspot.urbanlyfe.in/privacy-policy/',
      'https://qwikspot.urbanlyfe.in/terms/',
      'https://qwikspot.urbanlyfe.in/data-deletion/',
    ]);
  });
});
