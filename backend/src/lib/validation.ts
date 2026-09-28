import type { z } from 'zod';
import { Errors } from './errors.js';

/** Parses request input; failures become 400 INVALID_REQUEST without echoing the input. */
export function parseInput<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((issue) => issue.path.join('.') || 'body'))];
    throw Errors.invalidRequest(`Invalid fields: ${fields.join(', ')}`);
  }
  return parsed.data;
}
