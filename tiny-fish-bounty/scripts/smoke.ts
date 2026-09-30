// Hit each TinyFish endpoint once with real data (plus two schools' public events APIs):
//   npm run smoke            (Search + Fetch, both free)
//   npm run smoke -- --agent (also one Agent run, which uses TinyFish credits)
import { detectEventSource, getEvents } from "../src/sources/events.ts";
import { newUser } from "../src/store.ts";
import { fetchPage, runAgent, search } from "../src/tinyfish.ts";

const t0 = Date.now();
const results = await search("University of Florida student events calendar");
console.log(`Search ✅ ${results.length} results in ${Date.now() - t0}ms`);
for (const r of results.slice(0, 3)) console.log(`  - ${r.title}  ${r.url}`);

for (const url of ["https://gatorconnect.ufl.edu/events", "https://events.stanford.edu/"]) {
  const t1 = Date.now();
  const user = newUser("smoke");
  user.eventSource = await detectEventSource(url);
  const events = await getEvents(user, { limit: 3 });
  console.log(`Events via ${user.eventSource.kind} (${user.eventSource.label}) ✅ ${events.length} in ${Date.now() - t1}ms`);
  for (const e of events) console.log(`  - ${e.name} @ ${e.location}  ${e.url}`);
}

const t2 = Date.now();
const page = await fetchPage("https://github.com/SimplifyJobs/Summer2027-Internships");
console.log(`Fetch (web page) ✅ "${page.title}", ${page.text.length} chars in ${Date.now() - t2}ms`);

if (process.argv.includes("--agent")) {
  const t3 = Date.now();
  const run = await runAgent<{ title: string }>({
    url: "https://events.stanford.edu/",
    goal: "Report the name of the first event listed on the page.",
    outputSchema: { type: "object", properties: { title: { type: "string" } }, required: ["title"] },
    maxDurationSeconds: 60,
  });
  console.log(`Agent ✅ run ${run.runId}: ${JSON.stringify(run.result)} in ${Date.now() - t3}ms`);
} else {
  console.log("(Agent skipped because it uses credits. Run with --agent to test it.)");
}
