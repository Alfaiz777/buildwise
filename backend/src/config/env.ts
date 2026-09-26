import { z } from 'zod';

const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  GOOGLE_CLOUD_PROJECT: z.string().trim().min(1),
  CORS_ALLOWED_ORIGINS: z.string().default(''),
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
  // Read directly by the Firebase Admin SDK; validated here only for the production guard.
  FIRESTORE_EMULATOR_HOST: z.string().optional(),
  FIREBASE_AUTH_EMULATOR_HOST: z.string().optional(),
});

export interface Config {
  nodeEnv: 'development' | 'test' | 'production';
  port: number;
  projectId: string;
  corsAllowedOrigins: string[];
  logLevel: LogLevel;
  usingEmulators: boolean;
}

/**
 * Validates environment configuration at startup.
 * Error messages name the invalid variables but never echo their values.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((issue) => issue.path.join('.')))];
    throw new Error(`Invalid environment configuration: ${fields.join(', ')}`);
  }
  const e = parsed.data;
  const usingEmulators = Boolean(e.FIRESTORE_EMULATOR_HOST || e.FIREBASE_AUTH_EMULATOR_HOST);

  if (e.NODE_ENV === 'production' && usingEmulators) {
    throw new Error('Emulator hosts must not be set when NODE_ENV=production');
  }

  return {
    nodeEnv: e.NODE_ENV,
    port: e.PORT,
    projectId: e.GOOGLE_CLOUD_PROJECT,
    corsAllowedOrigins: e.CORS_ALLOWED_ORIGINS.split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
    logLevel: e.LOG_LEVEL,
    usingEmulators,
  };
}
