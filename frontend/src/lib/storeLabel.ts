/** L5: "Wellness Mart, Satellite" — a store with its area; the plain name when it has none. */
export const storeLabel = (s: { store_name: string; area?: string | null }) =>
  s.area ? `${s.store_name}, ${s.area}` : s.store_name;
