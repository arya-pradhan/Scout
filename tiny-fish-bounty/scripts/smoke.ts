// Hit each TinyFish endpoint once with real data (plus the HeelLife feed):
//   npm run smoke            (Search + Fetch, both free)
//   npm run smoke -- --agent (also one Agent run, which uses TinyFish credits)
import { fetchPage, runAgent, search } from "../src/tinyfish.ts";
import { getEvents } from "../src/sources/events.ts";

const t0 = Date.now();
const results = await search("UNC Chapel Hill COMP 211 course website");
console.log(`Search ✅ ${results.length} results in ${Date.now() - t0}ms`);
for (const r of results.slice(0, 3)) console.log(`  - ${r.title}  ${r.url}`);

const t1 = Date.now();
const events = await getEvents({ limit: 3 });
console.log(`HeelLife API (direct) ✅ ${events.length} events in ${Date.now() - t1}ms`);
for (const e of events) console.log(`  - ${e.name} @ ${e.location}  ${e.url}`);

const t2 = Date.now();
const page = await fetchPage("https://github.com/SimplifyJobs/Summer2027-Internships");
console.log(`Fetch (web page) ✅ "${page.title}", ${page.text.length} chars in ${Date.now() - t2}ms`);

if (process.argv.includes("--agent")) {
  const t3 = Date.now();
  const run = await runAgent<{ title: string }>({
    url: "https://heellife.unc.edu/events",
    goal: "Report the name of the first event listed on the page.",
    outputSchema: { type: "object", properties: { title: { type: "string" } }, required: ["title"] },
    maxSteps: 8,
    maxDurationSeconds: 60,
  });
  console.log(`Agent ✅ run ${run.runId}: ${JSON.stringify(run.result)} in ${Date.now() - t3}ms`);
} else {
  console.log("(Agent skipped because it uses credits. Run with --agent to test it.)");
}
