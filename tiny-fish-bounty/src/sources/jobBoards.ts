// Job boards and careers pages the student asked Scout to watch (any field): a department
// job board, a company careers page, a nonprofit board... Greenhouse/Lever/Ashby careers
// pages are read from their public JSON. Any other page: TinyFish Fetch reads it and Claude
// lists the postings, and boards that only render in a real browser (JS-heavy, "load more"
// buttons) fall back to the TinyFish Agent. Login-only sites (e.g. Handshake) can't be
// read, and onboarding says so.

import { createHash } from "node:crypto";
import { z } from "zod";
import { localDay, SITE_MODEL } from "../config.ts";
import { extract } from "../llm.ts";
import { knownJob, rememberJobs, type Job, type JobBoard } from "../store.ts";
import { fetchPage, runAgent } from "../tinyfish.ts";

const PostingsSchema = z.object({
  looks_like_job_board: z.boolean().describe("true if the page lists job, internship, fellowship or research positions"),
  postings: z.array(
    z.object({
      title: z.string(),
      company: z.string().describe("Employer; use the site's organization if the page is one company's careers page"),
      location: z.string().describe("As written, or empty string"),
      link: z.string().describe("Absolute URL of this posting if the page links to it, else empty string"),
    }),
  ),
});

const cache = new Map<string, { textHash: string; jobs: Job[]; looksLikeBoard: boolean }>();

function toJobs(url: string, postings: Array<{ title: string; company: string; location: string; link: string; posted?: string }>): Job[] {
  const out: Job[] = [];
  for (const p of postings) {
    if (!p.title.trim()) continue;
    let link = url;
    try {
      if (p.link) link = new URL(p.link, url).href;
    } catch {
      /* keep the board URL */
    }
    const id = `board:${createHash("sha1").update(`${link}|${p.title}|${p.company}`).digest("hex").slice(0, 16)}`;
    out.push({
      id,
      company: p.company.trim() || new URL(url).hostname,
      title: p.title.trim(),
      category: "",
      locations: p.location ? [p.location] : [],
      sponsorship: "",
      url: link,
      // The board's own post date when it has one; otherwise the first time Scout saw it.
      postedAt: knownJob(id)?.postedAt ?? (p.posted && !Number.isNaN(Date.parse(p.posted)) ? new Date(p.posted).toISOString() : new Date().toISOString()),
      source: "board",
    });
  }
  rememberJobs(out);
  return out;
}

// ---------- Company careers pages on Greenhouse / Lever / Ashby ----------
// These applicant-tracking systems power many company careers pages and publish every
// posting as public JSON, so they're read directly: faster, exact, and no Agent credits.

type Posting = { title: string; company: string; location: string; link: string; posted?: string };

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`${new URL(url).host} returned HTTP ${res.status}`);
  return res.json();
}

function atsReader(url: string): (() => Promise<Posting[]>) | null {
  const u = new URL(url);
  const slug = u.pathname.split("/").filter(Boolean)[0];
  if (!slug) return null;
  if (/^(job-boards|boards)\.greenhouse\.io$/.test(u.hostname)) {
    return async () => {
      const [board, data] = await Promise.all([
        getJson(`https://boards-api.greenhouse.io/v1/boards/${slug}`).catch(() => ({})) as Promise<{ name?: string }>,
        getJson(`https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`) as Promise<{
          jobs?: Array<{ title: string; absolute_url: string; location?: { name?: string }; first_published?: string; updated_at?: string }>;
        }>,
      ]);
      return (data.jobs ?? []).map((j) => ({
        title: j.title,
        company: board.name ?? slug,
        location: j.location?.name ?? "",
        link: j.absolute_url,
        posted: j.first_published,
      }));
    };
  }
  if (u.hostname === "jobs.lever.co") {
    return async () => {
      const data = (await getJson(`https://api.lever.co/v0/postings/${slug}?mode=json`)) as Array<{
        text: string;
        hostedUrl: string;
        categories?: { location?: string };
        createdAt?: number;
      }>;
      return data.map((j) => ({
        title: j.text,
        company: slug,
        location: j.categories?.location ?? "",
        link: j.hostedUrl,
        posted: j.createdAt ? new Date(j.createdAt).toISOString() : undefined,
      }));
    };
  }
  if (u.hostname === "jobs.ashbyhq.com") {
    return async () => {
      const data = (await getJson(`https://api.ashbyhq.com/posting-api/job-board/${slug}`)) as {
        jobs?: Array<{ title: string; jobUrl: string; location?: string; publishedAt?: string }>;
      };
      return (data.jobs ?? []).map((j) => ({ title: j.title, company: slug, location: j.location ?? "", link: j.jobUrl, posted: j.publishedAt }));
    };
  }
  return null;
}

/**
 * Read a board. Greenhouse/Lever/Ashby careers pages come from their public JSON; any other
 * page is read with TinyFish Fetch + Claude (Claude only runs when the page text changed).
 */
export async function readJobBoard(url: string): Promise<{ jobs: Job[]; looksLikeBoard: boolean }> {
  const ats = atsReader(url);
  if (ats) {
    const postings = await ats();
    return { jobs: toJobs(url, postings), looksLikeBoard: true };
  }
  return readJobBoardPage(url);
}

async function readJobBoardPage(url: string): Promise<{ jobs: Job[]; looksLikeBoard: boolean }> {
  const page = await fetchPage(url, { format: "markdown", ttl: 3600, purpose: "List the job and internship postings on this page" });
  const text = page.text.slice(0, 120_000);
  const textHash = createHash("sha1").update(text).digest("hex");
  const hit = cache.get(url);
  if (hit?.textHash === textHash) return hit;

  const r = await extract(
    PostingsSchema,
    `You list the open positions on a job board or careers page. Today is ${localDay()}.
Include every job, internship, co-op, fellowship or research position listed. Never invent postings.
Resolve relative links against ${url}.`,
    `Page URL: ${url}\nPage title: ${page.title}\n\n${text}`,
    SITE_MODEL,
  );
  const result = { textHash, jobs: toJobs(url, r.postings), looksLikeBoard: r.looks_like_job_board };
  cache.set(url, result);
  return result;
}

/** For boards Fetch can't read: the TinyFish Agent browses it like a person would. Read-only. */
export async function readJobBoardWithAgent(url: string): Promise<Job[]> {
  const run = await runAgent<{ postings: Array<{ title: string; company: string; location: string; link: string }> }>({
    url,
    goal: `This is a job board or careers page. List the open job, internship, co-op, fellowship or research postings shown (up to 30).
Scroll and click "load more" or the next page once if needed. For each, give the title, employer, location, and the link to the posting.
Do not sign in, create accounts, apply, or fill in any form. Only read.`,
    outputSchema: {
      type: "object",
      properties: {
        postings: {
          type: "array",
          items: {
            type: "object",
            properties: {
              title: { type: "string" },
              company: { type: "string" },
              location: { type: "string" },
              link: { type: "string" },
            },
            required: ["title", "company", "location", "link"],
          },
        },
      },
      required: ["postings"],
    },
    maxDurationSeconds: 150,
  });
  return toJobs(url, run.result?.postings ?? []);
}

/** Check a saved board the way it was set up (Fetch, or the Agent for JS-heavy boards). */
export async function checkBoard(board: JobBoard): Promise<Job[]> {
  return board.mode === "agent" ? readJobBoardWithAgent(board.url) : (await readJobBoard(board.url)).jobs;
}

/**
 * Used when a student adds a board: try Fetch first; if that finds no postings, send the
 * Agent. Returns the mode to save so future checks use what worked.
 */
export async function readJobBoardDeep(url: string, onDigging?: () => Promise<void>): Promise<{ jobs: Job[]; mode: JobBoard["mode"] }> {
  // Boards that render in the browser often come back empty from Fetch ("empty_content").
  const first = await readJobBoard(url).catch((err) => {
    console.warn(`[jobBoard] fetch failed for ${url}, trying the Agent:`, (err as Error).message);
    return { jobs: [] as Job[], looksLikeBoard: false };
  });
  if (first.jobs.length) return { jobs: first.jobs, mode: "fetch" };
  await onDigging?.();
  const jobs = await readJobBoardWithAgent(url).catch((err) => {
    console.warn(`[jobBoard] agent failed for ${url}:`, (err as Error).message);
    return [] as Job[];
  });
  return { jobs, mode: jobs.length ? "agent" : "fetch" };
}
