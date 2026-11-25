/* ThreadKeep 2 — read saved Reddit threads offline.
 *
 * How threads arrive: the "Save to ThreadKeep" Shortcut runs on a Reddit page in Safari (where you're signed in),
 * copies the thread data as "THREADKEEP:{...}", and you tap "Paste from Shortcut" here.
 * Everything is stored on this device: thread text in IndexedDB, images in the Cache API.
 */
'use strict';

const APP_VERSION = '2.2';
const MEDIA_CACHE = 'tk-media-v1';
const BUNDLE_PREFIX = 'THREADKEEP:';
const SHORTCUT_URL = 'shortcut/Save%20to%20ThreadKeep.shortcut';
const MB = 1024 * 1024;

/* ================= Settings ================= */

const DEFAULTS = {
  limitMB: 500,        // storage budget
  whenFull: 'evict',   // 'evict' = remove oldest posts (not kept ones), 'textonly' = stop saving images
  showNsfw: true,      // home page switch
  blurNsfw: true,      // blur NSFW images until tapped
  fontSize: 17,
};
const store = {
  get(key, fallback) { try { const v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v); } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch {} },
};
const settings = (() => {
  const saved = store.get('tk-settings', {}) || {};
  const s = { ...DEFAULTS };
  for (const k of Object.keys(DEFAULTS)) if (typeof saved[k] === typeof DEFAULTS[k]) s[k] = saved[k];
  if (saved.nsfw === 'hide') s.showNsfw = false;   // from version 1
  if (saved.nsfw === 'show') s.blurNsfw = false;
  return s;
})();
function saveSettings() {
  store.set('tk-settings', settings);
  applyFontSize();
}
function applyFontSize() { document.documentElement.style.setProperty('--reader-size', settings.fontSize + 'px'); }
applyFontSize();

/* ================= Storage (IndexedDB) ================= */

const dbReady = new Promise((resolve, reject) => {
  const req = indexedDB.open('threadkeep', 1);
  req.onupgradeneeded = () => {
    req.result.createObjectStore('posts', { keyPath: 'id' });   // library rows
    req.result.createObjectStore('threads', { keyPath: 'id' }); // full post + comments
  };
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});
async function tx(name, mode, fn) {
  const database = await dbReady;
  return new Promise((resolve, reject) => {
    const t = database.transaction(name, mode);
    let result;
    const r = fn(t.objectStore(name));
    if (r) r.onsuccess = () => { result = r.result; };
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('Storage write failed'));
  });
}
const db = {
  get: (s, id) => tx(s, 'readonly', o => o.get(id)),
  all: (s) => tx(s, 'readonly', o => o.getAll()),
  put: (s, v) => tx(s, 'readwrite', o => o.put(v)),
  del: (s, id) => tx(s, 'readwrite', o => o.delete(id)),
};

/* ================= Small helpers ================= */

const $ = (sel, el = document) => el.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const unamp = (s) => String(s || '').replace(/&amp;/g, '&');
const plural = (n, one, many) => n + ' ' + (n === 1 ? one : (many || one + 's'));

function fmtBytes(b) {
  if (!b) return '0 MB';
  if (b < MB) return Math.max(1, Math.round(b / 1024)) + ' KB';
  if (b < 1024 * MB) return (b / MB).toFixed(b < 10 * MB ? 1 : 0) + ' MB';
  return (b / 1024 / MB).toFixed(1) + ' GB';
}
function fmtAgo(sec) {
  const d = Date.now() / 1000 - sec;
  if (d < 3600) return Math.max(1, Math.floor(d / 60)) + 'm';
  if (d < 86400) return Math.floor(d / 3600) + 'h';
  if (d < 86400 * 30) return Math.floor(d / 86400) + 'd';
  if (d < 86400 * 365) return Math.floor(d / 86400 / 30) + 'mo';
  return Math.floor(d / 86400 / 365) + 'y';
}
function fmtNum(n) { n = n || 0; return n >= 10000 ? Math.round(n / 1000) + 'k' : n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n); }
const textBytes = (o) => new Blob([JSON.stringify(o)]).size;

let toastTimer;
function toast(msg, ms = 3000) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

function progress(text, fraction) {
  const el = $('#progress');
  if (text == null) { el.hidden = true; return; }
  el.hidden = false;
  $('#progressText').textContent = text;
  $('#progressFill').style.width = Math.round((fraction || 0) * 100) + '%';
}

/* ================= Cleaning Reddit's HTML ================= */

const ALLOWED = new Set(['A', 'P', 'BR', 'HR', 'B', 'STRONG', 'I', 'EM', 'DEL', 'S', 'SUP', 'SUB', 'CODE', 'PRE', 'BLOCKQUOTE', 'UL', 'OL', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TH', 'TD', 'SPAN', 'DIV', 'IMG']);
const DROP = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'FORM', 'SVG', 'BUTTON', 'INPUT']);
const REDDIT_IMG = /^https:\/\/(preview|i)\.redd\.it\//;

// Returns safe HTML. Reddit-hosted image links become <img> tags, and their URLs are added to `images`.
function sanitize(html, images) {
  if (!html) return '';
  if (!html.includes('<')) html = new DOMParser().parseFromString(html, 'text/html').documentElement.textContent; // entity-encoded
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const walk = (node) => {
    for (const el of [...node.children]) {
      if (DROP.has(el.tagName)) { el.remove(); continue; }
      if (!ALLOWED.has(el.tagName)) { walk(el); el.replaceWith(...el.childNodes); continue; }
      for (const a of [...el.attributes]) {
        const keep = (el.tagName === 'A' && a.name === 'href') || (el.tagName === 'IMG' && (a.name === 'src' || a.name === 'alt'));
        if (!keep) el.removeAttribute(a.name);
      }
      if (el.tagName === 'A') {
        let href = el.getAttribute('href') || '';
        if (href.startsWith('/')) href = 'https://www.reddit.com' + href;
        if (!/^https?:/i.test(href)) { el.removeAttribute('href'); walk(el); continue; }
        if (REDDIT_IMG.test(href) && /\.(jpe?g|png|gif|webp)(\?|$)/i.test(href)) {
          const img = doc.createElement('img');
          img.src = href; img.alt = el.textContent || 'image';
          images.push(href);
          el.replaceWith(img);
          continue;
        }
        el.setAttribute('href', href);
        el.setAttribute('target', '_blank');
        el.setAttribute('rel', 'noopener noreferrer');
      }
      if (el.tagName === 'IMG') {
        const src = el.getAttribute('src') || '';
        if (!/^https:/i.test(src)) { el.remove(); continue; }
        images.push(src);
      }
      walk(el);
    }
  };
  walk(doc.body);
  doc.querySelectorAll('img').forEach(i => i.setAttribute('loading', 'lazy'));
  return doc.body.innerHTML;
}

/* ================= Turning Reddit data into a saved thread ================= */

function phoneSizedPreview(preview) {
  const img = preview?.images?.[0];
  if (!img) return null;
  const fits = (img.resolutions || []).filter(r => r.width <= 1080);
  return unamp((fits[fits.length - 1] || img.source)?.url) || null;
}
function thumbOf(preview) {
  const res = preview?.images?.[0]?.resolutions || [];
  const r = res.find(x => x.width >= 140) || res[res.length - 1];
  return r ? unamp(r.url) : phoneSizedPreview(preview);
}

function mediaOf(p) {
  const src = p.crosspost_parent_list?.[0] || p;
  const out = [];
  if (src.is_gallery && src.gallery_data && src.media_metadata) {
    for (const item of src.gallery_data.items || []) {
      const m = src.media_metadata[item.media_id];
      if (!m || m.status !== 'valid') continue;
      const fits = (m.p || []).filter(r => r.x <= 1080);
      const url = (fits[fits.length - 1] || m.s)?.u || m.s?.gif;
      if (url) out.push({ url: unamp(url), caption: item.caption || '' });
    }
    return out;
  }
  const url = src.url_overridden_by_dest || src.url || '';
  const directImg = /\.(jpe?g|png|gif|webp)(\?|$)/i.test(url);
  if (src.post_hint === 'image' || directImg) {
    const u = phoneSizedPreview(src.preview) || (directImg ? url : null);
    if (u) out.push({ url: u, caption: '' });
    return out;
  }
  const pic = phoneSizedPreview(src.preview);
  if (pic) out.push({ url: pic, caption: (src.is_video || p.is_video) ? 'Video. Only the preview image is saved.' : '' });
  return out;
}

function trimComments(children, depthLeft, images) {
  const list = [];
  let more = 0;
  for (const ch of children || []) {
    if (ch.kind === 'more') { more += ch.data?.count || ch.data?.children?.length || 0; continue; }
    if (ch.kind !== 't1' || !ch.data) continue;
    const d = ch.data;
    const node = {
      a: d.author || '[deleted]', op: !!d.is_submitter, s: d.score || 0, t: d.created_utc || Date.now() / 1000,
      h: d.body_html ? sanitize(d.body_html, images) : esc(d.body || ''), f: d.author_flair_text || '',
      st: !!d.stickied, e: !!d.edited, r: [], m: 0,
    };
    const replies = d.replies?.data?.children || [];
    if (depthLeft > 0) { const sub = trimComments(replies, depthLeft - 1, images); node.r = sub.list; node.m = sub.more; }
    else node.m = replies.length;
    list.push(node);
  }
  return { list, more };
}
const countComments = (list) => list.reduce((n, c) => n + 1 + countComments(c.r), 0);

/* ================= Images ================= */

// Saves an image for offline use. Returns its size, or -1 when the size can't be read (image from a site without CORS).
async function cacheImage(url) {
  const cache = await caches.open(MEDIA_CACHE);
  if (await cache.match(url)) return 0;
  try {
    const res = await fetch(url, { mode: 'cors', credentials: 'omit' });
    if (!res.ok) throw new Error(res.status);
    const size = (await res.clone().blob()).size;
    await cache.put(url, res);
    return size;
  } catch {
    const res = await fetch(url, { mode: 'no-cors', credentials: 'omit' });
    await cache.put(url, res);
    return -1;
  }
}
async function usage() { try { return (await navigator.storage.estimate()).usage || 0; } catch { return 0; } }

async function removeImages(urls, exceptId) {
  if (!urls?.length) return;
  const stillUsed = new Set();
  for (const p of await db.all('posts')) if (p.id !== exceptId) (p.media || []).forEach(u => stillUsed.add(u));
  const cache = await caches.open(MEDIA_CACHE);
  await Promise.all(urls.filter(u => !stillUsed.has(u)).map(u => cache.delete(u)));
}

/* ================= Storage budget ================= */

const limitBytes = () => settings.limitMB * MB;
async function usedBytes(exceptId) {
  return (await db.all('posts')).filter(p => p.id !== exceptId).reduce((n, p) => n + (p.bytes || 0), 0);
}

// Makes room for `need` more bytes. With "remove oldest", deletes the oldest threads that aren't kept.
async function makeRoom(need, protectId) {
  let used = await usedBytes(protectId);
  if (used + need <= limitBytes()) return true;
  if (settings.whenFull !== 'evict') return false;
  const oldest = (await db.all('posts'))
    .filter(p => p.id !== protectId && !p.pinned)
    .sort((a, b) => a.savedAt - b.savedAt);
  for (const p of oldest) {
    await deletePost(p.id);
    used -= p.bytes || 0;
    if (used + need <= limitBytes()) return true;
  }
  return used + need <= limitBytes();
}

/* ================= Saving threads from the Shortcut ================= */

// Saves one thread (Reddit's [post, comments] JSON). Returns the post id.
async function saveThread(json, { fromSubreddit = false } = {}) {
  const p = json?.[0]?.data?.children?.[0]?.data;
  if (!p?.id) throw new Error('This thread data is incomplete.');
  const existing = await db.get('posts', p.id);
  const images = [];
  const media = mediaOf(p);
  const post = {
    id: p.id, title: p.title || 'Untitled', subreddit: p.subreddit || '', author: p.author || '', score: p.score || 0,
    created: p.created_utc || Date.now() / 1000, numComments: p.num_comments || 0, flair: p.link_flair_text || '',
    nsfw: !!p.over_18,
    html: sanitize(p.selftext_html || p.crosspost_parent_list?.[0]?.selftext_html, images),
    url: p.is_self ? '' : (p.url_overridden_by_dest || p.url || ''),
    permalink: 'https://www.reddit.com' + (p.permalink || '/comments/' + p.id),
    media,
  };
  const tree = trimComments(json?.[1]?.data?.children, 8, images);
  const thread = { id: p.id, post, comments: tree.list, more: tree.more, fetchedAt: Date.now() };
  const tBytes = textBytes(thread);

  if (existing) await removeImages(existing.media, p.id);
  if (!(await makeRoom(tBytes, p.id))) throw new Error('Storage is full (' + fmtBytes(limitBytes()) + '). Delete some threads or raise the limit in Settings.');
  await db.put('threads', thread);

  const thumb = thumbOf(p.preview || p.crosspost_parent_list?.[0]?.preview) || media[0]?.url || null;
  const row = {
    id: p.id, title: post.title, subreddit: post.subreddit, nsfw: post.nsfw,
    savedAt: existing?.savedAt || Date.now(), pinned: !!existing?.pinned, fromSubreddit: existing ? !!existing.fromSubreddit : fromSubreddit,
    savedComments: countComments(tree.list), thumb, media: [], bytes: tBytes, textOnly: false, complete: false,
  };
  await db.put('posts', row);

  for (const url of [...new Set([...(thumb ? [thumb] : []), ...media.map(m => m.url), ...images])]) {
    if (!(await makeRoom(256 * 1024, p.id))) { row.textOnly = true; break; }
    const before = await usage();
    let size;
    try { size = await cacheImage(url); } catch { continue; }
    if (size === -1) size = Math.max(50 * 1024, (await usage()) - before);
    row.media.push(url);
    row.bytes += size;
  }
  row.complete = true;
  await db.put('posts', row);
  return p.id;
}

async function pasteFromShortcut() {
  let text = '';
  try { text = await navigator.clipboard.readText(); }
  catch { showPasteBox(); return; }
  await importText(text);
}

async function importText(text) {
  text = String(text || '').trim();
  if (!text.startsWith(BUNDLE_PREFIX)) {
    toast(/reddit\.com|redd\.it/i.test(text)
      ? 'That’s a link. Open it in Safari, then Share → Save to ThreadKeep.'
      : 'Nothing from the Shortcut to paste. In Safari: Share → Save to ThreadKeep.', 5000);
    return;
  }
  let bundle;
  try { bundle = JSON.parse(text.slice(BUNDLE_PREFIX.length)); }
  catch { toast('The copied data is incomplete. Run the Shortcut again.', 5000); return; }
  if (bundle.error) { toast(bundle.error, 6000); return; }
  try { await navigator.clipboard.writeText(' '); } catch {} // don't leave the copied data (and sign-in pass) on the clipboard
  if (bundle.tk === 2) return importFromReddit(bundle);

  const fromSub = bundle.source === 'subreddit';
  let threads = (bundle.threads || []).filter(t => t?.[0]?.data?.children?.[0]?.data?.id);
  if (!settings.showNsfw && fromSub) threads = threads.filter(t => !t[0].data.children[0].data.over_18);
  if (!threads.length) {
    toast(fromSub ? 'Reddit was slow. Run the Shortcut on r/' + bundle.sub + ' again.' : 'Nothing to save in that copy.', 5000);
    return;
  }

  let saved = 0, lastId = null, error = '';
  for (let i = 0; i < threads.length; i++) {
    progress(threads.length > 1 ? 'Saving ' + (i + 1) + ' of ' + threads.length + '…' : 'Saving…', i / threads.length);
    try { lastId = await saveThread(threads[i], { fromSubreddit: fromSub }); saved++; }
    catch (e) { error = e.message; if (/Storage is full/.test(error)) break; }
  }
  progress(null);

  if (error && !saved) { toast(error, 6000); render(); return; }
  if (threads.length === 1) { location.hash = '#/p/' + lastId; route(); return; }
  if (fromSub && bundle.wanted && bundle.have < bundle.wanted) {
    toast('Saved ' + saved + '. You have ' + bundle.have + ' of the top ' + bundle.wanted + ' ' + (bundle.range || 'today') + ' from r/' + bundle.sub + '. Run the Shortcut again with the same choices for the rest.', 8000);
  } else if (fromSub) {
    toast('Saved the top ' + saved + ' ' + (bundle.range || 'today') + ' from r/' + bundle.sub + '.', 4000);
  } else {
    toast('Saved ' + plural(saved, 'thread') + '.');
  }
  if (error) setTimeout(() => toast(error, 6000), 7000);
  render();
}

/* ---- Version 2 Shortcut: it hands over your choices + Reddit's sign-in pass, and ThreadKeep downloads. ---- */
// The pass is used only for these requests to oauth.reddit.com and is never stored.

const RANGE_LABEL = { day: 'today', week: 'this week', month: 'this month', year: 'this year', all: 'of all time' };

async function redditApi(path, token) {
  let res;
  try { res = await fetch('https://oauth.reddit.com' + path, { headers: { Authorization: 'Bearer ' + token }, credentials: 'omit' }); }
  catch { throw new Error(navigator.onLine ? 'Couldn’t reach Reddit. Try again.' : 'You’re offline.'); }
  if (res.status === 401) throw new Error('Reddit’s sign-in pass has expired. Reload the Reddit page in Safari, then run the Shortcut again.');
  if (res.status === 403) throw new Error('Reddit refused the download (403). Make sure you’re signed in at reddit.com in Safari.');
  if (res.status === 429) throw new Error('Reddit says slow down. Wait a minute and try again.');
  if (!res.ok) throw new Error('Reddit error ' + res.status + '. Try again.');
  return res.json();
}

async function importFromReddit(b) {
  const pick = b.pick || {};
  const comments = Math.min(500, Math.max(5, pick.comments || 50));
  const depth = comments <= 25 ? 3 : comments <= 100 ? 5 : 8;
  const threadPath = (id) => '/comments/' + id + '?limit=' + comments + '&depth=' + depth + '&sort=top&raw_json=1';
  const hasToken = !!b.token && (!b.exp || b.exp * 1000 > Date.now() + 30000);

  // This post only
  if (pick.onlyThisPost) {
    if (!b.postId) { toast('You chose “This post only”, but no post was open. Open a post, or choose Top posts.', 6000); return; }
    progress('Downloading…', 0.3);
    let json = null, note = '';
    if (hasToken) {
      try { json = await redditApi(threadPath(b.postId), b.token); }
      catch (e) { note = e.message; }
    }
    if (!json && b.page) { json = b.page; note = 'Saved from the page (Reddit’s download didn’t work, so fewer comments).'; }
    if (!json) { progress(null); toast(note || 'Couldn’t find your Reddit sign-in in Safari. Sign in at reddit.com, then try again.', 7000); return; }
    try {
      progress('Saving…', 0.7);
      const id = await saveThread(json);
      progress(null);
      if (note) setTimeout(() => toast(note, 6000), 400);
      location.hash = '#/p/' + id; route();
    } catch (e) { progress(null); toast(e.message, 6000); render(); }
    return;
  }

  // Top N of a subreddit
  if (!b.sub) { toast('Open a subreddit (like r/AskReddit) or one of its posts, then run the Shortcut.', 6000); return; }
  if (!hasToken) { toast('Couldn’t find your Reddit sign-in in Safari. Sign in at reddit.com, reload the page, then try again.', 7000); return; }
  const top = Math.min(50, Math.max(1, pick.top || 10));
  const t = RANGE_LABEL[pick.t] ? pick.t : 'day';
  let ids;
  try {
    progress('Finding the top ' + top + ' ' + RANGE_LABEL[t] + ' in r/' + b.sub + '…', 0.02);
    const list = await redditApi('/r/' + b.sub + '/top?t=' + t + '&limit=' + Math.min(100, top + 5) + '&raw_json=1', b.token);
    ids = (list?.data?.children || []).map(c => c.data).filter(d => d && !d.stickied && (settings.showNsfw || !d.over_18)).slice(0, top).map(d => d.id);
  } catch (e) { progress(null); toast(e.message, 7000); return; }
  if (!ids.length) { progress(null); toast('No posts found in r/' + b.sub + ' ' + RANGE_LABEL[t] + '.', 5000); return; }

  let saved = 0, error = '';
  for (let i = 0; i < ids.length; i++) {
    progress('Saving ' + (i + 1) + ' of ' + ids.length + ' from r/' + b.sub + '…', i / ids.length);
    try { await saveThread(await redditApi(threadPath(ids[i]), b.token), { fromSubreddit: true }); saved++; }
    catch (e) { error = e.message; if (/Storage is full|expired|refused|slow down|offline/.test(error)) break; }
  }
  progress(null);
  if (saved === ids.length) toast('Saved the top ' + saved + ' ' + RANGE_LABEL[t] + ' from r/' + b.sub + '.', 5000);
  else toast('Saved ' + saved + ' of ' + ids.length + '. ' + error, 8000);
  render();
}

// If the app can't read the clipboard, show a box to paste into by hand.
function showPasteBox() {
  const box = $('#pasteBox');
  if (!box) { toast('Couldn’t read the clipboard.'); return; }
  box.hidden = false;
  const ta = $('textarea', box);
  ta.value = '';
  ta.focus();
  ta.oninput = () => { if (ta.value.trim()) { const v = ta.value; box.hidden = true; importText(v); } };
}

async function deletePost(id) {
  const row = await db.get('posts', id);
  await db.del('threads', id);
  await db.del('posts', id);
  if (row) await removeImages(row.media, id);
}

/* ================= Views ================= */

const view = $('#view');
let filterSub = '';
let search = '';

const ICONS = {
  paste: '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M9 3.5h6v3H9z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M9 5H6.5A1.5 1.5 0 0 0 5 6.5v13A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5v-13A1.5 1.5 0 0 0 17.5 5H15" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 10v7m-3-3 3 3 3-3" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  pin: '<svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><path d="M6 3h12v18l-6-4-6 4z" fill="currentColor"/></svg>',
};

function isStandalone() { return navigator.standalone === true || matchMedia('(display-mode: standalone)').matches; }
function isIOS() { return /iPhone|iPad|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1); }

function installCardHtml() {
  let hidden = false;
  try { hidden = sessionStorage.getItem('tk-install-hidden') === '1'; } catch {}
  if (!isIOS() || isStandalone() || hidden) return '';
  return `<section class="card notice">
    <div class="card-head"><h2>Install it on your iPhone</h2><button class="x" id="installClose" aria-label="Hide for now">×</button></div>
    <ol class="steps">
      <li>Open Safari (it has to be Safari) and go to <code>https://chirapat.github.io/threadkeep/</code></li>
      <li>Tap the Share button (the square with an arrow) → scroll down → Add to Home Screen → Add.</li>
      <li>From now on, always open ThreadKeep from the new icon on your Home Screen. Your saved posts live there, separate from Safari.</li>
    </ol>
  </section>`;
}

function setupStepsHtml() {
  return `<ol class="steps">
    <li>Open the <b>Settings</b> app → <b>Apps</b> → <b>Shortcuts</b> → <b>Advanced</b> → turn on <b>Allow Running Scripts</b>.</li>
    <li><a href="${SHORTCUT_URL}">Get the “Save to ThreadKeep” Shortcut</a> → <b>Add Shortcut</b>.</li>
    <li>Sign in at <b>reddit.com</b> in Safari.</li>
  </ol>`;
}

function howToHtml() {
  return `<div class="howto">
    <div><span class="num">1</span><p>In <b>Safari</b>, open a Reddit post or a subreddit like <b>r/AskReddit</b>.</p></div>
    <div><span class="num">2</span><p>Tap <b>Share</b> → <b>Save to ThreadKeep</b>, then pick this post or the top posts, from when, and how many comments.</p></div>
    <div><span class="num">3</span><p>Come back and tap <b>Paste from Shortcut</b>.</p></div>
  </div>`;
}

async function renderHome() {
  setHeader('ThreadKeep', false);
  const posts = (await db.all('posts')).sort((a, b) => b.savedAt - a.savedAt);
  const used = posts.reduce((n, p) => n + (p.bytes || 0), 0);
  const pct = Math.min(100, used / limitBytes() * 100);
  const nsfwCount = posts.filter(p => p.nsfw).length;
  const visible = settings.showNsfw ? posts : posts.filter(p => !p.nsfw);
  const subCounts = {};
  for (const p of visible) if (p.subreddit) subCounts[p.subreddit] = (subCounts[p.subreddit] || 0) + 1;
  const subs = Object.keys(subCounts).sort((a, b) => subCounts[b] - subCounts[a]);
  if (filterSub && !subCounts[filterSub]) filterSub = '';
  const q = search.toLowerCase();
  const shown = visible.filter(p => (!filterSub || p.subreddit === filterSub) && (!q || (p.title + ' ' + p.subreddit).toLowerCase().includes(q)));
  const setupDone = store.get('tk-setup-done', false) || posts.length > 0;

  view.innerHTML = `
    ${installCardHtml()}
    ${!setupDone ? `<section class="card setup">
        <h2>Set up in 3 steps</h2>
        <p class="muted">Reddit only lets you download while you’re signed in, so a free Shortcut grabs threads from Safari for you.</p>
        ${setupStepsHtml()}
        <button class="btn small" id="setupDone">I’ve done this</button>
      </section>` : ''}

    <button class="paste-btn" id="pasteBtn">${ICONS.paste}<span>Paste from Shortcut</span></button>
    <div id="pasteBox" class="card" hidden>
      <p class="muted" style="margin:0 0 8px">Touch and hold the box, then tap <b>Paste</b>.</p>
      <textarea rows="2" aria-label="Paste the copied thread here"></textarea>
    </div>

    ${!posts.length ? `<section class="empty">${howToHtml()}</section>` : `
      <div class="toolbar">
        <div class="gauge">
          <div class="gauge-bar"><div class="gauge-fill ${pct >= 95 ? 'full' : ''}" style="width:${pct}%"></div></div>
          <span>${fmtBytes(used)} of ${fmtBytes(limitBytes())}</span>
        </div>
        <label class="switch"><span>NSFW${nsfwCount && !settings.showNsfw ? ` <small>(${nsfwCount} hidden)</small>` : ''}</span>
          <input type="checkbox" role="switch" class="toggle" id="nsfwToggle" ${settings.showNsfw ? 'checked' : ''}></label>
      </div>
      ${subs.length > 1 ? `<div class="chips" id="chips">
        <button data-sub="" aria-pressed="${!filterSub}">All <small>${visible.length}</small></button>
        ${subs.map(s => `<button data-sub="${esc(s)}" aria-pressed="${filterSub === s}">r/${esc(s)} <small>${subCounts[s]}</small></button>`).join('')}
      </div>` : ''}
      ${visible.length > 6 ? `<input type="search" id="search" class="search" placeholder="Search saved threads" value="${esc(search)}">` : ''}
      <div class="list">${shown.map(itemHtml).join('') || '<p class="empty muted">Nothing matches.</p>'}</div>
    `}`;

  $('#pasteBtn').onclick = pasteFromShortcut;
  const sd = $('#setupDone'); if (sd) sd.onclick = () => { store.set('tk-setup-done', true); renderHome(); };
  const ic = $('#installClose'); if (ic) ic.onclick = () => { try { sessionStorage.setItem('tk-install-hidden', '1'); } catch {} renderHome(); };
  const nt = $('#nsfwToggle'); if (nt) nt.onchange = () => { settings.showNsfw = nt.checked; saveSettings(); renderHome(); };
  const ch = $('#chips'); if (ch) ch.onclick = (e) => { const b = e.target.closest('button'); if (b) { filterSub = b.dataset.sub; renderHome(); } };
  const se = $('#search');
  if (se) se.oninput = () => {
    search = se.value; const pos = se.selectionStart;
    renderHome().then(() => { const n = $('#search'); if (n) { n.focus(); n.setSelectionRange(pos, pos); } });
  };
}

function itemHtml(p) {
  const blur = p.nsfw && settings.blurNsfw;
  return `<a class="item" href="#/p/${esc(p.id)}">
    <div class="item-body">
      <div class="item-sub">r/${esc(p.subreddit)}${p.nsfw ? ' <span class="tag nsfw">NSFW</span>' : ''}${p.pinned ? ` <span class="tag kept">${ICONS.pin} Kept</span>` : ''}</div>
      <div class="item-title">${esc(p.title)}</div>
      <div class="item-meta">${plural(p.savedComments || 0, 'comment')} · ${fmtBytes(p.bytes)}${p.textOnly ? ' · text only' : ''}${p.complete === false ? ' · saving…' : ''}</div>
    </div>
    ${p.thumb ? `<img class="thumb ${blur ? 'blurred' : ''}" src="${esc(p.thumb)}" alt="" loading="lazy" onerror="this.remove()">` : ''}
  </a>`;
}

function commentHtml(c, level) {
  return `<div class="c" style="--lvl:${level % 5}">
    <div class="c-head" data-toggle>
      <span class="c-author ${c.op ? 'op' : ''}">${esc(c.a)}</span>${c.op ? '<span class="tag op">OP</span>' : ''}
      <span>${fmtNum(c.s)} pts · ${fmtAgo(c.t)}${c.e ? ' · edited' : ''}</span>
    </div>
    <div class="c-body rich">${c.h}</div>
    ${c.r.length ? `<div class="c-replies">${c.r.map(r => commentHtml(r, level + 1)).join('')}</div>` : ''}
    ${c.m ? `<div class="c-more">${plural(c.m, 'more reply', 'more replies')} not saved</div>` : ''}
  </div>`;
}

async function renderPost(id) {
  const row = await db.get('posts', id);
  const thread = await db.get('threads', id);
  if (!row || !thread) { setHeader('', true); view.innerHTML = '<p class="empty muted">This thread isn’t saved anymore.</p>'; return; }
  const p = thread.post;
  setHeader('r/' + p.subreddit, true);
  const blur = p.nsfw && settings.blurNsfw;
  const outLink = p.url && !/^https:\/\/(i|v|preview)\.redd\.it\//.test(p.url) && !/\.(jpe?g|png|gif|webp)(\?|$)/i.test(p.url)
    && !p.url.includes('/comments/') && !p.url.includes('/gallery/');
  view.innerHTML = `
    <article class="post ${blur ? 'nsfw-blur' : ''}">
      <div class="post-meta">u/${esc(p.author)} · ${fmtAgo(p.created)} ago${p.flair ? ` · <span class="tag">${esc(p.flair)}</span>` : ''}${p.nsfw ? ' <span class="tag nsfw">NSFW</span>' : ''}</div>
      <h2>${esc(p.title)}</h2>
      ${p.media.map(m => `<figure><img src="${esc(m.url)}" alt="" loading="lazy" onerror="this.closest('figure').remove()">${m.caption ? `<figcaption>${esc(m.caption)}</figcaption>` : ''}</figure>`).join('')}
      ${p.html ? `<div class="rich">${p.html}</div>` : ''}
      ${outLink ? `<a class="link-out" href="${esc(p.url)}" target="_blank" rel="noopener noreferrer">${esc(p.url)}</a>` : ''}
      <div class="post-stats">${fmtNum(p.score)} points · ${fmtNum(p.numComments)} comments on Reddit · saved ${new Date(thread.fetchedAt).toLocaleDateString()}</div>
      <div class="actions">
        <button class="btn small ${row.pinned ? 'on' : ''}" id="pinBtn">${ICONS.pin} ${row.pinned ? 'Kept' : 'Keep'}</button>
        <a class="btn small" href="${esc(p.permalink)}" target="_blank" rel="noopener noreferrer">Open on Reddit</a>
        <button class="btn small danger" id="delBtn">Delete</button>
      </div>
    </article>
    <div class="comments-head"><h3>${plural(countComments(thread.comments), 'comment')}</h3><span class="muted small">Tap a name to collapse</span></div>
    <div class="comments ${blur ? 'nsfw-blur' : ''}">${thread.comments.map(c => commentHtml(c, 0)).join('') || '<p class="muted">No comments were saved.</p>'}
      ${thread.more ? `<p class="c-more">${fmtNum(thread.more)} more comments on Reddit</p>` : ''}</div>`;

  view.onclick = (e) => {
    const im = e.target.closest('.nsfw-blur img:not(.revealed)');
    if (im) { e.preventDefault(); im.classList.add('revealed'); return; }
    const head = e.target.closest('[data-toggle]');
    if (head && !e.target.closest('a')) head.parentElement.classList.toggle('collapsed');
  };
  $('#pinBtn').onclick = async () => {
    row.pinned = !row.pinned; await db.put('posts', row);
    toast(row.pinned ? 'Kept: it won’t be removed when storage fills up.' : 'No longer kept.');
    renderPost(id);
  };
  $('#delBtn').onclick = async () => {
    if (!confirm('Delete this thread from your phone?')) return;
    await deletePost(id); location.hash = '#/';
  };
}

function seg(name, options, current) {
  return `<div class="seg" data-setting="${name}">${options.map(([v, label]) =>
    `<button type="button" data-value="${esc(v)}" aria-pressed="${String(v) === String(current)}">${label}</button>`).join('')}</div>`;
}

async function renderSettings() {
  setHeader('Settings', true);
  const used = await usedBytes();
  let persisted = false;
  try { persisted = await navigator.storage.persisted(); } catch {}
  view.innerHTML = `
    <section class="group"><h3>Storage</h3>
      <div class="field"><label>Space for saved threads</label>
        ${seg('limitMB', [[250, '250 MB'], [500, '500 MB'], [1000, '1 GB'], [2000, '2 GB']], settings.limitMB)}
        <p class="muted small">Using ${fmtBytes(used)}.${persisted ? '' : ' Open ThreadKeep from your Home Screen so iPhone keeps your threads.'}</p>
      </div>
      <div class="field"><label>When it’s full</label>
        ${seg('whenFull', [['evict', 'Remove oldest'], ['textonly', 'Save text only']], settings.whenFull)}
        <p class="muted small">Threads you mark <b>Keep</b> are never removed.</p>
      </div>
    </section>

    <section class="group"><h3>Reading</h3>
      <div class="field"><label>Text size</label>
        ${seg('fontSize', [[15, 'Small'], [17, 'Medium'], [19, 'Large'], [21, 'Larger']], settings.fontSize)}
      </div>
      <div class="field row-field"><label for="blurNsfw">Blur NSFW images until tapped</label>
        <input type="checkbox" role="switch" class="toggle" id="blurNsfw" ${settings.blurNsfw ? 'checked' : ''}></div>
    </section>

    <section class="group"><h3>The Shortcut</h3>
      <div class="field">
        <p class="label">Setup</p>
        ${setupStepsHtml()}
        <p class="label">Saving</p>
        ${howToHtml()}
        <p class="muted small">ThreadKeep downloads using your Safari sign-in, so even top 25 with 200 comments saves in one run.</p>
        <details><summary>The Shortcut link doesn’t work?</summary>
          <ol class="steps">
            <li>Open <b>Shortcuts</b> → <b>+</b>, name it <b>Save to ThreadKeep</b>.</li>
            <li>Tap <b>ⓘ</b> → turn on <b>Show in Share Sheet</b>, receiving <b>Safari web pages</b>.</li>
            <li>Add <b>Run JavaScript on Web Page</b> and replace its code with the script (button below). Edit its first line to choose what to save, e.g. <code>what: "Top 10 posts", range: "This week", comments: "100 comments"</code>.</li>
            <li>Add <b>Copy to Clipboard</b>.</li>
          </ol>
          <button class="btn small" id="copyScript">Copy the script</button>
        </details>
      </div>
    </section>

    <section class="group"><h3>Delete</h3>
      <div class="field"><button class="btn danger block" id="wipe">Delete all saved threads</button></div>
    </section>
    <p class="muted small center">ThreadKeep ${APP_VERSION} · Everything stays on this phone.</p>`;

  view.querySelectorAll('.seg').forEach(s => s.addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    const key = s.dataset.setting;
    settings[key] = typeof DEFAULTS[key] === 'number' ? Number(b.dataset.value) : b.dataset.value;
    saveSettings();
    s.querySelectorAll('button').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
    if (key === 'limitMB') makeRoom(0).then(() => toast('Storage limit: ' + fmtBytes(limitBytes())));
  }));
  $('#blurNsfw').onchange = (e) => { settings.blurNsfw = e.target.checked; saveSettings(); };
  $('#copyScript').onclick = async () => {
    try {
      const js = await (await fetch('shortcut/save-to-threadkeep.js', { cache: 'no-store' })).text();
      await navigator.clipboard.writeText(js);
      toast('Script copied.');
    } catch { toast('Couldn’t copy. Are you online?'); }
  };
  $('#wipe').onclick = async () => {
    if (!confirm('Delete every saved thread and image from this phone? This can’t be undone.')) return;
    for (const p of await db.all('posts')) await deletePost(p.id);
    await caches.delete(MEDIA_CACHE);
    toast('Everything deleted.');
    renderSettings();
  };
}

/* ================= Shell, routing, startup ================= */

function setHeader(title, back) {
  $('#title').textContent = title;
  $('#backBtn').hidden = !back;
  $('#settingsBtn').hidden = location.hash === '#/settings';
}

let renderTimer;
function render() { clearTimeout(renderTimer); renderTimer = setTimeout(route, 20); }
function route() {
  view.onclick = null;
  const h = location.hash;
  if (h.startsWith('#/p/')) return renderPost(decodeURIComponent(h.slice(4)));
  if (h === '#/settings') return renderSettings();
  return renderHome();
}
window.addEventListener('hashchange', () => { route(); window.scrollTo(0, 0); });
$('#backBtn').onclick = () => { location.hash = '#/'; };
$('#settingsBtn').onclick = () => { location.hash = '#/settings'; };

// iPhone keeps Home Screen apps running, so a new version may never load by itself.
async function checkForUpdate() {
  if (!navigator.onLine) return;
  try {
    const res = await fetch('version.json?t=' + Date.now(), { cache: 'no-store' });
    const { version } = await res.json();
    if (!version || version === APP_VERSION) return;
    let tried = ''; try { tried = sessionStorage.getItem('tk-reloaded-for') || ''; } catch {}
    if (tried === version) return;
    try { sessionStorage.setItem('tk-reloaded-for', version); } catch {}
    const reg = await navigator.serviceWorker?.getRegistration();
    if (reg) await reg.update().catch(() => {});
    location.reload();
  } catch {}
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) checkForUpdate(); });

// Removes leftovers from version 1 (rows that never downloaded, and settings that no longer exist).
async function cleanUpOldVersion() {
  for (const p of await db.all('posts')) {
    if (!(await db.get('threads', p.id))) { await db.del('posts', p.id); continue; }
    if (p.complete === undefined) { p.complete = true; delete p.status; delete p.error; await db.put('posts', p); }
  }
  for (const k of ['tk-token', 'tk-device', 'tk-seen', 'tk-lastsync', 'tk-syncerr', 'tk-nsfw-on']) { try { localStorage.removeItem(k); } catch {} }
  saveSettings();
}

(async function start() {
  checkForUpdate();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  try { if (navigator.storage?.persist) await navigator.storage.persist(); } catch {}
  await cleanUpOldVersion().catch(() => {});
  route();
})();
