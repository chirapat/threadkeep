# ThreadKeep

Save Reddit threads with their full comments and read them offline. Free, no Reddit account, no API key, no computer. Works on **iPhone and Android**.

It pulls threads from **[Arctic Shift](https://arctic-shift.photon-reddit.com)**, a free public Reddit archive — so it works even though Reddit has locked down its own API.

## Install (one time)

Open `https://chirapat.github.io/threadkeep/` and add it to your Home Screen:
- **iPhone (Safari):** Share → **Add to Home Screen** → Add.
- **Android (Chrome):** ⋮ menu → **Add to Home screen** (or **Install app**).

Always open ThreadKeep from the new icon. Your saved threads live there, offline.

## Use it

Out of the box the **Popular mix** is on — tap **Check now** and it saves the most-discussed threads from a rotating set of popular subreddits. To focus, open **Settings** and add your own subreddits (e.g. `AskReddit`, `explainlikeimfive`); keep the popular mix on alongside them, or turn it off.

You can also paste any **reddit.com thread link** on the home page to save one specific thread.

## Two libraries (Main + Private)

A tab at the top of the home page switches between two separate libraries:
- **Main** — your subreddits and the popular mix.
- **🔒 Private** — a separate surface with its own subreddits (set them under the **Private** tab → Settings). Its content downloads and lives only there, and the app opens on Main each time.

You can set a **passcode** on the Private library, and optionally **hide its tab** until you type the passcode in the box on the home page.

## Reading

- **Unread** filter, subreddit filters, and **search across titles and comments**.
- Threads you've opened are marked **read**; the app **remembers your scroll position** so you can continue where you left off.
- **Collapse all / expand all** comments; tap a commenter's name to collapse one thread of replies.
- **Keep** a thread so it's never auto-removed. **Swipe a thread left** for quick Keep/Delete. **🎲** opens a random thread.
- **Share** a thread as text, **pull down** to check for new threads.
- Images are saved for offline viewing; videos are not (only their preview image).

## What you control

- **Popular mix** on/off, your own **focus subreddits**, **threads per subreddit** each check (3 / 5 / 10 / 25), and **comments per thread** (50–500).
- **Keyword rules** — only save titles containing certain words, or skip titles containing others.
- **Total storage** (50 MB – 2 GB), and whether a full library **removes the oldest** or **stops saving**.
- **Appearance** — text size, light/dark/auto theme, and an accent colour.
- **Backup & restore** — export both libraries and settings to a file, import on another device.
- When to check: **on open**, **daily**, or **manually**.

## Honest limitations

- **Threads are usually a couple of weeks old.** The archive needs time to collect a thread's comments, so ThreadKeep saves well-discussed threads from a mature window rather than this minute's posts.
- **Ranked by number of comments**, not upvotes (the archive's scores aren't reliable). "Most comments" surfaces the best discussions.
- **Checks happen when you open the app** — phones don't let web apps run fully in the background.
- The archive is a free community service and rate-limits heavy use, so a big check takes a little while.

## Hosting your own copy

Upload these files to any free static host with HTTPS (GitHub Pages, Cloudflare Pages, Netlify). No server code needed.
