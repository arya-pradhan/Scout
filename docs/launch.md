# Scout launch kit

Everything for the submission: the 60-second demo script, the posts, and the checklist.

- Repo: https://github.com/arya-pradhan/tiny-fish-iMessage-Assistant
- Site: _your Vercel URL_
- Tags: TinyFish → X **@Tiny_Fish**, LinkedIn **TinyFish** (linkedin.com/company/tinyfish-ai) · Photon → X **@photon_hq**, LinkedIn **Photon** (linkedin.com/company/photon-framework)

---

## 60-second demo script

**Setup before recording:** run `npm run dev` with `SCHEDULER_TICK_MS=60000`. Finish onboarding on your phone first (school, Canvas feed, a course site, events page, "marketing internships in Chicago" or your real ask). Screen-record the iPhone. Put the laptop terminal (Scout's logs) beside it, or cut to it. **Blur your phone number and never show the Canvas feed link.**

| Time | Shot | On screen / voiceover |
|---|---|---|
| 0:00–0:07 | **The moment.** Close-up of the phone, a late-night lock screen, a text notification from Scout. | VO: "It's 11pm. I have a deadline that only exists on my professor's website, and I don't know about tomorrow's career fair." |
| 0:07–0:18 | **Proactive brief.** Open the thread: Scout's morning brief bubbles (📚 due soon · 🎉 on campus · 💼 new postings). | VO: "This is Scout. I never asked it anything. It texts me when something matters." |
| 0:18–0:32 | **Real web work #1 (Fetch).** Text *"what's due this week?"*. Show the typing dots, then cut to the terminal log of TinyFish Fetch reading the course site's calendar pages. Scout replies with dated items and links. | Lower third: "TinyFish Fetch → crawls the professor's site". |
| 0:32–0:47 | **Real web work #2 (Agent).** ❤️ a posting ("Saved to your tracker"), then text *"what does the application ask?"*. Scout: "Opening the application… 📝". Cut to the TinyFish run (logs or dashboard). Scout replies with the questions and documents. | Lower third: "TinyFish Agent → opens the real form, never submits". |
| 0:47–0:57 | **Payoff.** ❤️ an event → the Google Calendar link → tap → Save. Text *"remind me at 9 to start the essay"* → the ⏰ reminder arrives → 👍 → "✅ checked off" (or confetti when the week is clear). | VO: "It asks before anything is added, and it never fakes a source." |
| 0:57–1:00 | **End card.** "Scout 🧭 · built with Photon + TinyFish" + repo/site link. | |

Tips: keep each reply on screen long enough to read (~2s); speed up only the waiting. Record in light mode with a big font. Keep phone notifications off.

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
