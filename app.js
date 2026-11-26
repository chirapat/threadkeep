/* ThreadKeep 3 — save Reddit threads with their full comments for offline reading.
 *
 * Source: Arctic Shift (a free public Reddit archive, arctic-shift.photon-reddit.com). No Reddit key,
 * no login, no Shortcut — the app fetches directly. It ranks a subreddit's threads by number of comments
 * ("best discussions") and pulls the whole comment tree. Threads are a couple of weeks old or more,
 * because the archive needs time to collect a thread's comments.
 * Everything is stored on the device: thread text in IndexedDB, images in the Cache API.
 */
'use strict';

const APP_VERSION = '4.7';
const MEDIA_CACHE = 'tk-media-v1';
const API = 'https://arctic-shift.photon-reddit.com/api';
const MB = 1024 * 1024;

/* ================= Settings ================= */

// Built-in set of popular, comment-heavy subreddits for "Popular mix" mode.
const POPULAR = ['AskReddit', 'explainlikeimfive', 'todayilearned', 'NoStupidQuestions', 'Showerthoughts', 'LifeProTips', 'tifu', 'AmItheAsshole', 'OutOfTheLoop', 'changemyview', 'askscience', 'YouShouldKnow', 'Damnthatsinteresting', 'mildlyinteresting', 'interestingasfuck'];

const DEFAULTS = {
  subs: [],                 // Main library: your focus subreddits, e.g. ['AskReddit']
  includePopular: true,     // Main library: also pull hot threads from the built-in popular mix
  nsfwSubs: [],             // Private (NSFW) library: subreddits to download, e.g. ['gonewild']
  postsPerSub: 5,           // how many threads to grab per subreddit each check
  commentsPerThread: 100,   // size lever: max comments saved per thread
  autoCheck: 'open',        // 'off' | 'open' (on launch) | 'daily'
  limitMB: 500,             // storage budget
  whenFull: 'evict',        // 'evict' = remove oldest (not kept), 'stop' = stop downloading
  showNsfw: true,           // (legacy)
  autoNsfw: false,          // (legacy)
  blurNsfw: true,           // blur private images until tapped
  fontSize: 17,
  onlyKeywords: '',         // only auto-save threads whose title matches any (comma-separated)
  muteKeywords: '',         // skip threads whose title matches any
  pin: '',                  // passcode for the Private library ('' = none)
  hidePrivate: false,       // hide the Private tab until unlocked by passcode
  hideSubs: false,          // hide r/subreddit names in the Private library
  theme: 'auto',            // 'auto' | 'light' | 'dark'
  accent: 'orange',         // accent colour key
};
const ACCENTS = { orange: '#e8562a', blue: '#2f6fed', green: '#2f9e44', purple: '#8b4fd6', pink: '#d6336c', slate: '#475569' };
const store = {
  get(k, f) { try { const v = localStorage.getItem(k); return v == null ? f : JSON.parse(v); } catch { return f; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
const settings = (() => {
  const saved = store.get('tk-settings', {}) || {};
  const s = { ...DEFAULTS };
  for (const k of Object.keys(DEFAULTS)) {
    if (k === 'subs' || k === 'nsfwSubs') { if (Array.isArray(saved[k])) s[k] = saved[k].slice(); }
    else if (typeof saved[k] === typeof DEFAULTS[k]) s[k] = saved[k];
  }
  if (saved.nsfw === 'hide') s.showNsfw = false;
  return s;
})();
function saveSettings() { store.set('tk-settings', settings); applyFontSize(); applyTheme(); }
function applyFontSize() { document.documentElement.style.setProperty('--reader-size', settings.fontSize + 'px'); }
function applyTheme() {
  const root = document.documentElement;
  root.setAttribute('data-theme', settings.theme === 'auto' ? '' : settings.theme);
  const a = ACCENTS[settings.accent] || ACCENTS.orange;
  root.style.setProperty('--accent', a);
  root.style.setProperty('--accent-soft', a + '22');
}
applyFontSize(); applyTheme();

/* Read state, scroll memory, Private unlock, read-time */
const readSet = () => new Set(store.get('tk-read', []));
const isRead = (id) => readSet().has(id);
function markRead(id) { const s = readSet(); if (!s.has(id)) { s.add(id); store.set('tk-read', [...s].slice(-5000)); } }
function markUnread(id) { const s = readSet(); s.delete(id); store.set('tk-read', [...s]); }
function saveScroll(id, y) { const m = store.get('tk-scroll', {}); m[id] = Math.round(y); const keys = Object.keys(m); if (keys.length > 300) delete m[keys[0]]; store.set('tk-scroll', m); }
const getScroll = (id) => (store.get('tk-scroll', {})[id]) || 0;
function unlocked() { try { return sessionStorage.getItem('tk-unlocked') === '1'; } catch { return false; } }
function setUnlocked(v) { try { v ? sessionStorage.setItem('tk-unlocked', '1') : sessionStorage.removeItem('tk-unlocked'); } catch {} }
function wordCount(thread) {
  let n = (thread.post.html || '').split(/\s+/).length;
  const walk = (list) => list.forEach(c => { n += (c.h || '').replace(/<[^>]+>/g, ' ').split(/\s+/).length; walk(c.r); });
  walk(thread.comments);
  return n;
}
const readMins = (thread) => Math.max(1, Math.round(wordCount(thread) / 220));
const matchesAny = (title, csv) => { const terms = csv.split(',').map(s => s.trim().toLowerCase()).filter(Boolean); return terms.some(t => title.toLowerCase().includes(t)); };

const seen = {
  has: (id) => (store.get('tk-seen', []) || []).includes(id),
  add(ids) { const s = new Set(store.get('tk-seen', []) || []); ids.forEach(i => s.add(i)); store.set('tk-seen', [...s].slice(-4000)); },
};

/* ================= Storage (IndexedDB) ================= */

const dbReady = new Promise((resolve, reject) => {
  const req = indexedDB.open('threadkeep', 1);
  req.onupgradeneeded = () => { req.result.createObjectStore('posts', { keyPath: 'id' }); req.result.createObjectStore('threads', { keyPath: 'id' }); };
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});
async function tx(name, mode, fn) {
  const database = await dbReady;
  return new Promise((resolve, reject) => {
    const t = database.transaction(name, mode); let result;
    const r = fn(t.objectStore(name)); if (r) r.onsuccess = () => { result = r.result; };
    t.oncomplete = () => resolve(result); t.onerror = () => reject(t.error); t.onabort = () => reject(t.error || new Error('Storage write failed'));
  });
}
const db = {
  get: (s, id) => tx(s, 'readonly', o => o.get(id)),
  all: (s) => tx(s, 'readonly', o => o.getAll()),
  put: (s, v) => tx(s, 'readwrite', o => o.put(v)),
  del: (s, id) => tx(s, 'readwrite', o => o.delete(id)),
};

/* ================= Helpers ================= */

const $ = (sel, el = document) => el.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const unamp = (s) => String(s || '').replace(/&amp;/g, '&');
const plural = (n, one, many) => n + ' ' + (n === 1 ? one : (many || one + 's'));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const cleanSub = (s) => { const m = String(s || '').trim().replace(/^.*reddit\.com\//i, '').replace(/^\/?r\//i, '').match(/^[A-Za-z0-9_]{2,21}/); return m ? m[0] : ''; };

function fmtBytes(b) { if (!b) return '0 MB'; if (b < MB) return Math.max(1, Math.round(b / 1024)) + ' KB'; if (b < 1024 * MB) return (b / MB).toFixed(b < 10 * MB ? 1 : 0) + ' MB'; return (b / 1024 / MB).toFixed(1) + ' GB'; }
function fmtAgo(sec) { const d = Date.now() / 1000 - sec; if (d < 3600) return Math.max(1, Math.floor(d / 60)) + 'm'; if (d < 86400) return Math.floor(d / 3600) + 'h'; if (d < 86400 * 30) return Math.floor(d / 86400) + 'd'; if (d < 86400 * 365) return Math.floor(d / 86400 / 30) + 'mo'; return Math.floor(d / 86400 / 365) + 'y'; }
function fmtNum(n) { n = n || 0; return n >= 10000 ? Math.round(n / 1000) + 'k' : n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n); }
const textBytes = (o) => new Blob([JSON.stringify(o)]).size;

let toastTimer;
function toast(msg, ms = 3000) { const el = $('#toast'); el.textContent = msg; el.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), ms); }
function progress(text, frac) { const el = $('#progress'); if (text == null) { el.hidden = true; return; } el.hidden = false; $('#progressText').textContent = text; $('#progressFill').style.width = Math.round((frac || 0) * 100) + '%'; }

/* ================= Markdown → HTML (Reddit comments are markdown) ================= */

function mdToHtml(md) {
  if (!md) return '';
  let s = esc(String(md).replace(/\r\n?/g, '\n'));
  const blocks = [];
  s = s.replace(/```([\s\S]*?)```/g, (_, c) => { blocks.push('<pre><code>' + c.replace(/^\n+|\n+$/g, '') + '</code></pre>'); return '\u0000' + (blocks.length - 1) + '\u0000'; });
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>');
  s = s.replace(/(^|[\s(])((https?:\/\/)[^\s<]+[^\s<.,);!?])/g, '$1<a href="$2">$2</a>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/__([^_]+)__/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>').replace(/(^|[^_])_([^_\n]+)_/g, '$1<em>$2</em>');
  s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  // block-level, line by line
  const lines = s.split('\n'); const out = []; let list = null, quote = false;
  const closeList = () => { if (list) { out.push('</' + list + '>'); list = null; } };
  const closeQuote = () => { if (quote) { out.push('</blockquote>'); quote = false; } };
  for (let raw of lines) {
    const line = raw.trimEnd();
    if (/^\u0000\d+\u0000$/.test(line.trim())) { closeList(); closeQuote(); out.push(line.trim()); continue; }
    if (!line.trim()) { closeList(); closeQuote(); continue; }
    let m;
    if ((m = line.match(/^(#{1,6})\s+(.*)/))) { closeList(); closeQuote(); out.push('<h' + m[1].length + '>' + m[2] + '</h' + m[1].length + '>'); continue; }
    if (/^([-*_])\1{2,}$/.test(line.trim())) { closeList(); closeQuote(); out.push('<hr>'); continue; }
    if ((m = line.match(/^&gt;\s?(.*)/))) { closeList(); if (!quote) { out.push('<blockquote>'); quote = true; } out.push(m[1] + '<br>'); continue; }
    if ((m = line.match(/^\s*[-*]\s+(.*)/))) { closeQuote(); if (list !== 'ul') { closeList(); out.push('<ul>'); list = 'ul'; } out.push('<li>' + m[1] + '</li>'); continue; }
    if ((m = line.match(/^\s*\d+[.)]\s+(.*)/))) { closeQuote(); if (list !== 'ol') { closeList(); out.push('<ol>'); list = 'ol'; } out.push('<li>' + m[1] + '</li>'); continue; }
    closeList(); closeQuote(); out.push('<p>' + line + '</p>');
  }
  closeList(); closeQuote();
  let html = out.join('\n');
  html = html.replace(/\u0000(\d+)\u0000/g, (_, i) => blocks[+i]);
  return html;
}

/* ================= Clean HTML (shared) ================= */

const ALLOWED = new Set(['A', 'P', 'BR', 'HR', 'B', 'STRONG', 'I', 'EM', 'DEL', 'S', 'SUP', 'SUB', 'CODE', 'PRE', 'BLOCKQUOTE', 'UL', 'OL', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TH', 'TD', 'SPAN', 'DIV', 'IMG']);
const DROP = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'FORM', 'SVG', 'BUTTON', 'INPUT']);
const REDDIT_IMG = /^https:\/\/(preview|i)\.redd\.it\//;

function sanitize(html, images) {
  if (!html) return '';
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
          const img = doc.createElement('img'); img.src = href; img.alt = el.textContent || 'image'; images.push(href); el.replaceWith(img); continue;
        }
        el.setAttribute('href', href); el.setAttribute('target', '_blank'); el.setAttribute('rel', 'noopener noreferrer');
      }
      if (el.tagName === 'IMG') { const src = el.getAttribute('src') || ''; if (!/^https:/i.test(src)) { el.remove(); continue; } images.push(src); }
      walk(el);
    }
  };
  walk(doc.body);
  doc.querySelectorAll('img').forEach(i => i.setAttribute('loading', 'lazy'));
  return doc.body.innerHTML;
}

/* ================= Media (same shape as Reddit) ================= */

function phoneSizedPreview(preview) { const img = preview?.images?.[0]; if (!img) return null; const fits = (img.resolutions || []).filter(r => r.width <= 1080); return unamp((fits[fits.length - 1] || img.source)?.url) || null; }
function thumbOf(preview) { const res = preview?.images?.[0]?.resolutions || []; const r = res.find(x => x.width >= 140) || res[res.length - 1]; return r ? unamp(r.url) : phoneSizedPreview(preview); }
function mediaOf(p) {
  const out = [];
  if (p.is_gallery && p.gallery_data && p.media_metadata) {
    for (const item of p.gallery_data.items || []) { const m = p.media_metadata[item.media_id]; if (!m || m.status !== 'valid') continue; const fits = (m.p || []).filter(r => r.x <= 1080); const url = (fits[fits.length - 1] || m.s)?.u || m.s?.gif; if (url) out.push({ url: unamp(url), caption: item.caption || '' }); }
    return out;
  }
  const url = p.url_overridden_by_dest || p.url || '';
  const directImg = /\.(jpe?g|png|gif|webp)(\?|$)/i.test(url);
  if (p.post_hint === 'image' || directImg) { const u = phoneSizedPreview(p.preview) || (directImg ? url : null); if (u) out.push({ url: u, caption: '' }); return out; }
  const pic = phoneSizedPreview(p.preview); if (pic) out.push({ url: pic, caption: p.is_video ? 'Video. Only the preview image is saved.' : '' });
  return out;
}

/* ================= Arctic Shift data layer ================= */

async function arctic(path, tries = 7) {
  for (let i = 0; i < tries; i++) {
    let j;
    try { j = await (await fetch(API + path)).json(); }
    catch { if (!navigator.onLine) throw new Error('You’re offline.'); j = {}; }
    if (j && j.error && /slow down|timeout/i.test(j.error)) { await sleep(2000 + i * 800); continue; } // back off on rate limit
    if (j && j.data != null) return j.data;
    if (i === tries - 1) throw new Error((j && j.error) || 'Couldn’t reach the Reddit archive. Try again.');
    await sleep(1000 + i * 500);
  }
  throw new Error('The Reddit archive is busy. Try again in a minute.');
}

// Mature window: threads old enough that the archive has their comments.
async function fetchSubPosts(sub, pages = 2) {
  const posts = []; let cursor = '14d'; // start just older than 14 days
  for (let pg = 0; pg < pages; pg++) {
    const q = new URLSearchParams({ subreddit: sub, limit: '100', sort: 'desc', after: '95d', before: cursor });
    const batch = await arctic('/posts/search?' + q);
    if (!batch.length) break;
    posts.push(...batch); cursor = String(batch[batch.length - 1].created_utc);
    if (batch.length < 100) break; await sleep(400);
  }
  return posts;
}
async function fetchComments(postId, cap) {
  const out = []; let after = '';
  while (out.length < cap) {
    const q = new URLSearchParams({ link_id: postId, limit: '100', sort: 'asc' }); if (after) q.set('after', after);
    let batch; try { batch = await arctic('/comments/search?' + q); } catch { break; }
    if (!batch.length) break;
    out.push(...batch); after = String(batch[batch.length - 1].created_utc);
    if (batch.length < 100) break; await sleep(500);
  }
  return out.slice(0, cap);
}
async function fetchPostById(id) {
  const d = await arctic('/posts/ids?ids=' + encodeURIComponent(id));
  return Array.isArray(d) ? d[0] : d;
}

function parseLink(text) {
  text = String(text || '').trim();
  let m = text.match(/comments\/([a-z0-9]+)/i) || text.match(/redd\.it\/([a-z0-9]+)/i);
  if (m) return { type: 'post', id: m[1].toLowerCase() };
  const r = text.match(/(?:reddit\.com\/)?r\/([A-Za-z0-9_]{2,21})/i); if (r) return { type: 'sub', name: r[1] };
  if (/^[A-Za-z0-9_]{2,21}$/.test(text)) return { type: 'sub', name: text };
  return null;
}

/* ================= Turn archive data into a saved thread ================= */

function buildCommentTree(flat, images) {
  const byId = new Map();
  for (const c of flat) byId.set(c.id, { a: c.author || '[deleted]', op: !!c.is_submitter, s: c.score || 0, t: c.created_utc || Date.now() / 1000, h: sanitize(mdToHtml(c.body), images), f: c.author_flair_text || '', st: !!c.stickied, e: !!c.edited, r: [], m: 0, _pid: String(c.parent_id || '') });
  const roots = [];
  for (const node of byId.values()) { const pid = node._pid; delete node._pid; if (pid.startsWith('t1_') && byId.has(pid.slice(3))) byId.get(pid.slice(3)).r.push(node); else roots.push(node); }
  const sortRec = (nodes) => { nodes.sort((a, b) => (b.st - a.st) || (b.s - a.s)); nodes.forEach(n => sortRec(n.r)); };
  sortRec(roots);
  return roots;
}
const countComments = (list) => list.reduce((n, c) => n + 1 + countComments(c.r), 0);

// Downloads a thread from the archive and saves it. Returns the post id, or null if there were no comments yet.
async function saveThreadById(id, { fromSub = false, post = null, lib = currentLib() } = {}) {
  const p = post || await fetchPostById(id);
  if (!p || !p.id) throw new Error('That thread isn’t in the archive.');
  const flat = await fetchComments(p.id, settings.commentsPerThread);
  const images = [];
  const media = mediaOf(p);
  const postObj = {
    id: p.id, title: p.title || 'Untitled', subreddit: p.subreddit || '', author: p.author || '[deleted]', score: p.score || 0,
    created: p.created_utc || Date.now() / 1000, numComments: p.num_comments || flat.length, flair: p.link_flair_text || '',
    nsfw: !!p.over_18, html: sanitize(mdToHtml(p.selftext), images),
    url: (p.is_self ? '' : (p.url_overridden_by_dest || p.url || '')),
    permalink: 'https://www.reddit.com' + (p.permalink || '/comments/' + p.id),
    media,
  };
  const comments = buildCommentTree(flat, images);
  const saved = countComments(comments);
  const more = Math.max(0, (p.num_comments || 0) - saved);
  const thread = { id: p.id, post: postObj, comments, more, fetchedAt: Date.now() };
  const tBytes = textBytes(thread);

  const existing = await db.get('posts', p.id);
  if (existing) await removeImages(existing.media, p.id);
  if (!(await makeRoom(tBytes, p.id))) throw new Error('Storage is full (' + fmtBytes(limitBytes()) + '). Delete some threads or raise the limit in Settings.');
  await db.put('threads', thread);

  const thumb = thumbOf(p.preview) || media[0]?.url || null;
  const row = { id: p.id, title: postObj.title, subreddit: postObj.subreddit, nsfw: postObj.nsfw, lib: existing?.lib || lib, savedComments: saved, numComments: postObj.numComments,
    savedAt: existing?.savedAt || Date.now(), pinned: !!existing?.pinned, fromSub: existing ? !!existing.fromSub : fromSub, thumb, media: [], bytes: tBytes, textOnly: false, complete: false };
  await db.put('posts', row);
  for (const url of [...new Set([...(thumb ? [thumb] : []), ...media.map(m => m.url), ...images])]) {
    if (!(await makeRoom(256 * 1024, p.id))) { row.textOnly = true; break; }
    const before = await usage(); let size; try { size = await cacheImage(url); } catch { continue; }
    if (size === -1) size = Math.max(50 * 1024, (await usage()) - before);
    row.media.push(url); row.bytes += size;
  }
  row.complete = true; await db.put('posts', row);
  return p.id;
}

/* ================= Images & storage budget ================= */

async function cacheImage(url) {
  const cache = await caches.open(MEDIA_CACHE);
  if (await cache.match(url)) return 0;
  try { const res = await fetch(url, { mode: 'cors', credentials: 'omit' }); if (!res.ok) throw 0; const size = (await res.clone().blob()).size; await cache.put(url, res); return size; }
  catch { const res = await fetch(url, { mode: 'no-cors', credentials: 'omit' }); await cache.put(url, res); return -1; }
}
async function usage() { try { return (await navigator.storage.estimate()).usage || 0; } catch { return 0; } }
async function removeImages(urls, exceptId) {
  if (!urls?.length) return; const used = new Set();
  for (const p of await db.all('posts')) if (p.id !== exceptId) (p.media || []).forEach(u => used.add(u));
  const cache = await caches.open(MEDIA_CACHE); await Promise.all(urls.filter(u => !used.has(u)).map(u => cache.delete(u)));
}
const limitBytes = () => settings.limitMB * MB;
async function usedBytes(exceptId) { return (await db.all('posts')).filter(p => p.id !== exceptId).reduce((n, p) => n + (p.bytes || 0), 0); }
async function makeRoom(need, protectId) {
  let used = await usedBytes(protectId);
  if (used + need <= limitBytes()) return true;
  if (settings.whenFull !== 'evict') return false;
  const oldest = (await db.all('posts')).filter(p => p.id !== protectId && !p.pinned).sort((a, b) => (b.fromSub - a.fromSub) || (a.savedAt - b.savedAt));
  for (const p of oldest) { await deletePost(p.id); used -= p.bytes || 0; if (used + need <= limitBytes()) return true; }
  return used + need <= limitBytes();
}
async function deletePost(id) { const row = await db.get('posts', id); await db.del('threads', id); await db.del('posts', id); if (row) await removeImages(row.media, id); }

/* ================= Auto-download ================= */

let syncing = false;
const lastSync = (lib) => store.get('tk-lastsync-' + lib, 0);

// Current surface: 'main' (SFW) or 'nsfw' (Private). Resets to main when the app is fully reopened.
function currentLib() { try { return sessionStorage.getItem('tk-lib') === 'nsfw' ? 'nsfw' : 'main'; } catch { return 'main'; } }
function setLib(v) { try { sessionStorage.setItem('tk-lib', v); } catch {} }

// Subreddits to check for a library. Main = focus subs + rotating popular mix. Private = your NSFW subs.
function sourcesFor(lib) {
  if (lib === 'nsfw') return settings.nsfwSubs.slice();
  const mine = settings.subs.slice();
  const lower = new Set(mine.map(s => s.toLowerCase()));
  let extra = [];
  if (settings.includePopular) {
    const i = store.get('tk-popidx', 0) % POPULAR.length;
    const rotated = POPULAR.slice(i).concat(POPULAR.slice(0, i));
    store.set('tk-popidx', (i + 6) % POPULAR.length);
    extra = rotated.filter(s => !lower.has(s.toLowerCase())).slice(0, 6);
  }
  return [...mine, ...extra];
}

const UNREAD_ENOUGH = 20; // don't auto-download more while this many unread threads are waiting
async function checkSubs(force, lib = currentLib()) {
  const sources = sourcesFor(lib);
  if (syncing || !navigator.onLine || !sources.length) return;
  if (!force) {
    if (settings.autoCheck === 'off') return;
    if (settings.autoCheck === 'daily' && Date.now() - lastSync(lib) < 86400000) return;
    // Don't pile up: skip the automatic check while there's still plenty unread in this library.
    const unread = (await db.all('posts')).filter(p => (p.lib || 'main') === lib && !isRead(p.id)).length;
    if (unread >= UNREAD_ENOUGH) return;
  }
  syncing = true;
  let total = 0, failed = '', budgetFull = false;
  const nsfwLib = lib === 'nsfw';
  const nearFull = async () => (await usedBytes()) >= limitBytes() * 0.95;
  try {
    for (let si = 0; si < sources.length; si++) {
      const sub = sources[si];
      if (await nearFull()) { budgetFull = true; break; }
      if (si > 0) await sleep(1200); // space subreddits so the archive doesn't throttle us
      let posts;
      try { progress('Checking r/' + sub + '…', 0.03); posts = await fetchSubPosts(sub); }
      catch (e) {
        try { await sleep(3000); posts = await fetchSubPosts(sub); }
        catch (e2) { failed = 'r/' + sub + ': ' + e2.message; continue; }
      }
      const existing = new Set((await db.all('posts')).map(p => p.id));
      // Main library wants discussion threads (>3 comments) and never saves NSFW.
      // The Private library saves whatever its subs return (image subs often have few comments).
      posts = posts.filter(p => p && !p.stickied && (nsfwLib || (p.num_comments || 0) > 3) && !seen.has(p.id) && !existing.has(p.id) && (nsfwLib || !p.over_18)
        && (!settings.onlyKeywords.trim() || matchesAny(p.title || '', settings.onlyKeywords))
        && !(settings.muteKeywords.trim() && matchesAny(p.title || '', settings.muteKeywords)));
      posts.sort((a, b) => (b.num_comments || 0) - (a.num_comments || 0));
      const pick = posts.slice(0, settings.postsPerSub);
      for (let i = 0; i < pick.length; i++) {
        if (await nearFull()) { budgetFull = true; break; }
        progress('r/' + sub + ': saving ' + (i + 1) + ' of ' + pick.length + '…', (i + 1) / (pick.length + 1));
        try { const id = await saveThreadById(pick[i].id, { fromSub: true, post: pick[i], lib }); if (id) total++; }
        catch (e) { if (/Storage is full/.test(e.message)) { budgetFull = true; break; } }
        seen.add([pick[i].id]);
      }
      seen.add(pick.map(p => p.id));
      if (budgetFull) break;
    }
    store.set('tk-lastsync-' + lib, Date.now());
  } finally { syncing = false; progress(null); }
  if (total && budgetFull) toast('Saved ' + plural(total, 'thread') + '. Storage is full — raise the limit or delete some to get more.', 6000);
  else if (total) toast('Saved ' + plural(total, 'new thread') + '.', 4000);
  else if (budgetFull) toast('Storage is full. Raise the limit or delete some threads in Settings.', 6000);
  else if (failed) toast(failed, 6000);
  else if (force) toast('No new threads right now — the archive may be busy. Try again in a minute.', 6000);
  render();
}

async function savePostFromLink(input) {
  const p = parseLink(input);
  if (!p) { toast('Paste a reddit.com thread link, or a subreddit name.'); return; }
  if (p.type === 'sub') { toast('That’s a subreddit — add r/' + p.name + ' in Settings to auto-download from it.', 5000); return; }
  if (!navigator.onLine) { toast('You’re offline.'); return; }
  const existing = await db.get('posts', p.id);
  if (existing && existing.complete) { location.hash = '#/p/' + p.id; return; }
  progress('Downloading thread…', 0.3);
  try { const id = await saveThreadById(p.id); progress(null); location.hash = '#/p/' + id; route(); }
  catch (e) { progress(null); toast(e.message, 6000); }
}

/* ================= Views ================= */

const view = $('#view');
let filterSub = '', search = '', readFilter = 'all';
const _textCache = new Map();
async function threadText(id) {
  if (_textCache.has(id)) return _textCache.get(id);
  const t = await db.get('threads', id); let s = '';
  if (t) { s = t.post.title + ' ' + (t.post.html || '') + ' '; const w = (l) => l.forEach(c => { s += (c.a || '') + ' ' + (c.h || '') + ' '; w(c.r); }); w(t.comments); }
  s = s.replace(/<[^>]+>/g, ' ').toLowerCase(); _textCache.set(id, s); return s;
}
// Switch libraries. Asks for the passcode every time you enter the Private library; re-locks on leaving.
async function switchLib(target) {
  if (target === currentLib()) return;
  if (target === 'nsfw' && settings.pin) {
    const entry = prompt('Enter your Private passcode:');
    if (entry == null) return;
    if (entry !== settings.pin) { toast('Wrong passcode.'); return; }
    setUnlocked(true);
  }
  if (target === 'main') setUnlocked(false);
  setLib(target); filterSub = ''; search = ''; readFilter = 'all'; renderHome();
}
const ICONS = {
  pin: '<svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><path d="M6 3h12v18l-6-4-6 4z" fill="currentColor"/></svg>',
  refresh: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M20 11a8 8 0 1 0-.9 4.5M20 5v6h-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};
const isStandalone = () => navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
const isAndroid = () => /Android/.test(navigator.userAgent);

function installCardHtml() {
  let hidden = false; try { hidden = sessionStorage.getItem('tk-install-hidden') === '1'; } catch {}
  if (isStandalone() || hidden || (!isIOS() && !isAndroid())) return '';
  const steps = isAndroid()
    ? '<li>In Chrome, tap the <b>⋮</b> menu → <b>Add to Home screen</b> (or <b>Install app</b>).</li><li>Open ThreadKeep from the new icon. Your saved threads live there.</li>'
    : '<li>In Safari, tap the Share button → <b>Add to Home Screen</b>.</li><li>Open ThreadKeep from the new icon. Your saved threads live there.</li>';
  return `<section class="card notice"><div class="card-head"><h2>Install it on your ${isAndroid() ? 'phone' : 'iPhone'}</h2><button class="x" id="installClose" aria-label="Hide">×</button></div>
    <ol class="steps">${steps}</ol></section>`;
}

async function renderHome() {
  const lib = currentLib();
  if (lib === 'nsfw' && settings.hidePrivate && !unlocked()) { setLib('main'); return renderHome(); }
  setHeader(lib === 'nsfw' ? '🔒 Private' : 'ThreadKeep', false);
  if (lib !== 'nsfw') $('#title').innerHTML = 'ThreadKeep <span class="by">by Chisun</span>';
  const all = await db.all('posts');
  const posts = all.filter(p => (p.lib || 'main') === lib).sort((a, b) => b.savedAt - a.savedAt);
  const used = all.reduce((n, p) => n + (p.bytes || 0), 0);
  const pct = Math.min(100, used / limitBytes() * 100);
  const privCount = all.filter(p => (p.lib || 'main') === 'nsfw').length;
  const unreadCount = posts.filter(p => !isRead(p.id)).length;
  const readCount = posts.length - unreadCount;
  const subCounts = {}; for (const p of posts) if (p.subreddit) subCounts[p.subreddit] = (subCounts[p.subreddit] || 0) + 1;
  const subChips = Object.keys(subCounts).sort((a, b) => subCounts[b] - subCounts[a]);
  if (filterSub && !subCounts[filterSub]) filterSub = '';
  const q = search.trim().toLowerCase();
  let shown = posts.filter(p => !filterSub || p.subreddit === filterSub);
  if (q) { const out = []; for (const p of shown) { if ((p.title + ' ' + p.subreddit).toLowerCase().includes(q) || (await threadText(p.id)).includes(q)) out.push(p); } shown = out; }
  if (readFilter === 'unread') shown = shown.filter(p => !isRead(p.id)); else if (readFilter === 'read') shown = shown.filter(p => isRead(p.id));
  const ls = lastSync(lib);
  const showPrivateTab = lib === 'nsfw' || !settings.hidePrivate || unlocked();
  const srcLabel = lib === 'nsfw'
    ? (settings.nsfwSubs.map(s => 'r/' + esc(s)).join('  ') || 'No subreddits yet')
    : ((settings.subs.map(s => 'r/' + esc(s)).join('  ') + (settings.includePopular ? (settings.subs.length ? '  + popular mix' : 'Popular mix') : '')) || 'Nothing selected');
  const hasSources = sourcesFor(lib).length > 0;

  view.innerHTML = `
    <div class="libswitch" id="libswitch">
      <button data-lib="main" aria-pressed="${lib === 'main'}">Main</button>
      ${showPrivateTab ? `<button data-lib="nsfw" aria-pressed="${lib === 'nsfw'}">${settings.pin ? '🔒 ' : ''}Private${privCount ? ` <small>${privCount}</small>` : ''}</button>` : ''}
    </div>
    ${installCardHtml()}
    <section class="sync">
      <div><div class="sync-subs">${srcLabel}</div>
        <div class="muted small">${ls ? 'Checked ' + fmtAgo(ls / 1000) + ' ago' : 'Not checked yet'}${hasSources ? ' · most-discussed threads' : ''}</div></div>
      ${hasSources ? `<button class="btn small" id="checkBtn">${ICONS.refresh} Check now</button>` : `<a class="btn small" href="#/settings">Set up</a>`}
    </section>

    <form class="linkrow" id="linkForm">
      <input id="linkInput" type="text" inputmode="url" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="Paste a reddit link${settings.hidePrivate && !unlocked() ? ' or passcode' : ''}">
      <button class="btn" type="submit">Save</button>
    </form>

    ${posts.length ? `
      <div class="toolbar">
        <div class="gauge"><div class="gauge-bar"><div class="gauge-fill ${pct >= 95 ? 'full' : ''}" style="width:${pct}%"></div></div><span>${fmtBytes(used)} of ${fmtBytes(limitBytes())} total</span></div>
        <button class="btn small" id="surpriseBtn" title="Open a random thread">🎲</button>
      </div>
      <div class="filterbar">
        <button class="chip-toggle ${readFilter === 'unread' ? 'on' : ''}" data-read="unread">Unread${unreadCount ? ` <small>${unreadCount}</small>` : ''}</button>
        <button class="chip-toggle ${readFilter === 'read' ? 'on' : ''}" data-read="read">Read${readCount ? ` <small>${readCount}</small>` : ''}</button>
        ${subChips.length > 1 && !(lib === 'nsfw' && settings.hideSubs) ? subChips.slice(0, 20).map(s => `<button class="chip-toggle ${filterSub === s ? 'on' : ''}" data-sub="${esc(s)}">r/${esc(s)} <small>${subCounts[s]}</small></button>`).join('') + (filterSub ? `<button class="chip-toggle" data-sub="">All</button>` : '') : ''}
      </div>
      ${posts.length > 6 ? `<input type="search" id="search" class="search" placeholder="Search titles & comments" value="${esc(search)}">` : ''}
      <div class="list" id="list">${shown.map(itemHtml).join('') || '<p class="empty muted">Nothing matches.</p>'}</div>`
      : `<p class="empty muted">No saved threads in ${lib === 'nsfw' ? 'your Private library' : 'this library'} yet.${hasSources ? ' Tap <b>Check now</b> above.' : lib === 'nsfw' ? ' Add subreddits in Private settings.' : ''}</p>`}
    <p class="credit center">Designed by Chisunsoft</p>`;

  $('#libswitch').onclick = (e) => { const b = e.target.closest('button'); if (b) switchLib(b.dataset.lib); };
  const cb = $('#checkBtn'); if (cb) cb.onclick = () => checkSubs(true, lib);
  $('#linkForm').onsubmit = (e) => {
    e.preventDefault(); const v = $('#linkInput').value.trim(); $('#linkInput').value = '';
    if (settings.pin && v === settings.pin) { setUnlocked(true); setLib('nsfw'); filterSub = ''; search = ''; readFilter = 'all'; renderHome(); return; } // passcode unlock (no second prompt)
    savePostFromLink(v);
  };
  const ic = $('#installClose'); if (ic) ic.onclick = () => { try { sessionStorage.setItem('tk-install-hidden', '1'); } catch {} renderHome(); };
  const sb = $('#surpriseBtn'); if (sb) sb.onclick = () => { if (shown.length) location.hash = '#/p/' + shown[Math.floor(Math.random() * shown.length)].id; };
  const fb = $('.filterbar'); if (fb) fb.addEventListener('click', (e) => {
    const r = e.target.closest('[data-read]'); if (r) { readFilter = readFilter === r.dataset.read ? 'all' : r.dataset.read; renderHome(); return; }
    const b = e.target.closest('[data-sub]'); if (b) { filterSub = b.dataset.sub; renderHome(); }
  });
  const se = $('#search'); if (se) se.oninput = () => { search = se.value; const pos = se.selectionStart; renderHome().then(() => { const n = $('#search'); if (n) { n.focus(); n.setSelectionRange(pos, pos); } }); };
  wireSwipe($('#list'));
  wirePullRefresh(lib, hasSources);
}

function itemHtml(p) {
  const blur = p.nsfw && settings.blurNsfw;
  const hideSub = (p.lib || 'main') === 'nsfw' && settings.hideSubs;
  return `<div class="item-wrap"><a class="item ${isRead(p.id) ? 'read' : ''}" href="#/p/${esc(p.id)}" data-id="${esc(p.id)}">
    <div class="item-body">
      <div class="item-sub">${hideSub ? 'Private' : 'r/' + esc(p.subreddit)}${!isRead(p.id) ? '<span class="dot"></span>' : ''}${p.pinned ? ` <span class="tag kept">${ICONS.pin} Kept</span>` : ''}</div>
      <div class="item-title">${esc(p.title)}</div>
      <div class="item-meta">${plural(p.savedComments || 0, 'comment')} · ${fmtBytes(p.bytes)}${p.textOnly ? ' · text only' : ''}${p.complete === false ? ' · saving…' : ''}</div>
    </div>
    ${p.thumb ? `<img class="thumb ${blur ? 'blurred' : ''}" src="${esc(p.thumb)}" alt="" loading="lazy" onerror="this.remove()">` : ''}
  </a><div class="swipe-actions"><button class="sw-read" data-id="${esc(p.id)}">${isRead(p.id) ? 'Unread' : 'Read'}</button><button class="sw-keep" data-id="${esc(p.id)}">${p.pinned ? 'Unkeep' : 'Keep'}</button><button class="sw-del" data-id="${esc(p.id)}">Delete</button></div></div>`;
}

// Swipe an item left to reveal Keep / Delete.
const SWIPE_W = 204; // width of the three revealed actions (Read/Unread, Keep, Delete)
function wireSwipe(listEl) {
  if (!listEl) return;
  let active = null, startX = 0, startY = 0, dx = 0, dragging = false;
  const close = (el) => { if (el) el.style.transform = ''; };
  const closeAll = () => listEl.querySelectorAll('.item.swiped').forEach(a => { a.classList.remove('swiped'); close(a); });
  listEl.addEventListener('touchstart', (e) => {
    const a = e.target.closest('.item'); if (!a) return;
    if (active && active !== a) { active.classList.remove('swiped'); close(active); }
    active = a; startX = e.touches[0].clientX; startY = e.touches[0].clientY; dx = 0; dragging = false;
  }, { passive: true });
  listEl.addEventListener('touchmove', (e) => {
    if (!active) return; dx = e.touches[0].clientX - startX; const dy = e.touches[0].clientY - startY;
    if (!dragging && Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy)) dragging = true;
    if (dragging) { const x = Math.max(-SWIPE_W, Math.min(0, dx + (active.classList.contains('swiped') ? -SWIPE_W : 0))); active.style.transform = 'translateX(' + x + 'px)'; }
  }, { passive: true });
  listEl.addEventListener('touchend', () => {
    if (!active) return; const was = active.classList.contains('swiped');
    if (dragging) { const open = was ? dx < 80 : dx < -80; active.classList.toggle('swiped', open); active.style.transform = open ? 'translateX(-' + SWIPE_W + 'px)' : ''; }
    active = null;
  });
  listEl.addEventListener('click', async (e) => {
    const read = e.target.closest('.sw-read'), keep = e.target.closest('.sw-keep'), del = e.target.closest('.sw-del');
    if (read) { isRead(read.dataset.id) ? markUnread(read.dataset.id) : markRead(read.dataset.id); renderHome(); }
    else if (keep) { const row = await db.get('posts', keep.dataset.id); if (row) { row.pinned = !row.pinned; await db.put('posts', row); } renderHome(); }
    else if (del) { if (confirm('Delete this thread?')) { await deletePost(del.dataset.id); _textCache.delete(del.dataset.id); } renderHome(); }
    else if (e.target.closest('.item.swiped')) { e.preventDefault(); closeAll(); }
  });
}

// Pull down at the top to check for new threads.
function wirePullRefresh(lib, hasSources) {
  if (!hasSources) return;
  let startY = 0, pulling = false;
  view.addEventListener('touchstart', (e) => { pulling = window.scrollY <= 0; startY = e.touches[0].clientY; }, { passive: true });
  view.addEventListener('touchend', (e) => {
    if (!pulling) return; const dy = e.changedTouches[0].clientY - startY; pulling = false;
    if (dy > 90 && !syncing) { toast('Checking…', 1500); checkSubs(true, lib); }
  });
}

function commentHtml(c, level) {
  return `<div class="c" style="--lvl:${level % 5}">
    <div class="c-head" data-toggle><span class="c-author ${c.op ? 'op' : ''}">${esc(c.a)}</span>${c.op ? '<span class="tag op">OP</span>' : ''}<span>${fmtNum(c.s)} pts · ${fmtAgo(c.t)}</span></div>
    <div class="c-body rich">${c.h}</div>
    ${c.r.length ? `<div class="c-replies">${c.r.map(r => commentHtml(r, level + 1)).join('')}</div>` : ''}</div>`;
}

async function renderPost(id) {
  const row = await db.get('posts', id); const thread = await db.get('threads', id);
  if (!row || !thread) { setHeader('', true); view.innerHTML = '<p class="empty muted">This thread isn’t saved anymore.</p>'; return; }
  const p = thread.post; const hideSub = (row.lib || 'main') === 'nsfw' && settings.hideSubs;
  setHeader(hideSub ? '🔒 Private' : 'r/' + p.subreddit, true);
  const blur = p.nsfw && settings.blurNsfw;
  const outLink = p.url && !/^https:\/\/(i|v|preview)\.redd\.it\//.test(p.url) && !/\.(jpe?g|png|gif|webp)(\?|$)/i.test(p.url) && !p.url.includes('/comments/') && !p.url.includes('/gallery/');
  view.innerHTML = `
    <article class="post ${blur ? 'nsfw-blur' : ''}">
      <div class="post-meta">u/${esc(p.author)} · ${fmtAgo(p.created)} ago${p.flair ? ` · <span class="tag">${esc(p.flair)}</span>` : ''}${p.nsfw ? ' <span class="tag nsfw">NSFW</span>' : ''}</div>
      <h2>${esc(p.title)}</h2>
      ${p.media.map(m => `<figure><img src="${esc(m.url)}" alt="" loading="lazy" onerror="this.closest('figure').remove()">${m.caption ? `<figcaption>${esc(m.caption)}</figcaption>` : ''}</figure>`).join('')}
      ${p.html ? `<div class="rich">${p.html}</div>` : ''}
      ${outLink ? `<a class="link-out" href="${esc(p.url)}" target="_blank" rel="noopener noreferrer">${esc(p.url)}</a>` : ''}
      <div class="post-stats">${fmtNum(p.numComments)} comments on Reddit · ${readMins(thread)} min read · saved ${new Date(thread.fetchedAt).toLocaleDateString()}</div>
      <div class="actions">
        <button class="btn small ${row.pinned ? 'on' : ''}" id="pinBtn">${ICONS.pin} ${row.pinned ? 'Kept' : 'Keep'}</button>
        <button class="btn small" id="shareBtn">Share</button>
        <a class="btn small" href="${esc(p.permalink)}" target="_blank" rel="noopener noreferrer">Reddit</a>
        <button class="btn small danger" id="delBtn">Delete</button>
      </div>
    </article>
    <div class="comments-head"><h3>${plural(countComments(thread.comments), 'comment')}</h3><button class="btn small" id="collapseBtn">Collapse all</button></div>
    <div class="comments ${blur ? 'nsfw-blur' : ''}" id="comments">${thread.comments.map(c => commentHtml(c, 0)).join('') || '<p class="muted">No comments were saved for this thread yet.</p>'}
      ${thread.more ? `<p class="c-more">${fmtNum(thread.more)} more comments on Reddit</p>` : ''}</div>`;
  markRead(id);
  // restore scroll position (continue reading)
  const y = getScroll(id); if (y) requestAnimationFrame(() => window.scrollTo(0, y));
  let scrollTimer; const onScroll = () => { clearTimeout(scrollTimer); scrollTimer = setTimeout(() => saveScroll(id, window.scrollY), 200); };
  window.addEventListener('scroll', onScroll, { passive: true });
  view._cleanup = () => window.removeEventListener('scroll', onScroll);
  view.onclick = (e) => {
    const im = e.target.closest('.nsfw-blur img:not(.revealed)'); if (im) { e.preventDefault(); im.classList.add('revealed'); return; }
    const head = e.target.closest('[data-toggle]'); if (head && !e.target.closest('a')) head.parentElement.classList.toggle('collapsed');
  };
  let allCollapsed = false;
  $('#collapseBtn').onclick = () => {
    allCollapsed = !allCollapsed;
    $('#comments').querySelectorAll(':scope > .c').forEach(c => c.classList.toggle('collapsed', allCollapsed));
    $('#collapseBtn').textContent = allCollapsed ? 'Expand all' : 'Collapse all';
  };
  $('#pinBtn').onclick = async () => { row.pinned = !row.pinned; await db.put('posts', row); toast(row.pinned ? 'Kept: won’t be auto-removed.' : 'No longer kept.'); renderPost(id); };
  $('#delBtn').onclick = async () => { if (confirm('Delete this thread from your phone?')) { await deletePost(id); _textCache.delete(id); location.hash = '#/'; } };
  $('#shareBtn').onclick = () => shareThread(thread);
}

function threadToText(thread) {
  const strip = (h) => { const d = new DOMParser().parseFromString(h || '', 'text/html'); return d.body.textContent.trim(); };
  let out = thread.post.title + '\n' + ('https://www.reddit.com' + (thread.post.permalink || '').replace('https://www.reddit.com', '')) + '\n';
  if (thread.post.html) out += '\n' + strip(thread.post.html) + '\n';
  const walk = (list, depth) => list.forEach(c => { out += '\n' + '  '.repeat(depth) + c.a + ' (' + fmtNum(c.s) + '): ' + strip(c.h); walk(c.r, depth + 1); });
  out += '\n\n--- Comments ---';
  walk(thread.comments, 0);
  return out;
}
async function shareThread(thread) {
  const text = threadToText(thread);
  try {
    if (navigator.share) { await navigator.share({ title: thread.post.title, text }); return; }
    await navigator.clipboard.writeText(text); toast('Copied the thread to your clipboard.');
  } catch (e) { if (e && e.name === 'AbortError') return; try { await navigator.clipboard.writeText(text); toast('Copied to clipboard.'); } catch { toast('Couldn’t share.'); } }
}

function seg(name, options, current) { return `<div class="seg" data-setting="${name}">${options.map(([v, label]) => `<button type="button" data-value="${esc(v)}" aria-pressed="${String(v) === String(current)}">${label}</button>`).join('')}</div>`; }

async function renderSettings() {
  const lib = currentLib();
  setHeader(lib === 'nsfw' ? '🔒 Private settings' : 'Settings', true);
  const used = await usedBytes(); let persisted = false; try { persisted = await navigator.storage.persisted(); } catch {}
  const sourcesGroup = lib === 'nsfw'
    ? `<section class="group"><h3>🔒 Private library — subreddits</h3>
        <div class="field">
          <p class="muted small" style="margin:0 0 8px">Download into the Private surface (hidden from Main). Best with <b>text discussion</b> subreddits — e.g. <b>AskRedditAfterDark</b>, <b>sex</b>, <b>confession</b>, <b>DirtyConfession</b>. Image-only subreddits work too but have few comments.</p>
          <div class="sub-list" id="nsfwList">${settings.nsfwSubs.map(s => `<span class="sub-tag">r/${esc(s)}<button type="button" data-nremove="${esc(s)}" aria-label="Remove">×</button></span>`).join('') || '<span class="muted small">None yet.</span>'}</div>
          <form class="linkrow" id="nsfwForm" style="margin-top:10px"><input id="nsfwInput" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="e.g. AskRedditAfterDark"><button class="btn" type="submit">Add</button></form>
        </div>
        <div class="field row-field"><label for="blurNsfw">Blur images until tapped</label><input type="checkbox" role="switch" class="toggle" id="blurNsfw" ${settings.blurNsfw ? 'checked' : ''}></div>
        <div class="field row-field"><label for="hideSubs">Hide subreddit names (r/…)<span class="muted small"><br>No one can see which subs you're reading</span></label><input type="checkbox" role="switch" class="toggle" id="hideSubs" ${settings.hideSubs ? 'checked' : ''}></div>
      </section>`
    : `<section class="group"><h3>What to auto-save</h3>
        <div class="field row-field"><label for="incPop">Popular mix <span class="muted small">(hot threads from across Reddit)</span></label><input type="checkbox" role="switch" class="toggle" id="incPop" ${settings.includePopular ? 'checked' : ''}></div>
        <div class="field">
          <label>Your focus subreddits</label>
          <div class="sub-list" id="mainSubList">${settings.subs.map(s => `<span class="sub-tag">r/${esc(s)}<button type="button" data-remove="${esc(s)}" aria-label="Remove">×</button></span>`).join('') || '<span class="muted small">None yet — the popular mix will be used.</span>'}</div>
          <form class="linkrow" id="subForm" style="margin-top:10px"><input id="subInput" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="Add a subreddit, e.g. AskReddit"><button class="btn" type="submit">Add</button></form>
        </div>
      </section>`;
  view.innerHTML = `
    <div class="muted small" style="margin:0 0 12px">Configuring the <b>${lib === 'nsfw' ? 'Private' : 'Main'}</b> surface · switch with the tabs on the home page.</div>
    ${sourcesGroup}

    <section class="group"><h3>Downloads</h3>
      <div class="field"><label>Threads per subreddit, each check</label>${seg('postsPerSub', [[3, '3'], [5, '5'], [10, '10'], [25, '25']], settings.postsPerSub)}
        <p class="muted small">The most-commented recent threads are saved first.</p></div>
      <div class="field"><label>Check for new threads</label>${seg('autoCheck', [['open', 'On open'], ['daily', 'Daily'], ['off', 'Manually']], settings.autoCheck)}
        <p class="muted small">Threads are usually a couple of weeks old, so the archive has all their comments.</p></div>
      <div class="field"><label>Comments saved per thread</label>${seg('commentsPerThread', [[50, '50'], [100, '100'], [200, '200'], [500, '500']], settings.commentsPerThread)}</div>
      <div class="field"><label for="onlyKw">Only save titles containing <span class="muted small">(comma-separated, optional)</span></label>
        <input type="text" id="onlyKw" class="search" style="margin:0" value="${esc(settings.onlyKeywords)}" placeholder="e.g. advice, history" autocapitalize="off"></div>
      <div class="field"><label for="muteKw">Skip titles containing</label>
        <input type="text" id="muteKw" class="search" style="margin:0" value="${esc(settings.muteKeywords)}" placeholder="e.g. politics, spoiler" autocapitalize="off"></div>
    </section>

    <section class="group"><h3>Storage (shared)</h3>
      <div class="field"><label>Total storage</label>${seg('limitMB', [[10, '10 MB'], [25, '25 MB'], [50, '50 MB'], [250, '250 MB'], [500, '500 MB'], [1000, '1 GB'], [2000, '2 GB']], settings.limitMB)}
        <p class="muted small">Using ${fmtBytes(used)} across both libraries.${persisted ? '' : ' Open from your Home Screen so iPhone keeps your threads.'}</p></div>
      <div class="field"><label>When storage is full</label>${seg('whenFull', [['evict', 'Remove oldest'], ['stop', 'Stop saving']], settings.whenFull)}
        <p class="muted small">Auto-saved threads go first; ones you <b>Keep</b> are never removed.</p></div>
    </section>

    <section class="group"><h3>Appearance</h3>
      <div class="field"><label>Text size</label>${seg('fontSize', [[15, 'Small'], [17, 'Medium'], [19, 'Large'], [21, 'Larger']], settings.fontSize)}</div>
      <div class="field"><label>Theme</label>${seg('theme', [['auto', 'Auto'], ['light', 'Light'], ['dark', 'Dark']], settings.theme)}</div>
      <div class="field"><label>Accent colour</label>
        <div class="accents" id="accents">${Object.entries(ACCENTS).map(([k, v]) => `<button type="button" data-accent="${k}" class="${settings.accent === k ? 'on' : ''}" style="background:${v}" aria-label="${k}"></button>`).join('')}</div></div>
    </section>

    ${lib === 'nsfw' ? `<section class="group"><h3>🔒 Private lock</h3>
      <div class="field"><label>Passcode</label>
        <p class="muted small" style="margin:0 0 8px">${settings.pin ? 'A passcode is set. The Private tab asks for it.' : 'Set a passcode to lock the Private library.'}</p>
        <div class="row" style="display:flex;gap:8px">${settings.pin ? `<button class="btn" id="clearPin" style="flex:1">Remove passcode</button>` : `<button class="btn" id="setPin" style="flex:1">Set passcode</button>`}</div></div>
      <div class="field row-field"><label for="hidePriv">Hide the Private tab until the passcode is typed</label><input type="checkbox" role="switch" class="toggle" id="hidePriv" ${settings.hidePrivate ? 'checked' : ''} ${settings.pin ? '' : 'disabled'}></div>
      ${settings.pin ? '' : '<div class="field"><p class="muted small" style="margin:0">Set a passcode first to enable hiding.</p></div>'}
    </section>` : ''}

    <section class="group"><h3>Backup</h3>
      <div class="field" style="display:flex;gap:8px"><button class="btn" id="exportBtn" style="flex:1">Export backup</button><button class="btn" id="importBtn" style="flex:1">Import</button><input type="file" id="importFile" accept="application/json,.json" hidden></div>
      <div class="field"><p class="muted small" style="margin:0">Saves both libraries and settings to a file you can keep or move to another phone.</p></div>
    </section>

    <section class="group"><h3>Delete</h3><div class="field"><button class="btn danger block" id="wipe">Delete all saved threads</button></div></section>
    <p class="muted small center" style="line-height:1.7">ThreadKeep ${APP_VERSION} · Threads come from the free Arctic Shift Reddit archive. Your saved threads stay on this device; only an anonymous visit count (no cookies, no accounts) is recorded.<br><span class="credit">Designed by Chisunsoft</span></p>`;

  view.querySelectorAll('.seg').forEach(s => s.addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return; const key = s.dataset.setting;
    settings[key] = typeof DEFAULTS[key] === 'number' ? Number(b.dataset.value) : b.dataset.value; saveSettings();
    s.querySelectorAll('button').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
    if (key === 'limitMB') makeRoom(0);
  }));
  const subForm = $('#subForm'); if (subForm) subForm.onsubmit = (e) => { e.preventDefault(); const name = cleanSub($('#subInput').value); if (!name) { toast('Type a subreddit name, e.g. AskReddit.'); return; } if (settings.subs.some(s => s.toLowerCase() === name.toLowerCase())) { toast('Already added.'); return; } settings.subs.push(name); saveSettings(); renderSettings(); checkSubs(true, 'main'); };
  const mainList = $('#mainSubList'); if (mainList) mainList.onclick = (e) => { const b = e.target.closest('[data-remove]'); if (!b) return; settings.subs = settings.subs.filter(s => s !== b.dataset.remove); saveSettings(); renderSettings(); };
  const nsfwForm = $('#nsfwForm'); if (nsfwForm) nsfwForm.onsubmit = (e) => { e.preventDefault(); const name = cleanSub($('#nsfwInput').value); if (!name) { toast('Type a subreddit name.'); return; } if (settings.nsfwSubs.some(s => s.toLowerCase() === name.toLowerCase())) { toast('Already added.'); return; } settings.nsfwSubs.push(name); saveSettings(); renderSettings(); checkSubs(true, 'nsfw'); };
  const nsfwList = $('#nsfwList'); if (nsfwList) nsfwList.onclick = (e) => { const b = e.target.closest('[data-nremove]'); if (!b) return; settings.nsfwSubs = settings.nsfwSubs.filter(s => s !== b.dataset.nremove); saveSettings(); renderSettings(); };
  const incPop = $('#incPop'); if (incPop) incPop.onchange = (e) => { settings.includePopular = e.target.checked; saveSettings(); };
  const blur = $('#blurNsfw'); if (blur) blur.onchange = (e) => { settings.blurNsfw = e.target.checked; saveSettings(); };
  const hideSubs = $('#hideSubs'); if (hideSubs) hideSubs.onchange = (e) => { settings.hideSubs = e.target.checked; saveSettings(); };
  $('#onlyKw').onchange = (e) => { settings.onlyKeywords = e.target.value; saveSettings(); };
  $('#muteKw').onchange = (e) => { settings.muteKeywords = e.target.value; saveSettings(); };
  $('#accents').onclick = (e) => { const b = e.target.closest('[data-accent]'); if (!b) return; settings.accent = b.dataset.accent; saveSettings(); $('#accents').querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b)); };
  const setPin = $('#setPin'); if (setPin) setPin.onclick = () => { const a = prompt('Choose a passcode (digits or letters):'); if (!a) return; const b = prompt('Enter it again:'); if (a !== b) { toast('They didn’t match.'); return; } settings.pin = a; setUnlocked(true); saveSettings(); toast('Passcode set.'); renderSettings(); };
  const clearPin = $('#clearPin'); if (clearPin) clearPin.onclick = () => { if (!confirm('Remove the Private passcode?')) return; settings.pin = ''; settings.hidePrivate = false; saveSettings(); toast('Passcode removed.'); renderSettings(); };
  const hidePriv = $('#hidePriv'); if (hidePriv) hidePriv.onchange = (e) => { settings.hidePrivate = e.target.checked && !!settings.pin; saveSettings(); };
  $('#exportBtn').onclick = exportBackup;
  $('#importBtn').onclick = () => $('#importFile').click();
  $('#importFile').onchange = (e) => importBackup(e.target.files[0]);
  $('#wipe').onclick = async () => { if (!confirm('Delete every saved thread and image from this device?')) return; for (const p of await db.all('posts')) await deletePost(p.id); await caches.delete(MEDIA_CACHE); store.set('tk-seen', []); _textCache.clear(); toast('Everything deleted.'); renderSettings(); };
}

/* ================= Backup / restore ================= */

async function exportBackup() {
  try {
    const data = { app: 'threadkeep', version: 3, exportedAt: Date.now(), settings, read: store.get('tk-read', []), posts: await db.all('posts'), threads: await db.all('threads') };
    const file = new File([JSON.stringify(data)], 'threadkeep-backup-' + new Date().toISOString().slice(0, 10) + '.json', { type: 'application/json' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) { try { await navigator.share({ files: [file], title: 'ThreadKeep backup' }); return; } catch (e) { if (e.name === 'AbortError') return; } }
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(file), download: file.name }); document.body.append(a); a.click(); a.remove();
    toast('Backup saved.');
  } catch { toast('Couldn’t export.'); }
}
async function importBackup(file) {
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (data.app !== 'threadkeep') throw 0;
    let n = 0;
    for (const t of data.threads || []) { if (!(await db.get('threads', t.id))) await db.put('threads', t); const row = (data.posts || []).find(p => p.id === t.id); if (row && !(await db.get('posts', t.id))) { await db.put('posts', row); n++; } }
    if (Array.isArray(data.read)) { const s = new Set([...(store.get('tk-read', []) || []), ...data.read]); store.set('tk-read', [...s]); }
    if (data.settings) { for (const k of Object.keys(DEFAULTS)) if (k in data.settings) settings[k] = data.settings[k]; saveSettings(); }
    _textCache.clear();
    toast('Imported ' + n + ' threads.', 4000); renderSettings();
  } catch { toast('That isn’t a ThreadKeep backup.', 4000); }
}

/* ================= Shell, routing, startup ================= */

function setHeader(title, back) { $('#title').textContent = title; $('#backBtn').hidden = !back; $('#settingsBtn').hidden = location.hash === '#/settings'; }
let renderTimer;
function render() { clearTimeout(renderTimer); renderTimer = setTimeout(route, 20); }
function route() { if (view._cleanup) { view._cleanup(); view._cleanup = null; } view.onclick = null; const h = location.hash; if (h.startsWith('#/p/')) return renderPost(decodeURIComponent(h.slice(4))); if (h === '#/settings') return renderSettings(); return renderHome(); }
window.addEventListener('hashchange', () => { route(); window.scrollTo(0, 0); });
$('#backBtn').onclick = () => { location.hash = '#/'; };
$('#settingsBtn').onclick = () => { location.hash = '#/settings'; };

async function checkForUpdate() {
  if (!navigator.onLine) return;
  try {
    const { version } = await (await fetch('version.json?t=' + Date.now(), { cache: 'no-store' })).json();
    if (!version || version === APP_VERSION) return;
    let tried = ''; try { tried = sessionStorage.getItem('tk-reloaded-for') || ''; } catch {}
    if (tried === version) return; try { sessionStorage.setItem('tk-reloaded-for', version); } catch {}
    const reg = await navigator.serviceWorker?.getRegistration(); if (reg) await reg.update().catch(() => {});
    location.reload();
  } catch {}
}
// Auto-fill both libraries (Main, then Private if it has subreddits) so Private downloads
// even while you're on Main. Each has its own "skip while plenty unread" guard.
async function autoCheckAll() {
  await checkSubs(false, 'main');
  if (settings.nsfwSubs.length) await checkSubs(false, 'nsfw');
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) { checkForUpdate(); autoCheckAll(); } });
window.addEventListener('online', () => autoCheckAll());

(async function start() {
  checkForUpdate();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  try { if (navigator.storage?.persist) await navigator.storage.persist(); } catch {}
  // clean v1/v2 leftovers
  for (const p of await db.all('posts')) { if (!(await db.get('threads', p.id))) { await db.del('posts', p.id); continue; } if (p.complete === undefined) { p.complete = true; delete p.status; delete p.error; await db.put('posts', p); } }
  for (const k of ['tk-token', 'tk-apptoken', 'tk-device', 'tk-syncerr', 'tk-grab', 'tk-setup-done', 'tk-nsfw-on']) { try { localStorage.removeItem(k); } catch {} }
  route();
  autoCheckAll();
})();
