/**
 * Console-user identity administration (Firebase Authentication).
 *
 * This is NOT one of the five profile-swapped provider ports: Firebase Auth is a
 * direct SDK dependency in every profile (emulator locally, real service in GCP).
 * The interface exists only so application services can be tested without Firebase.
 */
export interface IdentityAdmin {
  findUidByEmail(email: string): Promise<string | null>;
  /** Creates a passwordless Firebase Auth user; the password is set via the setup link. */
  createUser(email: string): Promise<string>;
  /** Admin SDK password-reset link, handed over manually (no email service in the MVP). */
  createPasswordSetupLink(email: string): Promise<string>;
}
