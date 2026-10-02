/**
 * People read labels, not enums (M7 polish): "High intent", not "HIGH_INTENT".
 * Known values get a hand-written label; anything else is sentence-cased.
 */
const LABELS: Record<string, string> = {
  BRAND_ADMIN: 'Brand Admin',
  RETAIL_ADMIN: 'Retail Admin',
  PLATFORM_ADMIN: 'Platform Admin',
  CUSTOMER_ARRIVED: 'Customer arrived',
  NOT_SENT_OPTED_OUT: 'Not sent (opted out)',
  FAILED: 'Not delivered',
  OFFLINE: 'In store',
  ONLINE: 'Online',
  SKU: 'SKU',
};

export function sentence(value: string): string {
  const words = value.toLowerCase().replace(/_/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function label(value: string | null | undefined): string {
  if (!value) return '—';
  return LABELS[value] ?? sentence(value);
}
