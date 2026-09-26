import type { LogLevel } from '../config/env.js';

type Fields = Record<string, unknown>;

export interface Logger {
  debug(message: string, fields?: Fields): void;
  info(message: string, fields?: Fields): void;
  warn(message: string, fields?: Fields): void;
  error(message: string, fields?: Fields): void;
}

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const SEVERITY: Record<LogLevel, string> = {
  debug: 'DEBUG',
  info: 'INFO',
  warn: 'WARNING',
  error: 'ERROR',
};

/**
 * One JSON object per line on stdout: Cloud Logging parses `severity` and `message`.
 * Callers pass IDs and codes, never tokens, credentials or customer content.
 */
export function createLogger(minLevel: LogLevel = 'info', write: (line: string) => void = console.log): Logger {
  const log = (level: LogLevel, message: string, fields?: Fields) => {
    if (ORDER[level] < ORDER[minLevel]) return;
    write(JSON.stringify({ severity: SEVERITY[level], message, ...fields, time: new Date().toISOString() }));
  };
  return {
    debug: (m, f) => log('debug', m, f),
    info: (m, f) => log('info', m, f),
    warn: (m, f) => log('warn', m, f),
    error: (m, f) => log('error', m, f),
  };
}

export const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };
