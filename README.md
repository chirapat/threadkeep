# ThreadKeep

Save Reddit threads (post, comments and images) on your iPhone and read them offline. Free, with no server and no account needed.

## 1. Install it on your iPhone

1. Open Safari (it has to be Safari) and go to `https://chirapat.github.io/threadkeep/`
2. Tap the Share button (the square with an arrow) → scroll down → Add to Home Screen → Add.
3. From now on, always open ThreadKeep from the new icon on your Home Screen. Your saved posts live there, separate from Safari.

## 2. Add a free Reddit key (recommended)

With a key, ThreadKeep downloads any post or a subreddit's top posts directly — all comments — with no Shortcut.

1. On your iPhone, sign in at [reddit.com/prefs/apps](https://www.reddit.com/prefs/apps).
2. Tap **create another app…**, name it **ThreadKeep**, choose **installed app**.
3. Redirect URI: `https://chirapat.github.io/threadkeep/`
4. Tap **create app**, copy the short code under the app's name.
5. In ThreadKeep → **Settings → Reddit key**, paste it. You'll see "Reddit key works ✓".

**"Max clients have been reached"?** Your account already has the most apps Reddit allows. Delete or revoke an app you don't use on that page to free a slot, then create ThreadKeep.

### Saving (with a key)
On the home page: paste a reddit.com post link and tap **Save**, or type a subreddit, choose **Top 5/10/25/50**, a **time range** and **comments per thread**, and tap **Grab**.

## 3. No key? The Shortcut (fallback)

Without a key, a free Shortcut saves the single post you have open in Safari, with the comments loaded on screen.

1. Open the **Settings** app → **Apps** → **Shortcuts** → **Advanced** → turn on **Allow Running Scripts**.
2. On your iPhone, open [Save to ThreadKeep.shortcut](https://chirapat.github.io/threadkeep/shortcut/Save%20to%20ThreadKeep.shortcut) → **Add Shortcut**.
3. Sign in at reddit.com in Safari. Open a post, scroll to load comments, then **Share → Save to ThreadKeep**, and tap **Paste from Shortcut** in the app.

## Reading

- **Filter** by subreddit, **search**, and switch **NSFW** on or off from the home page.
- **Tap a commenter's name** to collapse that comment and its replies.
- **Keep** a thread so it's never removed when storage fills up.

## Settings

- **Space for saved threads:** 250 MB, 500 MB, 1 GB or 2 GB.
- **When it's full:** remove the oldest threads (except kept ones), or save new ones as text only.
- **Text size**, and whether to **blur NSFW images** until tapped.

## Limitations

- **Saving isn't automatic.** iPhone doesn't let web apps run in the background, so you start each save with the Shortcut. Reddit also blocks downloads that aren't signed in, which is why the Shortcut passes your Safari sign-in.
- **Videos** aren't saved. Only their preview picture is.
- **Very large threads** save the top comments (up to 200) rather than every reply.

## Hosting your own copy

Upload the files in this folder to any free static host with HTTPS (GitHub Pages, Cloudflare Pages, Netlify).
