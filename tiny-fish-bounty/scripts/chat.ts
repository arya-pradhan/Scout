// Talk to the bot in your terminal: same logic as iMessage, no phone needed.
//   npm run chat
// Uses a separate state file so it never touches your real iMessage setup.
//
// Extra commands:
//   /react <emoji>   tapback on the most recent bot bubble that can take one (e.g. /react ❤️)
//   /tick            run one scheduler pass now (brief, nudges, alerts, follow-ups)
//   /reminders       send any reminders that are due
process.env.STATE_PATH ??= "data/terminal-state.json";

const { mkdirSync, writeFileSync } = await import("node:fs");
const { createInterface } = await import("node:readline");
const { handleTapback, handleText } = await import("../src/bot.ts");
const { reminderPass, tick } = await import("../src/scheduler.ts");
const { getUser, recordRef, save } = await import("../src/store.ts");
type Reply = import("../src/reply.ts").Reply;

const user = getUser("terminal");
let msgCounter = 0;
let lastRefId: string | undefined;
let lastText: string | undefined;

async function print(replies: Reply[]): Promise<void> {
  for (const r of replies) {
    if ("text" in r) {
      const id = `t${++msgCounter}`;
      const tag = r.effect ? ` [✨ ${r.effect}]` : "";
      console.log(`\nbot${tag} › ${r.text.replace(/\n/g, "\n      ")}\n`);
      if (r.ref) {
        recordRef(user, id, r.ref);
        save();
        lastRefId = id;
      }
      lastText = r.text;
    } else if ("link" in r) console.log(`bot › [link preview] ${r.link}\n`);
    else if ("file" in r) {
      mkdirSync("data", { recursive: true });
      const path = `data/calendar-${Date.now()}.ics`;
      writeFileSync(path, r.file.data);
      console.log(`bot › [📎 ${r.file.name} → saved to ${path}]\n`);
    } else console.log("bot › [contact card]\n");
  }
}

const rl = createInterface({ input: process.stdin });
console.log('Chatting with iRameses (terminal mode). Say "hi" to start, Ctrl+C to quit. Extras: /react <emoji>, /tick, /reminders\n');
process.stdout.write("you › ");

for await (const line of rl) {
  if (!process.stdin.isTTY) console.log(line);
  const react = line.match(/^\/react\s+(\S+)/);
  if (react) {
    if (!lastRefId) console.log("(no bot bubble to react to yet)");
    else await handleTapback(user, react[1]!, lastRefId, lastText, print);
  } else if (line.trim() === "/tick") {
    await tick((_u, replies) => print(replies), [user]);
    console.log("(scheduler pass done)");
  } else if (line.trim() === "/reminders") {
    await reminderPass((_u, replies) => print(replies), [user]);
    console.log("(reminder pass done)");
  } else {
    await handleText(user, line, print);
  }
  process.stdout.write("you › ");
}
