# ThreadKeep

Save Reddit threads (post, comments and images) on your iPhone and read them offline. Free, with no server and no account needed.

## 1. Install it on your iPhone

1. Open Safari (it has to be Safari) and go to `https://chirapat.github.io/threadkeep/`
2. Tap the Share button (the square with an arrow) → scroll down → Add to Home Screen → Add.
3. From now on, always open ThreadKeep from the new icon on your Home Screen. Your saved posts live there, separate from Safari.

## 2. Set up the Shortcut (one time)

Reddit only allows downloads while you're signed in, so a free Shortcut grabs threads from Safari for you.

1. Open the **Settings** app → **Apps** → **Shortcuts** → **Advanced** → turn on **Allow Running Scripts**.
2. On your iPhone, open [Save to ThreadKeep.shortcut](https://chirapat.github.io/threadkeep/shortcut/Save%20to%20ThreadKeep.shortcut) → **Add Shortcut**.
3. Sign in at **reddit.com** in Safari.

If the Shortcut link won't import, build it yourself: **Shortcuts → +**, turn on **Show in Share Sheet** (Safari web pages), then add **Run JavaScript on Web Page** with the script from [`shortcut/save-to-threadkeep.js`](shortcut/save-to-threadkeep.js), followed by **Copy to Clipboard**.

## 3. Save threads

1. In **Safari**, open a Reddit post, or a subreddit such as `reddit.com/r/AskReddit`.
2. Tap **Share** → **Save to ThreadKeep**.
3. Open ThreadKeep and tap **Paste from Shortcut**.

A **post** is saved with its top comments. A **subreddit** saves today's top 10 posts with their comments. If it says some are missing, run it once more and it fetches the rest.

## Reading

- **Filter** by subreddit, **search**, and switch **NSFW** on or off from the home page.
- **Tap a commenter's name** to collapse that comment and its replies.
- **Keep** a thread so it's never removed when storage fills up.

## Settings

- **Space for saved threads:** 250 MB, 500 MB, 1 GB or 2 GB.
- **When it's full:** remove the oldest threads (except kept ones), or save new ones as text only.
- **Text size**, and whether to **blur NSFW images** until tapped.

## Limitations

- **Saving isn't automatic.** iPhone doesn't let web apps run in the background, and Reddit blocks downloads that aren't signed in.
- **Videos** aren't saved. Only their preview picture is.
- **Very large threads** save the top comments rather than every reply.

## Hosting your own copy

Upload the files in this folder to any free static host with HTTPS (GitHub Pages, Cloudflare Pages, Netlify).
