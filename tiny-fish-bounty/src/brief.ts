// The morning brief and the Sunday week-ahead plan: built deterministically from real
// data (no LLM), so every line is traceable to a source link. Each section is its own
// bubble with a `ref`, so a tapback acts on exactly that section (👍 homework = done,
// ❤️ events = add to calendar, ❤️ postings = save). Returns null when there's nothing
// worth a text.

import { currentTimezone, fmtDate, greeting, localHour, localWeekday } from "./config.ts";
import { upcomingHomework } from "./homework.ts";
import { say, type Reply } from "./reply.ts";
import { eventSourceLabel, getEvents } from "./sources/events.ts";
import { collectJobs, matchesPrefs } from "./sources/jobs.ts";
import type { UserState } from "./store.ts";

export async function buildBrief(user: UserState, opts: { greeting?: boolean } = {}): Promise<Reply[] | null> {
  const bubbles: Reply[] = [];
  const notes: string[] = [];

  const [hw, events, jobs] = await Promise.allSettled([
    upcomingHomework(user, 2),
    getEvents(user, {
      from: new Date(),
      to: endOfToday(),
      keywords: user.events.keywords,
      freeFood: user.events.freeFood,
      match: "any", // their interests OR free food
      eveningsOnly: user.events.eveningsOnly,
      limit: 3,
    }),
    user.internships.alerts ? collectJobs(user) : Promise.resolve({ jobs: [], failed: [] }),
  ]);

  if (hw.status === "fulfilled") {
    const items = hw.value.items.slice(0, 4);
    if (items.length) {
      const text = "📚 Due in the next 48h\n" + items.map((a) => `• ${a.course}: ${a.title} (${fmtDate(a.due)})\n  ${a.url}`).join("\n");
      bubbles.push(say(text, { kind: "homework", assignments: items.map((a) => a.key), text }));
    }
    if (hw.value.failed.length) notes.push(`couldn't reach ${hw.value.failed.join(", ")}`);
  } else notes.push("couldn't load homework");

  if (events.status === "fulfilled") {
    if (events.value.length) {
      const text =
        "🎉 On campus today\n" +
        events.value
          .map((e) => `• ${e.name} (${fmtDate(e.start)}, ${e.location})${e.perks.includes("Free Food") ? " 🍕" : ""}\n  ${e.url}`)
          .join("\n");
      bubbles.push(say(text, { kind: "events", events: events.value.map((e) => e.id), text }));
    }
  } else notes.push(`${eventSourceLabel(user)} wasn't responding`);

  if (jobs.status === "fulfilled") {
    const since = Date.now() - 24 * 3600_000;
    const fresh = jobs.value.jobs.filter((j) => new Date(j.postedAt).getTime() > since && matchesPrefs(j, user.internships)).slice(0, 3);
    if (fresh.length) {
      const text =
        "💼 New postings for you (last 24h)\n" +
        fresh
          .map((j) => `• ${j.company}: ${j.title}${j.locations.length ? ` (${j.locations.slice(0, 2).join(", ")})` : ""}\n  ${j.url}`)
          .join("\n");
      bubbles.push(say(text, { kind: "internships", jobs: fresh.map((j) => j.id), text }));
    }
    if (jobs.value.failed.length) notes.push(`couldn't check ${jobs.value.failed.join(", ")}`);
  } else notes.push("job sources weren't loading");

  if (!bubbles.length && !opts.greeting) return null;
  const hello = `${greeting()}${user.name ? `, ${user.name}` : ""}!`;
  const footer = notes.length ? `\n(heads up: ${notes.join("; ")})` : "";
  if (!bubbles.length) return [say(`${hello} Nothing due in the next 48h and no new matches. Enjoy the day 😌${footer}`)];
  return [say(`${hello} Here's your day 👇${footer}`), ...bubbles];
}

/** Sunday-night plan: the coming week's deadlines by day, application deadlines, a couple of events. */
export async function buildWeekAhead(user: UserState): Promise<Reply[] | null> {
  const bubbles: Reply[] = [];
  const hw = await upcomingHomework(user, 7).catch(() => null);
  if (hw?.items.length) {
    const byDay = new Map<string, string[]>();
    for (const a of hw.items) {
      const tz = currentTimezone();
      const day = new Date(a.due).toLocaleDateString("en-US", { timeZone: tz, weekday: "long", month: "short", day: "numeric" });
      const time = new Date(a.due).toLocaleTimeString("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" });
      byDay.set(day, [...(byDay.get(day) ?? []), `  • ${a.course}: ${a.title} (${time})`]);
    }
    const text = "📚 This week\n" + [...byDay].map(([day, lines]) => `${day}\n${lines.join("\n")}`).join("\n");
    bubbles.push(say(text, { kind: "homework", assignments: hw.items.map((a) => a.key), text }));
  }

  const soon = user.applications.filter((a) => a.status === "saved");
  if (soon.length) {
    const text =
      "💼 Saved, not applied yet\n" +
      soon
        .slice(0, 4)
        .map((a) => `• ${a.company}: ${a.title}${a.prep?.deadline ? ` (deadline ${a.prep.deadline})` : ""}`)
        .join("\n");
    bubbles.push(say(text, { kind: "application", appIds: soon.map((a) => a.id), text }));
  }

  const events = await getEvents(user, {
    from: new Date(),
    to: new Date(Date.now() + 7 * 24 * 3600_000),
    keywords: user.events.keywords,
    freeFood: user.events.freeFood,
    match: "any",
    eveningsOnly: user.events.eveningsOnly,
    limit: 2,
  }).catch(() => []);
  if (events.length) {
    const text = "🎉 Worth a look this week\n" + events.map((e) => `• ${e.name} (${fmtDate(e.start)}, ${e.location})\n  ${e.url}`).join("\n");
    bubbles.push(say(text, { kind: "events", events: events.map((e) => e.id), text }));
  }

  if (!bubbles.length) return null;
  const header = localWeekday() === "Sunday" ? "🗓️ Sunday check-in" : "🗓️ Your next 7 days";
  return [
    say(`${header}${user.name ? `, ${user.name}` : ""}! Here's what's coming up:`),
    ...bubbles,
    say('❤️ any bubble to get Google Calendar links for it, or say "add this week to my calendar".'),
  ];
}

/** Midnight tonight in the student's timezone (to the hour, which is all the brief needs). */
function endOfToday(): Date {
  const now = new Date();
  return new Date(now.getTime() + (24 - localHour(now)) * 3600_000 - now.getMinutes() * 60_000);
}

/** Flatten bubbles into one string for chat history. */
export function repliesText(replies: Reply[]): string {
  return replies
    .map((r) => ("text" in r ? r.text : ""))
    .filter(Boolean)
    .join("\n\n");
}
