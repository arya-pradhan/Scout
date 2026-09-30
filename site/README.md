# Scout showcase site

A single static page (`index.html`, no build step) that shows what Scout does.

## Deploy on Vercel
1. In Vercel, **Add New → Project** and import `arya-pradhan/tiny-fish-iMessage-Assistant`.
2. Set **Root Directory** to `site` and **Framework Preset** to **Other** (no build command, no output directory).
3. Deploy. Every push to `main` redeploys automatically.

Or from this folder: `npx vercel` (then `npx vercel --prod`).

## Add the demo video
In `index.html`, find the `<!-- Replace this div's contents with your demo … -->` comment in the **See it in 60 seconds** section and paste a YouTube embed (`<iframe src="https://www.youtube.com/embed/VIDEO_ID" …>`) or drop `demo.mp4` in this folder and use `<video src="demo.mp4" controls playsinline></video>`.
