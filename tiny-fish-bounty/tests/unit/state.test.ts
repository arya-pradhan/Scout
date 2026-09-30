import "../setup.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { handleReaction, normalizeTapback } from "../../src/reactions.ts";
import type { Reply } from "../../src/reply.ts";
import { getUser, knownJob, markSent, recordRef, rememberJobs, resetUser, save } from "../../src/store.ts";

const texts = (replies: Reply[]) => replies.map((r) => ("text" in r ? r.text : "")).join("\n");

test("new students start with safe defaults", () => {
  const u = getUser("+15550001111");
  assert.equal(u.onboarding.step, "intro");
  assert.equal(u.internships.simplify, false);
  assert.deepEqual(u.internships.boards, []);
  assert.equal(u.school, undefined);
  assert.equal(u.eventSource, undefined);
});

test("state is saved to the (temp) state file, never data/state.json", () => {
  const u = getUser("+15550002222");
  u.name = "Test";
  save();
  const saved = JSON.parse(readFileSync(process.env.STATE_PATH!, "utf8"));
  assert.equal(saved.users["+15550002222"].name, "Test");
  assert.doesNotMatch(process.env.STATE_PATH!, /data[\\/]state\.json$/);
});

test("reset keeps the chat id so Scout can still text them", () => {
  const u = getUser("+15550003333");
  u.spaceId = "chat-1";
  u.name = "Old";
  const fresh = resetUser("+15550003333");
  assert.equal(fresh.spaceId, "chat-1");
  assert.equal(fresh.name, undefined);
});

test("message refs are capped at 150 and proactive texts are deduped", () => {
  const u = getUser("+15550004444");
  for (let i = 0; i < 200; i++) recordRef(u, `m${i}`, { kind: "text" });
  assert.equal(Object.keys(u.messageRefs).length, 150);
  assert.ok(u.messageRefs.m199 && !u.messageRefs.m0);
  assert.equal(markSent(u, "nudge:1"), true);
  assert.equal(markSent(u, "nudge:1"), false);
});

test("tapbacks arrive as emoji or names", () => {
  assert.equal(normalizeTapback("❤️"), "love");
  assert.equal(normalizeTapback("love"), "love");
  assert.equal(normalizeTapback("👍🏽"), "like");
  assert.equal(normalizeTapback("disliked"), "dislike");
  assert.equal(normalizeTapback("❓"), "question");
  assert.equal(normalizeTapback("🎉"), "other");
});

test("👍 on a reminder completes it", async () => {
  const u = getUser("+15550005555");
  u.reminders.push({ id: "r1", text: "email prof", at: Date.now(), createdAt: Date.now(), sentAt: Date.now() });
  const sent: Reply[] = [];
  await handleReaction(u, "👍", { kind: "reminder", reminderId: "r1" }, undefined, async (r) => void sent.push(...r));
  assert.equal(u.reminders[0]!.done, true);
  assert.match(texts(sent), /checked off/);
});

test("❤️ on a posting saves it to the tracker; 👎 mutes the company", async () => {
  const u = getUser("+15550006666");
  rememberJobs([
    {
      id: "board:abc",
      company: "Acme",
      title: "Marketing Intern",
      category: "",
      locations: ["Chicago"],
      sponsorship: "",
      url: "https://acme.com/1",
      postedAt: new Date().toISOString(),
      source: "board",
    },
  ]);
  assert.ok(knownJob("board:abc"));
  const sent: Reply[] = [];
  const send = async (r: Reply[]) => void sent.push(...r);
  await handleReaction(u, "❤️", { kind: "internships", jobs: ["board:abc"] }, undefined, send);
  assert.equal(u.applications.length, 1);
  assert.equal(u.applications[0]!.company, "Acme");
  assert.match(texts(sent), /Saved Acme/);

  await handleReaction(u, "👎", { kind: "internships", jobs: ["board:abc"] }, undefined, send);
  assert.deepEqual(u.internships.excludeCompanies, ["Acme"]);
});

test("👍 on an ordinary chat reply does nothing (it probably means thanks)", async () => {
  const u = getUser("+15550007777");
  const sent: Reply[] = [];
  await handleReaction(u, "👍", { kind: "chat", assignments: ["canvas:1"], text: "here's what's due" }, undefined, async (r) => void sent.push(...r));
  assert.equal(sent.length, 0);
  assert.deepEqual(u.doneAssignments, []);
});
