// Talk to the bot in your terminal: same logic as iMessage, no phone needed.
//   npm run chat
// Uses a separate state file so it never touches your real iMessage setup.
process.env.STATE_PATH ??= "data/terminal-state.json";

const { createInterface } = await import("node:readline");
const { handleText } = await import("../src/bot.ts");
const { getUser } = await import("../src/store.ts");

const user = getUser("terminal");
const rl = createInterface({ input: process.stdin });
console.log('Chatting with Heel Buddy (terminal mode). Say "hi" to start, Ctrl+C to quit.\n');
process.stdout.write("you › ");

for await (const line of rl) {
  if (!process.stdin.isTTY) console.log(line);
  await handleText(user, line, async (replies) => {
    for (const r of replies) {
      if ("text" in r) console.log(`\nbot › ${r.text.replace(/\n/g, "\n      ")}\n`);
      else if ("link" in r) console.log(`bot › [link preview] ${r.link}\n`);
      else console.log("bot › [contact card]\n");
    }
  });
  process.stdout.write("you › ");
}
