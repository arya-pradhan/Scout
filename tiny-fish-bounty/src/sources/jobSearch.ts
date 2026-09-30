// A saved web-search watch for new postings in any field ("marketing internships in
// Chicago", "undergrad research positions in neuroscience"). TinyFish Search returns only
// recent results; Claude keeps the ones that are real postings. Claude picks results by
// number, so every link comes straight from the search results and can't be invented.

import { createHash } from "node:crypto";
import { z } from "zod";
import { localDay, MODEL } from "../config.ts";
import { extract } from "../llm.ts";
import { knownJob, rememberJobs, type Job } from "../store.ts";
import { search } from "../tinyfish.ts";

const PickSchema = z.object({
  postings: z.array(
    z.object({
      result: z.number().int().describe("The number of the search result"),
      title: z.string().describe("Position title"),
      company: z.string().describe("Employer, or empty string if unclear"),
      location: z.string().describe("As written, or empty string"),
    }),
  ),
});

const cache = new Map<string, { at: number; jobs: Job[] }>();
const CACHE_MS = 6 * 3600_000;

/** Recent postings matching the query. `fresh` skips the 6-hour cache. */
export async function searchJobs(query: string, fresh = false): Promise<Job[]> {
  const hit = cache.get(query);
  if (!fresh && hit && Date.now() - hit.at < CACHE_MS) return hit.jobs;

  const results = await search(`${query} apply`, {
    recencyMinutes: 3 * 24 * 60,
    purpose: `Find recently posted job or internship openings: ${query}`,
  });
  if (!results.length) {
    cache.set(query, { at: Date.now(), jobs: [] });
    return [];
  }
  const numbered = results.map((r, i) => `[${i + 1}] ${r.title}\n${r.url}\n${r.snippet}`).join("\n\n");
  const { postings } = await extract(
    PickSchema,
    `Today is ${localDay()}. From these search results, keep only the ones that are a specific open position (or a page listing
open positions) matching what the student wants: "${query}". Skip articles, advice posts, salary sites, and closed/expired roles.
Refer to results only by their number.`,
    numbered,
    MODEL,
  );
  const jobs: Job[] = [];
  for (const p of postings) {
    const r = results[p.result - 1];
    if (!r) continue;
    const id = `search:${createHash("sha1").update(r.url).digest("hex").slice(0, 16)}`;
    jobs.push({
      id,
      company: p.company.trim() || new URL(r.url).hostname.replace(/^www\./, ""),
      title: p.title.trim() || r.title,
      category: "",
      locations: p.location ? [p.location] : [],
      sponsorship: "",
      url: r.url,
      postedAt: knownJob(id)?.postedAt ?? new Date().toISOString(),
      source: "search",
    });
  }
  rememberJobs(jobs);
  cache.set(query, { at: Date.now(), jobs });
  return jobs;
}
