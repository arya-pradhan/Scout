// The morning brief: built deterministically from real data (no LLM), so every
// line is traceable to a source link. Returns null when there's nothing worth a text.

import { fmtDate, greeting } from "./config.ts";
import { upcomingHomework } from "./homework.ts";
import { getEvents } from "./sources/events.ts";
import { loadListings, matchesPrefs } from "./sources/internships.ts";
import type { UserState } from "./store.ts";

export async function buildBrief(user: UserState, opts: { greeting?: boolean } = {}): Promise<string | null> {
  const sections: string[] = [];
  const notes: string[] = [];

  const [hw, events, jobs] = await Promise.allSettled([
    upcomingHomework(user, 2),
    getEvents({
      from: new Date(),
      to: endOfToday(),
      keywords: user.events.keywords,
      freeFood: user.events.freeFood,
      match: "any", // their interests OR free food
      eveningsOnly: user.events.eveningsOnly,
      limit: 3,
    }),
    user.internships.alerts ? loadListings() : Promise.resolve([]),
  ]);

  if (hw.status === "fulfilled") {
    if (hw.value.items.length) {
      sections.push(
        "📚 Due in the next 48h\n" +
          hw.value.items
            .slice(0, 4)
            .map((a) => `• ${a.course}: ${a.title} (${fmtDate(a.due)})\n  ${a.url}`)
            .join("\n"),
      );
    }
    if (hw.value.failed.length) notes.push(`couldn't reach ${hw.value.failed.join(", ")}`);
  } else notes.push("couldn't load homework");

  if (events.status === "fulfilled") {
    if (events.value.length) {
      sections.push(
        "🎉 On campus today\n" +
          events.value
            .map((e) => `• ${e.name} (${fmtDate(e.start)}, ${e.location})${e.perks.includes("Free Food") ? " 🍕" : ""}\n  ${e.url}`)
            .join("\n"),
      );
    }
  } else notes.push("HeelLife wasn't responding");

  if (jobs.status === "fulfilled") {
    const since = Date.now() - 24 * 3600_000;
    const fresh = jobs.value
      .filter((j) => new Date(j.postedAt).getTime() > since && matchesPrefs(j, user.internships))
      .slice(0, 3);
    if (fresh.length) {
      sections.push(
        "💼 New internships (last 24h)\n" +
          fresh.map((j) => `• ${j.company}: ${j.title} (${j.locations.slice(0, 2).join(", ")})\n  ${j.url}`).join("\n"),
      );
    }
  } else notes.push("the internship list wasn't loading");

  if (!sections.length && !opts.greeting) return null;
  const hello = `${greeting()}${user.name ? `, ${user.name}` : ""}!`;
  const body = sections.length ? sections.join("\n\n") : "Nothing due in the next 48h and no new matches. Enjoy the day 😌";
  const footer = notes.length ? `\n\n(heads up: ${notes.join("; ")})` : "";
  return `${hello}\n\n${body}${footer}`;
}

function endOfToday(): Date {
  const d = new Date();
  d.setHours(23, 59, 59, 999);
  return d;
}
