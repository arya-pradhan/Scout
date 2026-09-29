// Merge homework from every source the user set up during onboarding.

import type { UserState } from "./store.ts";
import { readCanvasFeed, type Assignment } from "./sources/canvas.ts";
import { readCourseSite } from "./sources/courseSites.ts";

export interface HomeworkResult {
  items: Assignment[];
  /** Sources that failed, named so the bot can say exactly what it couldn't reach. */
  failed: string[];
}

const cache = new Map<string, { at: number; result: HomeworkResult }>();
const CACHE_MS = 15 * 60_000;

async function allHomework(user: UserState, fresh: boolean): Promise<HomeworkResult> {
  const hit = cache.get(user.id);
  if (!fresh && hit && Date.now() - hit.at < CACHE_MS) return hit.result;

  const jobs: Array<Promise<Assignment[]>> = [];
  const labels: string[] = [];
  if (user.canvasIcs) {
    jobs.push(readCanvasFeed(user.canvasIcs));
    labels.push("Canvas");
  }
  for (const course of user.courses) {
    for (const site of course.sites) {
      jobs.push(readCourseSite(site.url, course.code, site.pages).then((r) => r.assignments));
      labels.push(`${course.code} site (${site.label})`);
    }
  }
  const settled = await Promise.allSettled(jobs);
  const items: Assignment[] = [];
  const failed: string[] = [];
  settled.forEach((s, i) => {
    if (s.status === "fulfilled") items.push(...s.value);
    else {
      failed.push(labels[i]!);
      console.warn(`[homework] ${labels[i]} failed:`, s.reason);
    }
  });

  // The same assignment often appears on Canvas and the course site: keep one.
  const seen = new Set<string>();
  const deduped = items
    .sort((a, b) => a.due.localeCompare(b.due))
    .filter((a) => {
      const k = `${a.course}|${a.title.toLowerCase().replace(/[^a-z0-9]/g, "")}|${a.due.slice(0, 10)}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  const result = { items: deduped, failed };
  cache.set(user.id, { at: Date.now(), result });
  return result;
}

/** Upcoming, not-yet-done work due within `days`. */
export async function upcomingHomework(user: UserState, days = 7, fresh = false): Promise<HomeworkResult> {
  const { items, failed } = await allHomework(user, fresh);
  const now = Date.now();
  const until = now + days * 24 * 3600_000;
  const courseCodes = new Set(user.courses.map((c) => c.code));
  return {
    failed,
    items: items.filter((a) => {
      const t = new Date(a.due).getTime();
      if (t < now || t > until) return false;
      if (user.doneAssignments.includes(a.key)) return false;
      // Only courses the user confirmed (Canvas feeds include old/extra calendars).
      return courseCodes.size === 0 || courseCodes.has(a.course) || a.source !== "canvas";
    }),
  };
}

export function clearHomeworkCache(userId: string): void {
  cache.delete(userId);
}
