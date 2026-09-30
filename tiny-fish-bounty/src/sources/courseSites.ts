// Professor / course websites: found with TinyFish Search, crawled with TinyFish Fetch,
// and turned into dated assignments by Claude. Items without a date are dropped:
// the bot never guesses a deadline.
//
// Deadlines usually live one click deep (Calendar, Deliverables, Assignments...), so each
// read fetches the home page with its links, then the relevant same-site subpages in one
// batch. When that still finds nothing, discoverDeadlinePages() sends the TinyFish Agent
// to browse the site; the pages it finds are saved and crawled directly from then on.

import { createHash } from "node:crypto";
import { z } from "zod";
import { localDay, SITE_MODEL, TIMEZONE } from "../config.ts";
import { extract } from "../llm.ts";
import { fetchPage, fetchPages, runAgent, search, type FetchedPage, type SearchResult } from "../tinyfish.ts";
import type { Course } from "../store.ts";
import type { Assignment } from "./canvas.ts";

const ExtractedSchema = z.object({
  looks_like_course_page: z.boolean().describe("true if these pages are a course site/syllabus/schedule for the given course"),
  items: z.array(
    z.object({
      title: z.string().describe("Assignment/exam/project/deliverable name exactly as written"),
      due: z.string().describe("Due date-time in ISO 8601 with offset, e.g. 2026-10-02T23:59:00-04:00. Use 23:59 local if only a date is given."),
      link: z.string().describe("Absolute URL of the assignment itself if linked, else empty string"),
      found_on: z.string().describe("The PAGE url (from the === PAGE headers) where this item appears"),
    }),
  ),
});

export interface SiteReadResult {
  assignments: Assignment[];
  looksLikeCoursePage: boolean;
  hash: string;
  /** Every page that was read, home page first. */
  pagesRead: string[];
}

const RELEVANT =
  /calendar|schedule|deliverable|assignment|homework|\bhws?\b|hw\d|project|\blabs?\b|syllabus|exam|midterm|final|quiz|\bdue\b|weeks?\b|lecture|problem|pset|sprint|milestone/i;
const MAX_SUBPAGES = 8;
const PER_PAGE_CHARS = 40_000;
const TOTAL_CHARS = 160_000;

/** Pick same-site pages under the course's folder that likely hold deadlines. */
export function pickSubpages(baseUrl: string, links: string[]): string[] {
  const base = new URL(baseUrl);
  const dir = base.pathname.replace(/[^/]*$/, "");
  const relevant: string[] = [];
  const other: string[] = [];
  const seen = new Set([base.href.replace(/#.*$/, "")]);
  for (const raw of links) {
    let u: URL;
    try {
      u = new URL(raw.trim(), base);
    } catch {
      continue;
    }
    u.hash = "";
    if (!/^https?:$/.test(u.protocol) || u.host !== base.host || !u.pathname.startsWith(dir)) continue;
    if (/\.(png|jpe?g|gif|svg|zip|mp4|pptx?|docx?)$/i.test(u.pathname) || seen.has(u.href)) continue;
    seen.add(u.href);
    (RELEVANT.test(u.pathname) ? relevant : other).push(u.href);
  }
  return relevant.length ? relevant.slice(0, MAX_SUBPAGES) : other.slice(0, 4);
}

// Claude only re-reads when the crawled text actually changed; repeat checks of an
// unchanged site cost a couple of free TinyFish Fetches and no tokens.
const extractionCache = new Map<string, { textHash: string; result: SiteReadResult }>();

export async function readCourseSite(url: string, course: string, extraPages: string[] = []): Promise<SiteReadResult> {
  const purpose = `Find homework, projects, deliverables, quizzes and exams with due dates for ${course}`;
  const home = await fetchPage(url, { format: "markdown", ttl: 3600, links: true, purpose });
  const subUrls = [...new Set([...extraPages, ...pickSubpages(url, home.links)])].filter((u) => u !== url).slice(0, MAX_SUBPAGES);
  const subpages: FetchedPage[] = [];
  if (subUrls.length) {
    const { pages, failures } = await fetchPages(subUrls, { format: "markdown", ttl: 3600, purpose });
    subpages.push(...pages);
    for (const f of failures) console.warn(`[courseSite] couldn't read ${f.url}: ${f.error}`);
  }

  let text = "";
  const pagesRead: string[] = [];
  for (const p of [home, ...subpages]) {
    if (text.length >= TOTAL_CHARS) break;
    const pageUrl = p === home ? url : p.url;
    pagesRead.push(pageUrl);
    text += `=== PAGE: ${pageUrl} (${p.title})\n${p.text.slice(0, PER_PAGE_CHARS)}\n\n`;
  }
  text = text.slice(0, TOTAL_CHARS);

  const cacheKey = `${course}|${url}`;
  const textHash = createHash("sha1").update(text).digest("hex");
  const hit = extractionCache.get(cacheKey);
  if (hit?.textHash === textHash) return hit.result;

  const result = await extract(
    ExtractedSchema,
    `You extract deadlines from a university course website for ${course}. Today is ${localDay()} (timezone ${TIMEZONE}).
The input is several pages from the same site, each starting with "=== PAGE: <url>".
Include every assignment, project deliverable, quiz and exam that has a date on the pages.
Dates written without a year belong to the semester shown on the site (e.g. "Fall 2026"). Never invent a date for an item that has none.
Schedules are often a table of class days with items listed under each day. An item marked "EOW" (end of week) is due Friday of that same week at 23:59 local time, not on the class day it's listed under.
Times written in the page text (e.g. "Sept 30, 6pm") are US Eastern: use the -04:00/-05:00 offset.
Exception: the pages were loaded by a browser set to UTC, so a due time the page's JavaScript displayed as an odd hour like 3:59 AM or 4:59 AM is really 11:59 PM Eastern the day before. Output only those with a Z offset exactly as shown (e.g. 2026-09-30T03:59:00Z).
If a site also lists a past semester (e.g. last spring's schedule below this fall's), include only the current semester's items.
Include past items from this semester too; the caller filters by date. Resolve relative links against the page they appear on.`,
    text,
    SITE_MODEL,
  );
  const assignments: Assignment[] = [];
  const seenKeys = new Set<string>();
  for (const item of result.items) {
    const due = new Date(item.due);
    if (Number.isNaN(due.getTime())) continue;
    const key = `site:${course}:${item.title.toLowerCase().replace(/\s+/g, " ").trim()}`;
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    const foundOn = pagesRead.includes(item.found_on) ? item.found_on : url;
    assignments.push({
      key,
      course,
      title: item.title.trim(),
      due: due.toISOString(),
      url: item.link || foundOn,
      source: "course site",
    });
  }
  const read = { assignments, looksLikeCoursePage: result.looks_like_course_page, hash: hashItems(assignments), pagesRead };
  extractionCache.set(cacheKey, { textHash, result: read });
  return read;
}

export function hashItems(items: Assignment[]): string {
  const canon = items.map((a) => `${a.key}|${a.due}`).sort().join("\n");
  return createHash("sha1").update(canon).digest("hex");
}

/**
 * When a crawl finds no deadlines, let the TinyFish Agent browse the site in a real
 * browser (menus, JS navigation, "Assignments" tabs) and report which pages list them.
 * Takes ~1 minute and uses TinyFish credits, so it's only used when adding a site.
 */
export async function discoverDeadlinePages(url: string, course: string): Promise<string[]> {
  const run = await runAgent<{ pages: Array<{ url: string; what: string }> }>({
    url,
    goal: `This is the website for the university course ${course}. Browse it (menus, navigation links, tabs like Calendar, Schedule, Assignments, Deliverables, Homework, Syllabus) and find the pages that list assignments, project deliverables, quizzes or exams WITH due dates.
Report the URL of each such page. Only report pages on this course's own site. Do not log in, and do not submit or fill in anything.`,
    outputSchema: {
      type: "object",
      properties: {
        pages: {
          type: "array",
          items: {
            type: "object",
            properties: { url: { type: "string" }, what: { type: "string", description: "What deadlines the page lists" } },
            required: ["url", "what"],
          },
        },
      },
      required: ["pages"],
    },
    maxSteps: 20,
    maxDurationSeconds: 120,
  });
  const host = new URL(url).host;
  return (run.result?.pages ?? [])
    .map((p) => {
      try {
        return new URL(p.url, url).href;
      } catch {
        return "";
      }
    })
    .filter((u) => u && new URL(u).host === host && u !== url)
    .slice(0, MAX_SUBPAGES);
}

/**
 * Read a site; if nothing dated turns up, send the Agent to find the right pages and
 * read again. Returns the extra pages to save on the site so daily checks include them.
 */
export async function readCourseSiteDeep(
  url: string,
  course: string,
  onDigging?: () => Promise<void>,
): Promise<SiteReadResult & { extraPages: string[] }> {
  const first = await readCourseSite(url, course);
  if (first.assignments.length) return { ...first, extraPages: [] };
  await onDigging?.();
  try {
    const found = await discoverDeadlinePages(url, course);
    const extraPages = found.filter((p) => !first.pagesRead.includes(p));
    if (!extraPages.length) return { ...first, extraPages: [] };
    const second = await readCourseSite(url, course, extraPages);
    return { ...second, extraPages };
  } catch (err) {
    console.warn(`[courseSite] agent discovery failed for ${url}:`, (err as Error).message);
    return { ...first, extraPages: [] };
  }
}

/** Save (or refresh) a site on a course, never duplicating the same URL. */
export function upsertSite(course: Course, url: string, read: SiteReadResult & { extraPages: string[] }): void {
  const existing = course.sites.find((s) => s.url === url);
  const record = {
    url,
    label: new URL(url).hostname,
    pages: [...new Set([...(existing?.pages ?? []), ...read.extraPages])],
    lastHash: read.hash,
    lastChecked: Date.now(),
    knownItems: [...new Set([...(existing?.knownItems ?? []), ...read.assignments.map((a) => a.key)])],
    failures: 0,
  };
  if (existing) Object.assign(existing, record);
  else course.sites.push(record);
}

/** "find it": search the web for a course's own site (outside Canvas). */
export async function findCourseSite(course: string, school = "UNC Chapel Hill"): Promise<SearchResult[]> {
  const year = new Date().getFullYear();
  const results = await search(`${school} ${course} ${year} course website schedule assignments`, {
    purpose: `Find the public course website or schedule page for ${course} at ${school}, not Canvas`,
  });
  return results.filter((r) => !/canvas\.|instructure\.com|coursicle|ratemyprofessors|reddit\.com/i.test(r.url)).slice(0, 3);
}
