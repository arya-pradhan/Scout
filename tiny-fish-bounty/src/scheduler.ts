// Proactive texts: the morning brief, due-date nudges, "new assignment posted" alerts,
// verified internship drops, application follow-ups, the Sunday week-ahead plan, and
// reminders the student asked for. Everything is deduped; nothing but explicitly
// requested reminders is sent during quiet hours. Each bubble carries a `ref` so a
// tapback on it can act.

import { prepApplication } from "./applications.ts";
import { buildBrief, buildWeekAhead, repliesText } from "./brief.ts";
import { INTERNSHIP_CHECK_MS, SCHEDULER_TICK_MS, SITE_CHECK_MS, fmtDate, localDay, localHour, localWeekday } from "./config.ts";
import { upcomingHomework } from "./homework.ts";
import { say, type Reply } from "./reply.ts";
import { readCourseSite } from "./sources/courseSites.ts";
import { loadListings, matchesPrefs, verifyPosting, type Internship } from "./sources/internships.ts";
import { allUsers, internshipCache, markSent, pushHistory, save, type UserState } from "./store.ts";

export type ProactiveSend = (user: UserState, replies: Reply[]) => Promise<void>;

const DAY = 24 * 3600_000;

export function isQuiet(user: UserState, hour = localHour()): boolean {
  const { quietStart: s, quietEnd: e } = user.schedule;
  if (s === e) return false;
  return s > e ? hour >= s || hour < e : hour >= s && hour < e;
}

async function deliver(send: ProactiveSend, user: UserState, replies: Reply[]): Promise<void> {
  pushHistory(user, "assistant", repliesText(replies));
  save();
  await send(user, replies);
}

async function morningBrief(user: UserState, send: ProactiveSend): Promise<void> {
  const hour = localHour();
  const today = localDay();
  if (user.lastBriefDay === today || hour < user.schedule.briefHour || hour >= user.schedule.briefHour + 3) return;
  user.lastBriefDay = today;
  save();
  const brief = await buildBrief(user);
  if (brief) await deliver(send, user, brief); // null = nothing worth a text; stay quiet
}

/** Sunday 7pm: the week ahead. */
async function weekAhead(user: UserState, send: ProactiveSend): Promise<void> {
  const today = localDay();
  if (localWeekday() !== "Sunday" || localHour() < 19 || user.lastWeeklyDay === today) return;
  user.lastWeeklyDay = today;
  save();
  const plan = await buildWeekAhead(user);
  if (plan) await deliver(send, user, plan);
}

async function dueNudges(user: UserState, send: ProactiveSend): Promise<void> {
  const { items } = await upcomingHomework(user, 1.2);
  const due = items.filter((a) => {
    const left = new Date(a.due).getTime() - Date.now();
    const window = left <= 3 * 3600_000 ? "3h" : left <= DAY ? "24h" : null;
    return window !== null && markSent(user, `nudge${window}:${a.key}:${a.due}`);
  });
  if (!due.length) return;
  const head = due.length === 1 ? "Heads up ⏰" : `Heads up, ${due.length} things due soon ⏰`;
  const text =
    `${head}\n` +
    due.map((a) => `• ${a.course}: ${a.title} is due ${fmtDate(a.due)}\n  ${a.url}`).join("\n") +
    "\n\nAlready turned it in? 👍 this message.";
  await deliver(send, user, [say(text, { kind: "homework", assignments: due.map((a) => a.key), text })]);
}

async function courseSiteChanges(user: UserState, send: ProactiveSend): Promise<void> {
  for (const course of user.courses) {
    for (const site of course.sites) {
      if (Date.now() - (site.lastChecked ?? 0) < SITE_CHECK_MS) continue;
      site.lastChecked = Date.now();
      try {
        const read = await readCourseSite(site.url, course.code, site.pages);
        if (read.assignments.length === 0 && site.knownItems.length > 0) throw new Error("no dated items on the site anymore");
        const fresh = read.assignments.filter((a) => !site.knownItems.includes(a.key) && new Date(a.due).getTime() > Date.now());
        site.knownItems = [...new Set([...site.knownItems, ...read.assignments.map((a) => a.key)])];
        site.lastHash = read.hash;
        site.failures = 0;
        site.brokenNotified = false;
        save();
        if (fresh.length) {
          const text =
            `📌 New on the ${course.code} site:\n` +
            fresh.map((a) => `• ${a.title}, due ${fmtDate(a.due)}\n  ${a.url}`).join("\n") +
            "\n\n❤️ to add to your calendar.";
          await deliver(send, user, [say(text, { kind: "homework", assignments: fresh.map((a) => a.key), text })]);
        }
      } catch (err) {
        site.failures++;
        save();
        console.warn(`[scheduler] ${course.code} site ${site.url}:`, (err as Error).message);
        if (site.failures >= 2 && !site.brokenNotified) {
          site.brokenNotified = true;
          save();
          await deliver(send, user, [
            say(`Heads up: the ${course.code} page I watch (${site.url}) stopped working for me. Got a new link? Just send it.`),
          ]);
        }
      }
    }
  }
}

async function internshipDrops(user: UserState, listings: Internship[], send: ProactiveSend): Promise<void> {
  if (!user.internships.alerts || !user.internshipsSince) return;
  const since = Math.max(user.internshipsSince, Date.now() - 3 * DAY);
  const matches = listings.filter(
    (j) => new Date(j.postedAt).getTime() > since && !user.seenInternshipIds.includes(j.id) && matchesPrefs(j, user.internships),
  );
  if (!matches.length) return;
  user.seenInternshipIds.push(...matches.map((j) => j.id));
  save();

  // Verify the top 2 on the live site with TinyFish Agent before texting.
  const top = matches.slice(0, 2);
  const checks = await Promise.allSettled(top.map((j) => verifyPosting(j.url)));
  const shown: Internship[] = [];
  const lines: string[] = [];
  top.forEach((j, i) => {
    const c = checks[i]!;
    if (c.status === "fulfilled" && c.value.accepting_applications === false) return; // closed: don't bother them
    const detail =
      c.status === "fulfilled"
        ? [c.value.accepting_applications ? "✅ open" : "status unclear", c.value.deadline && `deadline ${c.value.deadline}`, c.value.pay]
            .filter(Boolean)
            .join(" · ")
        : "couldn't open the posting to double-check";
    shown.push(j);
    lines.push(`• ${j.company}: ${j.title} (${j.locations.slice(0, 2).join(", ")})\n  ${detail}\n  ${j.url}`);
  });
  if (!shown.length) return;
  const more = matches.length > top.length ? `+${matches.length - top.length} more matches. Want the list?\n` : "";
  const text = `💼 New internship${shown.length > 1 ? "s" : ""} for you:\n${lines.join("\n")}\n\n${more}❤️ to save to your tracker · 👎 for fewer like this`;
  await deliver(send, user, [say(text, { kind: "internships", jobs: shown.map((j) => j.id), text })]);
}

/** Tracker follow-ups: nudge saved-but-not-applied, catch closed postings, check in after applying. */
async function applicationFollowUps(user: UserState, send: ProactiveSend): Promise<void> {
  let agentChecks = 0;
  for (const app of user.applications) {
    const ref = { kind: "application" as const, appIds: [app.id] };
    if (app.status === "saved") {
      // Re-check with the Agent every 3 days (max 2 per tick) that it's still open.
      if (agentChecks < 2 && Date.now() - (app.lastCheckedAt ?? app.savedAt) > 3 * DAY) {
        agentChecks++;
        app.lastCheckedAt = Date.now();
        save();
        try {
          const prep = await prepApplication(app.url);
          app.prep = prep;
          if (prep.accepting_applications === false) {
            app.status = "closed";
            app.statusAt = Date.now();
            save();
            await deliver(send, user, [say(`Heads up: ${app.company} (${app.title}) stopped accepting applications. I moved it to closed.`, ref)]);
            continue;
          }
          save();
        } catch (err) {
          console.warn(`[scheduler] recheck ${app.company}:`, (err as Error).message);
        }
      }
      if (Date.now() - app.savedAt > 3 * DAY && markSent(user, `app-nudge:${app.id}`)) {
        const deadline = app.prep?.deadline ? ` The deadline is ${app.prep.deadline}.` : "";
        await deliver(send, user, [
          say(
            `Still want to apply to ${app.company} (${app.title})?${deadline} Say "prep ${app.company}" and I'll pull up what the application asks, or "remind me tonight".`,
            ref,
          ),
        ]);
      }
    }
    if (app.status === "applied" && app.appliedAt && Date.now() - app.appliedAt > 14 * DAY && markSent(user, `app-checkin:${app.id}`)) {
      await deliver(send, user, [say(`It's been 2 weeks since you applied to ${app.company}. Any word? Say "interview", "rejected", or "offer" and I'll update your tracker.`, ref)]);
    }
  }
}

/** Reminders the student set. Exact-time, and they ignore quiet hours (the student asked for that time). */
async function dueReminders(users: UserState[], send: ProactiveSend): Promise<void> {
  for (const user of users) {
    for (const r of user.reminders) {
      if (r.done || r.sentAt || r.at > Date.now()) continue;
      r.sentAt = Date.now();
      save();
      const text = `⏰ Reminder: ${r.text}\n\n👍 when it's done, or say "snooze 1h".`;
      await deliver(send, user, [say(text, { kind: "reminder", reminderId: r.id, text })]).catch((err) =>
        console.warn(`[scheduler] reminder for ${user.id}:`, err),
      );
    }
    // Keep the list short: drop reminders finished/sent over a week ago.
    user.reminders = user.reminders.filter((r) => !(r.sentAt && Date.now() - r.sentAt > 7 * DAY));
  }
}

let running = false;

/** One scheduler pass. `users` defaults to everyone reachable over iMessage. */
export async function tick(send: ProactiveSend, users?: UserState[]): Promise<void> {
  if (running) return;
  running = true;
  try {
    const targets = users ?? allUsers().filter((u) => u.onboarding.step === "done" && u.spaceId);
    const meta = internshipCache();
    let listings: Internship[] | null = null;
    if ((users || Date.now() - (meta.lastCheck ?? 0) > INTERNSHIP_CHECK_MS) && targets.some((u) => u.internships.alerts)) {
      meta.lastCheck = Date.now();
      listings = await loadListings().catch((err) => {
        console.warn("[scheduler] internship list:", (err as Error).message);
        return null;
      });
    }
    for (const user of targets) {
      if (isQuiet(user)) continue;
      const jobs: Array<[string, () => Promise<void>]> = [
        ["brief", () => morningBrief(user, send)],
        ["week", () => weekAhead(user, send)],
        ["nudges", () => dueNudges(user, send)],
        ["sites", () => courseSiteChanges(user, send)],
        ["applications", () => applicationFollowUps(user, send)],
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

export async function reminderPass(send: ProactiveSend, users?: UserState[]): Promise<void> {
  await dueReminders(users ?? allUsers().filter((u) => u.onboarding.step === "done" && u.spaceId), send);
}

export function startScheduler(send: ProactiveSend): void {
  console.log(`[scheduler] running every ${Math.round(SCHEDULER_TICK_MS / 1000)}s; reminders every 30s`);
  void tick(send);
  setInterval(() => void tick(send), SCHEDULER_TICK_MS);
  setInterval(() => void reminderPass(send), 30_000);
}
