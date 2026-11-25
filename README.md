# ThreadKeep

Save Reddit threads (post, comments and images) on your iPhone and read them offline. Free, with no server and no account other than Reddit's free developer key.

## 1. Put it online for free (GitHub Pages, about 5 minutes)

1. Create a free account at github.com.
2. Tap **+ → New repository**. Name it `threadkeep`, choose **Public**, and tap **Create repository**.
3. Tap **uploading an existing file**. Drag in **everything inside this folder** (`index.html`, `app.js`, `styles.css`, `sw.js`, `manifest.webmanifest`, and the `icons` folder). Tap **Commit changes**.
4. Go to **Settings → Pages**. Under "Branch" pick **main** and **/ (root)**, then tap **Save**.
5. After about a minute your app is live at `https://YOUR-USERNAME.github.io/threadkeep/`.

(Cloudflare Pages or Netlify work too. Any free static hosting with HTTPS will do.)

## 2. Install it on your iPhone

1. Open your app's address in **Safari**.
2. Tap **Share → Add to Home Screen**.
3. Always open ThreadKeep from that icon. Home Screen apps have their own storage, which iOS doesn't clear the way it clears Safari's.

## 3. Get your free Reddit client ID

Reddit blocks many anonymous requests, so the app uses your own free personal key.

1. In Safari, sign in at https://www.reddit.com/prefs/apps
2. Tap **create another app…**
3. Name: `ThreadKeep`. Type: **installed app**.
4. Redirect URI: your app's address, e.g. `https://YOUR-USERNAME.github.io/threadkeep/`
5. Tap **create app**. Copy the short code shown under the app name.
6. In ThreadKeep, open **Settings → Reddit client ID** and paste it. You'll see "Reddit connected ✓".

Since late 2025, Reddit usually doesn't create the app instantly. It sends you to its Responsible Builder Policy and an access request form, which a person reviews. Describe it as a personal, non-commercial, read-only app that saves threads you choose to read offline on your own phone, at a low request rate. Approval can take a while and isn't guaranteed. Until then, ThreadKeep tries Reddit's public pages directly from your phone, which may or may not be allowed on your network.

## Saving posts

- In the Reddit app: **Share → Copy link**, then open ThreadKeep and tap **Paste link & save**.
- The whole thread downloads right away. If you're offline, it queues and downloads as soon as you're back online with the app open.
- **Update comments** on a saved post re-downloads it with the newest comments.
- **Keep forever** stops a post from ever being removed automatically.

### If a short "/s/" share link fails
Make a Shortcut: **Shortcuts → +** and add these actions:
1. **Receive URLs from Share Sheet**
2. **Expand URL**
3. **Copy to Clipboard**

Name it "Expand link". In Reddit, share to **Expand link**, then paste in ThreadKeep.

## Settings

| Setting | Options |
|---|---|
| Storage limit | 250 MB, 500 MB, 1 GB, 2 GB, 4 GB |
| When full | Remove oldest posts (except kept ones), or save new posts as text only |
| Top comments | 25 / 50 / 100 / 200 / all (about 500 max) |
| Reply depth | Top only, 2, 4, 6, 10 levels |
| Images | Phone size (recommended), Original, None. Comment images on/off |
| Favourite subreddits | Auto-download new posts from e.g. r/AskReddit: 3/5/10/25 posts each, Top today / Top this week / Hot, checked every hour / 6 h / daily / only when you tap |
| NSFW | Show, Blur images (tap to reveal), or Hide (hidden from your list and never auto-downloaded). The **Show NSFW** switch on the home page turns NSFW posts on and off |

Auto-downloaded posts are labelled **Auto** and are the first to be removed when storage is full. Posts you delete are remembered and won't be downloaded again. The home page has subreddit chips to filter your list.

## Limitations

- **Videos** aren't saved. Only their preview picture is.
- iOS doesn't let web apps run in the background, so **queued downloads happen when you open the app**.
- **Very large threads**: Reddit returns up to about 500 comments per request, and deeper "load more" replies aren't fetched.
- **Images hosted outside Reddit** are stored but can't be measured exactly, so the storage meter estimates them.
- **Export text backup** in Settings saves all your threads, without images, as a file you can import later.
