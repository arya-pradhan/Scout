// Runtime settings read from .env (see .env.example).

import { AsyncLocalStorage } from "node:async_hooks";

export const MODEL = process.env.CLAUDE_MODEL ?? "claude-sonnet-5-5";

/**
 * Reading deadlines off messy course sites needs careful date reasoning ("EOW", times the
 * page's JavaScript showed in UTC, old semesters on the same page). Haiku got these wrong
 * in testing, so this one job uses a stronger model. It only runs when a site's text
 * changes (see courseSites.ts), so the cost stays small.
 */
export const SITE_MODEL = process.env.SITE_MODEL ?? "claude-sonnet-5-5";

/** Request options that only newer models accept (Haiku 4.5 rejects `effort`; server-side fallback is for 5.x models). */
export const supportsEffort = (model: string) => /opus-5|sonnet-5|fable|mythos|opus-4-[5678]|sonnet-4-6/.test(model);
export const supportsFallbacks = (model: string) => /opus-5|sonnet-5-5|fable/.test(model);
export const MODEL_SUPPORTS_EFFORT = supportsEffort(MODEL);
export const MODEL_SUPPORTS_FALLBACKS = supportsFallbacks(MODEL);

/** Fallback timezone when a student hasn't told us their school yet. */
export const DEFAULT_TIMEZONE = process.env.TZ_NAME ?? "America/New_York";

// Each student's school sets their timezone. It's scoped per message / scheduler pass
// with AsyncLocalStorage, so every date helper below uses the right one without threading
// the user through every call.
const tzScope = new AsyncLocalStorage<string>();

export function withTimezone<T>(timezone: string | undefined, fn: () => T): T {
  return tzScope.run(timezone || DEFAULT_TIMEZONE, fn);
}

/** The current student's IANA timezone (e.g. "America/Los_Angeles"). */
export function currentTimezone(): string {
  return tzScope.getStore() ?? DEFAULT_TIMEZONE;
}

/** The current student's UTC offset right now, e.g. "-04:00" (for prompts that need to write ISO times). */
export function utcOffset(d = new Date()): string {
  const name = d.toLocaleString("en-US", { timeZone: currentTimezone(), timeZoneName: "longOffset" }).split(" ").pop() ?? "GMT";
  const m = name.match(/GMT([+-]\d{2}:\d{2})/);
  return m ? m[1]! : "+00:00";
}

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

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
    timeZone: currentTimezone(),
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

/** Hour of day (0-23) in the student's timezone. */
export function localHour(d = new Date()): number {
  return Number(d.toLocaleString("en-US", { timeZone: currentTimezone(), hour: "numeric", hourCycle: "h23" }));
}

/** "Sunday", "Monday", … in the student's timezone. */
export function localWeekday(d = new Date()): string {
  return d.toLocaleDateString("en-US", { timeZone: currentTimezone(), weekday: "long" });
}

/** YYYY-MM-DD in the student's timezone. */
export function localDay(d = new Date()): string {
  return d.toLocaleDateString("en-CA", { timeZone: currentTimezone() });
}
