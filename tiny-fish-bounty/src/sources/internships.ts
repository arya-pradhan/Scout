// Internships from SimplifyJobs/Summer2027-Internships, verified live with TinyFish Agent.
//
// The repo's listings.json is a ~13MB raw data file, so it's pulled directly (with ETag
// caching). The web work that matters is done by TinyFish: the Agent opens the real
// application page (Workday, Greenhouse, ...) and confirms it's still accepting applications.

import { internshipCache, save, type InternshipPrefs } from "../store.ts";
import { runAgent } from "../tinyfish.ts";

const LISTINGS_URL =
  "https://raw.githubusercontent.com/SimplifyJobs/Summer2027-Internships/dev/.github/scripts/listings.json";
const TERM = process.env.INTERNSHIP_TERM ?? "Summer 2027";

export interface Internship {
  id: string;
  company: string;
  title: string;
  category: string;
  locations: string[];
  sponsorship: string;
  url: string;
  postedAt: string;
}

let cached: Internship[] = [];

export async function getListing(id: string): Promise<Internship | undefined> {
  return (await loadListings()).find((j) => j.id === id);
}

export async function loadListings(): Promise<Internship[]> {
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
    .map((l) => ({
      id: String(l.id),
      company: String(l.company_name ?? ""),
      title: String(l.title ?? ""),
      category: String(l.category ?? ""),
      locations: (l.locations as string[] | undefined) ?? [],
      sponsorship: String(l.sponsorship ?? "Other"),
      url: String(l.url ?? ""),
      postedAt: new Date(Number(l.date_posted ?? 0) * 1000).toISOString(),
    }))
    .sort((a, b) => b.postedAt.localeCompare(a.postedAt));
  meta.etag = res.headers.get("etag") ?? undefined;
  meta.lastCheck = Date.now();
  save();
  return cached;
}

export function matchesPrefs(job: Internship, prefs: InternshipPrefs, query?: string): boolean {
  const hay = `${job.company} ${job.title} ${job.category}`.toLowerCase();
  if ((prefs.excludeCompanies ?? []).some((c) => c.toLowerCase() === job.company.toLowerCase())) return false;
  if (query && !query.toLowerCase().split(/\s+/).every((w) => hay.includes(w))) return false;
  if (prefs.roles.length && !prefs.roles.some((r) => job.category.toLowerCase().includes(r.toLowerCase()) || hay.includes(r.toLowerCase()))) {
    return false;
  }
  if (prefs.needsSponsorship && /does not offer|u\.s\. citizenship/i.test(job.sponsorship)) return false;
  if (prefs.locations.length) {
    const locs = job.locations.join(" ").toLowerCase();
    const remote = locs.includes("remote");
    const inPlace = prefs.locations.some((p) => locs.includes(p.toLowerCase()));
    if (!inPlace && !(prefs.remoteOk && remote)) return false;
  }
  return true;
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
    goal: `This is an internship job posting. Read it (expand "show more" or scroll if needed) and report:
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
