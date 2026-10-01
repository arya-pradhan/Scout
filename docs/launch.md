# Scout launch kit

Everything for the submission: the 60-second demo script, the posts, and the checklist.

- Repo: https://github.com/arya-pradhan/tiny-fish-iMessage-Assistant
- Site: _your Vercel URL_
- Tags: TinyFish → X **@Tiny_Fish**, LinkedIn **TinyFish** (linkedin.com/company/tinyfish-ai) · Photon → X **@photon_hq**, LinkedIn **Photon** (linkedin.com/company/photon-framework)

---

## Recording the 60-second demo

**The plan:** record the iPhone screen and the laptop terminal at the same time, put them side by side in Clipchamp (it comes with Windows 11), and export one 1080p mp4. Upload that file **natively** to LinkedIn and X, and to **YouTube as Unlisted** for the site, the README and the submission.

The terminal shows what Scout is doing live: `[in]` your text (phone number masked), `[scout] tool …` (which tool Claude picked), and `[tinyfish] search/fetch/agent …` (the real web work, with timings).

### 1. Set up (10 minutes, once)
**Phone**
- [ ] **Save Scout as a contact,** so the thread header says "Scout" and not the number. Use the contact card Scout sent during onboarding (tap it → Create New Contact). If you can, use `site/static/fedora_companion.svg` exported as a PNG for its photo.
- [ ] **Turn on a Focus that only lets Scout through:** Settings → Focus → Do Not Disturb → People → Allow notifications from: Scout. Turn it on before you record.
- [ ] **Use light mode and a bigger text size.** Charge to over 50% so the battery icon isn't red.
- [ ] **Don't scroll up in the thread** while recording: the onboarding messages higher up include your Canvas feed link. Send a few messages first so they're off screen.
- [ ] **Add Screen Recording to Control Center:** Settings → Control Center → Screen Recording.

**Laptop**
- [ ] **Start Scout:** in `tiny-fish-bounty`, run `npm run dev`.
- [ ] **Make the terminal big:** press Ctrl + = a few times in the terminal window and maximize it. Close other windows and notifications.
- [ ] **Do one full dry run off camera** (the texts below) to check every reply works, then delete nothing. Real data is fine.

### 2. Record (about 8 minutes of real time, cut down to 60s)
1. Laptop: press **Win + Alt + R** with the terminal focused (Xbox Game Bar records that window). Or open Snipping Tool → Record → select the terminal.
2. Phone: Control Center → **Screen Recording**, then open the Scout thread.
3. Send these texts **in order**. Wait for each reply to finish before sending the next, and pause about 2 seconds on each reply so it's readable.

| # | Do this on the phone | What you'll see | Terminal shows | Caption in the edit |
|---|---|---|---|---|
| 1 | Text: **remind me in 2 minutes to start the essay** | "⏰ Got it, I'll text you at …" | `[scout] tool set_reminder` | "You text Scout like a friend" |
| 2 | Text: **what's due this week?** | Dated items with the professor's site link | `[scout] tool get_homework`, `[tinyfish] fetch … pages from <course site>` | "TinyFish Fetch: reads the professor's own site" |
| 3 | Text: **any new marketing internships in Chicago?** (or your real field) | Fresh postings with links | `[scout] tool get_jobs`, `[tinyfish] search "…", last 3d → N results` | "TinyFish Search: postings from the last 3 days" |
| 4 | ❤️ **that reply** (press and hold → heart) | "Saved … to your tracker" | `[tapback] •••1234: "❤️" → love` | "Tapbacks are controls" |
| 5 | Text: **what does the first one's application ask for?** | "Opening the application… 📝", then the questions and documents (1–2 min) | `[scout] tool prep_application`, `[tinyfish] agent started: browsing …`, `agent COMPLETED in 74s` | "TinyFish Agent: opens the real form. Read-only, never submits" |
| 6 | **Lock the phone** and wait for the reminder from step 1 | The ⏰ notification on the lock screen | (nothing) | "It texts you first" |
| 7 | Tap the notification, then 👍 the reminder | "✅ Checked off" | `[tapback] … → like` | |
| 8 | Text: **anything with free food this week?** | An event with its link | `[scout] tool get_events` | "Campus events from your school's own site" |
| 9 | ❤️ the event, tap the Google Calendar link, tap **Save** | The calendar event, pre-filled | `[tapback] … → love` | "You approve every add" |

4. Stop both recordings. The phone video is in Photos (AirDrop or iCloud it to the laptop). The laptop video is in `Videos\Captures`.

If the Agent in step 5 times out or a reply looks off, just send the text again. You'll cut the retries anyway.

### 3. Edit in Clipchamp (about 20 minutes)
1. **Create the video:** Create a new video at **16:9**. Drag in both recordings.
2. **Arrange the layout:**
   - **Phone:** on the left, scaled to fill the height.
   - **Terminal:** on the right, cropped to the log lines.
   - **Background:** a dark green (#1f3128) to match the site.
3. **Sync the clips:** line up each text you send with its `[in]` line appearing in the terminal.
4. **Cut it down:**
   - **Waits:** cut them, or speed them up to 4–8× (Agent runs especially), with a small "⏩ 1 min later" text.
   - **Order:** keep about 1:00. Steps 2, 3, 5 and 6 matter most; 8 and 9 can be quick.
5. **Add text:**
   - **Captions:** the ones in the table, as text boxes.
   - **Start card (2s):** "It's 11pm. Deadlines on a prof's site, an internship that just opened, a free-food event you'd miss."
   - **End card (2s):** "Scout · Photon + TinyFish" plus the GitHub link.
6. **Audio:** music from Clipchamp's library (or your voiceover). Export at **1080p**.

### 4. Publish
1. **YouTube:** upload the mp4 as **Unlisted**, titled "Scout: a study copilot over iMessage (Photon + TinyFish)". Send the link to Claude to embed on the site and in the README.
2. **LinkedIn (required) and X:** upload the **mp4 itself** (not the YouTube link) with the posts below, tagging TinyFish and Photon.
3. **Discord #showcase:** the YouTube link plus the blurb below.

**Never on screen:** API keys, `.env`, your phone number, your Canvas feed link. The terminal logs already mask the number and only print site host names.

---

## LinkedIn post (required)

> Meet Scout 🧭, a study copilot that lives in your texts.
>
> I built an AI assistant any college student can text on iMessage. It tracks homework from Canvas *and* professors' own websites, finds campus events you'd actually go to, and watches for jobs and internships in your field. It texts you first when something matters (a new assignment posted, a deadline in 3 hours, a verified new posting) and stays quiet otherwise.
>
> How it's built:
> 📱 Photon Spectrum is the iMessage layer: a real number, proactive texts, and tapbacks as controls (❤️ a posting to save it, 👍 a reminder to mark it done).
> 🐟 TinyFish is the web layer. Search discovers course sites, events pages and fresh postings. Fetch crawls messy professor sites (calendar pages, PDFs, "EOW" deadlines). The Agent opens real job postings to confirm they're still open and reads application forms, and it's read-only, so it never applies or submits.
> 🧠 Claude Sonnet 5.5 decides which tools to use and only states facts that came back from the live web, with links.
>
> It works at any school: onboarding over text asks where your school posts events and what jobs you want, in any field.
>
> Built for the TinyFish Students program × Photon iMessage bounty. Demo 👇
> Code: https://github.com/arya-pradhan/tiny-fish-iMessage-Assistant
> Site: [your Vercel link]
>
> @TinyFish @Photon #AIagents #iMessage #buildinpublic

(Tag them with LinkedIn's @-mention so the company pages are linked: type "@TinyFish" and pick the company, then "@Photon" and pick **Photon** (photon-framework).)

---

## X post

> Built Scout 🧭, an AI study copilot you text on iMessage.
>
> Homework from Canvas + prof sites, campus events, jobs in your field. It texts you first when something matters.
>
> @photon_hq = iMessage layer
> @Tiny_Fish Search/Fetch/Agent = live web work
>
> [video] · github.com/arya-pradhan/tiny-fish-iMessage-Assistant

(About 270 characters with the link; attach the video.)

---

## Discord #showcase

> **Scout 🧭: a study copilot over iMessage** (TinyFish × Photon bounty)
> Text it like a friend: "what's due this week?", "free food tonight?", "any new marketing internships in Chicago?". It also texts you first: a morning brief, due-soon nudges, new assignments on a prof's site, verified new postings.
> • Photon Spectrum: iMessage, proactive texts, tapbacks as controls, effects
> • TinyFish Search (find course sites/events pages/fresh postings) · Fetch (crawl prof sites + job boards) · Agent (verify postings are open, read application forms, read-only)
> • Works at any school; 36 offline tests + free live tests
> Demo: [link] · Code: https://github.com/arya-pradhan/tiny-fish-iMessage-Assistant · Site: [link]

---

## Submission checklist

**Requirements**
- [ ] Working demo: a real iMessage conversation, message in → web action → result back (the video above)
- [x] Photon Spectrum for iMessage + TinyFish doing real work (Search, Fetch **and** Agent → 3+ endpoint tier)
- [x] Works for different requests: free-form chat with 18 tools, plus onboarding for any school or field
- [x] Short explanation: README "How Photon and TinyFish are used" + the site
- [ ] 60-second demo posted on **LinkedIn (required)** and X, tagging TinyFish and Photon
- [ ] Shared in TinyFish Discord **#showcase**
- [ ] Submit the repo/site link with notes (the README intro works as the notes)

**Approval criteria → where it shows**
1. Useful: homework + events + jobs, the daily brief (README "The moment")
2. TinyFish used meaningfully: endpoint table (README / site "How it works")
3. End to end: the demo video beats 0:18–0:47
4. Remembers context and texts at the right moment: per-student memory, nudges, quiet hours, dedupe
5. Robust and trustworthy: read-only Agent goals, Save-to-add calendar, cited sources, named failures (README "Trust & safety")
6. Crafted: iMessage bubbles, tapbacks, effects, contact card
7. Demo: follow the script above

**Before posting:** don't show API keys, your phone number, or your Canvas feed link anywhere (the video, screenshots, or repo). `.env` and `data/` are gitignored.
