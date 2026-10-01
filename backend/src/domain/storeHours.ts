/**
 * Store hours (docs/04_DATA_MODEL.md §9.2): an IANA timezone plus one "HH:MM-HH:MM"
 * value per weekday in that timezone. An empty day is closed; hours never run past
 * midnight. "Open now" is computed here, deterministically — never by the AI.
 */

export const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] as const;
export type Weekday = (typeof WEEKDAYS)[number];

/** { timezone, monday: "10:00-21:00", ..., sunday: "" } */
export type StoreHours = Record<string, string>;

const AREA_LOCATION = /^[A-Za-z]+(?:[_-][A-Za-z]+)*(?:\/[A-Za-z0-9]+(?:[_+-][A-Za-z0-9]+)*)+$/;

/**
 * Only IANA identifiers such as "Asia/Kolkata" (or "UTC"). Offsets like "+05:30" and
 * abbreviations like "IST" are rejected even where the runtime would accept them.
 */
export function isValidIanaTimezone(timezone: string): boolean {
  if (timezone === 'UTC') return true;
  if (!AREA_LOCATION.test(timezone)) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

const DAY_RANGE = /^([01]\d|2[0-3]):([0-5]\d)-([01]\d|2[0-3]):([0-5]\d)$/;

/** Minutes since local midnight, or null for a closed day; undefined when malformed. */
export function parseDayHours(value: string): { opens: number; closes: number } | null | undefined {
  const trimmed = value.trim();
  if (trimmed === '') return null;
  const m = DAY_RANGE.exec(trimmed);
  if (!m) return undefined;
  const opens = Number(m[1]) * 60 + Number(m[2]);
  const closes = Number(m[3]) * 60 + Number(m[4]);
  // Opening must be earlier than closing; overnight hours are not supported in the MVP.
  return opens < closes ? { opens, closes } : undefined;
}

export type StoreHoursProblem = { code: 'INVALID_TIMEZONE' } | { code: 'INVALID_HOURS'; day: Weekday };

/** Validates a complete store_hours object; returns the first problem, or null. */
export function validateStoreHours(hours: StoreHours): StoreHoursProblem | null {
  if (!isValidIanaTimezone(hours.timezone ?? '')) return { code: 'INVALID_TIMEZONE' };
  for (const day of WEEKDAYS) {
    if (parseDayHours(hours[day] ?? '') === undefined) return { code: 'INVALID_HOURS', day };
  }
  return null;
}

const localParts = (timezone: string, now: Date) => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'long',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return { day: get('weekday').toLowerCase(), minutes: Number(get('hour')) * 60 + Number(get('minute')) };
};

/**
 * open_now = hours[local weekday] is non-empty AND opening ≤ local time < closing,
 * evaluated in the STORE's timezone regardless of the server's. Invalid hours → closed.
 */
export function isOpenNow(hours: StoreHours | null, now: Date): boolean {
  if (!hours || validateStoreHours(hours)) return false;
  const { day, minutes } = localParts(hours.timezone!, now);
  const range = parseDayHours(hours[day] ?? '');
  return !!range && range.opens <= minutes && minutes < range.closes;
}

/** The store's local weekday (lower-case), hour and "HH:MM" time for `now`. */
export function storeLocalTime(timezone: string, now: Date): { weekday: string; hour: number; time: string } {
  const { day, minutes } = localParts(timezone, now);
  const hour = Math.floor(minutes / 60);
  return { weekday: day, hour, time: `${String(hour).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}` };
}

/** Today's closing time ("21:00") in the store's timezone, or null when closed today / invalid hours. */
export function closingTimeToday(hours: StoreHours | null, now: Date): string | null {
  if (!hours || validateStoreHours(hours)) return null;
  const { day } = localParts(hours.timezone!, now);
  const range = parseDayHours(hours[day] ?? '');
  if (!range) return null;
  return `${String(Math.floor(range.closes / 60)).padStart(2, '0')}:${String(range.closes % 60).padStart(2, '0')}`;
}
