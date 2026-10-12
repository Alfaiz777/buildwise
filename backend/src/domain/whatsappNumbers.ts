/** WhatsApp number helpers (L2-WhatsApp). Pure. Phone numbers are never logged or shown in full. */

/** "+91 98765 43210" → "+91 •••• 3210"; anything without 4 digits → "••••". */
export function maskPhoneNumber(display: string): string {
  const digits = display.replace(/\D/g, '');
  if (digits.length < 4) return '••••';
  const country = /^\s*\+(\d{1,3})[\s-]/.exec(display)?.[1];
  return `${country ? `+${country} ` : ''}•••• ${digits.slice(-4)}`;
}

/** The customer's safe console label for a WhatsApp id ("919876543210" → "wa:••••3210"). */
export const whatsappDisplayRef = (waId: string) => `wa:••••${waId.replace(/\D/g, '').slice(-4)}`;

/** "+91 98765 43210" → "919876543210" (the wa.me form). */
export const waMeNumber = (display: string) => display.replace(/\D/g, '');

/** Meta ids are numeric strings. */
export const isMetaId = (id: unknown): id is string => typeof id === 'string' && /^\d{5,25}$/.test(id);
