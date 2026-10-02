# Scout showcase site

A static page with no build step:

- `index.html`: the content. The "day with Scout" chapters live here as a plain list, so the page still reads fine without JavaScript.
- `styles.css`: colors (dust grey / sage / fern / hunter / pine), the iPhone and iOS Messages screens, layout, dark mode.
- `app.js`: turns the chapter list into the scroll story (the clock, the phone thread, the Dynamic Island, the confetti), plus the nav, reveals and the mascot.
- `static/fedora_companion.svg`: the Scout mascot (also the favicon).

To preview locally, open `index.html` in a browser, or run `npx serve site` from the repo root.

## Deploy on Vercel
1. In Vercel, **Add New → Project** and import `arya-pradhan/Scout`.
2. Set **Root Directory** to `site` and **Framework Preset** to **Other** (no build command, no output directory).
3. Deploy. Every push to `main` redeploys automatically.

Or from this folder: `npx vercel` (then `npx vercel --prod`).

## Add the demo video
In `index.html`, find the `<!-- Replace this div's contents with your demo … -->` comment in the **Demo** section and paste a YouTube embed (`<iframe src="https://www.youtube.com/embed/VIDEO_ID" …>`) or drop `demo.mp4` in this folder and use `<video src="demo.mp4" controls playsinline></video>`.

## Edit the story
Each `<li class="chapter">` in `index.html` is one moment of the day: `data-time` is minutes after midnight (e.g. `915` = 3:15 PM), `data-chips` lights up the TinyFish endpoints, and `data-mood` sets the mascot's reaction (`tip`, `scan`, `work`, `happy`, `sleep`). Inside `.transcript`, use `.m.in` / `.m.out` bubbles, `.m.typing`, `.m.tapback` (`data-emoji`), `.m.link` (`data-icon`, `data-domain`), `.m.stamp`, plus `data-island` for the Dynamic Island and `data-confetti`.