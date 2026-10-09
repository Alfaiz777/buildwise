import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiContext } from '../api/apiContext';
import { ApiError, type ApiClient } from '../api/client';
import { ToastProvider } from '../components/ui';
import { ShopifyCard } from '../pages/brand/ShopifyCard';
import type { Connection } from '../pages/brand/types';

const CONNECTED: Connection = {
  connection_id: 'SHOPIFY',
  provider: 'SHOPIFY',
  source: 'SHOPIFY',
  status: 'CONNECTED',
  shop_domain: 'm6ccxz-wk.myshopify.com',
  shop_name: 'AquaSkin',
  connected_at: '2026-10-07T06:00:00.000Z',
  last_sync_at: '2026-10-07T06:30:00.000Z',
  last_error: null,
  product_count: 14,
  variant_count: 24,
};

function client(connections: Connection[], post: ApiClient['post'] = vi.fn(async () => ({})) as ApiClient['post']) {
  return {
    get: vi.fn(async () => ({ connections })) as ApiClient['get'],
    post,
    patch: vi.fn() as ApiClient['patch'],
    upload: vi.fn() as ApiClient['upload'],
  } satisfies ApiClient;
}

function renderCard(api: ApiClient, provider: 'MOCK' | 'SHOPIFY', navigate = vi.fn()) {
  render(
    <ApiContext.Provider value={api}>
      <ToastProvider>
        <ShopifyCard provider={provider} navigate={navigate} />
      </ToastProvider>
    </ApiContext.Provider>,
  );
  return navigate;
}

afterEach(() => window.history.replaceState(null, '', '/'));

describe('Settings → Shopify card (L2-Shopify)', () => {
  it('not connected: the store domain and "Connect Shopify" go to Shopify’s authorize URL', async () => {
    const post = vi.fn(async () => ({ authorize_url: 'https://m6ccxz-wk.myshopify.com/admin/oauth/authorize?x=1' }));
    const navigate = renderCard(client([], post as ApiClient['post']), 'SHOPIFY');
    const input = await screen.findByLabelText('Store domain');
    expect(input).toHaveAttribute('placeholder', 'm6ccxz-wk.myshopify.com');
    fireEvent.change(input, { target: { value: ' m6ccxz-wk.myshopify.com ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect Shopify' }));
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith('https://m6ccxz-wk.myshopify.com/admin/oauth/authorize?x=1'),
    );
    expect(post).toHaveBeenCalledWith('/api/integrations/shopify/connect', { shop: 'm6ccxz-wk.myshopify.com' });
  });

  it('a refused shop domain shows the server’s words and stays on the page', async () => {
    const post = vi.fn(async () => {
      throw new ApiError(400, 'INVALID_SHOP_DOMAIN', 'Enter your store’s myshopify.com domain.', false, null);
    });
    const navigate = renderCard(client([], post as ApiClient['post']), 'SHOPIFY');
    fireEvent.change(await screen.findByLabelText('Store domain'), { target: { value: 'evil.example' } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect Shopify' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Enter your store’s myshopify.com domain.');
    expect(navigate).not.toHaveBeenCalled();
  });

  it('connected: shop name, last sync, product count, Sync products and Disconnect (with a confirm)', async () => {
    const post = vi.fn(async (path: string) =>
      path.endsWith('/sync') ? CONNECTED : { ...CONNECTED, status: 'DISCONNECTED' },
    );
    const api = client([CONNECTED], post as ApiClient['post']);
    renderCard(api, 'SHOPIFY');
    expect(await screen.findByText('AquaSkin')).toBeInTheDocument();
    expect(screen.getByText('m6ccxz-wk.myshopify.com')).toBeInTheDocument();
    expect(screen.getByText('14 products · 24 variants')).toBeInTheDocument();
    expect(screen.queryByLabelText('Store domain')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Sync products' }));
    expect(await screen.findByText('Products synced: 14 products.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    const dialog = screen.getByRole('alertdialog');
    expect(dialog).toHaveTextContent('Qwikspot stops reading products and orders from AquaSkin.');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Disconnect' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/api/integrations/shopify/disconnect', {}));
  });

  it('back from Shopify: "Shopify connected" (or plain words for an error), then the query string is cleaned', async () => {
    window.history.replaceState(null, '', '/brand/settings?shopify=connected');
    renderCard(client([CONNECTED]), 'SHOPIFY');
    expect(await screen.findByText('Shopify connected')).toBeInTheDocument();
    expect(window.location.search).toBe('');
  });

  it.each([
    ['STATE_EXPIRED', 'The connection link expired after 10 minutes. Try connecting again.'],
    ['SHOP_ALREADY_CONNECTED', 'That Shopify store is already connected to another brand.'],
    ['SOMETHING_NEW', 'Shopify could not be connected.'],
  ])('error %s → %s', async (reason, words) => {
    window.history.replaceState(null, '', `/brand/settings?shopify=error&reason=${reason}`);
    renderCard(client([]), 'SHOPIFY');
    expect(await screen.findByText(words)).toBeInTheDocument();
    expect(window.location.search).toBe('');
  });

  it('mock mode: the local mock catalogue with Sync products, no connect form', async () => {
    renderCard(client([{ ...CONNECTED, source: 'MOCK', shop_domain: null, shop_name: null }]), 'MOCK');
    expect(await screen.findByText('Mock (local)')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sync products' })).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Disconnect' })).not.toBeInTheDocument();
  });
});
