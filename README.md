# ThreadKeep

Save Reddit threads with their full comments and read them offline on your iPhone. Free, no Reddit account, no API key, no computer.

It pulls threads from **[Arctic Shift](https://arctic-shift.photon-reddit.com)**, a free public Reddit archive — so it works even though Reddit has locked down its own API.

## Install (one time)

1. Open `https://chirapat.github.io/threadkeep/` in **Safari**.
2. Tap **Share → Add to Home Screen → Add**.
3. Always open ThreadKeep from the Home Screen icon. Your saved threads live there, offline.

## Use it

Out of the box, the **Popular mix** is on — tap **Check now** and it saves the most-discussed threads from a rotating set of popular subreddits. To focus, open **Settings → What to auto-save** and add your own subreddits (e.g. `AskReddit`, `explainlikeimfive`); you can keep the popular mix on alongside them, or turn it off.

ThreadKeep saves the **most-discussed threads**, with their whole comment trees, for offline reading. You can also paste any **reddit.com thread link** on the home page to save one specific thread.

## Two libraries (Main + Private)

A tab at the top of the home page switches between:
- **Main** — your subreddits and the popular mix. Always SFW.
- **🔒 Private** — a separate surface with its own NSFW subreddits (set them in **Settings → Private library**). NSFW threads download and live only here, and the app opens on Main each time.

## What you control

- **Popular mix** on/off, plus your own **focus subreddits**, and **threads per subreddit** each check (3 / 5 / 10 / 25).
- **Comments saved per thread** (50 / 100 / 200 / 500) — the main size lever.
- **Total storage** (50 MB / 250 MB / 500 MB / 1 GB / 2 GB), and whether a full library **removes the oldest** or **stops saving**. Threads you **Keep** are never auto-removed.
- **NSFW** lives in the Private library; images blur until tapped.
- When to check: **on open**, **daily**, or **manually**.

## How it reads

- Threads are grouped by subreddit with filter chips and search.
- Tap a commenter's name to collapse that comment and its replies.
- Images are saved for offline viewing; videos are not (only their preview image).

## Honest limitations

- **Threads are usually a couple of weeks old.** The archive needs time to collect a thread's comments, so ThreadKeep saves well-discussed threads from a mature window rather than this minute's posts. For reading discussions offline, that's a fair trade.
- **Ranked by number of comments**, not upvotes (the archive's scores aren't reliable). In practice "most comments" surfaces the best discussions.
- **Not truly automatic in the background** — iPhone doesn't let web apps run in the background, so a "check" happens when you open the app.
- The archive is a free community service and rate-limits heavy use, so a big check takes a little while.

## Hosting your own copy

Upload these files to any free static host with HTTPS (GitHub Pages, Cloudflare Pages, Netlify). No server code needed.
