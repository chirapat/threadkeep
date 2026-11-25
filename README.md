# ThreadKeep

Save Reddit threads (post, comments and images) on your iPhone and read them offline. Free, with no server and no account needed.

## 1. Install it on your iPhone

1. Open Safari (it has to be Safari) and go to `https://chirapat.github.io/threadkeep/`
2. Tap the Share button (the square with an arrow) → scroll down → Add to Home Screen → Add.
3. From now on, always open ThreadKeep from the new icon on your Home Screen. Your saved posts live there, separate from Safari.

## Hosting your own copy (GitHub Pages, about 5 minutes)

1. Create a free account at github.com.
2. Tap **+ → New repository**. Name it `threadkeep`, choose **Public**, and tap **Create repository**.
3. Tap **uploading an existing file**. Drag in **everything inside this folder** (`index.html`, `app.js`, `styles.css`, `sw.js`, `manifest.webmanifest`, and the `icons` folder). Tap **Commit changes**.
4. Go to **Settings → Pages**. Under "Branch" pick **main** and **/ (root)**, then tap **Save**.
5. After about a minute your app is live at `https://YOUR-USERNAME.github.io/threadkeep/`.

(Cloudflare Pages or Netlify work too. Any free static hosting with HTTPS will do.)

## 2. Saving posts (no Reddit key needed)

Reddit blocks apps that aren't signed in, so ThreadKeep uses a free Shortcut that grabs threads from Safari while you're signed in to Reddit there.

**One-time setup**
1. Open the **Settings** app → **Apps** → **Shortcuts** → **Advanced** → turn on **Allow Running Scripts**.
2. On your iPhone, open [Save to ThreadKeep.shortcut](https://chirapat.github.io/threadkeep/shortcut/Save%20to%20ThreadKeep.shortcut) → **Add Shortcut**. (If Safari offers to download it, tap Download, then open it from Safari's downloads.)
3. In Safari, sign in at **reddit.com**.

**Saving a post**
1. Open the post in **Safari**. From the Reddit app: Share → Copy link, then paste it into Safari.
2. Tap **Share** → **Save to ThreadKeep**. The first time, tap **Allow**.
3. Open ThreadKeep and tap **Paste link & save**.

**Grabbing a subreddit:** open e.g. `reddit.com/r/AskReddit` in Safari and run the same Shortcut. It saves today's top 10 posts with their comments.

If the Shortcut link doesn't import, build it yourself: **Shortcuts → +**, turn on **Show in Share Sheet** (Safari web pages), then add **Run JavaScript on Web Page** with the script from [`shortcut/save-to-threadkeep.js`](shortcut/save-to-threadkeep.js), **Copy to Clipboard**, and **Show Notification**.

Other things to know:
- **Update comments** on a saved post needs the Reddit key; without it, run the Shortcut on the post again.
- **Keep forever** stops a post from ever being removed automatically.

## Reddit client ID (optional)

With an approved key, ThreadKeep downloads by itself, including automatic downloads from your favourite subreddits, without the Shortcut.

1. In Safari, sign in at https://www.reddit.com/prefs/apps
2. Tap **create another app…**
3. Name: `ThreadKeep`. Type: **installed app**.
4. Redirect URI: `https://chirapat.github.io/threadkeep/`
5. Tap **create app**. Copy the short code shown under the app name.
6. In ThreadKeep, open **Settings → Reddit client ID** and paste it. You'll see "Reddit connected ✓".

Since late 2025, Reddit usually doesn't create the app instantly. It sends you to an access request form, which a person reviews. Describe it as a personal, non-commercial, read-only app that saves threads you choose to read offline on your own phone. Approval can take a while and isn't guaranteed.

## Settings

| Setting | Options |
|---|---|
| Storage limit | 250 MB, 500 MB, 1 GB, 2 GB, 4 GB |
| When full | Remove oldest posts (except kept ones), or save new posts as text only |
| Top comments | 25 / 50 / 100 / 200 / all (about 500 max) |
| Reply depth | Top only, 2, 4, 6, 10 levels |
| Images | Phone size (recommended), Original, None. Comment images on/off |
| Favourite subreddits | (Needs the Reddit key) Auto-download new posts from e.g. r/AskReddit: 3/5/10/25 posts each, Top today / Top this week / Hot, checked every hour / 6 h / daily / only when you tap |
| NSFW | Show, Blur images (tap to reveal), or Hide (hidden from your list and never auto-downloaded). The **Show NSFW** switch on the home page turns NSFW posts on and off |

Auto-downloaded posts are labelled **Auto** and are the first to be removed when storage is full. Posts you delete are remembered and won't be downloaded again. The home page has subreddit chips to filter your list.

## Limitations

- **Videos** aren't saved. Only their preview picture is.
- iOS doesn't let web apps run in the background, so **queued downloads happen when you open the app**.
- **Very large threads**: Reddit returns up to about 500 comments per request, and deeper "load more" replies aren't fetched.
- **Images hosted outside Reddit** are stored but can't be measured exactly, so the storage meter estimates them.
- **Export text backup** in Settings saves all your threads, without images, as a file you can import later.
