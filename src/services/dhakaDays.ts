// The shop runs on Bangladesh time (UTC+6, no daylight saving), so a "day" in a
// date filter is a Dhaka day, whatever time zone the server or the browser is in.
const DHAKA_OFFSET_MS = 6 * 60 * 60 * 1000;
export const DAY_MS = 24 * 60 * 60 * 1000;

export const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

// "2026-10-15" for the Dhaka day the moment falls on
export const dhakaDay = (date: Date): string => new Date(date.getTime() + DHAKA_OFFSET_MS).toISOString().slice(0, 10);

// Midnight at the start of a Dhaka day ("YYYY-MM-DD"); an Invalid Date for a day that doesn't exist
export const startOfDhakaDay = (day: string): Date => {
  const start = new Date(`${day}T00:00:00+06:00`);
  // Month 13 is no date at all, and JS rolls 2026-02-30 over to 2026-03-02; refuse both
  return !Number.isNaN(start.getTime()) && dhakaDay(start) === day ? start : new Date(NaN);
};

export const isDhakaDay = (day: string): boolean =>
  DAY_PATTERN.test(day) && !Number.isNaN(startOfDhakaDay(day).getTime());
