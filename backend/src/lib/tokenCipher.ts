import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/** An encrypted secret as stored in Firestore (L2-Shopify; docs/07 §9). Never logged, never returned. */
export interface SealedSecret {
  /** base64 */
  iv: string;
  /** base64 */
  tag: string;
  /** base64 */
  ciphertext: string;
  key_version: number;
}

/**
 * AES-256-GCM for third-party tokens kept server-side (Shopify offline tokens). The key
 * comes from TOKEN_ENCRYPTION_KEY (32 bytes); every value gets a fresh 12-byte IV, and the
 * auth tag makes any tampering — or the wrong key — fail to decrypt.
 */
export class TokenCipher {
  static readonly KEY_VERSION = 1;

  constructor(private readonly key: Buffer) {
    if (key.length !== 32) throw new Error('TokenCipher needs a 32-byte key');
  }

  seal(plain: string): SealedSecret {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return {
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      ciphertext: ciphertext.toString('base64'),
      key_version: TokenCipher.KEY_VERSION,
    };
  }

  open(sealed: SealedSecret): string {
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(sealed.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(sealed.ciphertext, 'base64')), decipher.final()]).toString(
      'utf8',
    );
  }
}
