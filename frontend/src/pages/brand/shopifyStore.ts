import { useCallback } from 'react';
import { useApi } from '../../api/apiContext';
import { useLoad } from '../../components/ConsoleShell';
import type { Connection } from './types';

/** The brand's real Shopify store, from its Shopify connection (never hard-coded). */
export interface ShopifyStore {
  url: string;
  domain: string;
  name: string | null;
}

export function storeOf(connections: Connection[] | undefined): ShopifyStore | null {
  const c = connections?.find((x) => x.provider === 'SHOPIFY');
  if (!c || !c.shop_domain || c.status === 'DISCONNECTED') return null;
  return { url: `https://${c.shop_domain}`, domain: c.shop_domain, name: c.shop_name ?? null };
}

/** The connected Shopify store for a Brand Console page, or null while unknown / not connected. */
export function useShopifyStore(enabled = true): ShopifyStore | null {
  const api = useApi();
  const connections = useLoad(
    useCallback(
      () =>
        enabled
          ? api.get<{ connections: Connection[] }>('/api/brand/connections')
          : Promise.resolve({ connections: [] as Connection[] }),
      [api, enabled],
    ),
  );
  return storeOf(connections.data?.connections);
}
