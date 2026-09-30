// Actions shared by chat tools and tapbacks, so "done with the lab" and a 👍 on the
// reminder behave identically.

import { saveListing } from "./applications.ts";
import { calendarReplies, deadlineItem, eventItem, type CalItem } from "./calendar.ts";
import { upcomingHomework } from "./homework.ts";
import { say, type Reply } from "./reply.ts";
import { getEventById } from "./sources/events.ts";
import { getJobById } from "./sources/jobs.ts";
import { save, type Application, type UserState } from "./store.ts";

/** Mark assignments done. Adds a confetti bubble when that clears the whole week. */
export async function markDone(user: UserState, keys: string[]): Promise<{ marked: string[]; replies: Reply[] }> {
  const { items } = await upcomingHomework(user, 60);
  const marked: string[] = [];
  for (const key of keys) {
    const hit = items.find((a) => a.key === key);
    if (hit && !user.doneAssignments.includes(key)) {
      user.doneAssignments.push(key);
      marked.push(`${hit.course}: ${hit.title}`);
    }
  }
  save();
  const replies: Reply[] = [];
  if (marked.length) {
    const week = await upcomingHomework(user, 7);
    if (week.items.length === 0) {
      replies.push(say("🎉 That's everything due this week. Nothing left. Go enjoy it!", undefined, "confetti"));
    }
  }
  return { marked, replies };
}

/** Build calendar links from real data only: school events, homework, custom items the student gave. */
export async function calendarFor(
  user: UserState,
  opts: { events?: string[]; assignments?: string[]; custom?: CalItem[] },
): Promise<{ replies: Reply[]; added: string[]; missing: number }> {
  const items: CalItem[] = [];
  let missing = 0;
  for (const id of opts.events ?? []) {
    const ev = await getEventById(id).catch(() => undefined);
    if (ev) items.push(eventItem(ev));
    else missing++;
  }
  if (opts.assignments?.length) {
    const { items: hw } = await upcomingHomework(user, 60);
    for (const key of opts.assignments) {
      const a = hw.find((x) => x.key === key);
      if (a) items.push(deadlineItem(a));
      else missing++;
    }
  }
  items.push(...(opts.custom ?? []));
  return { replies: items.length ? calendarReplies(items) : [], added: items.map((i) => i.title), missing };
}

/** Save postings (any source) to the tracker. */
export async function saveJobs(user: UserState, jobIds: string[]): Promise<Application[]> {
  const saved: Application[] = [];
  for (const id of jobIds) {
    const job = await getJobById(id).catch(() => undefined);
    if (job) saved.push(saveListing(user, job).app);
  }
  return saved;
}
