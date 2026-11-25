/* ThreadKeep — save Reddit threads (post + comments + images) for offline reading.
 * Everything is stored on the device: thread text in IndexedDB, images in the Cache API.
 */
'use strict';

const MEDIA_CACHE = 'tk-media-v1';
const MB = 1024 * 1024;

/* ---------------- Settings ---------------- */

const DEFAULTS = {
  limitMB: 500,          // offline storage budget
  whenFull: 'evict',     // 'evict' = remove oldest unpinned posts, 'stop' = save text only
  topComments: 100,      // number of top-level comments kept
  depth: 4,              // reply levels kept under each top-level comment
  sort: 'top',
  images: 'phone',       // 'phone' (≈1080px), 'original', 'none'
  commentImages: true,
  fontSize: 17,
  clientId: '',
  nsfw: 'blur',          // 'show', 'blur' (blur images until tapped), 'hide' (hidden from library and never auto-downloaded)
  subs: [],              // favourite subreddits to auto-download from, e.g. ['AskReddit']
  subCount: 10,          // posts per subreddit per check
  subSort: 'top-day',    // 'hot', 'top-day', 'top-week'
  syncHours: 6,          // how often to check favourites (0 = only when I tap "Check now")
};

function loadSettings() {
  let s;
  try { s = { ...DEFAULTS, ...JSON.parse(localStorage.getItem('tk-settings') || '{}') }; }
  catch { s = { ...DEFAULTS }; }
  s.subs = Array.isArray(s.subs) ? [...s.subs] : [];
  return s;
}

/* ---------------- Seen list (so deleted or already-fetched posts aren't auto-downloaded again) ---------------- */

function getSeen() { try { return new Set(JSON.parse(localStorage.getItem('tk-seen') || '[]')); } catch { return new Set(); } }
function addSeen(ids) {
  const seen = [...getSeen(), ...ids];
  try { localStorage.setItem('tk-seen', JSON.stringify([...new Set(seen)].slice(-3000))); } catch {}
}
let settings = loadSettings();
function saveSettings() {
  try { localStorage.setItem('tk-settings', JSON.stringify(settings)); } catch {}
  document.documentElement.style.setProperty('--reader-size', settings.fontSize + 'px');
}
document.documentElement.style.setProperty('--reader-size', settings.fontSize + 'px');

/* ---------------- IndexedDB ---------------- */

const dbReady = new Promise((resolve, reject) => {
  const req = indexedDB.open('threadkeep', 1);
  req.onupgradeneeded = () => {
    const db = req.result;
    db.createObjectStore('posts', { keyPath: 'id' });   // small summary rows for the library
    db.createObjectStore('threads', { keyPath: 'id' }); // full post + comment tree
  };
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

async function tx(store, mode, fn) {
  const db = await dbReady;
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let result;
    const r = fn(s);
    if (r) r.onsuccess = () => { result = r.result; };
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('Storage write failed'));
  });
}
const db = {
  get: (store, id) => tx(store, 'readonly', s => s.get(id)),
  all: (store) => tx(store, 'readonly', s => s.getAll()),
  put: (store, val) => tx(store, 'readwrite', s => s.put(val)),
  del: (store, id) => tx(store, 'readwrite', s => s.delete(id)),
};

/* ---------------- Helpers ---------------- */

const $ = (sel, el = document) => el.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const unamp = (s) => String(s || '').replace(/&amp;/g, '&');

function fmtBytes(b) {
  if (!b) return '0 MB';
  if (b < MB) return Math.max(1, Math.round(b / 1024)) + ' KB';
  if (b < 1024 * MB) return (b / MB).toFixed(b < 10 * MB ? 1 : 0) + ' MB';
  return (b / 1024 / MB).toFixed(2) + ' GB';
}
function fmtAgo(sec) {
  const d = Date.now() / 1000 - sec;
  if (d < 3600) return Math.max(1, Math.floor(d / 60)) + 'm';
  if (d < 86400) return Math.floor(d / 3600) + 'h';
  if (d < 86400 * 30) return Math.floor(d / 86400) + 'd';
  if (d < 86400 * 365) return Math.floor(d / 86400 / 30) + 'mo';
  return Math.floor(d / 86400 / 365) + 'y';
}
function fmtNum(n) { return n >= 10000 ? (n / 1000).toFixed(0) + 'k' : n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n ?? 0); }

let toastTimer;
function toast(msg, ms = 2600) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

function textBytes(obj) { return new Blob([JSON.stringify(obj)]).size; }

/* ---------------- Reddit link parsing ---------------- */

// Returns { id } for direct links, { short: url } for /s/ share links, or null.
function parseRedditLink(input) {
  const text = String(input || '').trim();
  const m = text.match(/https?:\/\/[^\s<>"']+/i);
  const raw = m ? m[0] : text;
  let u;
  try { u = new URL(raw.startsWith('http') ? raw : 'https://' + raw); } catch { return null; }
  const host = u.hostname.replace(/^www\.|^old\.|^new\.|^np\.|^m\.|^i\./, '');
  if (host === 'redd.it') {
    const id = u.pathname.split('/').filter(Boolean)[0];
    return id ? { id: id.toLowerCase() } : null;
  }
  if (!/(^|\.)reddit\.com$/.test(host) && host !== 'reddit.app.link') return null;
  const parts = u.pathname.split('/').filter(Boolean);
  const ci = parts.indexOf('comments');
  if (ci >= 0 && parts[ci + 1]) return { id: parts[ci + 1].toLowerCase() };
  if (parts[0] === 'comments' && parts[1]) return { id: parts[1].toLowerCase() };
  if (parts.includes('s') || host === 'reddit.app.link') return { short: u.href };
  return null;
}

/* ---------------- Reddit API ---------------- */

function deviceId() {
  let id = localStorage.getItem('tk-device');
  if (!id) {
    id = Array.from(crypto.getRandomValues(new Uint8Array(15)), b => b.toString(16).padStart(2, '0')).join('');
    try { localStorage.setItem('tk-device', id); } catch {}
  }
  return id;
}

async function getToken() {
  if (!settings.clientId) return null;
  try {
    const cached = JSON.parse(localStorage.getItem('tk-token') || 'null');
    if (cached && cached.cid === settings.clientId && cached.exp > Date.now() + 60000) return cached.token;
  } catch {}
  const res = await fetch('https://www.reddit.com/api/v1/access_token', {
    method: 'POST',
    headers: { Authorization: 'Basic ' + btoa(settings.clientId.trim() + ':') },
    body: new URLSearchParams({ grant_type: 'https://oauth.reddit.com/grants/installed_client', device_id: deviceId() }),
  });
  if (!res.ok) throw new ApiError(res.status === 401 ? 'Reddit rejected the client ID. Check it in Settings.' : 'Could not sign in to Reddit (' + res.status + ').', false);
  const data = await res.json();
  if (!data.access_token) throw new ApiError('Reddit rejected the client ID: ' + (data.error || 'unknown error'), false);
  try { localStorage.setItem('tk-token', JSON.stringify({ cid: settings.clientId, token: data.access_token, exp: Date.now() + data.expires_in * 1000 })); } catch {}
  return data.access_token;
}

class ApiError extends Error {
  constructor(msg, retry) { super(msg); this.retry = retry; }
}

async function redditGet(path) {
  const token = await getToken();
  const url = token ? 'https://oauth.reddit.com' + path : 'https://www.reddit.com' + path.replace(/(\?|$)/, '.json$1');
  let res;
  try {
    res = await fetch(url, token ? { headers: { Authorization: 'Bearer ' + token } } : {});
  } catch {
    if (!navigator.onLine) throw new ApiError('Offline. Will download when you are back online.', true);
    throw new ApiError(token
      ? 'Could not reach Reddit. Will retry later.'
      : 'Reddit blocked the request. Add your free Reddit client ID in Settings.', !!token);
  }
  if (res.status === 401 && token) { localStorage.removeItem('tk-token'); throw new ApiError('Reddit sign-in expired. Will retry.', true); }
  if (res.status === 429) throw new ApiError('Reddit rate limit hit. Will retry in a minute.', true);
  if (res.status === 403) throw new ApiError(token ? 'This post is private or removed.' : 'Reddit blocked the request. Add your free Reddit client ID in Settings.', false);
  if (res.status === 404) throw new ApiError('Post not found.', false);
  if (!res.ok) throw new ApiError('Reddit error ' + res.status + '. Will retry.', true);
  return res;
}

async function resolveShortLink(short) {
  // Share links like reddit.com/r/sub/s/AbC123 redirect to the real post. Try to follow that redirect.
  const u = new URL(short);
  const attempts = [];
  try {
    const token = await getToken();
    if (token) attempts.push(() => fetch('https://oauth.reddit.com' + u.pathname, { headers: { Authorization: 'Bearer ' + token } }));
  } catch {}
  attempts.push(() => fetch('https://www.reddit.com' + u.pathname));
  for (const go of attempts) {
    try {
      const res = await go();
      const p = parseRedditLink(res.url);
      if (p && p.id) return p.id;
    } catch {}
  }
  return null;
}

/* ---------------- HTML sanitising ---------------- */

const ALLOWED = new Set(['A', 'P', 'BR', 'HR', 'B', 'STRONG', 'I', 'EM', 'DEL', 'S', 'SUP', 'SUB', 'CODE', 'PRE', 'BLOCKQUOTE', 'UL', 'OL', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TH', 'TD', 'SPAN', 'DIV', 'IMG']);
const IMG_HOST = /^https:\/\/(preview|i)\.redd\.it\//;

// Cleans Reddit's HTML. Links to Reddit-hosted images become <img> tags (their URLs are pushed to `images`).
function sanitize(html, images, allowImages) {
  if (!html) return '';
  // Reddit sends *_html fields entity-encoded ("&lt;div class=md&gt;…"). Decode once if needed.
  if (!html.includes('<')) html = new DOMParser().parseFromString(html, 'text/html').documentElement.textContent;
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const walk = (node) => {
    for (const el of [...node.children]) {
      if (!ALLOWED.has(el.tagName) || (el.tagName === 'IMG' && !allowImages)) {
        if (['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'FORM'].includes(el.tagName)) { el.remove(); continue; }
        if (el.tagName === 'IMG') { el.remove(); continue; }
        el.replaceWith(...el.childNodes);
        continue;
      }
      for (const attr of [...el.attributes]) {
        const keep = (el.tagName === 'A' && attr.name === 'href') || (el.tagName === 'IMG' && (attr.name === 'src' || attr.name === 'alt'));
        if (!keep) el.removeAttribute(attr.name);
      }
      if (el.tagName === 'A') {
        let href = el.getAttribute('href') || '';
        if (href.startsWith('/')) href = 'https://www.reddit.com' + href;
        if (!/^https?:/i.test(href)) { el.removeAttribute('href'); continue; }
        if (allowImages && IMG_HOST.test(href) && /\.(jpe?g|png|gif|webp)(\?|$)/i.test(href)) {
          const img = doc.createElement('img');
          img.src = href; img.alt = el.textContent || 'image'; img.loading = 'lazy';
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
        el.setAttribute('loading', 'lazy');
      }
      walk(el);
    }
  };
  walk(doc.body);
  return doc.body.innerHTML;
}

/* ---------------- Turning Reddit JSON into a compact thread ---------------- */

function pickRes(preview, quality) {
  const img = preview?.images?.[0];
  if (!img) return null;
  if (quality === 'original') return unamp(img.source?.url);
  const fits = (img.resolutions || []).filter(r => r.width <= 1080);
  const best = fits[fits.length - 1] || img.source;
  return unamp(best?.url);
}
function pickThumb(preview) {
  const res = preview?.images?.[0]?.resolutions || [];
  const r = res.find(x => x.width >= 140) || res[res.length - 1];
  return r ? unamp(r.url) : null;
}

function extractMedia(p, quality) {
  // Returns [{ url, caption }]
  if (quality === 'none') return [];
  const src = p.crosspost_parent_list?.[0] || p;
  const out = [];
  if (src.is_gallery && src.gallery_data && src.media_metadata) {
    for (const item of src.gallery_data.items || []) {
      const m = src.media_metadata[item.media_id];
      if (!m || m.status !== 'valid') continue;
      let url;
      if (quality === 'original') url = m.s?.u || m.s?.gif;
      else {
        const fits = (m.p || []).filter(r => r.x <= 1080);
        url = (fits[fits.length - 1] || m.s)?.u || m.s?.gif;
      }
      if (url) out.push({ url: unamp(url), caption: item.caption || '' });
    }
    return out;
  }
  const url = src.url_overridden_by_dest || src.url || '';
  const directImg = /\.(jpe?g|png|gif|webp)(\?|$)/i.test(url) && !/\.gifv$/i.test(url);
  if (src.post_hint === 'image' || directImg) {
    const u = quality === 'original' && directImg ? url : (pickRes(src.preview, quality) || (directImg ? url : null));
    if (u) out.push({ url: u, caption: '' });
    return out;
  }
  // Videos and links: keep the preview picture so the post still makes sense offline.
  const pic = pickRes(src.preview, 'phone');
  if (pic) out.push({ url: pic, caption: src.is_video ? 'Video (only the preview image is saved offline)' : '' });
  return out;
}

function trimComments(children, depthLeft, limit, images) {
  const out = [];
  let more = 0;
  for (const ch of children || []) {
    if (ch.kind === 'more') { more += ch.data.count || ch.data.children?.length || 0; continue; }
    if (ch.kind !== 't1') continue;
    if (limit && out.length >= limit) { more += 1; continue; }
    const d = ch.data;
    const node = {
      a: d.author, op: !!d.is_submitter, s: d.score, t: d.created_utc,
      h: d.body_html ? sanitize(d.body_html, images, settings.images !== 'none' && settings.commentImages) : esc(d.body || ''),
      f: d.author_flair_text || '', st: !!d.stickied, e: !!d.edited,
      r: [], m: 0,
    };
    const replies = d.replies?.data?.children || [];
    if (depthLeft > 0) {
      const sub = trimComments(replies, depthLeft - 1, 0, images);
      node.r = sub.list; node.m = sub.more;
    } else {
      node.m = replies.reduce((n, c) => n + (c.kind === 'more' ? (c.data.count || 0) : 1), 0);
    }
    out.push(node);
  }
  return { list: out, more };
}

function countComments(list) { return list.reduce((n, c) => n + 1 + countComments(c.r), 0); }

/* ---------------- Media caching ---------------- */

// Downloads an image into the media cache. Returns its size in bytes, or -1 if unknown (cross-site image without CORS).
async function cacheMedia(url) {
  const cache = await caches.open(MEDIA_CACHE);
  const hit = await cache.match(url);
  if (hit) return 0; // already stored (shared with another post)
  try {
    const res = await fetch(url, { mode: 'cors', credentials: 'omit' });
    if (!res.ok) throw new Error(res.status);
    const blob = await res.clone().blob();
    await cache.put(url, res);
    return blob.size;
  } catch {
    const res = await fetch(url, { mode: 'no-cors', credentials: 'omit' });
    await cache.put(url, res);
    return -1;
  }
}

async function removeMedia(urls, exceptId) {
  if (!urls?.length) return;
  const others = new Set();
  for (const p of await db.all('posts')) if (p.id !== exceptId) (p.media || []).forEach(u => others.add(u));
  const cache = await caches.open(MEDIA_CACHE);
  await Promise.all(urls.filter(u => !others.has(u)).map(u => cache.delete(u)));
}

async function estimateUsage() {
  try { return (await navigator.storage.estimate()).usage || 0; } catch { return 0; }
}

/* ---------------- Storage budget ---------------- */

async function usedBytes(exceptId) {
  return (await db.all('posts')).filter(p => p.id !== exceptId).reduce((n, p) => n + (p.bytes || 0), 0);
}
const limitBytes = () => settings.limitMB * MB;

// Frees space by removing the oldest unpinned saved posts. Returns true if `need` bytes now fit.
async function makeRoom(need, protectId) {
  let used = await usedBytes(protectId);
  if (used + need <= limitBytes()) return true;
  if (settings.whenFull !== 'evict') return false;
  const victims = (await db.all('posts'))
    .filter(p => p.id !== protectId && !p.pinned && p.status === 'ready')
    .sort((a, b) => (b.auto ? 1 : 0) - (a.auto ? 1 : 0) || a.savedAt - b.savedAt); // auto-downloaded posts go first
  for (const v of victims) {
    await deletePost(v.id, true);
    used -= v.bytes || 0;
    toast('Storage full: removed oldest post "' + v.title.slice(0, 40) + '"');
    if (used + need <= limitBytes()) return true;
  }
  return used + need <= limitBytes();
}

/* ---------------- Saving ---------------- */

let queueRunning = false;

async function savePostFromInput(input) {
  const parsed = parseRedditLink(input);
  if (!parsed) { toast('That doesn’t look like a Reddit post link.'); return; }
  let id = parsed.id;
  if (!id) {
    if (!navigator.onLine) { toast('Short share links need a connection. Try again when online.'); return; }
    toast('Resolving share link…');
    id = await resolveShortLink(parsed.short);
    if (!id) {
      toast('Couldn’t open that short share link. Use the “Expand link” Shortcut (see Settings → iPhone setup).', 6000);
      return;
    }
  }
  const existing = await db.get('posts', id);
  if (existing && existing.status === 'ready') { toast('Already saved — opening it.'); location.hash = '#/p/' + id; return; }
  await db.put('posts', {
    id, title: existing?.title || 'Waiting to download…', subreddit: existing?.subreddit || '', author: '',
    savedAt: Date.now(), status: 'pending', bytes: 0, media: [], pinned: false,
  });
  toast(navigator.onLine ? 'Saving…' : 'Queued — will download when online.');
  render();
  runQueue();
}

async function runQueue() {
  if (queueRunning || !navigator.onLine) return;
  queueRunning = true;
  try {
    const pending = (await db.all('posts')).filter(p => p.status === 'pending' || p.status === 'downloading').sort((a, b) => a.savedAt - b.savedAt);
    for (const p of pending) {
      try { await downloadThread(p.id); }
      catch (e) {
        const row = await db.get('posts', p.id);
        if (!row) continue;
        row.status = e.retry ? 'pending' : 'error';
        row.error = e.message;
        await db.put('posts', row);
        if (!e.retry) toast(e.message, 4000);
        render();
        if (e.retry) break; // network trouble — stop and try later
      }
    }
  } finally { queueRunning = false; }
}

async function downloadThread(id, refresh = false) {
  const row = (await db.get('posts', id)) || { id, savedAt: Date.now(), pinned: false };
  row.status = 'downloading'; row.error = '';
  await db.put('posts', row);
  render();

  const q = new URLSearchParams({ limit: '500', depth: String(settings.depth + 1), sort: settings.sort, raw_json: '1' });
  const res = await redditGet('/comments/' + id + '?' + q);
  const json = await res.json();
  const p = json?.[0]?.data?.children?.[0]?.data;
  if (!p) throw new ApiError('Post not found.', false);

  const images = [];
  const allowImg = settings.images !== 'none';
  const media = extractMedia(p, settings.images);
  const post = {
    id: p.id, title: p.title, subreddit: p.subreddit, author: p.author, score: p.score,
    created: p.created_utc, numComments: p.num_comments, flair: p.link_flair_text || '',
    nsfw: !!p.over_18, spoiler: !!p.spoiler,
    html: sanitize(p.selftext_html || p.crosspost_parent_list?.[0]?.selftext_html, images, allowImg),
    url: p.is_self ? '' : (p.url_overridden_by_dest || p.url || ''),
    permalink: 'https://www.reddit.com' + p.permalink,
    isVideo: !!(p.is_video || p.crosspost_parent_list?.[0]?.is_video),
    media,
  };
  const tree = trimComments(json?.[1]?.data?.children, settings.depth - 1, settings.topComments, images);
  const thread = { id, post, comments: tree.list, more: tree.more, fetchedAt: Date.now(), settings: { top: settings.topComments, depth: settings.depth, sort: settings.sort } };
  const tBytes = textBytes(thread);

  if (refresh) await removeMedia(row.media, id);

  if (!(await makeRoom(tBytes, id))) {
    throw new ApiError('Storage limit reached (' + fmtBytes(limitBytes()) + '). Free some space or raise the limit in Settings.', false);
  }
  await db.put('threads', thread);

  const thumb = allowImg ? pickThumb(p.preview || p.crosspost_parent_list?.[0]?.preview) || media[0]?.url || null : null;
  const urls = [...new Set([...(thumb ? [thumb] : []), ...media.map(m => m.url), ...images])];
  Object.assign(row, {
    title: post.title, subreddit: post.subreddit, author: post.author, created: post.created, score: post.score,
    numComments: post.numComments, savedComments: countComments(tree.list), thumb, media: [], bytes: tBytes,
    status: 'downloading', nsfw: post.nsfw,
  });
  await db.put('posts', row);
  render();

  // Images, one at a time, keeping inside the budget.
  let skipped = 0;
  for (const url of urls) {
    if (!(await makeRoom(256 * 1024, id))) { skipped = urls.length - row.media.length; break; }
    const before = await estimateUsage();
    let size;
    try { size = await cacheMedia(url); } catch { continue; }
    if (size === -1) size = Math.max(50 * 1024, (await estimateUsage()) - before);
    row.media.push(url);
    row.bytes += size;
    await db.put('posts', row);
  }
  row.status = 'ready';
  row.updatedAt = Date.now();
  row.textOnly = skipped > 0;
  await db.put('posts', row);
  if (skipped) toast('Saved text only — storage limit reached before all images were stored.', 4500);
  else toast('Saved for offline: ' + post.title.slice(0, 50));
  render();
}

/* ---------------- Favourite subreddits ---------------- */

let syncRunning = false;

function cleanSubName(s) {
  const name = String(s || '').trim().replace(/^.*reddit\.com\//i, '').replace(/^\/?r\//i, '').replace(/\/.*$/, '');
  return /^[A-Za-z0-9_]{2,21}$/.test(name) ? name : null;
}

function lastSync() { return Number(localStorage.getItem('tk-lastsync') || 0); }

// Looks at each favourite subreddit and queues new posts for download.
async function syncSubs(force = false) {
  if (syncRunning || !navigator.onLine || !settings.subs.length) return 0;
  if (!force && (!settings.syncHours || Date.now() - lastSync() < settings.syncHours * 3600000)) return 0;
  syncRunning = true;
  let queued = 0, failed = 0, lastErr = '';
  try {
    const seen = getSeen();
    const existing = new Set((await db.all('posts')).map(p => p.id));
    const [sort, t] = settings.subSort === 'hot' ? ['hot', ''] : ['top', settings.subSort === 'top-week' ? 'week' : 'day'];
    for (const sub of settings.subs) {
      const q = new URLSearchParams({ limit: String(settings.subCount + 5), raw_json: '1' });
      if (t) q.set('t', t);
      let list;
      try { list = await (await redditGet('/r/' + sub + '/' + sort + '?' + q)).json(); }
      catch (e) { failed++; lastErr = 'r/' + sub + ': ' + e.message; if (e.retry) break; continue; }
      let n = 0;
      const newIds = [];
      for (const ch of list?.data?.children || []) {
        const d = ch.data;
        if (!d || d.stickied || n >= settings.subCount) continue;
        n++;
        if (seen.has(d.id) || existing.has(d.id)) continue;
        if (d.over_18 && settings.nsfw === 'hide') continue;
        await db.put('posts', {
          id: d.id, title: d.title, subreddit: d.subreddit, author: d.author, nsfw: !!d.over_18,
          savedAt: Date.now(), status: 'pending', bytes: 0, media: [], pinned: false, auto: true,
        });
        newIds.push(d.id);
        queued++;
      }
      addSeen(newIds);
    }
    try {
      // Remember the failure so the home page can show it; only count the check as done if something worked.
      if (failed) localStorage.setItem('tk-syncerr', lastErr); else localStorage.removeItem('tk-syncerr');
      if (failed < settings.subs.length) localStorage.setItem('tk-lastsync', String(Date.now()));
    } catch {}
  } finally { syncRunning = false; }
  if (failed) toast(lastErr, 6000);
  else if (queued) toast('Downloading ' + queued + ' new post' + (queued > 1 ? 's' : '') + ' from your subreddits');
  render();
  if (queued) runQueue();
  return { queued, failed };
}

async function deletePost(id, silent) {
  addSeen([id]);
  const row = await db.get('posts', id);
  await db.del('threads', id);
  await db.del('posts', id);
  if (row) await removeMedia(row.media, id);
  if (!silent) render();
}

/* ---------------- Views ---------------- */

const view = $('#view');
let libraryFilter = '';
let libSub = '';
const blurOn = (p) => p.nsfw && settings.nsfw !== 'show';

// Show install steps on iPhone/iPad when the app is opened in the browser instead of from the Home Screen.
function showInstallHelp() {
  const standalone = navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
  let hidden = false;
  try { hidden = sessionStorage.getItem('tk-install-hidden') === '1'; } catch {}
  return ios && !standalone && !hidden;
}

async function renderLibrary() {
  $('#title').textContent = 'ThreadKeep';
  $('#backBtn').hidden = true;
  const posts = (await db.all('posts')).sort((a, b) => b.savedAt - a.savedAt);
  const used = posts.reduce((n, p) => n + (p.bytes || 0), 0);
  const pct = Math.min(100, used / limitBytes() * 100);
  const f = libraryFilter.toLowerCase();
  const nsfwCount = posts.filter(p => p.nsfw).length;
  const visible = settings.nsfw === 'hide' ? posts.filter(p => !p.nsfw) : posts;
  // Subreddit chips: favourites first, then any other subreddit you've saved from.
  const subCounts = {};
  for (const p of visible) if (p.subreddit) subCounts[p.subreddit] = (subCounts[p.subreddit] || 0) + 1;
  const chipSubs = [...new Set([...settings.subs.filter(s => subCounts[s]), ...Object.keys(subCounts).sort((a, b) => subCounts[b] - subCounts[a])])];
  if (libSub && !subCounts[libSub]) libSub = '';
  const shown = visible.filter(p => (!libSub || p.subreddit === libSub) && (!f || (p.title + ' ' + p.subreddit).toLowerCase().includes(f)));
  const ls = lastSync();
  let syncErr = '';
  try { syncErr = localStorage.getItem('tk-syncerr') || ''; } catch {}

  view.innerHTML = `
    ${showInstallHelp() ? `<section class="install-card">
      <div class="install-head"><h2>Install it on your iPhone</h2>
        <button class="icon-btn" id="installClose" aria-label="Hide for now">×</button></div>
      <ol class="steps">
        <li>Open Safari (it has to be Safari) and go to <code>https://chirapat.github.io/threadkeep/</code></li>
        <li>Tap the Share button (the square with an arrow) → scroll down → Add to Home Screen → Add.</li>
        <li>From now on, always open ThreadKeep from the new icon on your Home Screen. Your saved posts live there, separate from Safari.</li>
      </ol>
    </section>` : ''}
    <section class="save-card">
      <button class="btn primary block" id="pasteBtn">Paste link &amp; save</button>
      <form class="row" id="saveForm" style="margin-top:8px">
        <input type="url" id="urlInput" placeholder="…or type a reddit.com link" autocomplete="off" autocapitalize="off">
        <button class="btn" type="submit">Save</button>
      </form>
      ${!settings.clientId && posts.some(p => p.status === 'error' && /blocked/i.test(p.error || '')) ? `<p class="hint" style="color:var(--bad)">Reddit is blocking downloads on this connection. Try another network (Wi-Fi vs mobile data), or add a free Reddit client ID in <a href="#/settings">Settings</a>.</p>` : ''}
    </section>
    <div class="meter">
      <div class="meter-bar"><div class="meter-fill ${pct >= 99 ? 'full' : ''}" style="width:${pct}%"></div></div>
      <div class="meter-text"><span>${fmtBytes(used)} of ${fmtBytes(limitBytes())} used</span><span>${posts.length} saved</span></div>
    </div>
    ${settings.subs.length ? `<div class="sync">
      <span>Auto-download: ${settings.subs.map(s => 'r/' + esc(s)).join(', ')}<br><small>${ls ? 'Checked ' + fmtAgo(ls / 1000) + ' ago' : 'Not checked yet'}</small>
      ${syncErr ? `<br><small style="color:var(--bad)">Last check failed: ${esc(syncErr)}</small>` : ''}</span>
      <button class="btn" id="syncBtn">Check now</button></div>`
      : `<p class="hint" style="margin:0 2px 12px">Want posts downloaded automatically from subreddits like r/AskReddit? Add them in <a href="#/settings">Settings</a>.</p>`}
    <label class="nsfw-toggle">
      <span>Show NSFW${nsfwCount ? ` <small>${nsfwCount} saved${settings.nsfw === 'hide' ? ', hidden' : ''}</small>` : ''}</span>
      <input type="checkbox" role="switch" id="nsfwToggle" ${settings.nsfw !== 'hide' ? 'checked' : ''}>
    </label>
    ${chipSubs.length > 1 ? `<div class="chips">
      <button data-sub="" aria-pressed="${!libSub}">All</button>
      ${chipSubs.map(s => `<button data-sub="${esc(s)}" aria-pressed="${libSub === s}">r/${esc(s)} <small>${subCounts[s]}</small></button>`).join('')}
    </div>` : ''}
    ${posts.length > 4 ? `<input type="search" id="filter" placeholder="Search saved posts" value="${esc(libraryFilter)}" style="margin-bottom:12px">` : ''}
    <div class="list">
      ${shown.map(itemHtml).join('') || (posts.length ? '<p class="empty">No matches.</p>' : `
        <div class="empty"><h2>Nothing saved yet</h2>
        In the Reddit app tap <b>Share → Copy link</b>, then come back here and tap <b>Paste link &amp; save</b>.</div>`)}
    </div>`;

  $('#pasteBtn').onclick = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (!text) { toast('Clipboard is empty.'); return; }
      savePostFromInput(text);
    } catch { toast('Couldn’t read the clipboard — paste into the box instead.'); $('#urlInput').focus(); }
  };
  const ic = $('#installClose');
  if (ic) ic.onclick = () => { try { sessionStorage.setItem('tk-install-hidden', '1'); } catch {} renderLibrary(); };
  const chips = $('.chips');
  if (chips) chips.onclick = (e) => {
    const b = e.target.closest('button'); if (!b) return;
    libSub = b.dataset.sub;
    renderLibrary();
  };
  $('#nsfwToggle').onchange = (e) => {
    // Remember whether you prefer NSFW shown plainly or blurred, so switching back restores it.
    if (e.target.checked) settings.nsfw = localStorage.getItem('tk-nsfw-on') || 'blur';
    else { try { localStorage.setItem('tk-nsfw-on', settings.nsfw === 'hide' ? 'blur' : settings.nsfw); } catch {} settings.nsfw = 'hide'; }
    saveSettings();
    toast(e.target.checked ? 'NSFW posts shown.' : 'NSFW posts hidden and won’t be auto-downloaded.');
    renderLibrary();
  };
  const sb = $('#syncBtn');
  if (sb) sb.onclick = async () => {
    if (!navigator.onLine) { toast('You’re offline.'); return; }
    sb.disabled = true; sb.textContent = 'Checking…';
    const r = await syncSubs(true);
    if (r && !r.failed && !r.queued) toast('No new posts right now.');
    render();
  };
  $('#saveForm').onsubmit =(e) => { e.preventDefault(); const v = $('#urlInput').value; $('#urlInput').value = ''; savePostFromInput(v); };
  const fi = $('#filter');
  if (fi) fi.oninput = () => { libraryFilter = fi.value; const pos = fi.selectionStart; renderLibrary().then(() => { const n = $('#filter'); n.focus(); n.setSelectionRange(pos, pos); }); };
}

function itemHtml(p) {
  const badge = {
    pending: `<span class="badge warn">${navigator.onLine ? 'Queued' : 'Waiting for connection'}</span>`,
    downloading: '<span class="badge warn">Downloading…</span>',
    error: `<span class="badge bad">Failed</span>`,
    ready: p.textOnly ? '<span class="badge warn">Text only</span>' : '<span class="badge ok">Offline</span>',
  }[p.status] || '';
  return `<a class="item" href="#/p/${esc(p.id)}">
    ${p.thumb ? `<img class="thumb ${blurOn(p) ? 'blurred' : ''}" src="${esc(p.thumb)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">` : '<div class="thumb"></div>'}
    <div class="item-body">
      <div class="item-title">${esc(p.title)}</div>
      <div class="meta">
        ${p.subreddit ? `<span>r/${esc(p.subreddit)}</span>` : ''}
        ${p.savedComments != null ? `<span>${fmtNum(p.savedComments)} comment${p.savedComments === 1 ? '' : 's'}</span>` : ''}
        ${p.bytes ? `<span>${fmtBytes(p.bytes)}</span>` : ''}
        ${p.pinned ? '<span>📌 Kept</span>' : ''}
        ${p.nsfw ? '<span class="badge bad">NSFW</span>' : ''}
        ${p.auto ? '<span class="badge">Auto</span>' : ''}
        ${badge}
      </div>
      ${p.status === 'error' ? `<div class="meta" style="color:var(--bad)">${esc(p.error)}</div>` : ''}
    </div>
  </a>`;
}

function commentHtml(c, level) {
  const color = `var(--thread-${(level % 5) + 1})`;
  return `<div class="c" style="--thread-color:${color}">
    <div class="c-head" data-toggle>
      <span class="c-author ${c.op ? 'op' : ''}">${esc(c.a)}${c.op ? ' · OP' : ''}</span>
      ${c.f ? `<span>${esc(c.f)}</span>` : ''}
      <span>▲ ${fmtNum(c.s)}</span>
      <span>${fmtAgo(c.t)}${c.e ? ' · edited' : ''}</span>
      ${c.st ? '<span>📌</span>' : ''}
    </div>
    <div class="c-body rich">${c.h}</div>
    ${c.r.length || c.m ? `<div class="c-replies">${c.r.map(r => commentHtml(r, level + 1)).join('')}
      ${c.m ? `<div class="more">${c.m} more ${c.m === 1 ? 'reply' : 'replies'} not saved</div>` : ''}</div>` : ''}
  </div>`;
}

async function renderPost(id) {
  $('#backBtn').hidden = false;
  const row = await db.get('posts', id);
  const thread = await db.get('threads', id);
  if (!row) { $('#title').textContent = 'Not found'; view.innerHTML = '<p class="empty">This post isn’t saved.</p>'; return; }
  $('#title').textContent = row.subreddit ? 'r/' + row.subreddit : 'Post';
  if (!thread) {
    view.innerHTML = `<div class="post"><h2>${esc(row.title)}</h2>
      <p>${row.status === 'error' ? esc(row.error) : 'Not downloaded yet. It will download automatically when you’re online.'}</p>
      <div class="actions"><button class="btn" id="retryBtn">Try again</button><button class="btn danger" id="delBtn">Delete</button></div></div>`;
    $('#retryBtn').onclick = async () => { row.status = 'pending'; await db.put('posts', row); runQueue(); render(); };
    $('#delBtn').onclick = async () => { await deletePost(id); location.hash = '#/'; };
    return;
  }
  const p = thread.post;
  view.className = blurOn(row) ? 'nsfw-blur' : '';
  view.innerHTML = `
    <article class="post">
      <div class="meta">
        <span>r/${esc(p.subreddit)}</span><span>u/${esc(p.author)}</span><span>${fmtAgo(p.created)} ago</span>
        ${p.flair ? `<span class="badge">${esc(p.flair)}</span>` : ''}
        ${p.nsfw ? '<span class="badge bad">NSFW</span>' : ''}
      </div>
      <h2>${esc(p.title)}</h2>
      ${p.media.length ? `<div class="media">${p.media.map(m => `<figure style="margin:0"><img src="${esc(m.url)}" alt="" loading="lazy" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'hint',textContent:'Image not saved offline'}))">${m.caption ? `<figcaption class="caption">${esc(m.caption)}</figcaption>` : ''}</figure>`).join('')}</div>` : ''}
      ${p.html ? `<div class="rich">${p.html}</div>` : ''}
      ${p.url && !/^https:\/\/(i|v|preview)\.redd\.it\//.test(p.url) && !p.url.includes('/gallery/') && !p.url.includes(p.id) ? `<a class="link-out" href="${esc(p.url)}" target="_blank" rel="noopener noreferrer">${esc(p.url)}</a>` : ''}
      <div class="meta"><span>▲ ${fmtNum(p.score)}</span><span>${fmtNum(p.numComments)} comments on Reddit</span><span>saved ${new Date(thread.fetchedAt).toLocaleDateString()}</span><span>${fmtBytes(row.bytes)}</span></div>
      <div class="actions">
        <button class="btn" id="refreshBtn">Update comments</button>
        <button class="btn" id="pinBtn">${row.pinned ? 'Unpin' : '📌 Keep forever'}</button>
        <a class="btn" href="${esc(p.permalink)}" target="_blank" rel="noopener noreferrer">Open on Reddit</a>
        <button class="btn danger" id="delBtn">Delete</button>
      </div>
    </article>
    <div class="comments-head"><h3>Comments</h3><span>${countComments(thread.comments)} saved · top ${thread.settings.top}, ${thread.settings.depth} levels</span></div>
    <div class="comments">${thread.comments.map(c => commentHtml(c, 0)).join('') || '<p class="empty">No comments.</p>'}
      ${thread.more ? `<p class="more">${thread.more} more comments not saved (raise “Top comments” in Settings, then tap Update comments)</p>` : ''}
    </div>`;

  view.onclick = (e) => {
    const im = e.target.closest('.nsfw-blur img');
    if (im && !im.classList.contains('revealed')) { e.preventDefault(); e.stopPropagation(); im.classList.add('revealed'); }
  };
  view.querySelector('.comments').addEventListener('click', (e) => {
    const head = e.target.closest('[data-toggle]');
    if (head && !e.target.closest('a')) head.parentElement.classList.toggle('collapsed');
  });
  $('#refreshBtn').onclick = async () => {
    if (!navigator.onLine) { toast('You’re offline.'); return; }
    try { await downloadThread(id, true); } catch (e) { toast(e.message, 4000); const r = await db.get('posts', id); r.status = 'ready'; await db.put('posts', r); render(); }
  };
  $('#pinBtn').onclick = async () => { row.pinned = !row.pinned; await db.put('posts', row); toast(row.pinned ? 'Kept — won’t be removed when storage is full.' : 'Unpinned.'); render(); };
  $('#delBtn').onclick = async () => { if (confirm('Delete this saved post from your phone?')) { await deletePost(id); location.hash = '#/'; } };
}

function seg(name, options, current) {
  return `<div class="seg" data-setting="${name}">${options.map(([v, label]) =>
    `<button type="button" data-value="${esc(v)}" aria-pressed="${String(v) === String(current)}">${label}</button>`).join('')}</div>`;
}

async function renderSettings() {
  $('#title').textContent = 'Settings';
  $('#backBtn').hidden = false;
  const used = await usedBytes();
  let persisted = false;
  try { persisted = await navigator.storage.persisted(); } catch {}
  view.innerHTML = `
    <section class="group"><h3>Offline storage</h3>
      <div class="field"><label>Storage limit</label>
        ${seg('limitMB', [[250, '250 MB'], [500, '500 MB'], [1000, '1 GB'], [2000, '2 GB'], [4000, '4 GB']], settings.limitMB)}
        <p class="hint">Using ${fmtBytes(used)}. ${persisted ? 'Storage is protected from automatic clean-up.' : 'Add ThreadKeep to your Home Screen so iOS keeps your saved posts.'}</p>
      </div>
      <div class="field"><label>When the limit is reached</label>
        ${seg('whenFull', [['evict', 'Remove oldest posts'], ['stop', 'Save text only']], settings.whenFull)}
        <p class="hint">Posts you mark “Keep forever” are never removed automatically.</p>
      </div>
    </section>

    <section class="group"><h3>Favourite subreddits</h3>
      <div class="field">
        <label for="subInput">Auto-download new posts from</label>
        <div class="sub-list">${settings.subs.map(s => `<span class="sub-tag">r/${esc(s)}<button type="button" data-remove="${esc(s)}" aria-label="Remove r/${esc(s)}">×</button></span>`).join('') || '<span class="hint" style="margin:0">None yet.</span>'}</div>
        <form class="row" id="subForm" style="margin-top:8px">
          <input type="text" id="subInput" placeholder="e.g. AskReddit" autocomplete="off" autocapitalize="off" spellcheck="false">
          <button class="btn" type="submit">Add</button>
        </form>
      </div>
      <div class="field"><label>Posts per subreddit</label>
        ${seg('subCount', [[3, '3'], [5, '5'], [10, '10'], [25, '25']], settings.subCount)}
      </div>
      <div class="field"><label>Which posts</label>
        ${seg('subSort', [['top-day', 'Top today'], ['top-week', 'Top this week'], ['hot', 'Hot now']], settings.subSort)}
      </div>
      <div class="field"><label>Check for new posts</label>
        ${seg('syncHours', [[1, 'Every hour'], [6, 'Every 6 h'], [24, 'Daily'], [0, 'Only when I tap']], settings.syncHours)}
        <p class="hint">Checks happen when you open ThreadKeep (iPhone web apps can’t run in the background). Auto-downloaded posts are removed first when storage is full, and posts you delete won’t come back.</p>
      </div>
    </section>

    <section class="group"><h3>NSFW content</h3>
      <div class="field">
        ${seg('nsfw', [['show', 'Show'], ['blur', 'Blur images'], ['hide', 'Hide']], settings.nsfw)}
        <p class="hint">Hide removes NSFW posts from your list and stops them being auto-downloaded. Blur keeps them but blurs images until you tap.</p>
      </div>
    </section>

    <section class="group"><h3>Comments</h3>
      <div class="field"><label>Top comments to save</label>
        ${seg('topComments', [[25, '25'], [50, '50'], [100, '100'], [200, '200'], [500, 'All*']], settings.topComments)}
        <p class="hint">*Reddit returns at most about 500 comments per request.</p>
      </div>
      <div class="field"><label>Reply depth</label>
        ${seg('depth', [[1, 'Top only'], [2, '2'], [4, '4'], [6, '6'], [10, '10']], settings.depth)}
        <p class="hint">How many levels deep to keep, counting the top comment itself. “Top only” saves no replies.</p>
      </div>
      <div class="field"><label>Order</label>
        ${seg('sort', [['top', 'Top'], ['confidence', 'Best'], ['new', 'New'], ['old', 'Old']], settings.sort)}
      </div>
    </section>

    <section class="group"><h3>Images</h3>
      <div class="field"><label>Image quality</label>
        ${seg('images', [['phone', 'Phone size'], ['original', 'Original'], ['none', 'No images']], settings.images)}
        <p class="hint">Phone size uses much less space and looks the same on an iPhone screen.</p>
      </div>
      <div class="field switch"><label for="ci">Save images inside comments</label><input type="checkbox" id="ci" ${settings.commentImages ? 'checked' : ''}></div>
    </section>

    <section class="group"><h3>Reading</h3>
      <div class="field"><label>Text size</label>
        ${seg('fontSize', [[15, 'Small'], [17, 'Medium'], [19, 'Large'], [21, 'X-Large']], settings.fontSize)}
      </div>
    </section>

    <section class="group"><h3>Reddit access</h3>
      <div class="field"><label for="cid">Reddit client ID (optional)</label>
        <p class="hint" style="margin:0 0 8px">Not needed if saving already works. Only add one if Reddit blocks downloads.</p>
        <input type="text" id="cid" value="${esc(settings.clientId)}" placeholder="e.g. aB3xYz_12QwErT" autocomplete="off" autocapitalize="off" spellcheck="false">
        <details style="margin-top:10px"><summary>How to get one (2 minutes)</summary>
          <ol class="steps">
            <li>In Safari, sign in at <a href="https://www.reddit.com/prefs/apps" target="_blank" rel="noopener">reddit.com/prefs/apps</a>.</li>
            <li>Tap <b>create another app…</b></li>
            <li>Name: <b>ThreadKeep</b>. Type: choose <b>installed app</b>.</li>
            <li>Redirect URI: <b>${esc(location.origin + location.pathname)}</b></li>
            <li>Tap <b>create app</b>. The ID is the short code under the app name. Paste it above.</li>
          </ol>
          <p class="hint">It’s free for personal use. Reddit now usually asks you to submit an access request first, which a person reviews. Describe ThreadKeep as a personal, non-commercial, read-only offline reader. Until it’s approved, ThreadKeep tries Reddit’s public pages directly.</p>
        </details>
      </div>
    </section>

    <section class="group"><h3>iPhone setup</h3>
      <div class="field">
        <details><summary>Install on your Home Screen</summary>
          <ol class="steps"><li>Open this page in Safari.</li><li>Tap <b>Share</b> → <b>Add to Home Screen</b>.</li><li>Always open ThreadKeep from the Home Screen icon — that’s where your saved posts live.</li></ol>
        </details>
      </div>
      <div class="field">
        <details><summary>Saving from the Reddit app</summary>
          <ol class="steps"><li>In the Reddit app, tap <b>Share → Copy link</b>.</li><li>Open ThreadKeep and tap <b>Paste link &amp; save</b>.</li></ol>
          <p class="hint">If short “/s/” share links fail, make a Shortcut: <b>Shortcuts → +</b>, add <b>Receive URLs from Share Sheet</b>, <b>Expand URL</b>, <b>Copy to Clipboard</b>. Name it “Expand link”. Then share from Reddit to “Expand link” and paste in ThreadKeep.</p>
        </details>
      </div>
    </section>

    <section class="group"><h3>Backup</h3>
      <div class="field row">
        <button class="btn" id="exportBtn" style="flex:1">Export text backup</button>
        <button class="btn" id="importBtn" style="flex:1">Import backup</button>
        <input type="file" id="importFile" accept="application/json,.json" hidden>
      </div>
      <div class="field"><button class="btn danger block" id="wipeBtn">Delete all saved posts</button></div>
    </section>
    <p class="hint" style="text-align:center">ThreadKeep stores everything on this device. Nothing is sent anywhere except requests to Reddit.</p>`;

  view.querySelectorAll('.seg').forEach(s => s.addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    const key = s.dataset.setting;
    settings[key] = typeof DEFAULTS[key] === 'number' ? Number(b.dataset.value) : b.dataset.value;
    saveSettings();
    s.querySelectorAll('button').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
    if (key === 'limitMB') makeRoom(0).then(() => toast('Storage limit: ' + fmtBytes(limitBytes())));
  }));
  $('#subForm').onsubmit = (e) => {
    e.preventDefault();
    const name = cleanSubName($('#subInput').value);
    if (!name) { toast('Type a subreddit name, e.g. AskReddit'); return; }
    if (settings.subs.some(s => s.toLowerCase() === name.toLowerCase())) { toast('r/' + name + ' is already added.'); return; }
    settings.subs.push(name); saveSettings();
    toast('Added r/' + name + '. Checking for posts…');
    renderSettings();
    syncSubs(true);
  };
  view.querySelector('.sub-list').onclick = (e) => {
    const b = e.target.closest('[data-remove]'); if (!b) return;
    settings.subs = settings.subs.filter(s => s !== b.dataset.remove); saveSettings();
    renderSettings();
  };
  $('#ci').onchange =(e) => { settings.commentImages = e.target.checked; saveSettings(); };
  $('#cid').onchange = (e) => {
    settings.clientId = e.target.value.trim(); saveSettings();
    try { localStorage.removeItem('tk-token'); } catch {}
    if (!settings.clientId) return;
    getToken().then(() => { toast('Reddit connected ✓'); runQueue(); }).catch(err => toast(err.message, 5000));
  };
  $('#exportBtn').onclick = exportBackup;
  $('#importBtn').onclick = () => $('#importFile').click();
  $('#importFile').onchange = (e) => importBackup(e.target.files[0]);
  $('#wipeBtn').onclick = async () => {
    if (!confirm('Delete every saved post and image from this phone? This can’t be undone.')) return;
    for (const p of await db.all('posts')) await deletePost(p.id, true);
    await caches.delete(MEDIA_CACHE);
    toast('All saved posts deleted.');
    render();
  };
}

async function exportBackup() {
  const data = { app: 'threadkeep', version: 1, exportedAt: Date.now(), posts: await db.all('posts'), threads: await db.all('threads') };
  const file = new File([JSON.stringify(data)], 'threadkeep-backup-' + new Date().toISOString().slice(0, 10) + '.json', { type: 'application/json' });
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: 'ThreadKeep backup' }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(file), download: file.name });
  document.body.append(a); a.click(); a.remove();
}

async function importBackup(file) {
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (data.app !== 'threadkeep') throw new Error('Not a ThreadKeep backup');
    let n = 0;
    for (const t of data.threads || []) {
      if (await db.get('threads', t.id)) continue;
      await db.put('threads', t);
      const p = (data.posts || []).find(x => x.id === t.id) || { id: t.id, title: t.post.title, subreddit: t.post.subreddit, savedAt: Date.now() };
      await db.put('posts', { ...p, media: [], bytes: textBytes(t), status: 'ready', textOnly: true });
      n++;
    }
    toast('Imported ' + n + ' posts (text only — tap Update comments to re-download images).', 5000);
    render();
  } catch (e) { toast('Import failed: ' + e.message, 4000); }
}

/* ---------------- Router & startup ---------------- */

let renderTimer;
function render() {
  clearTimeout(renderTimer);
  renderTimer = setTimeout(route, 30);
}
function route() {
  const h = location.hash;
  view.className = '';
  view.onclick = null;
  if (h.startsWith('#/p/')) return renderPost(decodeURIComponent(h.slice(4)));
  if (h === '#/settings') return renderSettings();
  return renderLibrary();
}
let lastHash = location.hash;
window.addEventListener('hashchange', () => {
  const fromPost = lastHash.startsWith('#/p/') || lastHash === '#/settings';
  lastHash = location.hash;
  route();
  if (!fromPost || location.hash.startsWith('#/p/')) window.scrollTo(0, 0);
});
$('#backBtn').onclick = () => { location.hash = '#/'; };
$('#settingsBtn').onclick = () => { location.hash = '#/settings'; };

function updateNet() {
  $('#netStatus').hidden = navigator.onLine;
  if (navigator.onLine) runQueue();
  render();
}
window.addEventListener('online', updateNet);
window.addEventListener('offline', updateNet);
document.addEventListener('visibilitychange', () => { if (!document.hidden) { runQueue(); syncSubs(); } });

(async function start() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  try { if (navigator.storage?.persist) await navigator.storage.persist(); } catch {}
  $('#netStatus').hidden = navigator.onLine;
  // Allow ?url=… (e.g. from a Shortcut) to save a link directly.
  const params = new URLSearchParams(location.search);
  const shared = params.get('url') || params.get('text');
  if (shared) { history.replaceState(null, '', location.pathname + location.hash); savePostFromInput(shared); }
  // Posts left mid-download when the app was closed go back in the queue.
  for (const p of await db.all('posts')) if (p.status === 'downloading') { p.status = 'pending'; await db.put('posts', p); }
  route();
  runQueue();
  syncSubs();
  setInterval(() => { runQueue(); syncSubs(); }, 60000);
})();
