// Proactive texts: the morning brief, due-date nudges, "new assignment posted" alerts
// from course sites, and verified internship drops. Everything is deduped and nothing
// is sent during the student's quiet hours.

import { INTERNSHIP_CHECK_MS, SCHEDULER_TICK_MS, SITE_CHECK_MS, fmtDate, localDay, localHour } from "./config.ts";
import { buildBrief } from "./brief.ts";
import { upcomingHomework } from "./homework.ts";
import { readCourseSite } from "./sources/courseSites.ts";
import { loadListings, matchesPrefs, verifyPosting, type Internship } from "./sources/internships.ts";
import { allUsers, internshipCache, markSent, pushHistory, save, type UserState } from "./store.ts";

export type ProactiveSend = (user: UserState, text: string) => Promise<void>;

export function isQuiet(user: UserState, hour = localHour()): boolean {
  const { quietStart: s, quietEnd: e } = user.schedule;
  if (s === e) return false;
  return s > e ? hour >= s || hour < e : hour >= s && hour < e;
}

async function text(send: ProactiveSend, user: UserState, body: string): Promise<void> {
  pushHistory(user, "assistant", body);
  save();
  await send(user, body);
}

async function morningBrief(user: UserState, send: ProactiveSend): Promise<void> {
  const hour = localHour();
  const today = localDay();
  if (user.lastBriefDay === today || hour < user.schedule.briefHour || hour >= user.schedule.briefHour + 3) return;
  user.lastBriefDay = today;
  save();
  const brief = await buildBrief(user);
  if (brief) await text(send, user, brief); // null = nothing worth a text; stay quiet
}

async function dueNudges(user: UserState, send: ProactiveSend): Promise<void> {
  const { items } = await upcomingHomework(user, 1.2);
  const lines: string[] = [];
  for (const a of items) {
    const left = new Date(a.due).getTime() - Date.now();
    const window = left <= 3 * 3600_000 ? "3h" : left <= 24 * 3600_000 ? "24h" : null;
    if (!window || !markSent(user, `nudge${window}:${a.key}:${a.due}`)) continue;
    lines.push(`• ${a.course}: ${a.title} is due ${fmtDate(a.due)}\n  ${a.url}`);
  }
  if (!lines.length) return;
  const soon = lines.length === 1 ? "Heads up ⏰" : `Heads up, ${lines.length} things due soon ⏰`;
  await text(send, user, `${soon}\n${lines.join("\n")}\n\nAlready turned it in? Just say "done with …"`);
}

async function courseSiteChanges(user: UserState, send: ProactiveSend): Promise<void> {
  for (const course of user.courses) {
    for (const site of course.sites) {
      if (Date.now() - (site.lastChecked ?? 0) < SITE_CHECK_MS) continue;
      site.lastChecked = Date.now();
      try {
        const read = await readCourseSite(site.url, course.code, site.pages);
        if (read.assignments.length === 0 && site.knownItems.length > 0) throw new Error("no dated items on the page anymore");
        const fresh = read.assignments.filter((a) => !site.knownItems.includes(a.key) && new Date(a.due).getTime() > Date.now());
        site.knownItems = [...new Set([...site.knownItems, ...read.assignments.map((a) => a.key)])];
        site.lastHash = read.hash;
        site.failures = 0;
        site.brokenNotified = false;
        save();
        if (fresh.length) {
          await text(
            send,
            user,
            `📌 New on the ${course.code} site:\n` +
              fresh.map((a) => `• ${a.title}, due ${fmtDate(a.due)}\n  ${a.url}`).join("\n"),
          );
        }
      } catch (err) {
        site.failures++;
        save();
        console.warn(`[scheduler] ${course.code} site ${site.url}:`, (err as Error).message);
        if (site.failures >= 2 && !site.brokenNotified) {
          site.brokenNotified = true;
          save();
          await text(send, user, `Heads up: the ${course.code} page I watch (${site.url}) stopped working for me. Got a new link? Just send it.`);
        }
      }
    }
  }
}

async function internshipDrops(user: UserState, listings: Internship[], send: ProactiveSend): Promise<void> {
  if (!user.internships.alerts || !user.internshipsSince) return;
  const since = Math.max(user.internshipsSince, Date.now() - 3 * 24 * 3600_000);
  const matches = listings.filter(
    (j) => new Date(j.postedAt).getTime() > since && !user.seenInternshipIds.includes(j.id) && matchesPrefs(j, user.internships),
  );
  if (!matches.length) return;
  user.seenInternshipIds.push(...matches.map((j) => j.id));
  save();

  // Verify the top 2 on the live site with TinyFish Agent before texting.
  const top = matches.slice(0, 2);
  const checks = await Promise.allSettled(top.map((j) => verifyPosting(j.url)));
  const lines: string[] = [];
  top.forEach((j, i) => {
    const c = checks[i]!;
    if (c.status === "fulfilled" && c.value.accepting_applications === false) return; // closed: don't bother them
    const detail =
      c.status === "fulfilled"
        ? [
            c.value.accepting_applications ? "✅ open" : "status unclear",
            c.value.deadline && `deadline ${c.value.deadline}`,
            c.value.pay && c.value.pay,
          ]
            .filter(Boolean)
            .join(" · ")
        : "couldn't open the posting to double-check";
    lines.push(`• ${j.company}: ${j.title} (${j.locations.slice(0, 2).join(", ")})\n  ${detail}\n  ${j.url}`);
  });
  if (!lines.length) return;
  const more = matches.length > top.length ? `\n\n+${matches.length - top.length} more matches. Want the list?` : "\n\nWant me to dig into any of these?";
  await text(send, user, `💼 New internship${lines.length > 1 ? "s" : ""} for you:\n${lines.join("\n")}${more}`);
}

let running = false;

async function tick(send: ProactiveSend): Promise<void> {
  if (running) return;
  running = true;
  try {
    const users = allUsers().filter((u) => u.onboarding.step === "done" && u.spaceId);
    const meta = internshipCache();
    let listings: Internship[] | null = null;
    if (Date.now() - (meta.lastCheck ?? 0) > INTERNSHIP_CHECK_MS && users.some((u) => u.internships.alerts)) {
      meta.lastCheck = Date.now();
      listings = await loadListings().catch((err) => {
        console.warn("[scheduler] internship list:", (err as Error).message);
        return null;
      });
    }
    for (const user of users) {
      if (isQuiet(user)) continue;
      const jobs: Array<[string, () => Promise<void>]> = [
        ["brief", () => morningBrief(user, send)],
        ["nudges", () => dueNudges(user, send)],
        ["sites", () => courseSiteChanges(user, send)],
      ];
      if (listings) jobs.push(["internships", () => internshipDrops(user, listings!, send)]);
      for (const [name, job] of jobs) {
        await job().catch((err) => console.warn(`[scheduler] ${name} for ${user.id}:`, err));
      }
    }
  } finally {
    running = false;
  }
}

export function startScheduler(send: ProactiveSend): void {
  console.log(`[scheduler] running every ${Math.round(SCHEDULER_TICK_MS / 1000)}s`);
  void tick(send);
  setInterval(() => void tick(send), SCHEDULER_TICK_MS);
}
