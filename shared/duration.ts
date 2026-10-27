// A month is counted as 30 days and a year as 365, so every duration is an exact number of seconds.
// ("m" is minutes; months must be spelled out or written "mo".)
const UNITS: Record<string, number> = {
  y: 31536000, yr: 31536000, yrs: 31536000, year: 31536000, years: 31536000,
  mo: 2592000, mos: 2592000, month: 2592000, months: 2592000,
  w: 604800, wk: 604800, wks: 604800, week: 604800, weeks: 604800,
  d: 86400, day: 86400, days: 86400,
  h: 3600, hr: 3600, hrs: 3600, hour: 3600, hours: 3600,
  m: 60, min: 60, mins: 60, minute: 60, minutes: 60,
  s: 1, sec: 1, secs: 1, second: 1, seconds: 1,
};
const MAX_SECONDS = 100 * 365 * 86400;

/**
 * Parses "3:05" (h:mm), "1:02:03" (h:mm:ss), or words: "3 hours and 5 minutes", "3h 5m", "1.5 hours",
 * "25 days", "12 weeks", "3 months and 2 days".
 * Returns whole seconds, or null if the text isn't a duration.
 */
export function parseDuration(input: string): number | null {
  const text = input.trim().toLowerCase();
  if (!text) return null;

  const colon = /^(\d+):(\d{1,2})(?::(\d{1,2}))?$/.exec(text);
  if (colon) {
    const [h, m, s] = [Number(colon[1]), Number(colon[2]), Number(colon[3] ?? 0)];
    if (m > 59 || s > 59) return null;
    const total = h * 3600 + m * 60 + s;
    return total <= MAX_SECONDS ? total : null;
  }

  let total = 0;
  const rest = text.replace(/(\d+(?:[.,]\d+)?)\s*([a-z]+)/g, (whole, num: string, unit: string) => {
    const mult = UNITS[unit];
    if (mult === undefined) return whole; // left in place so the leftover check fails
    total += Number(num.replace(',', '.')) * mult;
    return ' ';
  });
  if (rest.replace(/\band\b|[,&\s]/g, '') !== '' || !/\d/.test(text)) return null;
  total = Math.round(total);
  return total <= MAX_SECONDS ? total : null;
}

/** 11100 -> "3 h 5 min" */
export function formatDuration(totalSeconds: number): string {
  const s = Math.round(totalSeconds);
  if (s === 0) return '0 min';
  const parts: string[] = [];
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d) parts.push(`${d} d`);
  if (h) parts.push(`${h} h`);
  if (m) parts.push(`${m} min`);
  if (sec) parts.push(`${sec} s`);
  return parts.join(' ');
}
