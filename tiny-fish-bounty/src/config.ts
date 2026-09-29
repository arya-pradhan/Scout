// Runtime settings read from .env (see .env.example).

export const MODEL = process.env.CLAUDE_MODEL ?? "claude-sonnet-5-5";

/** Everything the bot says about dates is in this timezone. */
export const TIMEZONE = process.env.TZ_NAME ?? "America/New_York";

/** Phone numbers / Apple IDs the bot answers. Empty = answer anyone (not recommended). */
export const ALLOWED_SENDERS = (process.env.ALLOWED_PHONES ?? "")
  .split(",")
  .map((s) => normalizeSender(s))
  .filter(Boolean);

export function normalizeSender(id: string): string {
  const t = id.trim().toLowerCase();
  if (t.includes("@")) return t;
  const digits = t.replace(/[^\d]/g, "");
  return digits.length === 10 ? `+1${digits}` : digits ? `+${digits}` : "";
}

export function isAllowed(senderId: string): boolean {
  return ALLOWED_SENDERS.length === 0 || ALLOWED_SENDERS.includes(normalizeSender(senderId));
}

/** Scheduler cadence, overridable for testing (e.g. SCHEDULER_TICK_MS=60000). */
export const SCHEDULER_TICK_MS = Number(process.env.SCHEDULER_TICK_MS ?? 5 * 60_000);
export const INTERNSHIP_CHECK_MS = Number(process.env.INTERNSHIP_CHECK_MS ?? 2 * 60 * 60_000);
export const SITE_CHECK_MS = Number(process.env.SITE_CHECK_MS ?? 24 * 60 * 60_000);

/** Format a date for a text message, e.g. "Thu, Oct 2, 11:59 PM" (year added when it isn't this year). */
export function fmtDate(d: Date | string | number): string {
  const date = new Date(d);
  const otherYear = date.getFullYear() !== new Date().getFullYear();
  return date.toLocaleString("en-US", {
    timeZone: TIMEZONE,
    weekday: "short",
    month: "short",
    day: "numeric",
    ...(otherYear ? { year: "numeric" } : {}),
    hour: "numeric",
    minute: "2-digit",
  });
}

/** "Morning" / "Afternoon" / "Evening" for the student's local time. */
export function greeting(d = new Date()): string {
  const h = localHour(d);
  return h < 12 ? "☀️ Morning" : h < 17 ? "👋 Afternoon" : "🌙 Evening";
}

/** Hour of day (0-23) in the bot's timezone. */
export function localHour(d = new Date()): number {
  return Number(d.toLocaleString("en-US", { timeZone: TIMEZONE, hour: "numeric", hourCycle: "h23" }));
}

/** YYYY-MM-DD in the bot's timezone. */
export function localDay(d = new Date()): string {
  return d.toLocaleDateString("en-CA", { timeZone: TIMEZONE });
}
