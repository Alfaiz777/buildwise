import { createContext, useContext } from 'react';
import type { ApiClient } from './client';

export const ApiContext = createContext<ApiClient | null>(null);

export function useApi(): ApiClient {
  const api = useContext(ApiContext);
  if (!api) throw new Error('useApi must be used inside ApiContext');
  return api;
}

export type Scope = 'PLATFORM' | 'BRAND' | 'RETAIL';
export type Role = 'PLATFORM_ADMIN' | 'BRAND_ADMIN' | 'RETAIL_ADMIN';

/** A RETAIL_ADMIN's one store; `store_hours` is { timezone, monday: "HH:MM-HH:MM", ... }. */
export interface Store {
  store_id: string;
  store_name: string;
  city: string;
  address: string | null;
  store_status: string;
  store_hours: Record<string, string> | null;
}

interface MeBase {
  user: { user_id: string; email: string | null };
}

/**
 * Response of GET /api/me — the scope the backend resolved from the verified token.
 * Each scope carries only its own fields. Customers never sign in, so there is no
 * customer variant.
 */
export type MeResponse =
  | (MeBase & { scope: 'PLATFORM'; role: 'PLATFORM_ADMIN' })
  | (MeBase & { scope: 'BRAND'; role: 'BRAND_ADMIN'; brand_id: string; brand_name: string })
  | (MeBase & {
      scope: 'RETAIL';
      role: 'RETAIL_ADMIN';
      brand_id: string;
      brand_name: string;
      retailer_id: string;
      retailer_name: string;
      /** Exactly one store per RETAIL_ADMIN; never a list of the retailer's stores. */
      store_id: string;
      store: Store;
    });

/** Returned when a user is provisioned (platform or brand administration). */
export interface ProvisionedUser {
  user_id: string;
  email: string;
  role: Role;
  password_setup_link: string;
}
