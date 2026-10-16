/**
 * The Store Console's "Last 7 days" tiles (UI-4): the own store's holds, picked up, completion,
 * refused, expired and the value of pickups at the store's current offline prices. One place,
 * so the tiles' route and the store agent (L6) use the same numbers.
 */
import type { RetailPrincipal } from '../domain/principal.js';
import type { AccountService } from './accountService.js';
import type { ReservationService } from './reservationService.js';

export async function storeWeekSummary(
  deps: { account: Pick<AccountService, 'storeStock'>; reservations: Pick<ReservationService, 'weekSummary'> },
  principal: RetailPrincipal,
  options: { days: 7 | 28; includeHistory: boolean } = { days: 7, includeHistory: true },
) {
  const stock = await deps.account.storeStock(principal, principal.storeId);
  const prices = new Map(stock.filter((l) => l.offlinePrice !== null).map((l) => [l.sku, l.offlinePrice as number]));
  return deps.reservations.weekSummary(principal, prices, 'INR', options);
}
