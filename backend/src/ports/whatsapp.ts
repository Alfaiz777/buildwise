/**
 * WhatsApp-specific ports (L2-WhatsApp; docs/06 §10). One Meta app (Tech Provider), many brands:
 * each brand connects its own WhatsApp Business number through Embedded Signup. The business
 * token never leaves the backend: no API response, log line, URL or browser storage carries it.
 */

export type WhatsAppConnectionStatus = 'CONNECTED' | 'DISCONNECTED' | 'RESTRICTED';

/** A brand's connected number with its decrypted secrets — application code only. */
export interface WhatsAppConnection {
  brandId: string;
  wabaId: string;
  phoneNumberId: string;
  /** "+91 98765 43210" as Meta reports it — shown masked in the console. */
  displayPhoneNumber: string;
  verifiedName: string;
  /** GREEN | YELLOW | RED | UNKNOWN (Meta's quality rating). */
  qualityRating: string;
  status: WhatsAppConnectionStatus;
  businessToken: string;
  /** The two-step verification PIN set when the number was registered. */
  pin: string;
  connectedAt: string;
  updatedAt: string;
}

/**
 * Server-only storage: whatsapp_connections/{brandId} (token and PIN sealed with AES-256-GCM)
 * and whatsapp_numbers/{phoneNumberId} → brand (one number, one brand). Firestore rules deny clients.
 */
export interface WhatsAppConnectionStore {
  get(brandId: string): Promise<WhatsAppConnection | null>;
  /** Saves the connection and claims the number; false if another brand holds the number. */
  save(connection: WhatsAppConnection): Promise<boolean>;
  /** Status fields only (webhook account / quality updates); never the secrets. */
  updateStatus(
    brandId: string,
    patch: Partial<Pick<WhatsAppConnection, 'status' | 'qualityRating' | 'verifiedName'>> & { updatedAt: string },
  ): Promise<void>;
  /** Marks the connection DISCONNECTED, deletes the token and PIN, and releases the number. */
  disconnect(brandId: string, at: string): Promise<void>;
  brandForPhoneNumber(phoneNumberId: string): Promise<string | null>;
  /** The connections of a WABA (account_update webhooks name the WABA, not the number). */
  brandsForWaba(wabaId: string): Promise<string[]>;
  /** A sent message's latest delivery status (brands/{brandId}/messageStatuses/{wamid}); never moves backwards. */
  recordDeliveryStatus(
    brandId: string,
    update: { externalMessageId: string; status: 'SENT' | 'DELIVERED' | 'READ' | 'FAILED'; timestamp: string },
  ): Promise<void>;
}

export interface WhatsAppPhoneNumberInfo {
  id: string;
  displayPhoneNumber: string;
  verifiedName: string;
  qualityRating: string;
}

/** Normalized Graph API failures; never Meta's raw message, a token or the app secret. */
export class WhatsAppApiError extends Error {
  constructor(
    readonly kind: 'UNAUTHORIZED' | 'NOT_FOUND' | 'RATE_LIMITED' | 'INVALID' | 'FAILED',
    message: string,
    /** Meta's numeric error code when there is one (e.g. 131047 = outside the 24 h window). */
    readonly code: number | null = null,
  ) {
    super(message);
    this.name = 'WhatsAppApiError';
  }
}

/** The Graph API surface Qwikspot uses for WhatsApp (Cloud API + Embedded Signup onboarding). */
export interface WhatsAppGraphApi {
  /** Embedded Signup: the 30-second code → a business integration system user token. */
  exchangeCode(code: string): Promise<string>;
  getPhoneNumber(phoneNumberId: string, token: string): Promise<WhatsAppPhoneNumberInfo>;
  listPhoneNumbers(wabaId: string, token: string): Promise<WhatsAppPhoneNumberInfo[]>;
  subscribeApp(wabaId: string, token: string): Promise<void>;
  unsubscribeApp(wabaId: string, token: string): Promise<void>;
  registerNumber(phoneNumberId: string, token: string, pin: string): Promise<void>;
  /** POST /{phone_number_id}/messages → the wamid. */
  sendMessage(phoneNumberId: string, token: string, payload: Record<string, unknown>): Promise<string>;
}
