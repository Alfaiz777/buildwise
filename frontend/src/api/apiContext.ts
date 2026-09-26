import { createContext, useContext } from 'react';
import type { ApiClient } from './client';

export const ApiContext = createContext<ApiClient | null>(null);

export function useApi(): ApiClient {
  const api = useContext(ApiContext);
  if (!api) throw new Error('useApi must be used inside ApiContext');
  return api;
}

/** Response of GET /api/me. */
export interface MeResponse {
  user: { user_id: string; email: string | null; role: string; store_ids: string[] };
  brand: { brand_id: string; name: string } | null;
}
