import { blockedRequests } from "../setup.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { handleTapback, handleText, type Reply } from "../../src/bot.ts";
import { handleOnboarding, profileSummary } from "../../src/onboarding.ts";
import { getUser } from "../../src/store.ts";

const texts = (replies: Reply[]) => replies.map((r) => ("text" in r ? r.text : "")).join("\n---\n");

/** Send texts as the student; collect everything Scout sends back. */
async function converse(id: string, messages: string[]): Promise<Reply[][]> {
  const user = getUser(id);
  const out: Reply[][] = [];
  for (const m of messages) {
    const got: Reply[] = [];
    await handleText(user, m, async (r) => void got.push(...r));
    out.push(got);
  }
  return out;
}

test("a brand-new number gets the intro and Scout's contact card, whatever they text", async () => {
  const [first] = await converse("+15551110000", ["yo what is this"]);
  assert.match(texts(first!), /I'm Scout/);
  assert.ok(first!.some((r) => "contactCard" in r));
  assert.equal(getUser("+15551110000").onboarding.step, "intro");
});

test("full setup using only answers that need no Claude, ending in a first brief", async () => {
  const id = "+15551112222";
  const replies = await converse(id, [
    "hi",
    "Maya", // name
    "skip", // school
    "https://example.edu/not-a-feed", // bad Canvas link
    "skip", // Canvas
    "skip", // courses → no courses, so course sites are skipped too
    "skip", // events source (skips the interests question)
    "none", // jobs (skips the job boards question)
    "default", // brief time
  ]);
  const all = replies.map(texts);
  assert.match(all[1]!, /Nice to meet you, Maya/);
  assert.match(all[1]!, /Step 1 of 7: What school/);
  assert.match(all[3]!, /doesn't look like a Canvas calendar feed/);
  assert.match(all[5]!, /Step 5 of 7: Campus events/, "no courses → straight to events");
  assert.match(all[7]!, /No job alerts/);
  assert.match(all[7]!, /Step 7 of 7/);
  assert.match(all[8]!, /All set/);
  assert.ok(replies[8]!.some((r) => "effect" in r && r.effect === "confetti"), "confetti on finish");
  assert.match(all[8]!, /Nothing due in the next 48h|Here's your day/, "first brief sent");

  const user = getUser(id);
  assert.equal(user.onboarding.step, "done");
  assert.equal(user.internships.alerts, false);
  assert.ok(user.internshipsSince);
  assert.equal(blockedRequests.length, 0, `no network was needed: ${blockedRequests.join(", ")}`);
});

test("course list 'yes' confirms detected courses and walks each course site", async () => {
  const user = getUser("+15551113333");
  user.onboarding = { step: "courses", courseIndex: 0, started: true, pending: { detected: ["BIO 101", "ECON 310"] } };
  const r1 = await handleOnboarding(user, "yes");
  assert.deepEqual(user.courses.map((c) => c.code), ["BIO 101", "ECON 310"]);
  assert.match(texts(r1.replies), /Course sites \(1\/2\)[\s\S]*BIO 101/);
  const r2 = await handleOnboarding(user, "skip");
  assert.match(texts(r2.replies), /Course sites \(2\/2\)[\s\S]*ECON 310/);
  const r3 = await handleOnboarding(user, "next");
  assert.match(texts(r3.replies), /Where does your school post events/);
});

test("help, back and restart work at any step", async () => {
  const user = getUser("+15551114444");
  user.onboarding = { step: "canvas", courseIndex: 0, started: true };
  assert.match(texts((await handleOnboarding(user, "help")).replies), /skip \/ back \/ restart[\s\S]*Canvas/);
  await handleOnboarding(user, "back");
  assert.equal(user.onboarding.step, "school");
  await handleOnboarding(user, "restart");
  assert.equal(user.onboarding.step, "intro");
});

test("progress is saved after every step, so setup resumes after a restart", async () => {
  const id = "+15551115555";
  await converse(id, ["hi", "Jordan", "skip"]);
  const saved = JSON.parse(readFileSync(process.env.STATE_PATH!, "utf8"));
  assert.equal(saved.users[id].onboarding.step, "canvas");
  assert.equal(saved.users[id].name, "Jordan");
});

test("quick commands after setup don't need Claude", async () => {
  const id = "+15551116666";
  await converse(id, ["hi", "Sam", "skip", "skip", "skip", "skip", "none", "default"]);
  const before = blockedRequests.length;
  const [settings, apps, week] = await converse(id, ["settings", "apps", "my week"]);
  assert.match(texts(settings!), /Your setup, Sam[\s\S]*Jobs: alerts off/);
  assert.match(texts(apps!), /tracker is empty/);
  assert.match(texts(week!), /week looks clear/);
  assert.equal(blockedRequests.length, before);
  assert.match(profileSummary(getUser(id)), /Events: no events source yet/);
});

test("'reset' starts setup over", async () => {
  const id = "+15551117777";
  await converse(id, ["hi", "Lee", "skip", "skip", "skip", "skip", "none", "default"]);
  const [reset] = await converse(id, ["reset"]);
  assert.match(texts(reset!), /I'm Scout/);
  assert.equal(getUser(id).onboarding.step, "intro");
});

test("tapbacks during setup are ignored", async () => {
  const user = getUser("+15551118888");
  user.onboarding = { step: "canvas", courseIndex: 0, started: true };
  const got: Reply[] = [];
  await handleTapback(user, "❤️", "m1", "hi", async (r) => void got.push(...r));
  assert.equal(got.length, 0);
});
