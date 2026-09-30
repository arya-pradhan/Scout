// Jobs and internships for any field, from three kinds of sources:
//   - the Simplify Summer internship list (tech roles only: SWE, data, quant, PM, hardware)
//   - job boards / careers pages the student added (./jobBoards.ts)
//   - a web-search watch built from what they said they want (./jobSearch.ts)
// Any posting can be verified live with the TinyFish Agent (verifyPosting).
//
// Simplify's listings.json is a ~13MB raw data file, so it's pulled directly (with ETag
// caching). The web work that matters is done by TinyFish.

import { internshipCache, knownJob, rememberJobs, save, type InternshipPrefs, type Job, type UserState } from "../store.ts";
import { runAgent } from "../tinyfish.ts";
import { checkBoard } from "./jobBoards.ts";
import { searchJobs } from "./jobSearch.ts";

export type { Job };

const LISTINGS_URL =
  process.env.SIMPLIFY_LISTINGS_URL ?? "https://raw.githubusercontent.com/SimplifyJobs/Summer2027-Internships/dev/.github/scripts/listings.json";
const TERM = process.env.INTERNSHIP_TERM ?? "Summer 2027";

/** Simplify categories, offered when a student wants tech roles. */
export const SIMPLIFY_ROLES = ["Software", "AI/ML/Data", "Quant", "Product", "Hardware"] as const;

let cached: Job[] = [];

export async function loadListings(): Promise<Job[]> {
  const meta = internshipCache();
  const headers: Record<string, string> = {};
  if (meta.etag && cached.length) headers["If-None-Match"] = meta.etag;
  const res = await fetch(LISTINGS_URL, { headers, signal: AbortSignal.timeout(60_000) });
  if (res.status === 304) return cached;
  if (!res.ok) throw new Error(`GitHub returned HTTP ${res.status} for the Simplify list`);

  const raw = (await res.json()) as Array<Record<string, unknown>>;
  cached = raw
    .filter((l) => l.active === true && l.is_visible !== false)
    .filter((l) => ((l.terms as string[] | undefined) ?? []).some((t) => t.includes(TERM)))
    .map(
      (l): Job => ({
        id: String(l.id),
        company: String(l.company_name ?? ""),
        title: String(l.title ?? ""),
        category: String(l.category ?? ""),
        locations: (l.locations as string[] | undefined) ?? [],
        sponsorship: String(l.sponsorship ?? "Other"),
        url: String(l.url ?? ""),
        postedAt: new Date(Number(l.date_posted ?? 0) * 1000).toISOString(),
        source: "simplify",
      }),
    )
    .sort((a, b) => b.postedAt.localeCompare(a.postedAt));
  meta.etag = res.headers.get("etag") ?? undefined;
  meta.lastCheck = Date.now();
  save();
  return cached;
}

/** A posting shown earlier (any source), for tapbacks and the tracker. */
export async function getJobById(id: string): Promise<Job | undefined> {
  const hit = knownJob(id);
  if (hit) return hit;
  if (/^(board|search):/.test(id)) return undefined;
  const job = (await loadListings()).find((j) => j.id === id);
  if (job) rememberJobs([job]);
  return job;
}

/**
 * Does a posting fit the student's preferences? Simplify's role categories only apply to
 * Simplify listings; board/search postings were already chosen for this student.
 */
export function matchesPrefs(job: Job, prefs: InternshipPrefs, query?: string): boolean {
  const hay = `${job.company} ${job.title} ${job.category} ${job.locations.join(" ")}`.toLowerCase();
  if ((prefs.excludeCompanies ?? []).some((c) => c.toLowerCase() === job.company.toLowerCase())) return false;
  if (query && !query.toLowerCase().split(/\s+/).every((w) => hay.includes(w))) return false;
  if (job.source === "simplify" && prefs.roles.length) {
    const cat = job.category.toLowerCase();
    if (!prefs.roles.some((r) => cat.includes(r.toLowerCase()) || hay.includes(r.toLowerCase()))) return false;
  }
  // Company boards list every role; keep the ones that fit what the student asked for.
  if (job.source === "board") {
    const title = job.title.toLowerCase();
    if (prefs.internshipOnly && !/intern|co-?op|fellow|apprentice|summer|trainee|student|research assistant/.test(title)) return false;
    if (prefs.keywords.length && !prefs.keywords.some((k) => title.includes(k.toLowerCase()))) return false;
  }
  if (prefs.needsSponsorship && /does not offer|u\.s\. citizenship/i.test(job.sponsorship)) return false;
  if (prefs.locations.length && job.locations.length) {
    const locs = job.locations.join(" ").toLowerCase();
    const remote = locs.includes("remote");
    const inPlace = prefs.locations.some((p) => locs.includes(p.toLowerCase()));
    if (!inPlace && !(prefs.remoteOk && remote)) return false;
  }
  return true;
}

export interface CollectResult {
  jobs: Job[];
  /** Sources that failed, named so the bot can say exactly what it couldn't reach. */
  failed: string[];
}

/** Postings from every source the student set up, newest first. */
export async function collectJobs(user: UserState, opts: { freshSearch?: boolean } = {}): Promise<CollectResult> {
  const prefs = user.internships;
  const jobs: Job[] = [];
  const failed: string[] = [];
  const tasks: Array<[string, Promise<Job[]>]> = [];
  if (prefs.simplify) tasks.push(["the Simplify list", loadListings()]);
  for (const board of prefs.boards) tasks.push([board.label, checkBoard(board)]);
  if (prefs.searchQuery) tasks.push(["web search", searchJobs(prefs.searchQuery, opts.freshSearch)]);
  const settled = await Promise.allSettled(tasks.map(([, p]) => p));
  settled.forEach((s, i) => {
    if (s.status === "fulfilled") jobs.push(...s.value);
    else {
      failed.push(tasks[i]![0]);
      console.warn(`[jobs] ${tasks[i]![0]} failed:`, s.reason);
    }
  });
  const seen = new Set<string>();
  const unique = jobs.filter((j) => (seen.has(j.url) ? false : (seen.add(j.url), true)));
  return { jobs: unique.sort((a, b) => b.postedAt.localeCompare(a.postedAt)), failed };
}

export function jobSourcesSummary(prefs: InternshipPrefs): string {
  const parts: string[] = [];
  if (prefs.simplify) parts.push("Simplify tech list");
  if (prefs.boards.length) parts.push(`${prefs.boards.length} job board${prefs.boards.length === 1 ? "" : "s"}`);
  if (prefs.searchQuery) parts.push(`web search for "${prefs.searchQuery}"`);
  return parts.join(" + ") || "none";
}

export interface PostingCheck {
  accepting_applications: boolean | null;
  deadline: string;
  location: string;
  pay: string;
  requirements: string[];
  notes: string;
  runId: string;
}

/** TinyFish Agent opens the real posting and reports back. Never clicks apply. */
export async function verifyPosting(url: string): Promise<PostingCheck> {
  const run = await runAgent<Omit<PostingCheck, "runId">>({
    url,
    goal: `This is a job or internship posting. Read it (expand "show more" or scroll if needed) and report:
whether it is still accepting applications (look for "no longer accepting", "position filled", 404/expired pages, or a working Apply button),
the application deadline if stated, location(s), pay/salary if stated, and the 3-5 most important requirements.
Do NOT click Apply, do NOT sign in, do NOT fill in or submit any form. If you can't tell, set accepting_applications to null.`,
    outputSchema: {
      type: "object",
      properties: {
        accepting_applications: { type: "boolean", nullable: true },
        deadline: { type: "string", description: "Deadline as written, or empty string" },
        location: { type: "string" },
        pay: { type: "string", description: "Pay as written, or empty string" },
        requirements: { type: "array", items: { type: "string" } },
        notes: { type: "string", description: "Anything blocking, e.g. captcha or login wall" },
      },
      required: ["accepting_applications", "deadline", "location", "pay", "requirements", "notes"],
    },
    maxSteps: 15,
    maxDurationSeconds: 90,
  });
  const r = run.result;
  if (!r) throw new Error("the agent finished without reading the posting");
  // COMPLETED doesn't mean the goal succeeded.
  if (/captcha|blocked|access denied/i.test(r.notes ?? "")) r.accepting_applications = null;
  return { ...r, runId: run.runId };
}
