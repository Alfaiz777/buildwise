import type { Auth } from 'firebase-admin/auth';
import type { IdentityAdmin } from '../../ports/identity.js';

/** Firebase Auth Admin SDK; talks to the Auth emulator when FIREBASE_AUTH_EMULATOR_HOST is set. */
export class FirebaseIdentityAdmin implements IdentityAdmin {
  constructor(private readonly auth: Auth) {}

  async findUidByEmail(email: string): Promise<string | null> {
    try {
      return (await this.auth.getUserByEmail(email)).uid;
    } catch (err) {
      if ((err as { code?: string }).code === 'auth/user-not-found') return null;
      throw err;
    }
  }

  async createUser(email: string): Promise<string> {
    return (await this.auth.createUser({ email })).uid;
  }

  async createPasswordSetupLink(email: string): Promise<string> {
    return this.auth.generatePasswordResetLink(email);
  }
}
